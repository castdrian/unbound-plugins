# Handoff: Vencord → Unbound plugin ports

Live status doc. Updated after each change. Intentionally untracked — delete or `git rm --cached` if it ever gets added.

## Environment / workflow

- Device is a **vphone** (virtual jailbroken iPhone via `vphone-cli`), not a real device.
- User's own macOS app **vbound** (`~/Developer/vbound`) drives it:
  - **Addons** action = `bunx ubd build` in this repo, then copies each plugin's `dist/` onto the vphone, then relaunches Discord. **This is the only way code changes reach the device.**
  - **Discord** action = kill + relaunch Discord only.
- **The user deploys manually. Do not deploy for them.** Ask, then wait.
- Live debugger bridge: `bunx @unbound-app/debugger --port 9090`. One-shot eval: `bunx ubd eval --json < script.js` (piping via stdin avoids shell-escaping pain with `$` and quotes — strongly preferred over inline `-c` style).
- `.mcp.json` registers `unbound` as an MCP server, but **it has never actually connected in any session so far** (stays "connecting"). Do not wait on it; start the bridge manually and use `ubd eval`.
- The bridge dies if the device disconnects or another instance grabs port 9090. Symptom: `No device is connected to the debugger`. Fix: check `lsof -i :9090`, restart the bridge, and it reconnects on its own within a few seconds.
- **Redeploying relaunches Discord and wipes every `globalThis` probe set via eval.** Re-arm probes after any redeploy.

### Toggling plugins live

`unbound.plugins.enable('unbound.<id>')` / `.disable(...)` / `.entities` (a Map; values have `{id, started, failed}`). New/renamed plugin IDs start `started:false` even after redeploy — re-enable manually after any ID change.

### Waiting on device activity

Most probes only fire when the app renders. When polling for a probe result in bash, **do not `grep -c true`** on the eval JSON — the envelope contains `"ok":true` and always matches. Match the value field instead:

```sh
until echo 'globalThis.__probe.count' | bunx ubd eval --json 2>/dev/null | grep -qE '"value":"[1-9]'; do sleep 4; done
```

## Core API facts (read the client source, don't guess)

Client source of truth: `~/Developer/unbound/packages/client/src/api/`.

### Patcher

`patcher.before/after/instead(target, method, callback)` — the callback receives **one `ctx` object**, not positional args:

```ts
{ original: Fn, this: Self, result: Res | null, args: Args }
```

Each call returns its own unpatch closure. A previous session wasted effort on a probe written as `(self, args, res)`, which silently reports `undefined` for everything and looks like "the target never fires". If a probe shows all-undefined args, suspect the signature before concluding the target is wrong.

**Known upstream SDK bug:** `patcher.createPatcher(id).unpatchAll()` throws `TypeError: undefined is not a function` unconditionally, as does `unpatchAllByCaller(id)`. **Workaround used in all new plugins:** never use `createPatcher()`; use the free functions and store their returned closures.

### Metro

Real surface (from `api/metro/index.ts`): `find`, `findLazy`, `bulk`, `findByProps`, `findByName`, `findByFilePath`, `findByPrototypes`, **`findStore`** (not `findByStoreName`, which does not exist), plus `metro.common`, `metro.components`, `metro.stores`, `metro.filters`.

- `metro.findByFilePath('modules/.../File.tsx')` is the most reliable discovery method by far — Discord ships file paths and they are stable across reloads. **Prefer it over name scans and never hardcode numeric module ids.**
- `metro.findStore('Guild')`, `findStore('Message')`, `findStore('User')` all work.
- `metro.common.*` are facade exports, **not live references** — patching them silently no-ops. Use `findByProps` to get the real module before patching. (Using `metro.common.React` / `ReactNative` for *rendering* is fine.)
- Function `.name` is preserved in this Hermes build, so name scans are viable — but see the DCD finding below for why they were the wrong tool for message rows.
- Many components are `React.memo`/`forwardRef` wrapped; unwrap `.type` / `.render`.

## THE key architectural finding: message rows are native, not React

**Chat messages on this client are built as native DCD row descriptors in JS, then handed to a native renderer. There is no React component for a message's username, avatar, or role icon.**

Proven empirically: with 25 rows freshly rendered, call counters on `UsernameText`, `DisplayName`, `getNickname`, and `UserNameplateRow` all recorded **exactly zero calls**. Every Vencord-style "patch the username component" port is dead on arrival. Do not attempt that approach again for anything that renders inside a message row.

