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

## Realtime and protocol

- Runtime-validate every inbound and outbound protocol envelope at trust boundaries.
- Bound message size, collection lengths, rates, timeouts, and connection resource use.
- Associate actions with the authenticated/authorized session model selected by its task.
- Reject unknown message versions/types predictably; never dispatch arbitrary method names.
- Do not evaluate received code, interpolate it into shell/database commands, or trust client state.
- Signaling carries control/SDP/ICE only; reject attempted media payload tunneling.
- Design reconnection and idempotency so replay cannot duplicate destructive state transitions.

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
