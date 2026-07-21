import { useState } from 'react';

import { metro } from '@unbound-app/api';

import { blockUser, deleteReview, deleteReviewVote, reportReview, unblockUser, voteReview } from '@reviewdb/api';
import { getCurrentUser } from '@reviewdb/auth';
import { ReviewType, type Review } from '@reviewdb/entities';
import { canBlockReviewAuthor, canDeleteReview, canReportReview, getCurrentUserId, showToast } from '@reviewdb/utils';

function getDesignModule(): { Text?: any; Card?: any } | null {
	const discord = (metro as { components?: { Discord?: unknown } } | undefined)?.components?.Discord as
		| { Text?: any; Card?: any }
		| undefined;
	if (discord?.Text) return discord;

	if (typeof metro?.findByProps === 'function') {
		const found = metro.findByProps('Text', 'Heading') as { Text?: any; Card?: any } | null;
		if (found?.Text) return found;
	}

	return null;
}

function Tag({ label, color = '#5865f2' }: { label: string; color?: string }) {
	const ReactNative = metro.common.ReactNative;
	const Discord = getDesignModule();
	if (!Discord?.Text) return null;

	return (
		<ReactNative.View
			style={{
				paddingLeft: 4,
				paddingRight: 4,
				borderRadius: 4,
				flexDirection: 'row',
				justifyContent: 'center',
				alignItems: 'center',
				backgroundColor: color,
				marginLeft: 4,
			}}
		>
			<Discord.Text variant="text-xs/semibold" lineClamp={1} style={{ color: '#ffffff' }}>
				{label}
			</Discord.Text>
		</ReactNative.View>
	);
}

const dateFormatter = new Intl.DateTimeFormat();

export default function ReviewItem({
	review,
	profileId,
	hideTimestamps,
	onChanged,
}: {
	review: Review;
	profileId: string;
	hideTimestamps: boolean;
	onChanged(): void;
}) {
	const ReactNative = metro.common.ReactNative;
	const Discord = getDesignModule();
	const [expanded, setExpanded] = useState(false);
	const [busy, setBusy] = useState(false);
	const [localVote, setLocalVote] = useState<boolean | null>(review.userVote ?? null);
	const [score, setScore] = useState(review.score ?? 0);

	const myId = getCurrentUserId();
	const isOwnReview = review.sender.discordID === myId;
	const isAuthorBlocked = getCurrentUser()?.blockedUsers?.includes(review.sender.discordID) ?? false;

	async function handleVote(isUpvote: boolean) {
		if (busy || review.id === 0) return;
		if (isOwnReview) {
			showToast('You cannot vote on your own review.');
			return;
		}

		setBusy(true);
		try {
			if (localVote === isUpvote) {
				if (await deleteReviewVote(review.id)) {
					setLocalVote(null);
					setScore((current) => current + (isUpvote ? -1 : 1));
				}
				return;
			}

			if (await voteReview(review.id, isUpvote)) {
				const delta = localVote == null ? (isUpvote ? 1 : -1) : isUpvote ? 2 : -2;
				setLocalVote(isUpvote);
				setScore((current) => current + delta);
			}
		} finally {
			setBusy(false);
		}
	}

	async function handleDelete() {
		if (busy) return;
		setBusy(true);
		try {
			if (await deleteReview(review.id)) onChanged();
		} finally {
			setBusy(false);
		}
	}

	async function handleReport() {
		if (busy) return;
		setBusy(true);
		try {
			await reportReview(review.id);
		} finally {
			setBusy(false);
		}
	}

	async function handleBlockToggle() {
		if (busy) return;
		setBusy(true);
		try {
			await (isAuthorBlocked ? unblockUser(review.sender.discordID) : blockUser(review.sender.discordID));
			onChanged();
		} finally {
			setBusy(false);
		}
	}

	if (!Discord?.Text) return null;

	const comment = review.comment ?? '';
	const truncated = comment.length > 200 && !expanded;
	const canVote = review.id !== 0;
	const canDelete = canDeleteReview(profileId, review, myId);
	const canReport = canReportReview(review, myId);
	const canBlock = canBlockReviewAuthor(profileId, review, myId);

	const Container = Discord.Card ?? ReactNative.View;
	const containerProps = Discord.Card
		? { variant: 'secondary', border: 'subtle', radius: 8 }
		: {};

	return (
		<Container
			{...containerProps}
			style={{
				flexDirection: 'row',
				paddingVertical: 8,
				paddingHorizontal: 12,
				gap: 8,
				marginBottom: 8,
				marginHorizontal: 12,
			}}
		>
			{canVote && (
				<ReactNative.View style={{ alignItems: 'center', width: 24 }}>
					<ReactNative.Pressable disabled={busy} onPress={() => handleVote(true)}>
						<Discord.Text variant="text-md/bold" color={localVote === true ? 'header-primary' : 'text-muted'}>
							+
						</Discord.Text>
					</ReactNative.Pressable>
					<Discord.Text variant="text-sm/medium">{score}</Discord.Text>
					<ReactNative.Pressable disabled={busy} onPress={() => handleVote(false)}>
						<Discord.Text variant="text-md/bold" color={localVote === false ? 'header-primary' : 'text-muted'}>
							-
						</Discord.Text>
					</ReactNative.Pressable>
				</ReactNative.View>
			)}

			<ReactNative.View style={{ flex: 1, gap: 4 }}>
				<ReactNative.View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
					<ReactNative.Image source={{ uri: review.sender.profilePhoto }} style={{ width: 24, height: 24, borderRadius: 12 }} />
					<Discord.Text variant="text-sm/semibold">{review.sender.username}</Discord.Text>
					{review.type === ReviewType.System && <Tag label="SYSTEM" />}
					{isAuthorBlocked && (
						<Discord.Text variant="text-xs/medium" color="text-danger">
							Blocked
						</Discord.Text>
					)}
					{!hideTimestamps && review.type !== ReviewType.System && review.timestamp > 0 && (
						<Discord.Text variant="text-xs/medium" color="text-muted">
							{dateFormatter.format(review.timestamp * 1000)}
						</Discord.Text>
					)}
				</ReactNative.View>

				<Discord.Text variant="text-sm/normal">{truncated ? `${comment.slice(0, 200)}...` : comment}</Discord.Text>

				{comment.length > 200 && (
					<ReactNative.Pressable onPress={() => setExpanded((value) => !value)}>
						<Discord.Text variant="text-xs/medium" color="text-link">
							{expanded ? 'Show less' : 'Read more'}
						</Discord.Text>
					</ReactNative.Pressable>
				)}

				{(canDelete || canReport || canBlock) && review.id !== 0 && (
					<ReactNative.View style={{ flexDirection: 'row', gap: 14 }}>
						{canReport && (
							<ReactNative.Pressable disabled={busy} onPress={handleReport}>
								<Discord.Text variant="text-xs/medium" color="text-muted">
									Report
								</Discord.Text>
							</ReactNative.Pressable>
						)}
						{canBlock && (
							<ReactNative.Pressable disabled={busy} onPress={handleBlockToggle}>
								<Discord.Text variant="text-xs/medium" color="text-muted">
									{isAuthorBlocked ? 'Unblock' : 'Block'}
								</Discord.Text>
							</ReactNative.Pressable>
						)}
						{canDelete && (
							<ReactNative.Pressable disabled={busy} onPress={handleDelete}>
								<Discord.Text variant="text-xs/medium" color="text-danger">
									Delete
								</Discord.Text>
							</ReactNative.Pressable>
						)}
					</ReactNative.View>
				)}
			</ReactNative.View>
		</Container>
	);
}
