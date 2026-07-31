import { useState } from 'react';

import { metro, storage, toasts } from '@unbound-app/api';

import {
	getSourceLanguage,
	getTargetLanguage,
	hasRefreshToken,
	setSourceLanguage,
	setTargetLanguage,
} from '@translate/api';
import { openDiscordLoginFlow } from '@translate/oauth';
import LanguagePickerSheet from '@translate/sheets/LanguagePickerSheet';

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

export function TranslateSettingsScreen() {
	const ReactNative = metro.common.ReactNative;
	const Discord = getDesignModule();
	const state = STORE.useSettingsStore();
	const refreshConfigured = hasRefreshToken() || !!state.get('refreshToken', '');
	const targetLanguage = getTargetLanguage();
	const sourceLanguage = getSourceLanguage();
	const [connecting, setConnecting] = useState(false);

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
					label={connecting ? 'Connecting Discord account…' : refreshConfigured ? 'Reconnect Discord account' : 'Connect Discord account'}
					subLabel={connecting ? 'Finishing Discord authorization' : refreshConfigured ? 'Re-authenticate with Discord' : 'Sign in to enable translation'}
					disabled={connecting}
					onPress={() => {
						setConnecting(true);
						openDiscordLoginFlow(() => setConnecting(false));
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
			</Discord.TableRowGroup>
		</ReactNative.ScrollView>
	);
}
