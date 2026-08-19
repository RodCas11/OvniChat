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
