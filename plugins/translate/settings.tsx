import { metro, settings, storage, toasts } from '@unbound-app/api';

import {
	clearTokens,
	DEFAULT_API_BASE_URL,
	getApiBaseUrlSetting,
	getSourceLanguage,
	getTargetLanguage,
	setApiBaseUrl,
	setSourceLanguage,
	setTargetLanguage,
} from '@translate/api';
import LanguagePickerSheet from '@translate/sheets/LanguagePickerSheet';

const SETTINGS_ROUTE = 'unbound.translate.settings';
const STORE = storage.getStore('unbound.translate');

function openLanguageSheet(options: {
	title: string;
	current: string;
	includeAuto?: boolean;
	onSelect: (code: string) => void;
}) {
	const sheets = metro.findByProps('openLazy', 'hideActionSheet');
	if (!sheets) {
		toasts.showToast({ title: 'Translate', content: 'Language picker is unavailable.' });
		return;
	}
	const key = `unbound-translate-${options.title}-${options.current}`;

	sheets.openLazy(Promise.resolve({ default: LanguagePickerSheet }), key, {
		title: options.title,
		current: options.current,
		includeAuto: options.includeAuto,
		onSelect: options.onSelect,
		onClose: () => sheets.hideActionSheet(key),
	});
}

async function pasteRefreshTokenFromClipboard(): Promise<void> {
	const value = await metro.common.Clipboard.getString();
	if (!value || !value.trim()) {
		toasts.showToast({ title: 'Translate', content: 'Clipboard does not contain a token.' });
		return;
	}

	STORE.set('refreshToken', value.trim());
	STORE.remove('accessToken');
	STORE.remove('expiresAt');
	toasts.showToast({ title: 'Translate', content: 'Refresh token saved.' });
}

function cycleTargetLanguage(current: string): string {
	const options = ['en', 'es', 'fr'];
	const index = options.indexOf(current);
	return options[(index + 1) % options.length] ?? 'en';
}

function cycleSourceLanguage(current: string): string {
	return current === 'auto' ? 'en' : 'auto';
}

function TranslateSettingsScreen() {
	const ReactNative = metro.common.ReactNative;
	const Discord = metro.components.Discord;
	const state = STORE.useSettingsStore();
	const refreshConfigured = !!state.get('refreshToken', '');
	const targetLanguage = getTargetLanguage();
	const sourceLanguage = getSourceLanguage();
	const apiBaseUrl = getApiBaseUrlSetting();

	return (
		<ReactNative.ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
			<Discord.TableRowGroup title="Translate API">
				<Discord.TableRow
					label="Start Discord Login"
					subLabel={`${apiBaseUrl}/auth/login`}
					onPress={() => metro.api.Linking.openURL(`${apiBaseUrl}/auth/login`)}
				/>
				<Discord.TableRow
					label="Paste Refresh Token"
					subLabel={
						refreshConfigured
							? 'Configured. Tap to replace from clipboard.'
							: 'Tap to paste refresh token from clipboard.'
					}
					onPress={() => {
						void pasteRefreshTokenFromClipboard();
					}}
				/>
				<Discord.TableRow
					label="Clear Tokens"
					onPress={() => {
						clearTokens();
						toasts.showToast({ title: 'Translate', content: 'Tokens cleared.' });
					}}
				/>
				<Discord.TableRow
					label="API Base URL"
					subLabel={apiBaseUrl}
					onPress={() => {
						setApiBaseUrl(DEFAULT_API_BASE_URL);
						toasts.showToast({ title: 'Translate', content: 'API base reset to default.' });
					}}
				/>
			</Discord.TableRowGroup>

			<Discord.TableRowGroup title="Languages">
				<Discord.TableRow
					label="Source Language"
					subLabel={sourceLanguage}
					arrow
					onPress={() =>
						openLanguageSheet({
							title: 'Select source language',
							current: sourceLanguage,
							includeAuto: true,
							onSelect: setSourceLanguage,
						})
					}
				/>
				<Discord.TableRow
					label="Target Language"
					subLabel={targetLanguage}
					arrow
					onPress={() =>
						openLanguageSheet({
							title: 'Select target language',
							current: targetLanguage,
							onSelect: setTargetLanguage,
						})
					}
				/>
				<Discord.TableRow
					label="Cycle Target"
					onPress={() => setTargetLanguage(cycleTargetLanguage(targetLanguage))}
				/>
				<Discord.TableRow
					label="Cycle Source"
					onPress={() => setSourceLanguage(cycleSourceLanguage(sourceLanguage))}
				/>
			</Discord.TableRowGroup>
		</ReactNative.ScrollView>
	);
}

export function registerTranslateSettings(): void {
	settings.registerSettings({
		type: 'route',
		key: SETTINGS_ROUTE,
		useTitle: () => 'Translate',
		parent: null,
		section: 'Plugins',
		screen: {
			route: SETTINGS_ROUTE,
			getComponent: () => TranslateSettingsScreen,
		},
	});
}

export function unregisterTranslateSettings(): void {
	settings.removeSettings(SETTINGS_ROUTE);
}
