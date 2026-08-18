# Media core package boundary

Generic, environment-neutral semantic media-source abstractions (see `docs/ARCHITECTURE.md`'s
semantic media-source model: `microphone`, `camera`, `screen-video`, `screen-audio` are independent
sources). Independent of Electron and native Windows implementations — only standard Web/DOM
platform types (`MediaStreamTrack`, `navigator.mediaDevices`, etc.).

## What T3 implements

- `acquireMicrophone` (`src/microphone.ts`): requests audio-only microphone access via
  `getUserMedia`. Defaults `echoCancellation`/`noiseSuppression`/`autoGainControl` to `true` (each
  individually overridable); these are bare-boolean, spec-`ideal` constraints, so a device that
  cannot honor one still captures without it rather than failing outright. If the request
  specifically fails with `OverconstrainedError`, it retries once with no audio constraints at all
  before giving up — a guard for caller-supplied stricter constraints or a non-compliant platform,
  not an expected everyday path.
- `Microphone` (`src/microphone.ts`): the acquired `track`/`stream`, `muted` state, `setMuted()`
  (sets `track.enabled` — never destroys/reacquires the device to mute), and `stop()` (stops the
  underlying track(s); the instance is dead afterward).
- `MicrophoneAccessError` / `classifyMicrophoneErrorReason` (`src/microphone-errors.ts`): classifies
  a raw `getUserMedia` rejection into a small closed set —`'permission-denied'`,
  `'device-not-found'`, `'device-unavailable'`, `'unknown'` — by inspecting `DOMException.name`
  only, never a platform-authored message string.

## Testing

`classifyMicrophoneErrorReason`'s mapping table and `MicrophoneAccessError` are unit-tested
directly under `tests/media-core/`. `acquireMicrophone` is unit-tested against a stubbed
`navigator.mediaDevices.getUserMedia` (constraint defaulting/overriding, the overconstrained
fallback, mute/stop semantics, error-classification wiring) — this proves this package's own
orchestration, not that a real device or real browser constraint negotiation behaves as expected;
that requires a real Electron Renderer.
