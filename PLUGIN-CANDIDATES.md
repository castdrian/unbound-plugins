# Plugin port candidates

Ports worth considering from Vencord, Vendetta/Bunny, Pyoncord and Enmity, ranked by how well they fit the seams this client actually exposes.

Two findings shape the whole list:

- **Message rows are native.** They are built in JS by `generateMessageRowData` (`modules/messages/native/renderer/MessageWithContent.tsx`) and handed to a native DCD renderer. There is no React component for a message's username, avatar, badges or role icon. Anything that decorates a message must go through the row descriptor.
- **The composer is mostly native too.** Of 27 `chat_input/native` components, only `ChatInputGuardWrapper` renders. `ChatInputActions` (left) and `ChatInputRightActions` (right) are the only injectable React slots, and both are stable anchors.

Effort ratings assume the seam is already proven. See `HANDOFF.md` for the underlying details.

---

## Tier 1 — row descriptor mutations

Same seam as Show Me Your Name and Force Owner Crown. Every field below was confirmed present in a live row.

| Plugin | Origin | Seam | Effort |
|---|---|---|---|
| Custom Timestamps | Vendetta/Bunny | `row.message.timestamp` is a preformatted **string** — reformat it | Trivial |
| More User Tags | Vencord `moreUserTags` | `tagText`, `tagTextColor`, `tagBackgroundColor`, `tagVerified` via `getTagProperties` | Low |
| Role Color Everywhere | Vencord `roleColorEverywhere` | `usernameColor`, `roleColor`, `roleColors`, `colorString` | Low |
| Better Role Dot | Vencord `betterRoleDot` | `shouldShowRoleDot`, `shouldShowRoleOnName` | Trivial |
| Show Timeouts | Vencord `showTimeouts` | `communicationDisabled` | Trivial |

## Tier 2 — send-path patches

Same seam as Clear URLs: `patcher.before` on `findByProps('sendMessage', 'editMessage')`.

| Plugin | Origin | Notes |
|---|---|---|
| Text Replace | Vencord `textReplace` | Rule-based find/replace on outgoing content. Structurally identical to Clear URLs; could share the replacer |
| No Reply Mention | Vencord `noReplyMention` | Not the send path — `createPendingReply` / `setPendingReplyShouldMention` exist |
| Silent Typing | Vencord `silentTyping` | `startTyping` / `stopTyping` confirmed present |
| Unindent | Vencord `unindent` | Trivial content transform |

## Tier 3 — composer buttons

The `ChatInputRightActions` anchor plus the fade/press pattern from Preview Message are already solved, so these are mostly assembly.

- **Silent Message Toggle** (Vencord `silentMessageToggle`) — toggle button plus an `@silent` content prefix. Best next candidate in this tier.
- **Send Timestamps** (Vencord `sendTimestamps`) — inserts `<t:…>`; needs a small picker UI.

## Tier 4 — slash commands

`getBuiltInCommands` and `BUILT_IN_COMMANDS` are reachable, so the Vendetta approach of injecting into that array should work. **Unproven** — one spike derisks the whole group.

Message Tags, Urban Dictionary, Wikisearch, petpet, More Commands.

Note the Unbound SDK has **no commands API**; this would be raw array patching.

## Tier 5 — high value, real work

- **Message Logger** (deleted/edited messages) — the most requested plugin across every mobile mod. Dispatcher patch (proven by No Blocked Messages) plus row styling. Medium-hard, big payoff.
- **NoTrack** — block analytics/science requests. Popular on mobile; needs the analytics module located first.
- **View Raw / Copy Raw** — ActionSheet (`openLazy`, `hideActionSheet`) and Clipboard (`getString`, `setString`) both exist; needs the message long-press sheet patch point identified.

## Needs discovery before estimating

- **Anonymise File Names** — no `uploadFiles` module found by that name.
- **Reveal All Spoilers** — no `revealSpoiler` module found.
- Anything depending on relationships, presence, permissions-by-store or link trust: those `findByProps` probes returned an identical generic Flux-store shape, i.e. **false matches**, not real hits.

## Attempted and abandoned

**Always Animate** — tried and dropped. Vencord's `.canAnimate` patch has no mobile equivalent, and forcing `canAnimate` on every avatar/icon URL getter produced animated URLs but **no visible animation**, implying the native image decoder renders a static frame regardless. See `HANDOFF.md` for the full write-up before reconsidering.

## Not worth attempting

Desktop-only by construction: Spotify controls, web keybinds, volume booster, rnnoise, picture-in-picture, devtools companion, web context menus, arRPC, system badge.

Anything requiring React injection *inside* a rendered message. The native renderer forecloses it — proven when a crown forced onto all 19 visible reply references rendered nothing, because the compact reply preview ignores `roleIcon` entirely.

---

## Verified module reference

Collected while assessing the above; all confirmed live.

| Purpose | Lookup |
|---|---|
| Message tag properties | `metro.findByName('getTagProperties', { interop: false })` |
| Permission computation | `metro.findByProps('computePermissions', 'canEveryoneRole')` |
| Permission bitfield | `metro.findByProps('Permissions', 'ThemeTypes').Permissions` (53 entries, bigint) |
| Reply mention control | `metro.findByProps('createPendingReply')` → `createPendingReply`, `setPendingReplyShouldMention`, `deletePendingReply` |
| Typing | `metro.findByProps('startTyping', 'stopTyping')` |
| Slash commands | `metro.findByProps('getBuiltInCommands')` → `BUILT_IN_COMMANDS` |
| NSFW gate | `metro.findByProps('shouldNSFWGateGuild')` |
| Action sheets | `metro.findByProps('openLazy', 'hideActionSheet')` |
| Alerts | `metro.findByProps('openLazy', 'close')` → `show`, `confirm` |
| Clipboard | `metro.findByProps('getString', 'setString')` |
| Haptics | `metro.findByFilePath('modules/haptics/HapticUtils.native.tsx')` |
| Stores | `metro.findStore('Guild' \| 'Channel' \| 'Message' \| 'User' \| 'GuildMember' \| 'PendingReply')` |
