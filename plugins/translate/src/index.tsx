import { toasts } from '@unbound-app/api';

import { startTranslateMenuPatch, stopTranslateMenuPatch } from '@translate/menu';
import { registerTranslateSettings, unregisterTranslateSettings } from '@translate/settings';

export default {
	start() {
		try {
			registerTranslateSettings();
		} catch (error) {
			toasts.showToast({
				title: 'Translate',
				content: error instanceof Error ? error.message : String(error),
			});
		}

		try {
			startTranslateMenuPatch();
		} catch (error) {
			toasts.showToast({
				title: 'Translate',
				content: error instanceof Error ? error.message : String(error),
			});
		}
	},

	stop() {
		try {
			stopTranslateMenuPatch();
		} catch { }

		try {
			unregisterTranslateSettings();
		} catch { }
	},
};
