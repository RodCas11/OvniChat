# Security architecture

Security boundaries are product architecture, not post-release hardening. T0 establishes the
following requirements; later tasks must implement and test them.

## Electron boundary

Every application window must explicitly set:

```ts
nodeIntegration: false;
contextIsolation: true;
sandbox: true;
```

Defaults can change or be overridden, so tests must inspect the actual window preferences. Keep
`webSecurity` enabled. Prefer a registered secure custom application protocol over `file://` once
the T1 shell establishes loading. Apply a restrictive Content Security Policy without unsafe
script evaluation.

Preload exposes one narrow, typed method per capability through `contextBridge`. It must never
expose raw `ipcRenderer`, generic channel names, Node globals, filesystem access, shell execution,
or an arbitrary command/path API. Main must validate the sender frame/origin and runtime-validate
every argument before privileged work.

Deny unexpected navigation, new-window creation, external protocol handling, and remote content.
Open external URLs only through an explicit allowlist and user action.

## Media permissions and capture

Electron permission requests are not safe merely because the Renderer is local. Install both
`setPermissionCheckHandler` and `setPermissionRequestHandler`; default-deny unknown origins,
frames, permission kinds, and media types. Display capture must follow an active user gesture and an
explicit source choice—never silently grant the first enumerated screen/window.

Treat source titles, thumbnails, device labels, PIDs, and capture contents as sensitive. Render
names as untrusted text and do not log them. Show an active capture indicator and reliable stop
control. Stop all owned tracks during teardown.

**Implemented (T3 microphone, T4 camera):** `apps/desktop/src/main/permissions.ts` installs both
handlers and grants exactly two cases — `permission === 'media'` where the request is audio-only
**or** video-only (never both in the same `mediaTypes` array; microphone and camera are always two
independent `getUserMedia` calls, never one combined request) **and** the requesting origin matches
the app's own allowed-origins list. Every other permission kind, and every other media/origin
combination, is denied.

**Implemented (T5 screen/window capture):** display capture is a materially different grant path
from `getUserMedia` — see `permissions.ts`'s `isDisplayCaptureRequest` doc comment for the research
this is based on (this app's pinned Electron version's own C++ source). The actual grant decision
lives in `apps/desktop/src/main/screen-share.ts`'s `session.setDisplayMediaRequestHandler()`, not
in the permission handlers: source enumeration (`desktopCapturer.getSources()`) is sanitized to
plain data before ever reaching the Renderer, a source can only be selected from the _most recent_
enumeration (a stale/previous-enumeration id is rejected), a successful selection is single-use
(consumed synchronously as the first thing the handler does, so a second concurrent
`getDisplayMedia()` call can never observe or reuse it), the id is re-resolved against Main's own
cached native source list before granting (never trusting the sanitized data the Renderer holds),
the request's origin is checked, and no source ever satisfies a request without an explicit prior
`selectScreenShareSource` call from a trusted sender — there is no default/first-enumerated-source
grant. A researched, documented residual finding (`permissions.ts`'s `isDisplayCaptureRequest` doc
comment) about a legacy `chromeMediaSource: 'screen'` `getUserMedia()` constraint form that does not
route through `setDisplayMediaRequestHandler` at all is flagged for ongoing `security-reviewer`
attention — this app's Renderer never invokes that legacy form itself, and is defended in depth
against reaching a state where it could (`sandbox: true`, `contextIsolation: true`, `script-src
'self'` CSP, no Node/filesystem exposure through Preload), but the residual risk is documented
rather than silently accepted. Source titles/names are rendered as plain text content only, never
interpolated into markup/attributes, and are not logged (see `ScreenSourcePicker.tsx`).

