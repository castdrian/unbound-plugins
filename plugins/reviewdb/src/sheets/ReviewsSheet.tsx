import { useCallback, useEffect, useState } from 'react';

import { metro, storage } from '@unbound-app/api';

import { addReview, getReviews, REVIEWS_PER_PAGE, type UserReviewsData } from '@reviewdb/api';
import { authorize } from '@reviewdb/auth';
import { getCurrentUserId, isRelationshipBlocked, showToast } from '@reviewdb/utils';

import ReviewItem from '@reviewdb/sheets/ReviewItem';

const STORE = storage.getStore('unbound.reviewdb');

function getDesignModule(): {
	ActionSheet?: any;
	Text?: any;
	TextArea?: any;
	Button?: any;
	RowButton?: any;
} | null {
	const discord = (metro as { components?: { Discord?: unknown } } | undefined)?.components?.Discord as
		| { ActionSheet?: any; Text?: any; TextArea?: any; Button?: any; RowButton?: any }
		| undefined;
	if (discord?.ActionSheet && discord?.TextArea && discord?.Button) return discord;

	if (typeof metro?.findByProps === 'function') {
		const found = metro.findByProps('ActionSheet', 'TextArea', 'Button') as
			| { ActionSheet?: any; Text?: any; TextArea?: any; Button?: any; RowButton?: any }
			| null;
		if (found?.ActionSheet && found?.TextArea && found?.Button) return found;
	}

	return null;
}

function ReviewsSheet({ discordId, name, onClose }: { discordId: string; name: string; onClose(): void }) {
	const ReactNative = metro.common.ReactNative;
	const Discord = getDesignModule();
	const [data, setData] = useState<UserReviewsData | null>(null);
	const [loading, setLoading] = useState(true);
	const [comment, setComment] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const state = STORE.useSettingsStore();

	const myId = getCurrentUserId();
	const hideTimestamps = state.get('hideTimestamps', false);
	const hideBlockedUsers = state.get('hideBlockedUsers', true);
	const showWarning = state.get('showWarning', true);

	const load = useCallback(
		async (offset: number, append: boolean) => {
			setLoading(true);
			const result = await getReviews(discordId, { offset, limit: REVIEWS_PER_PAGE, fetchVotes: true });
			setData((previous) => (append && previous ? { ...result, reviews: [...previous.reviews, ...result.reviews] } : result));
			setLoading(false);
		},
		[discordId],
	);

	useEffect(() => {
		void load(0, false);
	}, [load]);

	function refetch() {
		void load(0, false);
	}

	const visibleReviews = (data?.reviews ?? []).filter((review) => !hideBlockedUsers || !isRelationshipBlocked(review.sender.discordID));
	const ownReview = visibleReviews.find((review) => review.sender.discordID === myId);
	const isOwnProfile = myId != null && discordId === myId;
	const authorized = !!state.get('token', '');

	async function submit() {
		const trimmed = comment.trim();
		if (!trimmed) return;

		setSubmitting(true);
		try {
			const result = await addReview({ userid: discordId, comment: trimmed });
			if (result) {
				setComment('');
				refetch();
			}
		} finally {
			setSubmitting(false);
		}
	}

	if (!Discord?.ActionSheet) {
		return (
			<ReactNative.View style={{ padding: 16 }}>
				<ReactNative.Text>Reviews are unavailable on this client build.</ReactNative.Text>
			</ReactNative.View>
		);
	}

	return (
		<Discord.ActionSheet>
			<Discord.Text variant="heading-lg/semibold" style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 2 }}>
				{name}'s Reviews{data?.reviewCount ? ` (${data.reviewCount})` : ''}
			</Discord.Text>

			{showWarning && (
				<Discord.Text variant="text-xs/medium" color="text-muted" style={{ paddingHorizontal: 16, paddingBottom: 4 }}>
					Please be respectful. Reviews are public and can be reported.
				</Discord.Text>
			)}

			<ReactNative.View>
				{visibleReviews.map((review) => (
					<ReviewItem key={review.id} review={review} profileId={discordId} hideTimestamps={hideTimestamps} onChanged={refetch} />
				))}

				{!loading && visibleReviews.length === 0 && (
					<Discord.Text style={{ padding: 12 }} color="text-muted">
						No reviews yet. Be the first!
					</Discord.Text>
				)}

				{loading && (
					<ReactNative.View style={{ padding: 12, alignItems: 'center' }}>
						<ReactNative.ActivityIndicator />
					</ReactNative.View>
				)}

				{data?.hasNextPage && !loading && (
					<ReactNative.Pressable style={{ padding: 12, alignItems: 'center' }} onPress={() => load(data.reviews.length, true)}>
						<Discord.Text variant="text-sm/semibold" color="text-link">
							Load more
						</Discord.Text>
					</ReactNative.Pressable>
				)}
			</ReactNative.View>

			{!isOwnProfile && authorized && (
				<ReactNative.View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12, gap: 8 }}>
					<Discord.TextArea
						placeholder={ownReview ? `Update review for @${name}` : `Review @${name}`}
						value={comment}
						onChange={setComment}
						maxLength={1000}
					/>
					<Discord.Button
						text={ownReview ? 'Update Review' : 'Submit Review'}
						loading={submitting}
						disabled={!comment.trim()}
						onPress={() => void submit()}
					/>
				</ReactNative.View>
			)}

			{!isOwnProfile && !authorized && (
				<ReactNative.Pressable
					style={{ flexDirection: 'row', justifyContent: 'center', paddingVertical: 10, paddingBottom: 14 }}
					onPress={() => {
						onClose();
						authorize(() => openReviewsSheet(discordId, name));
					}}
				>
					<Discord.Text variant="text-sm/semibold" color="text-link">
						Sign in to leave a review
					</Discord.Text>
				</ReactNative.Pressable>
			)}
		</Discord.ActionSheet>
	);
}

export function openReviewsSheet(discordId: string, name: string): void {
	if (typeof metro?.findByProps !== 'function') return;

	const sheets = metro.findByProps('openLazy', 'hideActionSheet') as
		| { openLazy?: (...args: unknown[]) => unknown; hideActionSheet?: (key: string) => void }
		| null;
	if (!sheets?.openLazy) {
		showToast('Reviews are unavailable on this client build.');
		return;
	}

	const key = `unbound-reviewdb-${discordId}-${Date.now()}`;

	sheets.openLazy(Promise.resolve({ default: ReviewsSheet }), key, {
		discordId,
		name,
		onClose: () => sheets.hideActionSheet?.(key),
	});
}

export default ReviewsSheet;
