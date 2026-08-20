# T10 — Persistent server-side text chat

## Goal

Give the OvniChat Dedicated Server persistent text chat: two scopes (server-wide "Server Chat" and
per-voice-channel "Channel Chat"), stored on the independently-operated Dedicated Server itself,
never centrally. This corrects an earlier, now-superseded roadmap assumption that T10 would be
ephemeral/session-only chat — chat history **must** survive client disconnect, client restart, and
server restart. There is still no central OvniChat chat service and no client-side authoritative
message store: the Dedicated Server is the sole source of truth; the Client renders and requests,
never owns.

## Context

T9 gave the Dedicated Server its first authorization model and its first persistent runtime state
(a SQLite-backed authorization store). T10 is the second persistent concern: chat messages. The two
persistence domains have deliberately different lifecycle philosophies — authorization state must
never be silently lost (fail-closed, last-admin protection); chat is persistent-by-default but the
product framing tolerates eventual, operator-configured retention in a later task. See
[ADR 0014](../adr/0014-persistent-server-owned-chat-history.md) for the storage-topology decision
this distinction drove, and [`../architecture/PERSISTENT_TEXT_CHAT.md`](../architecture/PERSISTENT_TEXT_CHAT.md)
for the full design.

**Product naming correction, effective this task:** the product is now marketed as **OvniChat**
("OvniChat Client" and "OvniChat Dedicated Server"). Product-facing UI, documentation, and new
architecture/task docs use this name going forward. The internal `@disco-voador/*` npm package
scope is **not** renamed as part of T10 — that remains a separate, deliberately deferred, fully
verified migration task, to avoid unrelated churn across this already-large task.

## In scope

- Two chat scopes: server-wide, and one per existing server-owned voice channel — no independent
  Discord-style text-channel hierarchy yet.
- Server-side persistence for both scopes, in the Dedicated Server's own SQLite store
  (`chat.sqlite`), entirely separate from T9's `authorization.sqlite`.
- Bounded, cursor-based pagination for history — never the full table loaded into memory or sent to
  a client in one response.
- Deterministic message ordering via a server-local monotonic message id, not wall-clock timestamps
  alone.
- Server-derived sender identity and nickname-at-send — a client can never spoof either.
- Two new permissions (`chat.server.send`, `chat.channel.send`); reading history requires no
  permission beyond being an admitted, `ready` connection (this repository has no channel-visibility
  ACL beyond server admission, and T10 does not invent one).
- Sending channel chat requires current voice-channel membership; reading a channel's history does
  not — a deliberate, documented asymmetry.
- Live delivery: server-wide broadcast to every `ready` connection; channel-scoped delivery to
  current channel members only.
- Server-side per-connection chat rate limiting, separate from the existing generic transport-level
  limiter.
- No client-side authoritative persistence: the Client keeps only currently-loaded pages in memory,
  cleared on disconnect, re-requested on reconnect.
- Plain UTF-8 text only; stored-XSS-safe rendering (never `dangerouslySetInnerHTML`).
- Minimal, functional (not polished) chat UI: Server Chat / current-channel Chat tabs, composer,
  "load older" pagination.

## Out of scope

Message editing and deletion (architected to be addable later without a schema migration, but not
implemented — see [ADR 0014](../adr/0014-persistent-server-owned-chat-history.md)); read receipts/
unread tracking; typing indicators; reactions; mentions/notifications; attachments/file uploads;
full-text search; retention-policy configuration (`retentionDays`, `maxMessagesPerChannel` — the
storage schema does not prevent adding this later); an independent text-channel hierarchy separate
from voice channels; any `@disco-voador/*` package-namespace rename.

## Architecture constraints

- Chat lives behind the existing realtime protocol/connection module — no second, parallel REST
  server introduced for history retrieval.
- `services/realtime` stays chat-storage-agnostic: it depends only on the narrow `ChatPort`
  interface (`services/realtime/src/chat-port.ts`), defaulting to a permissive no-op implementation,
  mirroring T9's `AuthorizationPort` seam exactly.
- The chat store lives inside `services/dedicated-server`, in its own `chat/` module, its own
  physical SQLite file, its own migration list — never merged into T9's authorization store (see
  ADR 0014 for the full reasoning).
- Every `ChatPort`/`ChatStore` method is synchronous, matching `AuthorizationPort`'s own reasoning:
  `node:sqlite`'s `DatabaseSync` is synchronous, and `Connection`/`routeClientMessage` are a fully
  synchronous hot path.
- No client message ever asserts its own sender identity or nickname — the server always derives
  both from the already-authenticated connection.

## Relevant packages

