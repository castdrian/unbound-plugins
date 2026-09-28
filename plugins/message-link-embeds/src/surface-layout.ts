export interface SurfaceLayoutMetrics {
	contentHeight: number;
	viewportHeight: number;
	offsetX: number;
	offsetY: number;
	topInset: number;
	bottomInset: number;
	inverted: boolean;
}

export interface BottomAnchor {
	atBottom: boolean;
	inverted: boolean;
	x: number;
	y: number;
}

export interface ScrollOffset {
	x: number;
	y: number;
}

export class BottomAnchorTracker {
	private anchor: BottomAnchor | undefined;

	get pending(): boolean {
		return this.anchor !== undefined;
	}

	capture(anchor: BottomAnchor | null): void {
		if (!anchor?.atBottom || this.anchor) return;
		this.anchor = anchor;
	}

	correction(metrics: SurfaceLayoutMetrics, userIsScrolling: boolean): ScrollOffset | undefined {
		if (!this.anchor) return;
		if (userIsScrolling) {
			this.clear();
			return;
		}

		const correction = bottomOffsetCorrection(this.anchor, metrics, false);
		if (correction) this.clear();
		return correction;
	}

	clear(): void {
		this.anchor = undefined;
	}
}

export function readBottomAnchor(
	metrics: SurfaceLayoutMetrics,
	tolerance: number = 36,
): BottomAnchor {
	const targetOffset = bottomOffset(metrics);
	const atBottom =
		Number.isFinite(targetOffset) &&
		Number.isFinite(metrics.offsetY) &&
		Math.abs(targetOffset - metrics.offsetY) <=
			Math.max(tolerance, metrics.topInset + metrics.bottomInset);

	return {
		atBottom,
		inverted: metrics.inverted,
		x: Number.isFinite(metrics.offsetX) ? metrics.offsetX : 0,
		y: Number.isFinite(metrics.offsetY) ? metrics.offsetY : 0,
	};
}

export function readSurfaceAnchor(
	metrics: SurfaceLayoutMetrics,
	followsLatestMessage: boolean,
	tolerance: number = 36,
): BottomAnchor {
	const anchor = readBottomAnchor(metrics, tolerance);
	if (followsLatestMessage) anchor.atBottom = true;
	return anchor;
}

export function bottomOffsetCorrection(
	anchor: BottomAnchor,
	metrics: SurfaceLayoutMetrics,
	userIsScrolling: boolean,
): ScrollOffset | undefined {
	if (!anchor.atBottom || userIsScrolling) return;

	const targetOffset = bottomOffset(metrics);
	if (!Number.isFinite(targetOffset) || !Number.isFinite(metrics.offsetY)) return;
	if (Math.abs(targetOffset - metrics.offsetY) <= 1) return;

	return { x: anchor.x, y: targetOffset };
}

export function surfaceHeightCacheKey(channelId: string, messageId: string, width: number): string {
	return `${channelId}:${messageId}:${Math.round(width)}`;
}

export function shouldRefreshSurfaceRow(
	force: boolean,
	lastInvalidatedHeight: number,
	height: number,
): boolean {
	return force || lastInvalidatedHeight !== height;
}

export class SurfaceHeightCache {
	private values = new Map<string, number>();

	constructor(private readonly limit: number = 128) {}

	get(key: string, fallback: number): number {
		const height = this.values.get(key);
		if (height === undefined) return fallback;

		this.values.delete(key);
		this.values.set(key, height);
		return height;
	}

	set(key: string, height: number): void {
		if (!Number.isFinite(height) || height <= 0) return;

		this.values.delete(key);
		this.values.set(key, height);
		if (this.values.size > this.limit) {
			const oldest = this.values.keys().next().value;
			if (oldest !== undefined) this.values.delete(oldest);
		}
	}

	clear(): void {
		this.values.clear();
	}
}

function bottomOffset(metrics: SurfaceLayoutMetrics): number {
	const maximumOffset = metrics.contentHeight - metrics.viewportHeight + metrics.bottomInset;
	return metrics.inverted ? -metrics.topInset : Math.max(-metrics.topInset, maximumOffset);
}
