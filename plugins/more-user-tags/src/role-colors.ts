export interface RoleColorStops {
	primaryColor: string;
	secondaryColor?: string;
	tertiaryColor?: string;
}

function validHexColor(color: unknown): color is string {
	return typeof color === 'string' && /^#[\da-f]{6}$/i.test(color);
}

export function getRoleColorStops(
	colors: RoleColorStops | null | undefined,
	fallbackColor: unknown,
	includeEnhanced: boolean = true,
): string[] {
	const primary = validHexColor(colors?.primaryColor) ? colors.primaryColor : fallbackColor;
	if (!validHexColor(primary)) return [];
	if (!includeEnhanced) return [primary];

	return [primary, colors?.secondaryColor, colors?.tertiaryColor].filter(
		(color, index, stops): color is string =>
			validHexColor(color) && stops.indexOf(color) === index,
	);
}

function relativeLuminance(color: string): number {
	const value = Number.parseInt(color.slice(1), 16);
	const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map((channel) => {
		const normalized = channel / 255;
		return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	});

	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

export function getContrastingTextColor(backgrounds: string[]): string {
	if (backgrounds.length === 0) return '#ffffff';

	const luminances = backgrounds.map(relativeLuminance);
	const whiteContrast = Math.min(...luminances.map((luminance) => 1.05 / (luminance + 0.05)));
	const blackContrast = Math.min(...luminances.map((luminance) => (luminance + 0.05) / 0.05));

	return blackContrast > whiteContrast ? '#000000' : '#ffffff';
}
