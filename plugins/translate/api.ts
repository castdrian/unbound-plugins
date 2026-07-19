import { storage } from '@unbound-app/api';

export const PATCHER_ID = 'unbound.translate';
export const DEFAULT_API_BASE_URL = 'https://translate.unbound.rip';
export const DEFAULT_TARGET_LANGUAGE = 'en';
export const DEFAULT_SOURCE_LANGUAGE = 'auto';

const STORE = storage.getStore(PATCHER_ID);
const TOKEN_SKEW_MS = 15_000;
const LANGUAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type SessionTokens = {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
};

export type TranslationLanguage = {
	code: string;
	name: string;
	nativeName?: string;
};

type TranslationResponse =
	| { translatedText?: string }
	| { translations?: Array<{ text?: string; translatedText?: string }> };

let cachedLanguages: TranslationLanguage[] | null = null;
let cachedLanguagesAt = 0;
let pendingLanguages: Promise<TranslationLanguage[]> | null = null;

function getApiBaseUrl(): string {
	return STORE.get('apiBaseUrl', DEFAULT_API_BASE_URL);
}

function readTokens(): SessionTokens | null {
	const accessToken = STORE.get('accessToken', '');
	const refreshToken = STORE.get('refreshToken', '');
	const expiresAt = STORE.get('expiresAt', 0);

	if (!accessToken || !refreshToken || !expiresAt) return null;

	return { accessToken, refreshToken, expiresAt };
}

function writeTokens(tokens: SessionTokens): void {
	STORE.set('accessToken', tokens.accessToken);
	STORE.set('refreshToken', tokens.refreshToken);
	STORE.set('expiresAt', tokens.expiresAt);
}

export function clearTokens(): void {
	STORE.remove('accessToken');
	STORE.remove('refreshToken');
	STORE.remove('expiresAt');
}

export function getSourceLanguage(): string {
	return STORE.get('sourceLanguage', DEFAULT_SOURCE_LANGUAGE);
}

export function getTargetLanguage(): string {
	return STORE.get('targetLanguage', DEFAULT_TARGET_LANGUAGE);
}

export function setSourceLanguage(code: string): void {
	STORE.set('sourceLanguage', code);
}

export function setTargetLanguage(code: string): void {
	STORE.set('targetLanguage', code);
}

export function getApiBaseUrlSetting(): string {
	return STORE.get('apiBaseUrl', DEFAULT_API_BASE_URL);
}

export function setApiBaseUrl(url: string): void {
	STORE.set('apiBaseUrl', url.trim() || DEFAULT_API_BASE_URL);
}

async function refreshSessionTokens(): Promise<SessionTokens> {
	const refreshToken = STORE.get('refreshToken', '');

	if (!refreshToken) {
		throw new Error('No refresh token configured. Open plugin settings and complete login.');
	}

	const response = await fetch(`${getApiBaseUrl()}/auth/refresh`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ refreshToken }),
	});

	if (!response.ok) {
		if (response.status === 401) clearTokens();
		const reason = await response.text().catch(() => 'refresh failed');
		throw new Error(`Auth refresh failed (${response.status}): ${reason}`);
	}

	const data = (await response.json()) as {
		accessToken?: string;
		refreshToken?: string;
		expiresIn?: number;
	};

	if (!data.accessToken || !data.refreshToken || typeof data.expiresIn !== 'number') {
		throw new Error('Auth refresh returned an invalid payload.');
	}

	const next: SessionTokens = {
		accessToken: data.accessToken,
		refreshToken: data.refreshToken,
		expiresAt: Date.now() + data.expiresIn * 1000,
	};

	writeTokens(next);
	return next;
}

async function getValidAccessToken(): Promise<string> {
	const current = readTokens();
	if (current && current.expiresAt - TOKEN_SKEW_MS > Date.now()) {
		return current.accessToken;
	}

	const refreshed = await refreshSessionTokens();
	return refreshed.accessToken;
}

export async function listLanguages(force = false): Promise<TranslationLanguage[]> {
	const isFresh = cachedLanguages && Date.now() - cachedLanguagesAt < LANGUAGE_CACHE_TTL_MS;
	if (!force && isFresh && cachedLanguages) return cachedLanguages;
	if (pendingLanguages) return pendingLanguages;

	pendingLanguages = (async () => {
		const response = await fetch(`${getApiBaseUrl()}/languages`);
		if (!response.ok) {
			const reason = await response.text().catch(() => 'failed to load languages');
			throw new Error(`Language lookup failed (${response.status}): ${reason}`);
		}

		const data = (await response.json()) as unknown;
		if (!Array.isArray(data)) {
			throw new Error('Language lookup returned an invalid payload.');
		}

		const languages = data
			.map((entry): TranslationLanguage | null => {
				if (!entry || typeof entry !== 'object') return null;
				const code = (entry as { code?: unknown }).code;
				const name = (entry as { name?: unknown }).name;
				const nativeName = (entry as { nativeName?: unknown }).nativeName;

				if (typeof code !== 'string' || typeof name !== 'string') return null;

				return {
					code,
					name,
					nativeName: typeof nativeName === 'string' ? nativeName : undefined,
				};
			})
			.filter((entry): entry is TranslationLanguage => entry !== null)
			.sort((left, right) => left.name.localeCompare(right.name));

		cachedLanguages = languages;
		cachedLanguagesAt = Date.now();
		return languages;
	})().finally(() => {
		pendingLanguages = null;
	});

	return pendingLanguages;
}

export async function translateText(text: string): Promise<string> {
	if (!text.trim()) {
		throw new Error('Message is empty.');
	}

	const requestBody = {
		q: text,
		source: getSourceLanguage(),
		target: getTargetLanguage(),
	};

	const requestOnce = async (token: string) =>
		fetch(`${getApiBaseUrl()}/translate`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(requestBody),
		});

	let token = await getValidAccessToken();
	let response = await requestOnce(token);

	if (response.status === 401) {
		token = (await refreshSessionTokens()).accessToken;
		response = await requestOnce(token);
	}

	if (!response.ok) {
		const reason = await response.text().catch(() => 'translation failed');
		throw new Error(`Translate failed (${response.status}): ${reason}`);
	}

	const data = (await response.json()) as TranslationResponse;

	if ('translatedText' in data && typeof data.translatedText === 'string') {
		return data.translatedText;
	}

	if ('translations' in data && Array.isArray(data.translations) && data.translations.length > 0) {
		const first = data.translations[0];
		if (typeof first?.translatedText === 'string') return first.translatedText;
		if (typeof first?.text === 'string') return first.text;
	}

	throw new Error('Translation API returned an unexpected payload.');
}
