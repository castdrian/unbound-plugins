import { assets, metro, settings, storage } from '@unbound-app/api';

import { authorize } from '@reviewdb/auth';
import { openBlockedUsersSheet } from '@reviewdb/sheets/BlockedUsersSheet';
import { openReviewsSheet } from '@reviewdb/sheets/ReviewsSheet';
import { getCurrentUserId } from '@reviewdb/utils';

const ADDON_ID = 'unbound.reviewdb';
const SETTINGS_ROUTE = 'unbound.reviewdb.settings';
const STORE = storage.getStore(ADDON_ID);

function getDesignModule(): {
	TableRowGroup?: any;
	TableRow?: any;
	TableSwitchRow?: any;
} | null {
	const discord = (metro as { components?: { Discord?: unknown } } | undefined)?.components?.Discord as
		| { TableRowGroup?: any; TableRow?: any; TableSwitchRow?: any }
		| undefined;
	if (discord?.TableRowGroup && discord?.TableRow) return discord;

	if (typeof metro?.findByProps === 'function') {
		const found = metro.findByProps('TableRow', 'TableRowGroup') as
			| { TableRowGroup?: any; TableRow?: any; TableSwitchRow?: any }
			| null;
		if (found?.TableRowGroup && found?.TableRow) return found;
	}

	return null;
}

function ReviewDBIcon() {
	const ReactNative = metro.common.ReactNative;
	const id = assets.getIDByName('StarIcon') ?? assets.Icons?.StarIcon;
	if (typeof id === 'number') {
		return <ReactNative.Image source={id} style={{ width: 20, height: 20 }} />;
	}

	return <ReactNative.Text>R</ReactNative.Text>;
}

function openExternalLink(url: string): void {
	const ReactNative = metro.common.ReactNative;
	ReactNative.Linking?.openURL(url)?.catch?.(() => undefined);
}

function ReviewDBSettingsScreen() {
	const ReactNative = metro.common.ReactNative;
	const Discord = getDesignModule();
	const state = STORE.useSettingsStore();
	const authorized = !!state.get('token', '');
	const myId = getCurrentUserId();

	if (!Discord?.TableRowGroup || !Discord?.TableRow) {
		return (
			<ReactNative.ScrollView contentContainerStyle={{ padding: 16 }}>
				<ReactNative.Text>ReviewDB settings are unavailable on this client build.</ReactNative.Text>
			</ReactNative.ScrollView>
		);
	}

	const SwitchRow = Discord.TableSwitchRow ?? Discord.TableRow;

	return (
		<ReactNative.ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
			<Discord.TableRowGroup title="Account">
				<Discord.TableRow
					label={authorized ? 'Reauthorize with ReviewDB' : 'Authorize with ReviewDB'}
					subLabel={authorized ? 'You are connected to ReviewDB' : 'Sign in to review users and see your reviews'}
					onPress={() => authorize()}
				/>
				<Discord.TableRow
					label="View My Reviews"
					arrow
					disabled={!myId}
					onPress={() => myId && openReviewsSheet(myId, 'You')}
				/>
				<Discord.TableRow
					label="Manage Blocked Users"
					subLabel="Users you have blocked from leaving reviews"
					arrow
					disabled={!authorized}
					onPress={() => authorized && openBlockedUsersSheet()}
				/>
			</Discord.TableRowGroup>

			<Discord.TableRowGroup title="Preferences">
				<SwitchRow
					label="Notify About New Reviews"
					subLabel="Show a toast on startup when you have new reviews"
					value={state.get('notifyReviews', true)}
					onValueChange={(value: boolean) => state.set('notifyReviews', value)}
				/>
				<SwitchRow
					label="Show Community Guidelines Warning"
					subLabel="Display a warning to be respectful at the top of the reviews list"
					value={state.get('showWarning', true)}
					onValueChange={(value: boolean) => state.set('showWarning', value)}
				/>
				<SwitchRow
					label="Hide Timestamps"
					value={state.get('hideTimestamps', false)}
					onValueChange={(value: boolean) => state.set('hideTimestamps', value)}
				/>
				<SwitchRow
					label="Hide Reviews From Blocked Users"
					subLabel="Hide reviews from users you have blocked on Discord"
					value={state.get('hideBlockedUsers', true)}
					onValueChange={(value: boolean) => state.set('hideBlockedUsers', value)}
				/>
			</Discord.TableRowGroup>

			<Discord.TableRowGroup title="Links">
				<Discord.TableRow label="ReviewDB Website" arrow onPress={() => openExternalLink('https://reviewdb.mantikafasi.dev')} />
				<Discord.TableRow label="ReviewDB Support Server" arrow onPress={() => openExternalLink('https://discord.gg/eWPBSbvznt')} />
			</Discord.TableRowGroup>
		</ReactNative.ScrollView>
	);
}

export function registerReviewDBSettings(): void {
	settings.registerSettings({
		type: 'route',
		key: SETTINGS_ROUTE,
		useTitle: () => 'ReviewDB',
		parent: null,
		addonId: ADDON_ID,
		IconComponent: ReviewDBIcon,
		screen: {
			route: SETTINGS_ROUTE,
			getComponent: () => ReviewDBSettingsScreen,
		},
	} as Parameters<typeof settings.registerSettings>[0]);
}

export function unregisterReviewDBSettings(): void {
	settings.removeSettings(SETTINGS_ROUTE);
}
