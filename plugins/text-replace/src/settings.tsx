import { useState } from 'react';

import { metro, storage } from '@unbound-app/api';

import { applyRules, createRule, normalizeRules, type TextReplaceRule } from '@text-replace/rules';

const STORE = storage.getStore('unbound.text-replace');

type RuleKind = 'stringRules' | 'regexRules';
type RuleField = 'find' | 'replace' | 'onlyIfIncludes';

function getRules(kind: RuleKind): TextReplaceRule[] {
	return normalizeRules(STORE.get(kind, []));
}

function saveRules(kind: RuleKind, rules: TextReplaceRule[]): void {
	STORE.set(kind, rules.length ? rules : [createRule()]);
}

function RuleInput({
	label,
	value,
	placeholder,
	onChange,
}: {
	label: string;
	value: string;
	placeholder: string;
	onChange: (value: string) => void;
}) {
	const { ReactNative } = metro.common;
	const colors = (metro.common.Theme as any)?.colors ?? {};

	return (
		<ReactNative.View style={{ gap: 6 }}>
			<ReactNative.Text style={{ color: colors.HEADER_PRIMARY ?? '#f2f3f5', fontSize: 14, fontWeight: '600' }}>
				{label}
			</ReactNative.Text>
			<ReactNative.TextInput
				autoCapitalize='none'
				autoCorrect={false}
				multiline={label === 'Replace'}
				placeholder={placeholder}
				placeholderTextColor={colors.TEXT_MUTED ?? '#949ba4'}
				style={{
					backgroundColor: colors.BACKGROUND_SECONDARY ?? '#2b2d31',
					borderColor: colors.BACKGROUND_MODIFIER_ACCENT ?? '#4e5058',
					borderRadius: 8,
					borderWidth: 1,
					color: colors.TEXT_NORMAL ?? '#dbdee1',
					minHeight: label === 'Replace' ? 64 : 40,
					paddingHorizontal: 12,
					paddingVertical: 10,
					textAlignVertical: 'top',
				}}
				value={value}
				onChangeText={onChange}
			/>
		</ReactNative.View>
	);
}

function RuleEditor({
	rule,
	index,
	isRegex,
	onChange,
	onDelete,
}: {
	rule: TextReplaceRule;
	index: number;
	isRegex: boolean;
	onChange: (field: RuleField, value: string) => void;
	onDelete: () => void;
}) {
	const { ReactNative } = metro.common;
	const colors = (metro.common.Theme as any)?.colors ?? {};

	return (
		<ReactNative.View
			style={{
				backgroundColor: colors.BACKGROUND_SECONDARY_ALT ?? '#1e1f22',
				borderRadius: 12,
				gap: 12,
				padding: 14,
			}}
		>
			<ReactNative.Text style={{ color: colors.HEADER_PRIMARY ?? '#f2f3f5', fontSize: 16, fontWeight: '700' }}>
				{rule.find ? `Rule ${index + 1} — ${rule.find}` : `Empty Rule ${index + 1}`}
			</ReactNative.Text>
			<RuleInput
				label='Find'
				placeholder={isRegex ? '/pattern/gi' : 'Text to replace'}
				value={rule.find}
				onChange={(value) => onChange('find', value)}
			/>
			<RuleInput
				label='Replace'
				placeholder='Replacement text; use \\n for a new line'
				value={rule.replace}
				onChange={(value) => onChange('replace', value)}
			/>
			<RuleInput
				label='Only If Message Includes'
				placeholder='Optional condition'
				value={rule.onlyIfIncludes}
				onChange={(value) => onChange('onlyIfIncludes', value)}
			/>
			<ReactNative.Pressable
				onPress={onDelete}
				style={({ pressed }: { pressed: boolean }) => ({
					alignItems: 'center',
					backgroundColor: colors.BUTTON_DANGER_BACKGROUND ?? '#da373c',
					borderRadius: 8,
					opacity: pressed ? 0.7 : 1,
					paddingVertical: 10,
				})}
			>
				<ReactNative.Text style={{ color: colors.TEXT_NORMAL ?? '#ffffff', fontWeight: '700' }}>
					Delete Rule
				</ReactNative.Text>
			</ReactNative.Pressable>
		</ReactNative.View>
	);
}