**Implemented (T6 system audio):** screen sharing may optionally also grant Windows system-audio
loopback (`audio: 'loopback'` — Electron's documented, Windows-only mechanism confirmed against
this app's pinned Electron version's own type definitions; never the legacy `chromeMediaSource`
path) — never silently, only when the user's explicit per-share "Share audio" choice, the
platform's own confirmation the Renderer's `getDisplayMedia()` call actually requested audio
(`request.audioRequested`), and `process.platform === 'win32'` all independently agree. That choice
is armed in the same single-use `pendingSelection` as the video source (`{sourceId, shareAudio}`),
consumed by the same synchronous, single-use, origin-checked `setDisplayMediaRequestHandler` path
above — there is no separate, independently-timed audio permission step. A T6 security review noted
that the pre-existing T5 residual race (a second concurrent `getDisplayMedia()` call from an
already-arbitrary-script-execution Renderer racing to consume an armed selection before the
legitimate caller does) now can also yield the audio grant when the legitimately-armed selection
requested one, not only video — the same precondition and defense-in-depth already documented above
apply; this does not weaken the three-way check itself, only widens what an already-documented race
could obtain. Microphone is now announced through the same `media:track-source` mechanism camera and
screen-video already used (`packages/protocol`'s `TrackSource` gained `'microphone'`/`'screen-audio'`
members) — server-side forwarding continues to derive `sourceParticipantId` from the sender's own
voice-registry membership, never from client-supplied data, unaffected by the schema widening.

**Test-only automation flags, and why they can't leak into a real build:** `DISCO_VOADOR_E2E_FAKE_MEDIA`
(Chromium's fake-microphone-and-camera command-line switches — the same single switch provides
both), `DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL`/`_DISPLAY_NAME`/`_AUTO_CAMERA`/
`_AUTO_CAMERA_OFF_MS`/`_AUTO_SCREEN_SHARE`/`_AUTO_SCREEN_SHARE_OFF_MS` (auto-join a voice channel
and optionally auto-toggle the camera/screen share with no user interaction, for the scripted
two-instance voice/camera/screen smoke tests), and `DISCO_VOADOR_E2E_SCREEN_SMOKE` (arms the
screen-share smoke test's console-relay exit watcher) are all read from the environment but gated a
second time behind `!app.isPackaged` before they can take effect — `app.isPackaged` reflects how
the binary was actually built/launched, not anything an environment variable can spoof, so a
packaged/distributed build can never activate any of them regardless of what surrounds its
environment. T5's screen-share auto-selection deliberately does **not** add a special test-only IPC
channel for this — the E2E flow drives the exact same `listScreenShareSources`/
`selectScreenShareSource` production IPC a real picker uses, just choosing whichever screen source
sorts first automatically, so there is no additional privileged surface introduced purely for
testing. This is the reusable pattern for any future test-only automation hook: gate on the env var
for opt-in, and separately on `!app.isPackaged` for an unspoofable production kill-switch, checked
at every point that matters (command-line switches in `main/index.ts`, and again before the IPC
channel that exposes the config to the Renderer in `main/window.ts`).

## Realtime and protocol

- Runtime-validate every inbound and outbound protocol envelope at trust boundaries.
- Bound message size, collection lengths, rates, timeouts, and connection resource use.
- Associate actions with the authenticated/authorized session model selected by its task.
- Reject unknown message versions/types predictably; never dispatch arbitrary method names.
- Do not evaluate received code, interpolate it into shell/database commands, or trust client state.
- Signaling carries control/SDP/ICE only; reject attempted media payload tunneling.
- Design reconnection and idempotency so replay cannot duplicate destructive state transitions.

**Implemented (T3):** `webrtc:offer`/`answer`/`ice-candidate` forwarding never trusts a client's
claimed identity — the forwarded message's `sourceParticipantId` is always derived server-side from
the sending connection's own voice-registry membership (`services/realtime/src/protocol-handlers.ts`'s
`buildForwardedSignal`), never read from the client's message body. Signaling is only forwarded
between two connections confirmed to be in the _same_ voice channel
(`VoiceRegistry.resolveSignalingTarget`); a sender not in any channel, a target in a different
channel, or a self-targeted signal are all rejected without closing the connection (non-fatal, per
the closed error-code-to-close-code mapping in `packages/protocol/src/errors.ts`). SDP and ICE
candidates are bounded opaque strings/structures the server never parses semantically — only their
size is bounded (65536 / 1024 bytes; the SDP bound was raised from an original 8192 in T5 after live
testing found a genuine 3-media-source offer exceeding it, then raised again in T6 after live
testing found a genuine 4-media-source offer (with a screen-share re-share cycle) measuring 25,235
characters against the T5-era 24576 bound — see `packages/protocol/src/messages/webrtc.ts`'s
`SDP_MAX_LENGTH` doc comment) so a hostile client cannot smuggle an oversized payload inside an
otherwise-small signaling message. The realtime service's transport-level
`REALTIME_MAX_MESSAGE_BYTES` (`services/realtime/src/config.ts`) was raised alongside it each time
(16 KiB → 32 KiB for T5, 32 KiB → 80 KiB for T6) and deliberately kept with headroom above the SDP
bound, not sized identically to it, once JSON envelope overhead and `\r\n` escaping are accounted
for.

