import { useRef } from 'react';

import { metro } from '@unbound-app/api';

type DiscordAuthSheetProps = {
	authorizeUrl: string;
	redirectUri: string;
	onResult: (location: string) => void;
	onClose: () => void;
};

type NavigationEvent = { url?: string };

function getWebViewComponent(): any | null {
	if (typeof metro?.findByProps === 'function') {
		const byProp = metro.findByProps('WebView') as { WebView?: unknown } | null;
		if (byProp?.WebView) return byProp.WebView;
	}

	if (typeof metro?.findByName === 'function') {
		return metro.findByName('WebView') as unknown;
	}

	return null;
}

function getDesignModule(): { ActionSheet?: any } | null {
	const discord = (metro as { components?: { Discord?: unknown } } | undefined)?.components?.Discord as
		| { ActionSheet?: any }
		| undefined;
	if (discord?.ActionSheet) return discord;

	if (typeof metro?.findByProps === 'function') {
		const found = metro.findByProps('ActionSheet') as { ActionSheet?: any } | null;
		if (found?.ActionSheet) return found;
	}

	return null;
}

function DiscordAuthSheet({ authorizeUrl, redirectUri, onResult, onClose }: DiscordAuthSheetProps) {
	const ReactNative = metro.common.ReactNative;
	const Discord = getDesignModule();
	const WebView = getWebViewComponent();
	const settledRef = useRef(false);

	function handleNavigation(url: string | undefined): boolean {
		if (!url || settledRef.current) return true;
		if (!url.startsWith(redirectUri)) return true;

		settledRef.current = true;
		onResult(url);
		onClose();
		return false;
	}

	const content = !WebView ? (
		<ReactNative.View style={{ padding: 16 }}>
			<ReactNative.Text>Login is unavailable on this client build.</ReactNative.Text>
		</ReactNative.View>
	) : (
		<ReactNative.View style={{ height: 560 }}>
			<WebView
				source={{ uri: authorizeUrl }}
				startInLoadingState
				onShouldStartLoadWithRequest={(request: NavigationEvent) => handleNavigation(request.url)}
				onNavigationStateChange={(state: NavigationEvent) => handleNavigation(state.url)}
			/>
		</ReactNative.View>
	);

	if (!Discord?.ActionSheet) {
		return content;
	}

	return <Discord.ActionSheet>{content}</Discord.ActionSheet>;
}

export default DiscordAuthSheet;
