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
combination, is denied. Screen-capture permission gating (indicator, stop control, source-choice
consent) remains unimplemented until T5.

**Test-only automation flags, and why they can't leak into a real build:** `DISCO_VOADOR_E2E_FAKE_MEDIA`
(Chromium's fake-microphone-and-camera command-line switches — the same single switch provides
both) and `DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL`/`_DISPLAY_NAME`/`_AUTO_CAMERA`/
`_AUTO_CAMERA_OFF_MS` (auto-join a voice channel and optionally auto-toggle the camera with no user
interaction, for the scripted two-instance voice/camera smoke tests) are all read from the
environment but gated a second time behind `!app.isPackaged` before they can take effect —
`app.isPackaged` reflects how the binary was actually built/launched, not anything an environment
variable can spoof, so a packaged/distributed build can never activate any of them regardless of
what surrounds its environment. This is the reusable pattern for any future test-only automation
hook: gate on the env var for opt-in, and separately on `!app.isPackaged` for an unspoofable
production kill-switch, checked at every point that matters (command-line switches in
`main/index.ts`, and again before the IPC channel that exposes the config to the Renderer in
`main/window.ts`).

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
size is bounded (8192 / 1024 bytes) so a hostile client cannot smuggle an oversized payload inside an
otherwise-small signaling message.

Authentication and authorization details remain open for T2/T7 and require an explicit threat
review before public exposure.

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