**Implemented (T5):** `media:track-source` (the semantic camera-vs-screen-video identity
announcement — see `docs/architecture/WEBRTC_SCREEN_SHARE.md`) follows the exact same
never-trust-client-identity pattern as `webrtc:offer`/`answer`/`ice-candidate`: the forwarded
message's `sourceParticipantId` is always server-derived from the sender's own voice-registry
membership, never read from the client's message body, and delivery is targeted (resolved via the
same `resolveSignalingTarget`, same same-channel-only authorization) rather than a channel-wide
broadcast.

**Implemented (T7 — client identity and authentication):** every connection must complete a
challenge/response proof of private-key possession before it reaches `ready` — see
`docs/architecture/CLIENT_IDENTITY.md` for the full design. Key points relevant to this document:

- The private key is generated and used exclusively in the Electron Main process; it never crosses
  the Preload/Renderer boundary in any form, is never logged, and is never included in an error
  message or IPC response. `apps/desktop/src/main/identity/identity-service.ts` is the only place a
  decrypted private key ever exists in memory.
- At rest, the private key is encrypted via Electron's `safeStorage` (Windows DPAPI-backed) before
  ever touching disk (`%APPDATA%/DiscoVoador/identity/identity.json`, atomic write). If
  `safeStorage.isEncryptionAvailable()` is `false`, identity creation/load fails closed — throws an
  actionable error — rather than falling back to a plaintext file.
