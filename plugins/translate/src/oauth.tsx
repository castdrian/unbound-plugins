import { metro, toasts } from '@unbound-app/api';

import { getApiBaseUrlSetting, storeSessionTokens } from './api';

function findOAuth2AuthorizeModal(): any | null {
	if (typeof metro?.findByProps === 'function') {
		const byProp = metro.findByProps('OAuth2AuthorizeModal') as { OAuth2AuthorizeModal?: unknown } | null;
		if (byProp?.OAuth2AuthorizeModal) return byProp.OAuth2AuthorizeModal;
	}

	if (typeof metro?.findByName === 'function') {
		return metro.findByName('OAuth2AuthorizeModal') as unknown;
	}

	return null;
}

function getQueryParam(url: string, key: string): string | null {
	const queryIndex = url.indexOf('?');
	if (queryIndex < 0) return null;

	const query = url.slice(queryIndex + 1);
	if (!query) return null;

	for (const part of query.split('&')) {
		const [rawKey, rawValue = ''] = part.split('=');
		if (decodeURIComponent(rawKey ?? '') !== key) continue;
		return decodeURIComponent(rawValue.replace(/\+/g, ' '));
	}

	return null;
}

function getOAuthError(url: string): string | null {
	const error = getQueryParam(url, 'error');
	const description = getQueryParam(url, 'error_description');
	if (description) return description;
	if (error) return error;
	return null;
}

async function handleAuthResult(location: string, redirectUri: string): Promise<void> {
	const errorCode = getQueryParam(location, 'error');
	if (errorCode) {
		if (errorCode !== 'access_denied') {
			toasts.showToast({ title: 'Translate', content: getOAuthError(location) ?? errorCode });
		}
		return;
	}

	if (!location.startsWith(redirectUri)) return;

	const code = getQueryParam(location, 'code');
	const state = getQueryParam(location, 'state');
	if (!code || !state) return;

	try {
		const result = await fetch(location, {
			headers: { Accept: 'application/json' },
		});
		const raw = await result.text();
		let payload: {
			accessToken?: unknown;
			refreshToken?: unknown;
			expiresIn?: unknown;
			error?: unknown;
		} | null = null;

		try {
			payload = JSON.parse(raw) as {
				accessToken?: unknown;
				refreshToken?: unknown;
				expiresIn?: unknown;
				error?: unknown;
			};
		} catch {
			if (!result.ok) {
				throw new Error(raw.trim() || 'Discord login failed.');
			}
			throw new Error('Discord login returned an invalid payload.');
		}

		if (!result.ok) {
			throw new Error(typeof payload?.error === 'string' ? payload.error : 'Discord login failed.');
		}

		if (
			typeof payload?.accessToken !== 'string' ||
			typeof payload?.refreshToken !== 'string' ||
			typeof payload?.expiresIn !== 'number'
		) {
			throw new Error('Discord login returned an invalid payload.');
		}

		storeSessionTokens({
			accessToken: payload.accessToken,
			refreshToken: payload.refreshToken,
			expiresAt: Date.now() + payload.expiresIn * 1000,
		});
		toasts.showToast({ title: 'Translate', content: 'Discord login completed.' });
	} catch (error) {
		toasts.showToast({
			title: 'Translate',
			content: error instanceof Error ? error.message : String(error),
		});
	}
}

export function openDiscordLoginFlow(): void {
	if (typeof metro?.findByProps !== 'function') {
		toasts.showToast({ title: 'Translate', content: 'OAuth is unavailable.' });
		return;
	}

	void (async () => {
		try {
			const modals = metro.findByProps('pushModal', 'popModal') as
				| {
					pushModal?: (options: { key: string; modal: any; closable?: boolean }) => void;
					popModal?: (key: string) => void;
				}
				| null;
			const OAuth2AuthorizeModal = findOAuth2AuthorizeModal();

			if (!modals?.pushModal || !modals?.popModal || !OAuth2AuthorizeModal) {
				toasts.showToast({ title: 'Translate', content: 'OAuth modal is unavailable.' });
				return;
			}

			const response = await fetch(`${getApiBaseUrlSetting()}/auth/login`, {
				method: 'GET',
				redirect: 'manual' as any,
			} as any);
			const authorizeUrl =
				typeof response.headers?.get === 'function' ? (response.headers.get('location') ?? response.url) : response.url;
			const clientId = getQueryParam(authorizeUrl, 'client_id');
			const redirectUri = `${getApiBaseUrlSetting()}/auth/callback`;

			if (!clientId) {
				toasts.showToast({ title: 'Translate', content: 'OAuth configuration is incomplete.' });
				return;
			}

			const key = 'unbound-translate-oauth2-authorize';

			modals.pushModal({
				key,
				closable: true,
				modal: {
					key,
					modal: OAuth2AuthorizeModal,
					animation: 'slide-up',
					shouldPersistUnderModals: false,
					props: {
						clientId,
						redirectUri,
						scopes: ['identify', 'email', 'guilds'],
						responseType: 'code',
						permissions: 0n,
						cancelCompletesFlow: false,
						callback: ({ location }: { location?: string | null }) => {
							if (!location) return;
							void handleAuthResult(location, redirectUri);
						},
						dismissOAuthModal: () => modals.popModal?.(key),
					},
				},
			});
		} catch (error) {
			toasts.showToast({
				title: 'Translate',
				content: error instanceof Error ? error.message : 'Connect flow failed unexpectedly.',
			});
		}
	})();
}