### The seam

`modules/messages/native/renderer/MessageWithContent.tsx` exports **`generateMessageRowData(opts, renderOpts, str)`**, which returns the row object. This is plain JS and patching it is a pure-JS change — no native/JSI work needed.

```ts
const target = metro.findByFilePath('modules/messages/native/renderer/MessageWithContent.tsx');
patcher.after(target, 'generateMessageRowData', (ctx) => {
  const row = ctx.result?.message;      // the message descriptor, mutate in place
  const src = ctx.args[0]?.message;     // the source message (has .author)
});
```

Fires ~200x during an active scroll. Related modules in the same directory (`RowGenerator.tsx`, `transformReactions.tsx`, `createMessageContent.tsx`, `system_messages/*`) are the seams for other row features.

### Row descriptor shape

`ctx.result` is `{type, message, canAddNewReactions, reactionsTheme, separatorBefore, changeType, swipeActions, …}`; normal message rows are `type === 1`.

`ctx.result.message` (~90 fields). The load-bearing ones found so far:

| Field | Notes |
|---|---|
| `username` | **A plain resolved string**, e.g. `"Caerus (The Perish Collective)"`. Already the display name. |
| `authorId`, `guildId`, `channelId` | ids |
| `roleIcon` | `{source: <url string>, name, size: 18, alt}` — renders an icon next to the name |
| `usernameColor`, `roleColor`, `roleColors`, `shouldShowRoleOnName` | |
| `tagText`, `tagType`, `tagTextColor`, `tagBackgroundColor`, `tagIconUrl` | the BOT-tag mechanism |
| `clanTag`, `clanBadgeUrl`, `clanTagGuildId` | |
| `referencedMessage` | reply preview — see below |
| `reactions`, `content`, `embeds`, `attachments`, `timestamp` | |

`ctx.args[0].message` is the **source** message and carries `.author` (`{username, globalName, id}`), `.nick`, `.blocked`, `.ignored`, `.content`, etc.

### Reply references

`row.message.referencedMessage` is a **wrapper**: `{state, message}`. The inner `.message` has the **identical schema** to a normal row (`username`, `authorId`, `guildId`, `roleIcon`, …).

Two gotchas:
1. The source side only carries a `messageReference` **stub** — `{type, message_id, guild_id, channel_id}` with **no author object**. Resolve the raw username via `metro.findByProps('getCurrentUser','getUser').getUser(authorId)` instead. Confirmed working.
2. **Reply previews prefix the displayed name with `@`** (e.g. `"@ratts"`). Any `username === nick` comparison must strip that prefix first, or authors without a nickname render as `@dylib.dev (@dylib.dev)`.

**`roleIcon` is NOT rendered in the compact reply preview.** Proven: a crown forced onto all 19 visible reply references rendered nothing, and `alreadyHad: 0` showed Discord never populates the field there itself. **Do not retry owner crowns (or any role icon) on replies.**

### Assets

`assets.getIDByName('ic_crown_16px')` → `1745`; `'CrownIcon'` → `2420`. To get something usable as a `roleIcon.source`, resolve it:

```ts
metro.common.ReactNative.Image.resolveAssetSource(id).uri
// file:///.../Discord.app/assets/images/native/icons/ic_crown_16px@3x.png
```

A `file://` URI string works fine as `roleIcon.source` even though Discord's own values are https URLs. **Do not use a remote SVG URL** — RN's `Image` cannot render raw SVG and fails silently.

### Settings UI

`metro.components.Discord` exists with `TableRowGroup`, `TableRow`, `TableSwitchRow`, `TableRadioGroup`, `TableRadioRow`. Use reviewdb's `getDesignModule()` fallback pattern (try `metro.components.Discord`, then `metro.findByProps('TableRow','TableRowGroup')`).

`TableRadioGroup`/`TableRadioRow` **are compiled to bytecode**, so their prop shapes cannot be read via `String(fn)` and were not verified. Show Me Your Name deliberately uses `TableRow` + a `✓` trailing element instead, matching reviewdb (known to work on this build). If you want real radio rows, verify the props on-device first.

## Plugin status

### Show Me Your Name (`unbound.show-me-your-name`) — ✅ done, pushed, confirmed live

