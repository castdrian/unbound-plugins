import { NativeModules, Platform } from 'react-native';

function getNativeModuleLocale(): string | null {
	if (Platform.OS === 'ios') {
		const settings = NativeModules.SettingsManager?.settings;
		return settings?.AppleLocale ?? settings?.AppleLanguages?.[0] ?? null;
	}

	return NativeModules.I18nManager?.localeIdentifier ?? null;
}

function getIntlLocale(): string | null {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale ?? null;
	} catch {
		return null;
	}
}

export function getDeviceLocale(): string {
	return getNativeModuleLocale() ?? getIntlLocale() ?? 'unknown';
}
