# ADR 0016: Automatic reconnect as a wrapping controller, plus the media-restoration policy

## Status

Accepted and implemented (T11).

## Context

Through T10, `apps/desktop/src/renderer/realtime/realtime-client.ts`'s `RealtimeClient` had no
reconnect logic at all — every WebSocket close (explicit disconnect, server rejection, or a raw
network drop) was treated identically, and `use-voice-channel.ts` permanently tore down the
connection, transport, and all local media on any close. T11 required automatic reconnection with a
bounded backoff, voice-channel restoration, and an explicit, privacy-motivated policy on which local
media sources are allowed to come back on their own.

A `software-architect` review was conducted before implementation, covering three linked questions:
where the retry state machine should live, how it should interact with `use-voice-channel.ts`'s
existing effect/transport lifecycle, and whether adding `replaceTrack` to `packages/rtc-core`'s
`MediaTransport` interface (needed for T11's live device-switching feature, tracked separately)
threatens that interface's SFU-readiness contract. Only the first two are recorded here; the
`replaceTrack` addition is documented in `packages/rtc-core`'s own code and `docs/architecture/
WEBRTC_VOICE.md`.

## Decision

**A separate wrapping class, `apps/desktop/src/renderer/realtime/reconnect-controller.ts`'s
`ReconnectController`, not new states inside `RealtimeClient` itself.** `RealtimeClient` already
tolerates being `connect()`-ed again after a close (`connect()`'s own `if (this.socket) return` guard;
the `'close'` listener clears `this.socket`), so the controller owns exactly **one** `RealtimeClient`
instance for an entire connection sequence — including every automatic reconnect attempt — and only
ever calls `.connect()`/`.disconnect()` on it. This keeps every domain-event listener a caller
registers on `.client` (`catalog`, `joined`, `chatMessage`, ...) valid across every reconnect with no
re-subscription needed. Reconnect logic living in a separate, opt-in wrapper (rather than inside
`RealtimeClient` itself) also means the existing E2E scripts that construct `RealtimeClient` directly
(`e2e-identity-auth.mjs` and others, which expect today's simple "one connect, one final close"
semantics) are completely unaffected — only a caller that constructs a `ReconnectController` opts into
retry behavior.

One small, purely additive change to `RealtimeClient` itself was necessary: a new `closed` event
carrying the raw WebSocket close `code`/`reason`, fired immediately before the existing
`stateChange('closed')`. Nothing before T11 needed the actual close code — `reconnect-policy.ts`'s
`classifyCloseCode` needs it to decide retryable-vs-not, and the server already closes every fatal
condition with the specific numeric code matching its `ErrorCode` (`packages/protocol/src/
close-codes.ts`), so the raw code alone is sufficient; no correlation with a preceding `server:error`
message is needed.

**`transport` (the `P2PMeshTransport`) is rebuilt on every reconnect; `client` never is.** Every P2P
peer connection is unrecoverable once its signaling channel (the WebSocket) is gone, and
`P2PMeshTransport.closeAll()` is documented to permanently disable an instance — so a fresh session
needs a fresh mesh regardless of whether the underlying `RealtimeClient` survives. `use-voice-channel.ts`'s
main effect declares `transport` with `let`, not `const`, specifically so a `recreateTransport()`
function (invoked from the `'reconnecting'` handler) can reassign it in place; every other closure in
the effect that references `transport` (`onJoined`, `onLeft`, `releaseMicrophone`, etc.) automatically
observes the new instance on its next invocation, since a JavaScript closure captures the _binding_,
not a value snapshot — no changes were needed to any of those closures' own bodies.

**Bounded exponential backoff with jitter, reset on success, applied only to an already-established
session.** `INITIAL_BACKOFF_MS = 1000`, doubling, capped at `MAX_BACKOFF_MS = 30_000`, "equal jitter"
(half the delay fixed, half random) to avoid many clients retrying in lockstep after the same server
restart. Critically, `ReconnectController` only auto-retries a close if the controller has reached
`'open'` at least once during the current `connect()` sequence (`everReachedOpen`) — a **first**
connection attempt that fails (wrong address, refused, server not running) surfaces immediately as a
`connectionFailed` event and never silently retry-loops, regardless of whether its close code would
otherwise be classified retryable. Automatic reconnect is reserved for recovering an already-working
session's unexpected loss, not for guessing whether a first attempt might eventually succeed — this
was a deliberate design choice beyond what the task spec stated explicitly, made to avoid an opaque,
indefinite retry loop on a simple address typo.

**Close-code classification lives in `reconnect-policy.ts`, not inside the controller.** A small,
independently unit-tested pure function, `classifyCloseCode`, maps a numeric close code to
`'retry' | 'no-retry'` via `packages/protocol`'s own `CLOSE_CODES` map — non-retryable: a genuine
client/protocol bug (`INVALID_MESSAGE`, `UNSUPPORTED_PROTOCOL`, `HANDSHAKE_REQUIRED`,
`UNEXPECTED_MESSAGE`, `MESSAGE_TOO_LARGE`), a broken local identity (`IDENTITY_INVALID_PUBLIC_KEY`,
`IDENTITY_INVALID_SIGNATURE`, `IDENTITY_PROTOCOL_ERROR` — deliberately _not_
`IDENTITY_CHALLENGE_EXPIRED`, a timing condition a fresh challenge on retry genuinely resolves), or an
explicit authorization decision needing user action (`INVITE_REQUIRED`, `BANNED`, `KICKED`). Everything
else — including an unrecognized code, most commonly `1006` "abnormal closure" (a raw network drop or
the server process dying without a close handshake) — defaults to retryable.

**Media restoration policy, decided per source, mandatory and privacy-motivated:**

| Source                      | After an unexpected loss + successful reconnect                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice-channel membership    | Restored automatically — the same `join()` action a user would invoke manually, re-applying the current mute state to the freshly-acquired microphone                                              |
| Microphone                  | Released during the loss, reacquired fresh by the restoration `join()` call — never held "dangling" with nothing to publish it to                                                                  |
| Mute / deafen state         | Never reset by the reconnect cycle at all (neither `mutedRef`/`state.muted` nor `state.deafened` are touched by `onReconnecting`), so restoration is correct "for free" without special-case logic |
| Camera                      | **Never** auto-restored — fully released the moment a loss is detected (`onReconnecting`), regardless of whether it was ever on before                                                             |
| Screen video/audio          | **Never** auto-restored — same treatment as camera                                                                                                                                                 |
| Currently-open chat threads | Cleared on loss, explicitly re-requested (fresh history pages, never trusted client-side cache) once reconnected                                                                                   |

Camera/screen non-restoration is the one place this ADR treats a product requirement as
non-negotiable rather than an engineering trade-off: silently turning a camera or screen share back on
without a fresh, deliberate user action would be a real privacy regression, independent of how
technically convenient auto-restoration might be.

## Consequences

- `use-voice-channel.ts` gained meaningful new complexity (a rebuilt-per-reconnect `transport`,
  `currentChannelRef`/`joinRef`/`openChatThreadsBeforeLossRef`, three new controller-event handlers)
  but the file's existing decomposition precedent (`RemoteMediaReconciler`, extracted in T6 for the
  identical reason — a stateful, closure-heavy concern this repository has no renderer-level test
  harness for) was followed: `reconnect-controller.ts` and `reconnect-policy.ts` are both plain,
  React-free, directly unit-tested modules, not more inline hook logic.
- A previously-undocumented gap this review surfaced by reading the actual code (not assumed from the
  task summary): before T11, an unexpected connection loss neither reconnected _nor_ cleaned up —
  `onStateChange`'s old `'closed'` branch reset some UI-visible state but never called
  `transport.closeAll()` or stopped microphone/camera, leaving them orphaned. T11 corrects this as a
  side effect of the reconnect design, not as a separately-scoped bug fix.
- New E2E-only diagnostic markers, `disco-voador:connection-status:*` and `disco-voador:voice-joined:*`
  (unconditional `console.info`, matching every existing `disco-voador:*` marker's convention — public,
  non-sensitive data only), plus a new relay-only E2E hook (`armE2EReconnectSmokeRelay`, mirroring
  `armE2ETextChatRelay`'s exact no-exit-forcing shape) drive `e2e:reconnect-smoke`, a new real-Electron/
  real-Dedicated-Server E2E proving the full server-restart-recovery scenario: unexpected SIGTERM,
  bounded automatic reconnect on the same port/data directory, fresh T7 re-authentication (same
  `identityId`, never a replayed proof), voice-channel restoration with a genuinely fresh
  server-issued `participantId`, real peer audio re-established, Server Chat history correctly
  reloaded (not a stale live event), and camera/screen confirmed to never auto-restart. Passed 3
  consecutive clean runs.

## Alternatives

- **Reconnect logic inside `RealtimeClient` itself:** rejected — would change observable behavior for
  every existing direct consumer (the E2E scripts), and mixes two concerns (the wire-protocol client,
  and a retry/backoff policy) that have no reason to be coupled.
- **Reconnect logic inline inside `use-voice-channel.ts`'s effect:** rejected — the hook already has a
  documented history (T5/T6) of exactly this class of bug (stateful reconciliation logic living
  inline, with no direct test coverage, producing real live-found defects) being fixed by extraction
  into a plain class; repeating that mistake for reconnect was avoidable from the start.
- **Always retry regardless of `everReachedOpen`:** rejected as a genuine UX regression — a mistyped
  address or an unreachable server would retry silently and indefinitely with no clear failure signal,
  worse than every connection attempt before T11.
- **Auto-restore camera/screen after reconnect:** rejected outright as a privacy regression; not
  seriously considered as a trade-off, per the task's own explicit, mandatory constraint.