- Patches `generateMessageRowData`, rewrites `result.message.username`.
- Default mode is **`nick-user` → `Display Name (@username)`** (user's explicit choice; note this deviates from Vencord, whose default is `user-nick`). Usernames are always `@`-prefixed.
- Also rewrites `referencedMessage.message.username` when the `inReplies` setting is on.
- `inReplies` defaults to **`false`** for Vencord parity — verified at `~/Developer/Vencord/src/plugins/showMeYourName/index.tsx:51`. Caveat: that checkout is from **Aug 2023** and may not match current upstream.
- Verified live: 96/125 rows rewritten on the deployed build; 36 reply references rewritten.

### Force Owner Crown (`unbound.force-owner-crown`) — ✅ done, pushed, confirmed live

- Patches `generateMessageRowData`, sets `result.message.roleIcon` to the crown when `findStore('Guild').getGuild(guildId).ownerId === authorId`. Skips rows that already have a role icon.
- Replies deliberately excluded (see above — impossible).
- Verified live: forcing a crown on all rows proved the render path, then the owner-gated version matched only the actual owner.

### Clear URLs (`unbound.clear-urls`) — ✅ done, pushed, verified end-to-end

- `patcher.before` on `findByProps('sendMessage','editMessage')`, rewrites the arg whose `.content` is a string.
- Verified by reading the sent message back out of `findStore('Message')`: `https://example.com?utm_source=…&gclid=…&fbclid=…#target-anchor` was stored as `https://example.com/#target-anchor`.
- **The `#fragment` is preserved by design** — rules only delete `searchParams`; `url.toString()` keeps the hash. Matches Vencord/ClearURLs upstream. Confirmed intended with the user.

### No Blocked Messages (`unbound.no-blocked-messages`) — ✅ pre-existing, working

Untouched this session. Do not restart the abandoned "force row refresh" experiments.

### Typing Avatars (`unbound.typing-avatars`) — ✅ done, confirmed live by the user

Took three live iterations against a channel with real typing. Final state confirmed "perfect" by the user.

**Structure (captured with the plugin disabled, so this is the untouched shape):**
- `TypingIndicator` (`modules/chat/native/TypingIndicator.tsx`) takes `{channel, screenIndex, wrapperStyle}` and returns `<TransitionItem item renderItem>`; `renderItem` has **arity 0**.
- `result.props.item` = `{channel, typingUserIds: [...], wrapperStyle}`. **`typingUserIds` is handed to you directly** — the `useTypingUserIds` hook is unnecessary, and using the item data avoids any hook-order or subscription concerns. The plugin no longer imports it.
- `wrapperStyle` = `[{backgroundColor:'transparent', paddingRight:16}, {paddingLeft:32}]`.
- `TypingIndicatorInner`'s props are **only `{transitionState, cleanUp}`** — there is **no `children` prop**.

**Root cause of the original failure, now proven rather than suspected:** the old code did `cloneElement(item, null, <TypingAvatars/>)` to inject avatars as children. Since `TypingIndicatorInner` accepts no `children`, that was silently discarded — exactly the "normal indicator, no avatars" symptom.

**The three fixes that were each needed:**
1. **Wrap, don't inject as children** — a flex-row `View` containing the avatars plus the original item.
2. **Give the original item `flex: 1`** — without this the "X is typing…" *text* vanished while the animated dots still rendered. This was the subtlest bug; the indicator was being width-collapsed inside the flex row.
3. **Collapse the inner `paddingLeft: 32` to 0**, then apply `paddingLeft: 32` on the outer wrapper instead. Otherwise the original gutter stacked on top of the avatar width and produced a huge gap with the avatars shoved off the left edge.

Final tuned constants: `AVATAR_GUTTER 32`, `AVATAR_GAP 4`, `AVATAR_HEIGHT 16`, `AVATAR_OVERLAP -6`, `MAX_AVATARS 3`, `AvatarSizes.SIZE_16`. The 32 gutter makes the avatars start exactly where the dots originally sat, which is what the user wanted.

**Technique worth reusing:** live layout tuning via a `globalThis.__tune` object read on every render, adjusted with one-line evals (`Object.assign(globalThis.__tune, {padLeft: 32})`) while the user watches. Converged in a few seconds per iteration with no rebuild or redeploy.

### Who Reacted (`unbound.who-reacted`) — 📦 STASHED, removed from the workspace

The plugin folder is **gone from `plugins/`**. Its source is in a git stash:

```
git stash list          # look for "who-reacted: experimental, shelved"
git stash pop stash@{N} # restores plugins/who-reacted/src + manifest
```

`dist/` and `node_modules/` were deleted too, deliberately — vbound's Addons action copies each plugin's `dist/`, so a stale build would have kept deploying it. Run `bun install` after popping. **A copy is still deployed and enabled on the device**; it keeps producing the square avatar chips until removed there or disabled via `unbound.plugins.disable('unbound.who-reacted')`.

Why it was shelved: `row.message.reactions[0]` is

```js
{ me, me_burst, count, count_details: { burst, normal },
  burst_colors: [], burst_count,
  emoji: { name: '🔥', id: null, src: '', displayName: 'fire, 1 reaction, press to react' } }
```

**No field expresses an avatar group.** One array entry = one chip = one emoji image plus a count, so a stacked avatar row is not representable — the separate square chips are the ceiling of the pure-JS approach, not a bug. Do not re-attempt from `row.message.reactions`.

Research that remains valid if it is ever revived:
- Reference: `~/Developer/Vencord/src/plugins/whoReacted.tsx`.
- `modules/reactions/ReactionActionCreators.tsx` exposes `getReactors({channelId, messageId, emoji, type})`, which makes the authorized GET internally. `addReaction` args are `[channelId, messageId, emoji, 'Message', {burst: false}]`.
- Intercepting synthetic marker ids in `addReaction` prevents taps from sending or removing real reactions — the user verified this was safe.
- Native hierarchy: `DCDReactionListView` → `UICollectionView` → `ReactionCollectionViewCell` → `DiscordChatComponentsSwift.ReactionView` → `DCDEmojiView` in a `DCDReusableYYLabel`. The native marker must go in the synthetic emoji's `displayName`, which is what `ReactionView.accessibilityLabel` reflects.
- The uncommitted loader-ios work (`UnboundNative.chat.setReactionAvatarGroups`, the `ChatUI.x` overlay experiment) is on the `feat/unbound-native` branch.
- Cheapest viable alternative if revisited: a **long-press reactor-list sheet** (ActionSheet + Clipboard both exist) rather than trying to stack avatars.

### Preview Message (`unbound.preview-message`) — 🟡 button SOLVED and confirmed live; preview action still a placeholder

**The four-session flicker problem is solved.** Root cause was never the visibility logic — it was the anchor.

**The composer is mostly native.** Walking the live React tree under `ChatInputGuardWrapper` gives:

```
FloatingChatInputContainer
  anon
    ChatInputImageCarousel
    ChatInputNotificationNudge
    View
      ChatInputContextBar
      View
        ChatInputActions          <- LEFT (+ button row)
        View
          ChatInputNativeComponent  <- the text field itself, NATIVE
          ChatInputCover
          ChatInputCharCounter
        ChatInputRightActions     <- RIGHT, the correct anchor
        ChatInputSendButton
```

A sweep of **all 27** `chat_input/native` components with call counters during a type+delete cycle found exactly **one** that fires: `ChatInputGuardWrapper` (44 hits). `ChatInputExpressionButton` never renders at all. The emoji/send controls are not React. `ChatInputActions` and `ChatInputRightActions` are the only genuinely injectable React slots.

**Current anchor: `modules/chat_input/native/action_buttons/ChatInputRightActions.tsx`.**
- `default` is `memo(...)`; unwrap the `type`/`render` chain to reach the function (the plugin has a generic `unwrapComponent` helper for this).
- Returns a plain `View`; inject the button by `unshift`-ing onto `React.Children.toArray(result.props.children)`.
- **Stability: 1 mount / 0 unmounts** across renders, with a press registering correctly. `useSyncExternalStore` on the draft store works fine here — it only ever failed before because the old host destroyed its children.
- `ChatInputActions` (left side) is also stable (1 mount / 0 unmounts over 5 renders) — a viable fallback, but the user rejected the left position.

**Confirmed working by the user:** correct position, no crash, button appears/hides with draft content.

**Crash that was hit and fixed:** `toasts.open(...)` does not exist and crashed the app. The real API is **`toasts.showToast({title, content})`** (see `@unbound-app/api/src/toasts.d.ts`).

**Other useful values:** `assets.getIDByName('EyeIcon')` → 148. `ChatInputConstants.tsx` exports `CHAT_INPUT_ACTION_BUTTON_SIZE` (40), `_MARGIN` (4), `_WIDTH` (48). The right-actions row does not set its own gap, so the button sizes itself.

**Real message preview: WORKING, confirmed by the user.** Tapping the eye opens a Portal overlay rendering the draft as a genuine Discord message row.

- `ChatItem` comes from **`metro.findByFilePath('components_native/chat/ChatItem.tsx').default`**. The old code used `findByProps('DCDAutoModerationSystemMessageView','default')`, which **false-matches the UIManager** (a module exposing `measure`/`createView`/`manageChildren`) — so `ChatItem` was silently `undefined` and the old `MessagePreview` always bailed at its guard. Resolve by file path.
- Props: `<ChatItem rowGenerator={new RowManager()} message={record} />`.
- **`MessageRecord` timestamp MUST be a `Date` object, not an ISO string.** Passing a string constructs without error but crashed the app later with **`Invalid time value`**. Real records have `timestamp instanceof Date` and `editedTimestamp === null`; mirror a real record's field *types*, not just its field names. Pass a full raw payload including `edited_timestamp: null`.
- Pre-flight `new RowManager().generate({rowType: 1, message: record})` off-screen before rendering — it throws cheaply if the record is malformed, instead of taking the app down.
- Overlay fades via `ReactNative.Animated` opacity, and fires haptics on appear: **`metro.findByFilePath('modules/haptics/HapticUtils.native.tsx')` → `triggerHapticFeedback(HapticFeedbackTypes.IMPACT_MEDIUM)`** (33 types available including `IMPACT_LIGHT/MEDIUM/HEAVY`, `SOFT`, `RIGID`, `NOTIFICATION_*`).
- **JSX gotcha:** the component refs are module-level `let` variables; assign to a capitalised local (`const ChatItem = chatItem`) before use in JSX, or lowercase JSX is treated as a host element.

**Transition: SOLVED after ~8 live iterations.** Final values: `SHOW_DELAY_MS 60`, `SHOW_MS 70`, `HIDE_MS 25`, plus press feedback (`opacity 0.5`, `scale 0.86`, `IMPACT_LIGHT` haptic on press-in, `hitSlop 8`).

What was learned, in order, because several plausible approaches are dead ends:

1. **`TransitionItem` does not animate anything for you.** Wrapping the button in the same `TransitionItem` the gift button uses did nothing — a probe of the props it passes to `renderItem`'s element returned only our own props, no `transitionState`/`cleanUp`. It is a coordination shell; the *child* is expected to consume `transitionState` (as `TypingIndicatorInner` does). Setting `item: null` did not remove the child either.
2. **Animating `width` looks wrong.** The right-actions row is laid out against the send button, and *both* the gift button leaving and the send button arriving reflow it. Animating our width made the button visibly slide during the fade.
3. **Absolute positioning fixes the slide but breaks text.** `position:'absolute'` removed it from flow so it faded in place — but then long multi-line messages wrapped *underneath* it, since the text field reserved no space.
4. **Final answer: in flow, width snaps, only opacity animates.** `width: visible ? 32 : 0`, `marginRight: visible ? 0 : -8` (cancels the row's `gap: 8` when collapsed), `opacity` animated. No slide, no text overlap.
5. **Timing constraint:** the show needs a small delay or the button appears mid-reflow and gets dragged; ~60ms is the practical floor. The hide must be very short (25ms) or it is still fading when the gift button animates back.

**Live tuning was essential here** — a `globalThis.__delay` object read on every render, adjusted with one-line evals while the user watched, converged this in minutes. Do not try to guess these values.

**Owner crown empty-square note:** the user saw the crown render as an empty square once. An A/B/C test injecting `file://` vs numeric asset id vs an https CDN url into `roleIcon.source` **made things worse** — it produced "data in this message model failed to be decoded" errors on most rows. Do not repeat that test. The user judged the empty square a transient render failure that a clean app reload would fix; the committed `file://` approach is unchanged and was working before.

Anchors tried and eliminated across sessions (do not retry): `MessagesScreen`, `ChatInputContextBar`, `ChatInputGuardWrapper` as an injection point, both `ChatButton` modules, `FloatingChatInputContainer`, `ChatInputActionButtonGiftOrThread` (3 mounts / 2 unmounts per typing cycle), `ChatInputExpressionButton` (never renders).

React fiber/owner internals are **not available** in this production build and `__REACT_DEVTOOLS_GLOBAL_HOOK__` does not exist — do not attempt fiber-tree walking. `AppRegistry.setWrapperComponentProvider` was ruled out by the user as too risky.

### No Reply Mention (`unbound.no-reply-mention`) — ✅ done, pushed, confirmed live

Vencord patches the desktop reply bar's shift-key `shouldMention`, which has **no mobile equivalent**. The mobile seam is `metro.findByProps('createPendingReply')`, which exposes `createPendingReply`, `setPendingReplyShouldMention` and `deletePendingReply`. A `patcher.before` on `createPendingReply` setting `args[0].shouldMention` is enough; confirmed the reply composer then defaults the mention to off.

### More User Tags (`unbound.more-user-tags`) — ✅ done, pushed, confirmed live

**Seam: `metro.findByName('getTagProperties', { interop: false }).default`** — a dedicated function returning `{tagText, tagTextColor, tagBackgroundColor, tagVerified, tagType, ...}`, i.e. exactly the tag fields that appear on the row descriptor. Patch it with `patcher.after` and return a modified object; do not mutate the row in `generateMessageRowData` for this.

Found via the mobile reference the user supplied: <https://github.com/shipwr3ckd/revengeplugin/tree/master/plugins/staff-tags/src>. Worth re-reading if tags need extending — it also shows colour handling via `ReactNative.processColor` and role-colour backgrounds.

- Guard on `result.tagText` already being set, or you overwrite Discord's own BOT/SYSTEM/AI tags.
- Permissions: `metro.findByProps('Permissions', 'ThemeTypes').Permissions` is the real bitfield (**53 entries, bigint**), and `metro.findByProps('computePermissions', 'canEveryoneRole').computePermissions({user, context: guild, overwrites: channel?.permissionOverwrites})` returns the user's total. Do not hardcode permission values. Note `metro.common.constants` does **not** carry `Permissions` on this build.
- Tag names/display names/permission sets follow Vencord (`WEBHOOK`/Webhook, `OWNER`/Owner, `ADMINISTRATOR`/Admin, `MODERATOR_STAFF`/Staff, `MODERATOR`/Mod, `VOICE_MODERATOR`/VC Mod) per the user's explicit preference, with `MANAGE_WEBHOOKS` added to the Staff set from the mobile reference.
- Verified live: 423 `getTagProperties` calls, 148 tagged, resolving Owner and Mod correctly.

**Tag colours** (an addition over both Vencord and the mobile reference — Vencord renders all tags with Discord's default styling, and the reference ships its colours commented out):

- `tagBackgroundColor` / `tagTextColor` expect **processed ARGB ints**, not hex strings: `metro.common.ReactNative.processColor('#ff0000')` → `4294901760`. Same encoding as `usernameColor` on the row.
- `metro.common.chroma` does **not** exist on this build, so text contrast is computed manually from perceived luminance (`(r*299 + g*587 + b*114) / 1000 > 150 ? black : white`).
- Role colours come from `metro.findStore('GuildMember').getMember(guildId, userId).colorString` (e.g. `#bf9fff`). Note `getMember` is on the prototype, so it will not show up in an `Object.keys` scan of the store — do not conclude it is missing.
- Two settings, both verified live: `coloredTags` (default on, per-tag palette) and `useRoleColor` (**default on**, overrides with the member's role colour). Each tag also has its own on/off toggle keyed `tag.<NAME>`.

### Always Animate — ❌ ATTEMPTED AND ABANDONED, do not retry as-is

Investigated and dropped at the user's direction. The plugin folder was deleted; nothing was committed. **The findings below are the valuable part — they say the obvious approach does not work.**

**Vencord's approach does not port.** It patches `.canAnimate` globally (`match: /\.canAnimate\b/g`). There is **no `.canAnimate` property anywhere in the mobile bundle**; it is a desktop-only construct. Mobile splits animation control two ways:

1. **Message content** — `animateEmoji` and `gifAutoPlay` booleans on the row descriptor. Forcing them works, but on an account that already has both settings enabled it is a no-op (measured: 200 rows, `changed: 0`).
2. **Avatars / guild icons** — the URL-builder module `metro.findByProps('getUserAvatarURL', 'getGuildIconURL', 'isAnimatedIconHash')`. Two different argument shapes, both confirmed live:
   - `getUserAvatarSource(user, canAnimate, size)` — positional; called with `canAnimate: false` (254 calls observed)
   - `getGuildIconURL({id, size, icon, canAnimate, lossless})` — options object (16 calls observed)

**The negative result:** forcing `canAnimate` true across all eight getters (46 avatar calls and 1 guild icon flipped, zero errors) produced **no visible animation at all**. The URLs then point at the animated `a_`-prefixed assets, so the JS side is doing the right thing — something further down, most likely the **native image decode layer**, still renders a single static frame.

Conclusion: this is probably **not solvable from JS**. Anyone resuming should start by confirming whether the native image loader can play GIF/APNG at all on this build, rather than re-deriving the JS seams above.

Also note a probe bug worth avoiding: patching several module exports in a `for (const n of names)` loop and referencing `n` inside the callback attributed **every** call to the last name. Build the callback in a factory (`makeProbe(name)`) so each closure captures its own name.

## Port candidates

`PLUGIN-CANDIDATES.md` (untracked, like this file) ranks further Vencord/Vendetta/Pyoncord/Enmity ports by how well they fit the known seams, and carries a table of verified module lookups. **Keep it untracked** — the user asked for it not to be committed.

## Repo / tooling

- **Pre-commit hook** (`.githooks/pre-commit`, installed by the `prepare` script via `core.hooksPath`, no dependency added): regenerates `plugins/README.md` and stages it on every commit.
- `scripts/generate-plugins-readme.ts` now filters plugin folders against **`git ls-files`**, so locally-scaffolded but unpushed plugins no longer leak into the published README. Because `git ls-files` reads the index, staging a new plugin before committing correctly includes it in the same commit.
- `bunx tsc --noEmit` fails repo-wide with `TS5103: Invalid value for '--ignoreDeprecations'` — **pre-existing**, unrelated to plugin code. To typecheck, generate a temp config with that line swapped out.
- Conventional Commits. **No comments in any file, ever** (user's global rule).

### Commits pushed this session

```
8043c4e fix: align typing avatars and neutralise crown description
e9e0fd6 feat: add typing avatars plugin
78bbf58 revert: drop owner crown on reply references
5bc638b feat: apply name and crown to reply references
6bfc64c chore: regenerate plugins readme on commit
8a684d5 feat: add clear urls plugin
95c58eb fix: list only published plugins in readme
16d6739 feat: add force owner crown plugin
37dfbb9 feat: add show me your name plugin
```

Still untracked / uncommitted: `.mcp.json`, `HANDOFF.md`, `PLUGIN-CANDIDATES.md`, plus modified `.gitignore` and `bun.lock`. Every plugin in `plugins/` is now committed and pushed.

### Other repos

- `~/Developer/unbound` on `feat/unbound-native`: typed native facade in `packages/client/src/api/native.ts` + regenerated SDK. Uncommitted.
- `~/Developer/loader-ios` on `feat/unbound-native`: JSI transport, `UnboundNative.chat.setReactionAvatarGroups`/`clearReactionAvatarGroups`, feature flag `chat.reactionAvatars`, read-only hierarchy probes, and a native reaction-stacking experiment in `ChatUI.x`. Uncommitted. Preserve the user-owned `.agents/` and `.codex/` directories.

## Immediate priorities if resuming

1. **Preview Message — render a real message component** instead of the placeholder toast. See its section for the `ChatItem` + `MessageRecord` + `RowManager` + `Portal` approach.
2. **Preview Message — smooth the gift-button → eye-button transition.** Currently the gift button vanishes and the eye button jumps in. User suggested animating one into the other.
3. **Who Reacted** — stashed and removed from the workspace; the JS route is ruled out. Only revisit on request (see its section for how to restore).

## Reusable techniques

- **Live tuning loop**: have the patch read a `globalThis.__tune` object on every render, then adjust with one-line evals while the user watches. Converges layout in seconds with no rebuild/redeploy. Used to land Typing Avatars.
- **Decisive render-path test**: before debugging *why* a conditional visual feature does not appear, force it unconditionally on every row. If nothing renders, the field is not read by the renderer and no amount of logic-fixing will help. This settled both the owner crown (works on main rows) and the reply crown (impossible) in one pass each.
- **Disable the deployed plugin before probing** the thing it patches, or you capture your own modified output and misread it as the original.
- **Read the client source, not memory**, for API shapes: `~/Developer/unbound/packages/client/src/api/`.
