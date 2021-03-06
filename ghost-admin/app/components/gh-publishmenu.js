import Component from '@ember/component';
import EmailFailedError from 'ghost-admin/errors/email-failed-error';
import {action} from '@ember/object';
import {computed} from '@ember/object';
import {reads} from '@ember/object/computed';
import {inject as service} from '@ember/service';
import {task, timeout} from 'ember-concurrency';

const CONFIRM_EMAIL_POLL_LENGTH = 1000;
const CONFIRM_EMAIL_MAX_POLL_LENGTH = 15 * 1000;

export default Component.extend({
    clock: service(),
    intl: service(),

    backgroundTask: null,
    classNames: 'gh-publishmenu',
    displayState: 'draft',
    post: null,
    postStatus: 'draft',
    runningText: null,
    saveTask: null,
    sendEmailWhenPublished: false,
    typedDateError: null,

    _publishedAtBlogTZ: null,
    _previousStatus: null,

    isClosing: null,

    onClose() {},

    forcePublishedMenu: reads('post.pastScheduledTime'),

    postState: computed('post.{isPublished,isScheduled}', 'forcePublishedMenu', function () {
        if (this.forcePublishedMenu || this.get('post.isPublished')) {
            return 'published';
        } else if (this.get('post.isScheduled')) {
            return 'scheduled';
        } else {
            return 'draft';
        }
    }),

    triggerText: computed('postState', function () {
        let state = this.postState;

        if (state === 'published') {
            return this.intl.t('trigger.Update');
        } else if (state === 'scheduled') {
            return this.intl.t('trigger.Scheduled');
        } else {
            return this.intl.t('trigger.Publish');
        }
    }),

    _runningText: computed('postState', 'saveType', function () {
        let saveType = this.saveType;
        let postState = this.postState;
        let runningText;

        if (postState === 'draft') {
            runningText = saveType === 'publish' ? 'taskButton.Publishing' : 'taskButton.Scheduling';
        }

        if (postState === 'published') {
            runningText = saveType === 'publish' ? 'taskButton.Updating' : 'taskButton.Unpublishing';
        }

        if (postState === 'scheduled') {
            runningText = saveType === 'schedule' ? 'taskButton.Rescheduling' : 'taskButton.Unscheduling';
        }

        return this.intl.t(runningText || 'taskButton.Publishing').toString();
    }),

    buttonText: computed('postState', 'saveType', function () {
        let saveType = this.saveType;
        let postState = this.postState;
        let buttonText;

        if (postState === 'draft') {
            buttonText = saveType === 'publish' ? 'taskButton.Publish' : 'taskButton.Schedule';
        }

        if (postState === 'published') {
            buttonText = saveType === 'publish' ? 'taskButton.Update' : 'taskButton.Unpublish';
        }

        if (postState === 'scheduled') {
            buttonText = saveType === 'schedule' ? 'taskButton.Reschedule' : 'taskButton.Unschedule';
        }

        return this.intl.t(buttonText || 'taskButton.Publish').toString();
    }),

    successText: computed('_previousStatus', 'postState', function () {
        let postState = this.postState;
        let previousStatus = this._previousStatus;
        let buttonText;

        if (previousStatus === 'draft') {
            buttonText = postState === 'published' ? 'taskButton.Published' : 'taskButton.Scheduled';
        }

        if (previousStatus === 'published') {
            buttonText = postState === 'draft' ? 'taskButton.Unpublished' : 'taskButton.Updated';
        }

        if (previousStatus === 'scheduled') {
            buttonText = postState === 'draft' ? 'taskButton.Unscheduled' : 'taskButton.Rescheduled';
        }

        return this.intl.t(buttonText || 'taskButton.Published').toString();
    }),

    didReceiveAttrs() {
        this._super(...arguments);

        // update the displayState based on the post status but only after a
        // save has finished to avoid swapping the menu prematurely and triggering
        // calls to `setSaveType` due to the component re-rendering
        // TODO: we should have a better way of dealing with this where we don't
        // rely on the side-effect of component rendering calling setSaveType
        let postStatus = this.postStatus;
        if (postStatus !== this._postStatus) {
            if (this.get('saveTask.isRunning')) {
                this.get('saveTask.last').then(() => {
                    this.set('displayState', postStatus);
                });
            } else {
                this.set('displayState', postStatus);
            }
        }

        this._postStatus = this.postStatus;
    },

    actions: {
        setSaveType(saveType) {
            let post = this.post;

            this.set('saveType', saveType);

            if (saveType === 'draft') {
                post.set('statusScratch', 'draft');
            } else if (saveType === 'schedule') {
                post.set('statusScratch', 'scheduled');
            } else if (saveType === 'publish') {
                post.set('statusScratch', 'published');
            }
        },

        open() {
            this._cachePublishedAtBlogTZ();
            this.set('isClosing', false);
            this.get('post.errors').clear();
            if (this.onOpen) {
                this.onOpen();
            }
        },

        close(dropdown, e) {
            // don't close the menu if the datepicker popup or confirm modal is clicked
            if (e) {
                let onDatepicker = !!e.target.closest('.ember-power-datepicker-content');
                let onModal = !!e.target.closest('.fullscreen-modal-container');

                if (onDatepicker || onModal) {
                    return false;
                }
            }

            if (!this._skipDropdownCloseCleanup) {
                this._cleanup();
            }
            this._skipDropdownCloseCleanup = false;

            this.onClose();
            this.set('isClosing', true);

            return true;
        }
    },

    // action is required because <GhFullscreenModal> only uses actions
    confirmEmailSend: action(function () {
        return this._confirmEmailSend.perform();
    }),

    _confirmEmailSend: task(function* () {
        this.sendEmailConfirmed = true;
        let post = yield this.save.perform();

        // simulate a validation error if saving failed so that the confirm
        // modal can react accordingly
        if (!post || post.errors.length) {
            throw null;
        }

        let pollTimeout = 0;
        if (post.email && post.email.status !== 'submitted') {
            while (pollTimeout < CONFIRM_EMAIL_MAX_POLL_LENGTH) {
                yield timeout(CONFIRM_EMAIL_POLL_LENGTH);
                post = yield post.reload();

                if (post.email.status === 'submitted') {
                    break;
                }
                if (post.email.status === 'failed') {
                    throw new EmailFailedError(post.email.error);
                }
            }
        }

        return post;
    }),

    retryEmailSend: action(function () {
        return this._retryEmailSend.perform();
    }),

    _retryEmailSend: task(function* () {
        if (!this.post.email) {
            return;
        }

        let email = yield this.post.email.retry();

        let pollTimeout = 0;
        if (email && email.status !== 'submitted') {
            while (pollTimeout < CONFIRM_EMAIL_POLL_LENGTH) {
                yield timeout(CONFIRM_EMAIL_POLL_LENGTH);
                email = yield email.reload();

                if (email.status === 'submitted') {
                    break;
                }
                if (email.status === 'failed') {
                    throw new EmailFailedError(email.error);
                }
            }
        }

        return email;
    }),

    openEmailConfirmationModal: action(function (dropdown) {
        if (dropdown) {
            this._skipDropdownCloseCleanup = true;
            dropdown.actions.close();
        }
        this.set('showEmailConfirmationModal', true);
    }),

    closeEmailConfirmationModal: action(function () {
        this.set('showEmailConfirmationModal', false);
        this._cleanup();
    }),

    save: task(function* ({dropdown} = {}) {
        let {
            post,
            sendEmailWhenPublished,
            sendEmailConfirmed,
            saveType,
            typedDateError
        } = this;

        // don't allow save if an invalid schedule date is present
        if (typedDateError) {
            return false;
        }

        // validate publishedAtBlog to avoid an alert when saving for already displayed errors
        // important to do this before opening email confirmation modal too
        try {
            yield post.validate({property: 'publishedAtBlog'});
        } catch (error) {
            // re-throw if we don't have a validation error
            if (error) {
                throw error;
            }
            return false;
        }

        if (
            post.status === 'draft' &&
            !post.email && // email sent previously
            sendEmailWhenPublished &&
            !sendEmailConfirmed // set once confirmed so normal save happens
        ) {
            this.openEmailConfirmationModal(dropdown);
            return;
        }

        this.sendEmailConfirmed = false;

        // runningText needs to be declared before the other states change during the
        // save action.
        this.set('runningText', this._runningText);
        this.set('_previousStatus', this.get('post.status'));
        this.setSaveType(saveType);

        try {
            // will show alert for non-date related failed validations
            post = yield this.saveTask.perform({sendEmailWhenPublished});

            // revert the email checkbox to avoid weird inbetween states
            this.set('sendEmailWhenPublished', false);

            this._cachePublishedAtBlogTZ();
            return post;
        } catch (error) {
            // re-throw if we don't have a validation error
            if (error) {
                throw error;
            }
        }
    }),

    _cachePublishedAtBlogTZ() {
        this._publishedAtBlogTZ = this.get('post.publishedAtBlogTZ');
    },

    _cleanup() {
        this.set('showConfirmEmailModal', false);
        this.set('sendEmailWhenPublished', false);

        // when closing the menu we reset the publishedAtBlogTZ date so that the
        // unsaved changes made to the scheduled date aren't reflected in the PSM
        this.post.set('publishedAtBlogTZ', this._publishedAtBlogTZ);

        this.post.set('statusScratch', null);
        this.post.validate();
    }
});
