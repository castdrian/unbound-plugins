import { useEffect, useMemo, useState } from 'react';

import { metro } from '@unbound-app/api';

import { listLanguages, type TranslationLanguage } from '../api';

type LanguagePickerSheetProps = {
	title: string;
	includeAuto?: boolean;
	current: string;
	onSelect: (code: string) => void;
	onClose: () => void;
};

function languageLabel(language: TranslationLanguage): string {
	return language.nativeName && language.nativeName !== language.name
		? `${language.name} (${language.nativeName})`
		: language.name;
}

function LanguagePickerSheet({ title, includeAuto, current, onSelect, onClose }: LanguagePickerSheetProps) {
	const ReactNative = metro.common.ReactNative;
	const Discord = metro.components.Discord;
	const [query, setQuery] = useState('');
	const [languages, setLanguages] = useState<TranslationLanguage[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			try {
				const loaded = await listLanguages();
				if (!cancelled) setLanguages(loaded);
			} catch (err) {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	const rows = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		const matches = languages.filter((language) => {
			if (!normalizedQuery) return true;
			return (
				language.code.toLowerCase().includes(normalizedQuery) ||
				language.name.toLowerCase().includes(normalizedQuery) ||
				language.nativeName?.toLowerCase().includes(normalizedQuery)
			);
		});

		return includeAuto
			? [{ code: 'auto', name: 'Auto detect' } as TranslationLanguage, ...matches]
			: matches;
	}, [includeAuto, languages, query]);

	function choose(code: string) {
		onSelect(code);
		onClose();
	}

	return (
		<Discord.ActionSheet>
			<Discord.TextField
				size="md"
				value={query}
				onChange={setQuery}
				isClearable
				isRound
				placeholder={title}
			/>
			{error ? <Discord.ActionSheetRow label={error} onPress={onClose} /> : null}
			{rows.map((language) => (
				<Discord.ActionSheetRow
					key={language.code}
					label={language.code === 'auto' ? 'Auto detect' : languageLabel(language)}
					subLabel={language.code === current ? `${language.code} • current` : language.code}
					onPress={() => choose(language.code)}
				/>
			))}
			{!error && rows.length === 0 ? <Discord.ActionSheetRow label="No matches" onPress={onClose} /> : null}
		</Discord.ActionSheet>
	);
}

export default LanguagePickerSheet;
