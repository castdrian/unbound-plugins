import { startTranslateMenuPatch, stopTranslateMenuPatch } from '@translate/menu';
import { registerTranslateSettings, unregisterTranslateSettings } from '@translate/settings';

export default {
	start() {
		startTranslateMenuPatch();
		registerTranslateSettings();
	},

	stop() {
		stopTranslateMenuPatch();
		unregisterTranslateSettings();
	},
};
