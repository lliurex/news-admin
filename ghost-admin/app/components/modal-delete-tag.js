import ModalComponent from 'ghost-admin/components/modal-base';
import {alias} from '@ember/object/computed';
import {inject as service} from '@ember/service';
import {task} from 'ember-concurrency';

export default ModalComponent.extend({
    intl: service(),

    // Allowed actions
    confirm: () => {},

    tag: alias('model'),

    actions: {
        confirm() {
            this.deleteTag.perform();
        }
    },

    deleteTag: task(function* () {
        try {
            yield this.confirm();
        } finally {
            this.send('closeModal');
        }
    }).drop()
});