`packages/protocol` (new `chat.ts`/`messages/chat.ts` schemas, two new permission keys, one new
error code), `services/realtime` (new `chat-port.ts`, `protocol-handlers.ts`/`connection.ts`/
`server.ts` wiring), `services/dedicated-server` (new `chat/` module, new `storage/` shared
utilities, composition-root wiring), `apps/desktop` (chat composer/history UI, realtime client/hook
wiring).

## Relevant agents

`realtime-backend-engineer` for the protocol/handler/storage wiring; `software-architect` for the
persistent chat/storage-topology decision (see ADR 0014); `electron-desktop-engineer` for the client
UI; `security-reviewer` and `qa-engineer` before completion.

## Relevant skills

`project-orientation`, `planning-feature`, `realtime-protocol`, `text-chat`, `self-hosting`,
`security-review`, `testing-quality`.

## Acceptance criteria

- Server Chat and Channel Chat both work and both persist server-side.
- A server restart against the same data directory preserves chat history; a client restart does
  not erase it (there is nothing to erase — the client never owned it).
- A fresh client (different local profile/identity, never having sent anything) can retrieve
  existing history for a scope it can see.
- History requests are bounded and paginated; a client cannot request an unbounded page.
- Live messages and history pages reconcile without duplication, using message id as the
  deduplication key.
- The server derives sender identity/nickname itself; nickname-at-send is fixed permanently once a
  message is persisted, regardless of later nickname changes.
- Stable `identityId` is never exposed to an ordinary receiving client.
- Message bodies and history pages are bounded; stored HTML/script content renders as inert literal
  text, including after a restart.
- SQL is parameterized throughout; no raw sender data is duplicated into ordinary application logs.
- Two independent Dedicated Servers share no chat history whatsoever.
- A Guest sending a chat message creates a persistent message row but does **not** create a T9
  authorization membership/profile row — a real, documented change to the previous "a Guest creates
  no persistent server data" statement (see [Privacy](#privacy-statement) below).
- T9 permissions/enforcement, existing media (voice/camera/screen/screen-audio), and identity
  auth/persistence show no regression under the new chat surface.

## Definition of Done

