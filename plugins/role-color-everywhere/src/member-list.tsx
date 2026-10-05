import {
	getRoleColorAppearance,
	roleColorAt,
	type RoleColorAppearance,
	type RoleColorStops,
} from '@shared/role-colors';
import { metro, patcher } from '@unbound-app/api';

const USER_LIST_PATH = 'modules/main_tabs_v2/native/shared_components/user_list/UsersFastList.tsx';

interface Role {
	name?: string;
	colorString?: string | null;
	colorStrings?: RoleColorStops | null;
}

interface RoleStore {
	getUnsafeMutableRoles(guildId: string): Record<string, Role> | null | undefined;
}

interface UserListProps {
	getItemProps?: (section: number, index: number) => { props?: { guildId?: string } };
	getSectionProps?: (section: number) => { props?: { title?: string } };
	sections?: number[];
}

function roleHeaderAppearance(
	props: UserListProps,
	section: number,
	roles: RoleStore,
): RoleColorAppearance | null {
	const title = props.getSectionProps?.(section)?.props?.title;
	const guildId = props.getItemProps?.(section, 0)?.props?.guildId;
	if (typeof title !== 'string' || !guildId) return null;
	const roleName = /^(.*) — \d+$/.exec(title)?.[1];
	if (!roleName) return null;
	const matching = Object.values(roles.getUnsafeMutableRoles(guildId) ?? {}).filter(
		(role) => role.name === roleName,
	);
	if (matching.length !== 1) return null;
	const appearance = getRoleColorAppearance(matching[0].colorStrings, matching[0].colorString);
	return appearance.colors.length ? appearance : null;
}

export function installMemberListColors(roles: RoleStore, enabled: () => boolean): () => void {
	const listModule = metro.findByFilePath(USER_LIST_PATH, { interop: false }) as {
		UsersFastList?: { render: (props: UserListProps) => any };
	} | null;
	const list = listModule?.UsersFastList;
	if (typeof list?.render !== 'function') return () => {};

	return patcher.after(list, 'render', ({ args, result }) => {
		if (!enabled()) return;
		const props = args[0] as UserListProps;
		const renderHeader = result?.props?.renderSectionHeader;
		if (typeof renderHeader !== 'function' || !props.getSectionProps || !props.getItemProps) return;
		const { React, ReactNative } = metro.common;
		return React.cloneElement(result, {
			renderSectionHeader: (section: number, ...rest: unknown[]) => {
				const header = renderHeader(section, ...rest);
				const appearance = roleHeaderAppearance(props, section, roles);
				if (!appearance || typeof header?.props?.title !== 'string') return header;
				const title = header.props.title as string;
				const characters = Array.from(title);
				const content =
					appearance.colors.length === 1
						? title
						: characters.map((character, index) => (
								<ReactNative.Text
									key={index}
									style={{
										color:
											roleColorAt(
												appearance.colors,
												characters.length === 1 ? 0 : index / (characters.length - 1),
											) ?? appearance.colors[0],
									}}
								>
									{character}
								</ReactNative.Text>
							));
				return React.cloneElement(header, {
					title: (
						<ReactNative.Text style={{ color: appearance.colors[0] }}>{content}</ReactNative.Text>
					),
				});
			},
		});
	});
}
