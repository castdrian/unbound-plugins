import { native, storage, toasts } from '@unbound-app/api';

import { getDeviceLocale } from '@aussie-mode/locale';
import { startRotation, stopRotation } from '@aussie-mode/rotate';

const TARGET_LOCALE = 'en-AU';
const ROTATE_ON_TARGET_LOCALE = false;
const FORCE_ROTATE_REGARDLESS_OF_LOCALE = true;

const STORE = storage.getStore('adrian.aussie-mode');

export default {
	start() {
		const locale = getDeviceLocale();
		console.log('[Aussie Mode] device locale:', locale);
		toasts.showToast({ title: 'Aussie Mode', content: `Detected locale: ${locale}` });

		const shouldRotate = FORCE_ROTATE_REGARDLESS_OF_LOCALE || (ROTATE_ON_TARGET_LOCALE && locale === TARGET_LOCALE);
		if (!shouldRotate) return;

		const reloadedSinceEnable = STORE.get('reloadedSinceEnable', false);
		if (!reloadedSinceEnable) {
			STORE.set('reloadedSinceEnable', true);
			void native.reload();
			return;
		}

		startRotation();
	},

	stop() {
		stopRotation();

		const reloadedSinceEnable = STORE.get('reloadedSinceEnable', false);
		STORE.set('reloadedSinceEnable', false);

		if (reloadedSinceEnable) {
			void native.reload();
		}
	},
};