See [`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md). T10 additionally requires:
`docs/architecture/PERSISTENT_TEXT_CHAT.md` written (done); ADR 0014 recorded (done); a real
Electron persistence E2E covering both scopes, a live cross-client delivery proof, a real server
restart, and a genuinely fresh client profile receiving history purely through the history API
(done — see below); security and QA review of the new surface, including any findings fixed.

## Handoff notes

### What is real and verified

- **Protocol** (`packages/protocol/src/chat.ts`, `packages/protocol/src/messages/chat.ts`): a
  canonical `chatMessageViewSchema` shared by both the live-broadcast and history-page wire shapes;
  two new client message types, two new server message types — all additive; `serverCapabilitySchema`
  gained `'text-chat'`; `permissionKeySchema` gained `chat.server.send`/`chat.channel.send`;
  `errorCodeSchema` gained `CHAT_RATE_LIMITED`. `CURRENT_PROTOCOL_VERSION` intentionally not bumped
  (matches T9's own no-bump precedent — every change is additive).
- **`services/realtime`**: `ChatPort` injection seam; `HandlerContext` gained `chat`/`nickname`;
  `Connection` now retains the connection's nickname for its lifetime; `OutgoingAction` gained a
  `'broadcast-ready'` variant for server-wide chat delivery; `VoiceRegistry` gained
  `getChannelMemberConnectionIds`; two new chat-specific rate-limit buckets (`RealtimeConfig.
chatSendRateLimit`/`chatHistoryRateLimit`), separate from the generic transport-level limiter.
- **`services/dedicated-server/src/chat/`**: `ChatStore` (implements `ChatPort` against real
  `node:sqlite`), its own migration list, its own `chat.sqlite` file. A new shared
  `services/dedicated-server/src/storage/sqlite-store-utils.ts` factors the open+pragmas+migration-
  runner _pattern_ out of both `AuthorizationStore` and `ChatStore` — `AuthorizationStore` was
  refactored to use it too (mechanical, same behavior; the full existing T9 test suite is the
  regression guard and passed unchanged).
- **Desktop client**: `ChatPanel.tsx` (Server Chat / current-channel Chat tabs, composer bounded to
  the same length the protocol enforces, "load older" pagination, never `dangerouslySetInnerHTML`);
  `use-voice-channel.ts`'s new `chatThreads` state (per-scope, deduplicated-by-id, ascending-ordered
  message lists — never the full history, never preloaded for channels the user has not opened) and
  `sendChatMessage`/`loadChatHistory` actions; `RealtimeClient` gained `sendChatMessage`/
  `requestChatHistory` and two new events.
- **Tests**: new `tests/dedicated-server/chat-store.test.ts` (unit-level: send/read, scope/channel
  isolation, pagination/ordering, restart persistence, no-raw-identity-leak); a new "T10 persistent
  text chat" describe block in `tests/dedicated-server/integration.test.ts` (real sockets: live
  server/channel broadcast, membership-required-to-send, history-does-not-require-membership,
  paginated history over the wire, restart persistence, data minimization — a Guest's chat send
  creates no T9 membership row, verified by inspecting `authorization.sqlite` directly — joint
  authorization+chat composition, cross-server isolation); a new "T10 chat: send/history" describe
  block in `tests/realtime/protocol-handlers.test.ts` (unit-level handler wiring with a mock
  `ChatPort`).

### E2E evidence

- **`pnpm --filter @disco-voador/desktop run e2e:text-chat-persistence`** (new): a real Electron
  flow — B connects and opens Server Chat; A connects, sends a Server Chat message (observed live by
  B), joins the "general" voice channel, and sends a Channel Chat message; A and B exit; the real
  Dedicated Server process is stopped (`SIGTERM`) and restarted against the _same_ data directory;
  Electron C — a genuinely different `--user-data-dir` (fresh local identity, no relationship to A
  or B) — connects and retrieves both messages purely through the history API, confirmed never
  received as a live event. **Four consecutive clean runs** (two before the OvniChat product-naming
  UI changes, two more after them against a freshly repackaged Electron build).
- **`e2e:authorization`, `e2e:connection-smoke`, `e2e:identity-auth`, `e2e:identity-persistence`,
  `e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`, `e2e:screen-audio-smoke`**: all
  re-verified passing (one run each) against the freshly repackaged build carrying the full T10 chat
  surface and the OvniChat naming changes — no regression. `e2e:authorization` and
  `e2e:connection-smoke` additionally show the new `disco-voador:chat-history:` marker firing
  automatically (via `ChatPanel` mounting once connected), confirming the new UI integrates cleanly
  alongside every pre-existing scenario without being specifically driven by them.

### Security and QA review

`security-reviewer` and `qa-engineer` were dispatched independently against the full T10 surface.
Both reported **no release-blocking findings**. One real, non-blocking issue was found and fixed;
several real coverage gaps were found and closed with new regression tests.

**Security review** — verdict: no release-blocking findings. Verified directly against code (not
doc-trust): sender spoofing is structurally impossible (`.strict()` schemas with no sender field;
`senderIdentityId`/`senderNickname` always come from `ctx.identityId`/`ctx.nickname`, never from the
parsed client message); `ChatStore` uses parameterized SQL throughout; send-side authorization and
channel-membership checks run server-side before persistence; history-read asymmetry is exactly as
narrow as documented (only a `CHANNEL_NOT_FOUND` check, no other gating); pagination bounds are
enforced at the schema layer with no bypass found; message-size bounds are enforced before domain
logic ever runs; a storage failure never produces a false-success broadcast (`ChatStore` never
catches its own SQL errors, letting them propagate to the same outer `try/catch` every other
unexpected handler failure already uses); the `ChatPort` interface never returns a sender's stable
`identityId` to `services/realtime` at all; `ChatPanel.tsx` never uses `dangerouslySetInnerHTML`;
the data-minimization and cross-server-isolation tests genuinely test real persisted files/real
sockets, not tautologies; store separation (`chat.sqlite` vs. `authorization.sqlite`) is structural,
not just documented; the new E2E automation hooks are correctly double-gated
(`!app.isPackaged` + explicit env var).

One **Low-severity, non-blocking** finding: the Renderer's `use-voice-channel.ts` logs an
unconditional `console.info` diagnostic marker including the full message body on every chat event
(`onChatMessage`/`onChatHistoryPage`) — the same `disco-voador:*` marker convention every other
T7-T10 E2E scenario in this codebase already uses, and which `e2e-text-chat-persistence.mjs`
depends on to verify a specific persisted string reappeared. This contradicted an earlier,
too-absolute version of this document's and `docs/SECURITY.md`'s "message bodies are never logged"
wording. **Fixed** by correcting both documents to scope that claim precisely to the Dedicated
Server's own application logs (which genuinely never log a body, verified directly) and explicitly
naming the Renderer's E2E-diagnostic console marker as the one documented client-side exception —
low practical exposure, since a packaged build always disables DevTools
(`apps/desktop/src/main/window.ts`), and the corresponding Main-process relay of this output
requires an explicit env var plus `!app.isPackaged`. See
[`../architecture/PERSISTENT_TEXT_CHAT.md`](../architecture/PERSISTENT_TEXT_CHAT.md)'s "Logging"
section for the corrected statement. A related residual-risk item (chat storage has no retention
policy yet and per-connection rate limiting doesn't cap aggregate server-wide write volume) was
recorded as a documented, accepted, explicitly-deferred tradeoff, not a T10 defect — see that same
document's "Known limitations."

**QA review** — independently re-ran the full test suite, `pnpm lint`/`typecheck`/`build`, and the
complete `pnpm check` pipeline (all green); independently ran `e2e-text-chat-persistence.mjs` and
re-verified `e2e:authorization`, `e2e:connection-smoke`, `e2e:identity-auth`,
`e2e:identity-persistence`, `e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke` against the
current build (all passing; `e2e:screen-audio-smoke` was already running elsewhere in the same
session and deliberately skipped by instruction, separately re-verified by the orchestrating
session). Independently verified the Guest-chat-creates-no-membership-row claim with a standalone
script inspecting both real SQLite files directly, not just trusting the existing automated test.

QA found and closed several real, pre-existing coverage gaps by adding new regression tests (no
product/behavior code was changed): no protocol-schema test file had ever existed for chat
(`tests/protocol/chat-messages.test.ts`, new, 28 tests: body bounds/control-characters/Unicode/
hostile-HTML-as-plain-text, `.strict()` anti-spoofing, scope/channelId refinement, pagination
bounds); `CHAT_RATE_LIMITED` had no test at any layer for either bucket (2 new real-socket tests);
the oversized-body and oversized-history-`limit` `INVALID_MESSAGE` paths had no test for chat
specifically (2 new real-socket tests, confirming both are fatal/connection-closing, consistent with
this codebase's existing schema-violation convention); `AUTHORIZATION_DENIED` for missing
`chat.server.send` had no real-socket-level test (1 new); a real-socket, real-restart Unicode and
hostile-HTML round-trip test was missing (2 new); nickname-at-send permanence had no real-reconnect
-level test (1 new). Total added: 9 tests in `tests/dedicated-server/integration.test.ts` plus the
28 in the new protocol-schema file.

QA also flagged, and the orchestrating session closed immediately after: `mergeChatMessages`/
`chatThreadKey` (the client-side live/history dedup-and-reconciliation logic in
`use-voice-channel.ts`) had no dedicated unit test despite being load-bearing, only exercised
indirectly through the full hook. Both functions were exported (mechanical, no behavior change) and
a new `tests/desktop/use-voice-channel-chat.test.ts` (11 tests) now covers deduplication, ascending
re-sort, and out-of-order live/history arrival directly — mirroring `RemoteMediaReconciler`'s own
T3-T6 precedent for keeping a reconciliation-shaped concern independently testable.

Two items QA explicitly flagged as **not independently forced**, with reasoning for why residual
risk is low rather than treating them as unresolved gaps: (1) stored-XSS inertness was verified by
code inspection (`ChatPanel.tsx` never uses `dangerouslySetInnerHTML`; the wire/storage round-trip
of a literal `<script>` body was verified byte-for-byte through a real restart) but not by literally
querying a live Chromium DOM — React's plain-text-child HTML-escaping is a structural, not a
runtime-togglable, guarantee, and the code path is identical for live and historical messages; (2) a
genuine SQLite write failure was not artificially forced (deterministic injection risks flakiness),
but the code path was traced directly (`handleChatSend` only ever broadcasts from an already-`ok`
store result; `ChatStore` never catches its own SQL errors, so a real failure reaches the same outer
`try/catch` an existing unit test already proves contains an equivalent failure correctly).

**Post-review verification**: `corepack pnpm check` — Prettier, ESLint, whole-repo typecheck,
`vitest run` (56 files, **823 tests**, up from 776 before the review-driven additions), composite
build, `verify-repository.mjs`, and the dependency audit all pass.

### Privacy statement

T10 changes what "a Guest creates no persistent server data" means, and this document states the
correction explicitly rather than leaving the old T9-era claim uncorrected: an ordinary Guest
_connection_ alone still creates no persistent authorization profile (T9's guarantee is unchanged).
**If that Guest sends a chat message, the independently-operated Dedicated Server stores that
message and its minimal authorship metadata** (identityId, nickname-at-send, body, timestamp,
scope/channel) — this is intentional and is the entire point of persistent chat, not a regression.
It does **not** create a T9 authorization membership/profile row merely because a message was sent;
those remain two independent facts about an identity on a given server. No email, phone, real name,
hardware fingerprint, IP address, or central-service copy of any message ever exists. No message
body is duplicated into ordinary application logs. Two independent Dedicated Servers share no chat
history, exactly as they share no authorization state (T9).

### Next task

T11 — Devices / Bookmarks / Reconnect / Product UX is next, not started. Do not implement it as
part of T10.