function RulesSection({
	title,
	description,
	kind,
	isRegex,
	onChange,
}: {
	title: string;
	description: string;
	kind: RuleKind;
	isRegex: boolean;
	onChange: () => void;
}) {
	const { ReactNative } = metro.common;
	const colors = (metro.common.Theme as any)?.colors ?? {};
	const rules = getRules(kind);

	function updateRule(index: number, field: RuleField, value: string): void {
		const nextRules = rules.map((rule, ruleIndex) =>
			ruleIndex === index ? { ...rule, [field]: value } : rule,
		);
		const updatedRule = nextRules[index];

		if (
			index !== nextRules.length - 1 &&
			!updatedRule.find &&
			!updatedRule.replace &&
			!updatedRule.onlyIfIncludes
		) {
			nextRules.splice(index, 1);
		}

		saveRules(kind, nextRules);
		onChange();
	}

	function deleteRule(index: number): void {
		const nextRules = rules.filter((_rule, ruleIndex) => ruleIndex !== index);
		saveRules(kind, nextRules);
		onChange();
	}

	function addRule(): void {
		if (!rules[rules.length - 1]?.find) return;
		saveRules(kind, [...rules, createRule()]);
		onChange();
	}

	return (
		<ReactNative.View style={{ gap: 10 }}>
			<ReactNative.Text style={{ color: colors.HEADER_PRIMARY ?? '#f2f3f5', fontSize: 20, fontWeight: '800' }}>
				{title}
			</ReactNative.Text>
			<ReactNative.Text style={{ color: colors.TEXT_MUTED ?? '#949ba4', fontSize: 14, lineHeight: 20 }}>
				{description}
			</ReactNative.Text>
			{rules.map((rule, index) => (
				<RuleEditor
					key={rule.id}
					rule={rule}
					index={index}
					isRegex={isRegex}
					onChange={(field, value) => updateRule(index, field, value)}
					onDelete={() => deleteRule(index)}
				/>
			))}
			<ReactNative.Pressable
				disabled={!rules[rules.length - 1]?.find}
				onPress={addRule}
				style={({ pressed }: { pressed: boolean }) => ({
					alignItems: 'center',
					backgroundColor: colors.BUTTON_SECONDARY_BACKGROUND ?? '#4e5058',
					borderRadius: 8,
					opacity: !rules[rules.length - 1]?.find || pressed ? 0.55 : 1,
					paddingVertical: 10,
				})}
			>
				<ReactNative.Text style={{ color: colors.TEXT_NORMAL ?? '#ffffff', fontWeight: '700' }}>
					Add Rule
				</ReactNative.Text>
			</ReactNative.Pressable>
		</ReactNative.View>
	);
}

export function TextReplaceSettingsScreen() {
	const { ReactNative } = metro.common;
	const colors = (metro.common.Theme as any)?.colors ?? {};
	const [, setRevision] = useState(0);
	const [example, setExample] = useState('');
	const output = applyRules(example, getRules('stringRules'), getRules('regexRules'));

	return (
		<ReactNative.ScrollView contentContainerStyle={{ gap: 24, padding: 16 }}>
			<ReactNative.View style={{ gap: 8 }}>
				<ReactNative.Text style={{ color: colors.HEADER_PRIMARY ?? '#f2f3f5', fontSize: 22, fontWeight: '800' }}>
					TextReplace
				</ReactNative.Text>
				<ReactNative.Text style={{ color: colors.TEXT_MUTED ?? '#949ba4', fontSize: 14, lineHeight: 20 }}>
					Replace text in messages before you send them.
				</ReactNative.Text>
			</ReactNative.View>
			<RulesSection
				title='Text Rules'
				description='Replace literal text everywhere it appears in a message.'
				kind='stringRules'
				isRegex={false}
				onChange={() => setRevision((value) => value + 1)}
			/>
			<RulesSection
				title='Regex Rules'
				description='Use JavaScript regexes such as /hello/gi. Invalid regexes are ignored.'
				kind='regexRules'
				isRegex
				onChange={() => setRevision((value) => value + 1)}
			/>
			<ReactNative.View style={{ gap: 10 }}>
				<ReactNative.Text style={{ color: colors.HEADER_PRIMARY ?? '#f2f3f5', fontSize: 20, fontWeight: '800' }}>
					Rule Tester
				</ReactNative.Text>
				<RuleInput label='Message' placeholder='Type a message to test your rules' value={example} onChange={setExample} />
				<ReactNative.View style={{ backgroundColor: colors.BACKGROUND_SECONDARY_ALT ?? '#1e1f22', borderRadius: 12, gap: 6, padding: 14 }}>
					<ReactNative.Text style={{ color: colors.TEXT_MUTED ?? '#949ba4', fontSize: 14, fontWeight: '600' }}>
						Output
					</ReactNative.Text>
					<ReactNative.Text style={{ color: colors.TEXT_NORMAL ?? '#dbdee1', fontSize: 16 }}>
						{output || 'Your transformed message appears here.'}
					</ReactNative.Text>
				</ReactNative.View>
			</ReactNative.View>
		</ReactNative.ScrollView>
	);
}
