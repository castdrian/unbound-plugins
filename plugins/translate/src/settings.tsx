import { assets, metro, settings, storage, toasts } from '@unbound-app/api';

import {
	clearTokens,
	getSourceLanguage,
	getTargetLanguage,
	hasRefreshToken,
	setSourceLanguage,
	setTargetLanguage,
} from '@translate/api';
import { openDiscordLoginFlow } from '@translate/oauth';
import LanguagePickerSheet from '@translate/sheets/LanguagePickerSheet';

const SETTINGS_ROUTE = 'unbound.translate.settings';
const STORE = storage.getStore('unbound.translate');

function getDesignModule(): {
	TableRowGroup?: any;
	TableRow?: any;
} | null {
	const discord = (metro as { components?: { Discord?: unknown } } | undefined)?.components?.Discord as
		| { TableRowGroup?: any; TableRow?: any }
		| undefined;
	if (discord?.TableRowGroup && discord?.TableRow) return discord;

	if (typeof metro?.findByProps === 'function') {
		const found = metro.findByProps('TableRow', 'TableRowGroup') as
			| { TableRowGroup?: any; TableRow?: any }
			| null;
		if (found?.TableRowGroup && found?.TableRow) return found;
	}

	return null;
}

function TranslateIcon() {
	const ReactNative = metro.common.ReactNative;
	const id = assets.getIDByName('LanguageIcon') ?? assets.Icons.LanguageIcon;
	if (typeof id === 'number') {
		return <ReactNative.Image source={id} style={{ width: 20, height: 20 }} />;
	}

	return <ReactNative.Text>T</ReactNative.Text>;
}

function openLanguageSheet(options: {
	title: string;
	current: string;
	includeAuto?: boolean;
	onSelect: (code: string) => void;
}) {
	const sheets = typeof metro?.findByProps === 'function' ? metro.findByProps('openLazy', 'hideActionSheet') : null;
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
	const Discord = getDesignModule();
	const state = STORE.useSettingsStore();
	const refreshConfigured = hasRefreshToken() || !!state.get('refreshToken', '');
	const targetLanguage = getTargetLanguage();
	const sourceLanguage = getSourceLanguage();

	if (!Discord?.TableRowGroup || !Discord?.TableRow) {
		return (
			<ReactNative.ScrollView contentContainerStyle={{ padding: 16 }}>
				<ReactNative.Text>Translate settings are unavailable on this client build.</ReactNative.Text>
			</ReactNative.ScrollView>
		);
	}

	return (
		<ReactNative.ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
			<Discord.TableRowGroup title="Translate API">
				<Discord.TableRow
					label={refreshConfigured ? 'Reconnect Discord' : 'Connect Discord'}
					subLabel={refreshConfigured ? 'Refresh your translation session.' : 'Sign in to enable translation.'}
					onPress={() => {
						openDiscordLoginFlow();
					}}
				/>
				<Discord.TableRow label="Status" subLabel={refreshConfigured ? 'Connected' : 'Not connected'} disabled />
				<Discord.TableRow
					label="Clear Session"
					disabled={!refreshConfigured}
					onPress={() => {
						clearTokens();
						toasts.showToast({ title: 'Translate', content: 'Session cleared.' });
					}}
				/>
			</Discord.TableRowGroup>

			<Discord.TableRowGroup title="Languages">
				<Discord.TableRow
					label="Source Language"
					subLabel={sourceLanguage}
					arrow
					disabled={!refreshConfigured}
					onPress={() =>
						refreshConfigured &&
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
					disabled={!refreshConfigured}
					onPress={() =>
						refreshConfigured &&
						openLanguageSheet({
							title: 'Select target language',
							current: targetLanguage,
							onSelect: setTargetLanguage,
						})
					}
				/>
				<Discord.TableRow
					label="Cycle Target"
					disabled={!refreshConfigured}
					onPress={() => setTargetLanguage(cycleTargetLanguage(targetLanguage))}
				/>
				<Discord.TableRow
					label="Cycle Source"
					disabled={!refreshConfigured}
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
		IconComponent: TranslateIcon,
		screen: {
			route: SETTINGS_ROUTE,
			getComponent: () => TranslateSettingsScreen,
		},
	});
}

export function unregisterTranslateSettings(): void {
	settings.removeSettings(SETTINGS_ROUTE);
}