- The Renderer's IPC surface for identity (`getIdentity`, `signIdentityChallenge`,
  `regenerateIdentity`, `getNickname`, `setNickname`) goes through the same `assertTrustedSender`
  origin/sender check every other IPC channel in this app uses. `signIdentityChallenge` is
  deliberately not a generic signing oracle: it accepts only structured, individually-bounded
  parameters (mirroring the wire protocol's own schemas exactly), and Main reconstructs the
  canonical payload itself from its own stored public key — a compromised Renderer can only ever
  obtain a signature over this one specific domain-separated identity-auth message shape.
  `regenerateIdentity` is confirmation-gated in the Renderer UI, but that gate is a UX safeguard for
  the legitimate user, not an independent security boundary — a Renderer compromise capable of
  calling it unprompted already has equivalent access via `signIdentityChallenge` (full
  impersonation of the current identity), so this does not materially widen what such a compromise
  could already do.
- The server (`services/realtime`) never trusts a client-supplied `identityId` — it always derives
  one itself (`SHA-256` of the verified public key) after signature verification succeeds. The
  identity-challenge nonce uses `node:crypto`'s `randomBytes`, is single-use, connection-bound
  (embedded in the signed payload alongside `connectionId`), and expires
  (`REALTIME_IDENTITY_CHALLENGE_TTL_MS`, default 10s). The existing per-connection handshake timeout
  (`REALTIME_HANDSHAKE_TIMEOUT_MS`) now also covers the new `awaiting_identity_proof` state, so an
  idle unauthenticated connection can never be left open indefinitely regardless of which half of
  the two-step handshake it stalls in.
- `packages/identity` (the Node-only Ed25519 implementation) is architecturally forbidden from ever
  being imported by Renderer/Preload code or by the environment-neutral packages (`protocol`,
  `rtc-core`, `media-core`, `shared`) — enforced by `scripts/verify-architecture.mjs`'s `isIdentity()`
  check, the same pattern already used for `packages/windows-media`.
- T7 introduces no central account database, no email/password/phone collection, and no
  cross-server identity-correlation service — the realtime server holds identity state only for a
  connection's lifetime.

Authorization (server-local permissions, groups, invite/privilege tokens, bans keyed by
`identityId`) remains open for T9 and requires its own explicit threat review before public
exposure — T7 only establishes _who_ a connection is, never _what it's allowed to do_.

**Implemented (T8 — Dedicated Server product boundary):** see
`docs/architecture/DEDICATED_SERVER.md` for the full design. Key points relevant to this document:

- The Dedicated Server's config file (`disco-voador-server.config.json` by default) is
  `.strict()`-validated `zod` JSON — an unknown key, malformed JSON, an out-of-range port, or a
  duplicate voice-channel id all fail server startup loudly (`ServerConfigFileError`) rather than
  silently falling back to defaults. It never contains credentials, client identity private keys, or
  any account data — only display/network/channel configuration (T8 Section 11/35).
  `services/dedicated-server` introduces no `server-users.json`/`users.db`/`accounts.sqlite` or any
  equivalent.
- `REALTIME_HOST` still defaults to `127.0.0.1` — a Dedicated Server never listens beyond localhost
  without an explicit operator choice (config file `host` or `REALTIME_HOST`); T8 introduced no
  hidden default that widens this.
- `server:hello` (sent only after T7's identity-proof step succeeds — T8 changes nothing about when
  or whether it is sent) gained required `serverName`/`serverCapabilities` fields, both bounded and
  schema-validated (`packages/protocol/src/server-metadata.ts`: name 1-100 chars with control
  characters rejected, capabilities a closed enum bounded to 16 entries) on both send and receive.
  `serverName` is operator-controlled display text; the Renderer renders it as plain text content,
  never interpolated into markup/attributes, consistent with how source titles/device labels are
  already handled (see above). Protocol version bumped 2 → 3 — an incompatible client/server pairing
  fails closed with `UNSUPPORTED_PROTOCOL`, the same defined failure T2 already established, not
  undefined behavior.
- Voice channels are now server-owned configuration delivered via the existing, already-validated
  `voice:catalog` message — no second, parallel HTTP/REST API was introduced for server metadata or
  channel discovery.
- The client's manually entered server address (`apps/desktop/src/renderer/connection/
parse-server-address.ts`) is parsed with the platform's own `URL` parser rather than hand-rolled
  string splitting (which breaks on IPv6), bounds input length, and rejects any address carrying a
  path/query/fragment/credentials component — a pasted invite URL or malformed string can never
  silently connect somewhere the user did not intend. It only ever produces a `ws://` URL; `wss://`
  production addressing is deferred to T13.
- Connecting to a second, different server reuses the same effect-teardown lifecycle T3-T7 already
  established (`use-voice-channel.ts`'s cleanup on `realtimeConfig` change/unmount) — no new
  teardown logic was added, and no server-specific session state (WebSocket, peer connections,
  voice-channel membership, media) can leak from one server connection into the next; the local T7
  identity is unaffected, since it lives entirely outside that component tree.
- Two independently configured Dedicated Server instances share no mutable state — each
  `createDedicatedServer(config)` call composes its own `createRealtimeServer` with its own closed-
  over configuration; nothing module-level is shared between two servers running in the same
  process (relevant because `tests/dedicated-server/integration.test.ts` runs two real instances in
  one Vitest process to prove this).
- All new T8 E2E-only automation (`DISCO_VOADOR_E2E_CONNECTION_SMOKE`, the `disco-voador:
server-name:` console marker, the `AutoConnect` component) follows the same unspoofable
  `!app.isPackaged` + explicit-env-var gating pattern documented above — traced directly, not just
  by doc comment.
- T8 introduces no telemetry, analytics, or phone-home mechanism, and no cross-server correlation:
  the same local identity may authenticate independently to any number of Dedicated Servers with no
  service anywhere aware of more than one connection at a time.
- **CSP `connect-src` finding, fixed during T8's own security review**: through T7, the realtime
  server address was fixed operator/deployment configuration, letting the Renderer's CSP
  `connect-src` allowlist one exact pre-declared origin. T8's `ConnectionScreen` made the address a
  genuine runtime, user-typed value — but the CSP wiring was not updated to match, so a real user
  typing any address other than the one baked in via `DISCO_VOADOR_REALTIME_URL` at launch would have
  had every connection attempt silently blocked by Chromium's own CSP enforcement, defeating T8's
  core "connect to whichever address your operator gives you" deliverable outside of test tooling
  that manipulates environment variables. `security-reviewer` found this; fixed by scoping
  `connect-src` to the `ws:`/`wss:` schemes generically (`content-security-policy.ts`) instead of one
  pre-declared origin — every other directive (`default-src`, `script-src`, no `https:`/`http:` in
  `connect-src`) remains as restrictive as before, so this narrows the necessarily-dynamic target
  down to exactly one channel (WebSocket) rather than general network access. A compromised Renderer
  gaining the ability to open a WebSocket to an address of its choosing is an accepted consequence of
  the product itself letting a legitimate user choose any self-hosted server address — not a gap this
  CSP directive could have meaningfully closed once that became a real feature.

**Implemented (T9 — server-local authorization):** see `docs/architecture/SERVER_AUTHORIZATION.md`
for the full design. Key points relevant to this document:

- Admission (ban check, invite-only requirements) is evaluated inside the same
  `handleIdentityProof` function T7 already gated `ready` behind — a connection reaches `ready` only
  after _both_ a verified identity proof _and_ a successful admission decision. No new codepath can
  skip either half.
- The Dedicated Server's authorization store (`services/dedicated-server/src/authorization/
store.ts`) uses `node:sqlite`'s parameterized queries throughout (`?` placeholders) — no raw SQL
  string interpolation of any client-supplied value anywhere in the module.
- Token redemption (privilege keys, invite tokens, the bootstrap admin token) is atomic by
  construction: a single SQL compare-and-swap (`UPDATE ... WHERE consumed_at IS NULL`) inside one
  transaction, executed synchronously with no `await` between the check and the write — two
  "simultaneous" redemption attempts are actually serialized by Node's own single-threaded event
  loop, so exactly one can ever win. See
  `docs/adr/0013-server-authorization-storage-and-rbac.md` for why this was a correctness
  requirement, not an optimization.
- Raw bearer tokens are never persisted — only a SHA-256 digest. The one-time bootstrap Server Admin
  token is printed to the operator's own console exactly once (a genuinely fresh authorization
  store only), never through the structured logger, never repeated on a later restart.
- Every `client:authorization-*` mutation is permission-checked server-side
  (`services/realtime/src/protocol-handlers.ts`) against the _caller's own_ current permissions
  before the mutation runs — client UI (`AuthorizationPanel.tsx`) hiding a section is a presentation
  courtesy only, never the actual boundary; a Guest hand-crafting an admin-only message is rejected
  identically regardless of what its own UI shows.
- Moderation targets (grant/revoke/kick/ban) are always resolved server-side from a
  `targetParticipantId` via `VoiceRegistry`, never trusted as a client-supplied identity — the one
  documented exception is `client:authorization-unban`'s `identityId` field, since an administrator
  managing bans has no online participant to target and this view is never shown to an ordinary
  user (T9 Section 25); it remains gated behind the same `moderation.ban` permission check as
  ban/list-bans.
- An admitted Guest with no concrete authorization event (no redemption, no admin grant, no ban)
  writes no row to the authorization store — data minimization verified directly against the real
  SQLite file, not just the store's own read path.
- T9 introduces the Dedicated Server's first persistent runtime state but no new categories of
  sensitive data beyond what server-local authorization strictly requires: `identityId`s, group
  memberships, token digests, and ban records — never email, phone, real name, password, hardware
  fingerprint, or IP address.

**Implemented (T10 — persistent server-side text chat):** see
`docs/architecture/PERSISTENT_TEXT_CHAT.md` for the full design. Key points relevant to this
document:

- The chat store (`services/dedicated-server/src/chat/store.ts`) uses `node:sqlite`'s parameterized
  queries throughout, matching T9's own `AuthorizationStore` discipline — no raw SQL string
  interpolation of any client-supplied value (message body, nickname, channelId, or pagination
  cursor) anywhere in the module.
- The server always derives the sender's identity and current nickname from the already-verified
  connection — `client:chat-send`/`client:chat-history-request` carry no sender field at all, so
  there is nothing for a client to spoof; a raw protocol client attempting to set one is rejected
  outright by `.strict()` schema validation.
- Persisted content is treated as hostile content: the Renderer's chat panel
  (`apps/desktop/src/renderer/voice/ChatPanel.tsx`) never uses `dangerouslySetInnerHTML` — every
  message body renders as plain React text content (HTML-escaped by construction) for both a live
  message and one loaded from history, so a persisted `<script>...</script>` body renders as inert
  literal text indefinitely, including after a server restart. Verified directly by a real end-to-end
  run that stores such a body and reloads it through the history API.
- Sending is permission-gated server-side (`chat.server.send`/`chat.channel.send`); channel-scoped
  sending additionally requires the sender's _current_ voice-channel membership, resolved
  server-side the same way every other T9 moderation/signaling target already is — never trusted
  from client-supplied state. Reading history requires no permission (this repository has no
  channel-visibility ACL beyond server admission), a deliberate, documented asymmetry, not an
  oversight.
- History requests are bounded (`limit` capped by schema, defaulting server-side when omitted) and
  additionally rate-limited per connection, separately from the existing generic transport-level
  limiter — persistent storage makes an unbounded read/write flood materially more expensive than
  T2's original in-memory-only threat model assumed.
- Message bodies are never written to the Dedicated Server's structured logger or any other
  server-side application log — the chat store is the one intentional copy of message content; a
  storage failure on send is contained by the same outer `try/catch` every other unexpected handler
  failure already goes through, which logs only `error.message`, never any part of the triggering
  message. **One documented client-side exception**, found by `security-reviewer` during T10's own
  review: the Renderer's `use-voice-channel.ts` logs an unconditional `console.info` diagnostic
  marker (including the body) on every chat event, the same pattern every other T7-T10 E2E scenario
  already uses and the new text-chat E2E script depends on. Practical exposure is low — a packaged
  build always disables DevTools, so this output is unobservable in a real end-user install, and the
  Main-process relay of it requires an explicit env var plus `!app.isPackaged` — but it is a real,
  intentional exception to the "never logged" statement above, not covered by it. See
  `docs/architecture/PERSISTENT_TEXT_CHAT.md`'s "Logging" section for the full, corrected statement.
- The chat store never returns a sender's stable `identityId` to `services/realtime` at all (not
  merely omitted on the wire) — there is currently no feature that needs it past the point of
  persisting the row, so the narrowest possible `ChatPort` surface was kept narrow.
- `chat.sqlite` is a physically separate file from `authorization.sqlite` (see
  `docs/adr/0014-persistent-server-owned-chat-history.md`) specifically so a chat-store problem can
  never reach — at the storage-engine level, not merely by discipline — the authorization data T9
  already treats as fail-closed and never-silently-discardable.
- Two independent Dedicated Servers share no chat history whatsoever, verified directly over real
  sockets, the same isolation guarantee T9 already established for authorization state.
- A Guest sending a chat message creates a persistent message row (identityId, nickname-at-send,
  body, timestamp) but this does **not** create a T9 `identity_group_memberships` row — verified by
  inspecting the real `authorization.sqlite` file directly after a Guest chat send. This is a real,
  documented change to the previous "a Guest creates no persistent server data" statement — see
  `docs/architecture/PERSISTENT_TEXT_CHAT.md`'s "Data minimization change from T9" section for the
  precise, corrected claim.

**Implemented (T11 — local client settings, bookmarks, device management, automatic reconnect):** see
`docs/architecture/CLIENT_SETTINGS_AND_RECONNECT.md` for the full design. Key points relevant to this
document:

- The new local settings file (`apps/desktop/src/main/settings/settings-file.ts`,
  `%APPDATA%/DiscoVoador/settings.json`) holds only client-local preference data — device ids, a
  screen-quality preset, mute/deafen-on-launch flags, `connectOnStartup`, and server bookmarks. It
  never contains an invite/privilege/bootstrap bearer token: `ConnectionScreen`'s token field remains
  exactly as ephemeral as it was before T11 (cleared immediately after one connect attempt, T9 Section
  72), and no code path threads it into a bookmark. Verified directly against the bookmark input type
  (`BookmarkInput`/`DesktopBookmarkInput`), which structurally has no token-shaped field, and by a
  dedicated test asserting the on-disk shape of a persisted bookmark has exactly three keys.
- The five new IPC methods (`getClientSettings`, `updateClientSettings`, `addBookmark`,
  `updateBookmark`, `removeBookmark`) each validate the Renderer-supplied argument against a
  `.strict()` zod schema in `main/ipc.ts` before it ever reaches the settings store — the same
  "never trust the Renderer's shape" discipline `signIdentityChallenge` already established — and go
  through the existing `assertTrustedSender` origin/sender check every other IPC channel uses. No new
  raw filesystem, `ipcRenderer`, or generic-channel access was introduced.
- A corrupted `settings.json` is never silently destroyed: the original is renamed aside
  (`settings.json.corrupted-<timestamp>`), never overwritten or deleted in place, before a
  section-by-section salvage (only the genuinely malformed sections fall back to defaults) is written
  as the replacement. Settings are not security-sensitive, so this is a fail-open (not fail-closed,
  unlike identity) recovery discipline — see ADR 0015.
- Automatic reconnect (`apps/desktop/src/renderer/realtime/reconnect-controller.ts`) never caches or
  replays an identity proof: every reconnect attempt performs the complete T7 challenge/response
  handshake from scratch, with a fresh server-issued nonce, exactly like any other connection. T9
  admission (ban check, invite-only membership) is re-evaluated identically on every reconnect — a
  ban applied while a client is disconnected is enforced on its very next reconnect attempt, not
  bypassed by whatever connection state preceded it.
- Reconnect logic is classified, not blind: `reconnect-policy.ts`'s `classifyCloseCode` never
  retry-loops against a definitive rejection (`BANNED`, `KICKED`, `INVITE_REQUIRED`, a protocol/
  identity error) or against a first connection attempt that never succeeded even once — only an
  already-established session's unexpected loss is retried automatically, with a bounded (1s-30s,
  jittered) backoff and no bound on total retry duration short of an explicit user cancel/disconnect.
- Camera and screen-video/audio are never automatically restarted after a reconnect — released
  immediately when a loss is detected, restored only by an explicit, fresh user action afterward. This
  is a mandatory, non-negotiable privacy constraint (not merely a default), verified directly by
  `e2e:reconnect-smoke`'s own assertion that neither ever shows evidence of activity across a full
  disconnect/reconnect cycle in which neither was ever manually re-enabled.
- No new telemetry, analytics, or phone-home mechanism of any kind — device ids, bookmarks, and
  connection/reconnect state are never sent to any Dedicated Server or any other destination.
- Device enumeration (`navigator.mediaDevices.enumerateDevices()`) and live device switching
  (`switchMicrophone`/`switchCamera`, via `packages/rtc-core`'s new `MediaTransport.replaceTrack`)
  are pure Renderer/Web-API/`rtc-core` operations — neither crosses IPC, and neither widens the
  existing narrow `getUserMedia`/`getDisplayMedia` permission model (`main/permissions.ts`'s
  audio-only-or-video-only-never-both grant condition, and the requesting-origin check, are
  unaffected). One new IPC channel, `getE2ESettingsPersistenceConfig`, was added for the new
  E2E-only settings-persistence test harness, gated identically to every other `DesktopE2E*Config`
  channel (`!app.isPackaged` plus an explicit env var, checked at both the command-line-switch layer
  and again before the config is exposed to the Renderer) — it always resolves to `undefined` for a
  real, packaged build, exactly like `getE2EVoiceConfig`.
- `HTMLMediaElement.setSinkId()` (output-device selection) and the local microphone-level/output-test
  tools are pure Web Audio API usage — no recording, no upload, no new native/Electron capability
  exposed to the Renderer.
- Switching a microphone/camera device mid-call never renegotiates the peer connection (`replaceTrack`
  is a transceiver-level swap — see `docs/architecture/WEBRTC_VOICE.md`) and never widens what a
  remote participant can observe: the same track kind (audio/video) simply now carries different
  hardware's content, with no new signaling message or protocol surface introduced.

## Secrets and configuration

- No real credentials, private keys, TURN shared secret, auth tokens, or certificates in Git.
- Never embed durable TURN credentials in the desktop application.
- Keep local `.env`, key, certificate, and actual Coturn config files ignored and access-restricted.
- Redact secrets from logs, errors, crash reports, test snapshots, screenshots, and diagnostics.
- Rotate a secret immediately if it is exposed; removing it from the latest commit is insufficient.

`pnpm verify:secrets` is a high-confidence pattern check, not a complete secret scanner or substitute
for repository-host protections.

## Windows/native integration

Keep native functionality in `packages/windows-media` behind narrow interfaces. Renderer requests
use validated opaque identifiers rather than raw command lines or unrestricted paths. A helper must
authenticate/validate its local IPC, run with least privilege, bound memory and audio buffers, and
fail closed on protocol mismatch. Validate PIDs against reuse/exit races and never imply that a PID
equals a security identity.

Native capture requires visible consent and stop behavior even when Windows does not provide a
browser prompt. Protected media may be unavailable and must not be bypassed.

## TURN and self-hosting

- Use authenticated Coturn; anonymous relay is prohibited.
- Store the TURN REST shared secret only server-side and issue short-lived client credentials.
- Pin and review the image, apply quotas/rate limits, disable unused administration, and block
  multicast peers.
- Validate real allocations and forced relay; a running process is not a sufficient health check.
- Terminate TLS with real certificates. An ordinary HTTP reverse proxy cannot proxy TURN.

## Dependencies and upstream source

Pin deliberate versions, review release/security notes, preserve third-party notices, and update
Electron promptly because it carries Chromium security fixes. Do not copy implementation from
VDO.Ninja or its signaling server without the licensing workflow in
[`LICENSING.md`](LICENSING.md).

## Review triggers

Consult `security-reviewer` for privileged IPC, navigation/protocol handling, media permission,
authentication/authorization, externally reachable handlers, secrets, native helper boundaries,
TURN credentials, shell/path handling, and dependency risk. Record threat assumptions and actual
verification in the task handoff.
