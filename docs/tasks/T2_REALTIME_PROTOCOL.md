# T2 — Shared realtime protocol and realtime service foundation

## Goal

Give `packages/protocol` real, runtime-validated, versioned wire contracts, and turn
`services/realtime` into a real, running, self-hosted WebSocket service implementing the
connection lifecycle those contracts describe: handshake, heartbeat, invalid-input rejection, and
clean shutdown. No voice, text, or presence product behavior yet — T2 is the communication
backbone later tasks build on.

## Context

T1 delivered the secure Electron shell. `packages/protocol`, `packages/config`, and
`services/realtime` were still T0 markers. ADR 0004 and ADR 0005 already accepted "one internally
modular self-hosted realtime service" with contracts defined once in `packages/protocol` and
runtime-validated at ingress; T2 is the first task to actually implement that decision.

## In scope

- `packages/protocol`: typed + runtime-validated (`zod`) message schemas, protocol versioning,
  parse helpers. Platform-neutral — no Electron/React/Node-fs/Windows/WebRTC dependency.
- `packages/config`: small reusable env-parsing/validation primitives (`parseConfig` + coercion
  schema factories), consumed by `services/realtime`'s own concrete config schema.
- `services/realtime`: a real Node.js WebSocket server (`ws`) with connection lifecycle, explicit
  handshake, heartbeat/liveness, per-connection rate limiting, max message size enforcement,
  structured logging, and programmatic `start()`/`stop()` for tests and the CLI bootstrap alike.
- Minimum protocol surface: `client:hello`, `client:ping` / `server:hello`, `server:pong`,
  `server:error`.
- Real WebSocket integration tests (no mocked transport) proving handshake, two independent
  clients, ping/pong, and hostile-client rejection paths.

## Out of scope

- WebRTC, `RTCPeerConnection`, microphone/camera/screen capture, Windows audio, Coturn runtime, SFU
  (T3-T6, T9-T10).
- Voice-channel signaling (`voice:*`, `webrtc:*` messages).
- Text messages, history, editing, deletion, SQLite schema (T7).
- Authentication, accounts, passwords, OAuth, sessions.
- Friends, DMs, roles, permissions, moderation.
- Production TLS termination/deployment topology (self-hosting hardening, later task).
- The actual Electron desktop realtime client — T2 proves the server with dedicated test clients;
  `packages/protocol` must stay consumable by `apps/desktop` later without desktop wiring now.

## Architecture constraints

- `packages/protocol` must not depend on Electron, React, Node-specific filesystem APIs, Windows
  APIs, or WebRTC; its runtime validator must work unmodified in both Node and a browser-like
  Renderer context.
- Every inbound WebSocket message is runtime-validated before reaching domain logic; a compile-time
  type alone is never sufficient for network input.
- Signaling/control traffic only — media payloads must never traverse this service.
- Config is centralized and validated once at process startup; domain code never reads
  `process.env` directly.
- The server exposes reusable `createRealtimeServer(config)` -> `{ start(), stop() }`; it must not
  be reachable only through a CLI entrypoint.

## Relevant packages

- `packages/protocol`
- `packages/config`
- `services/realtime`

## Relevant agents

- `realtime-backend-engineer` for implementation design and protocol/service review;
- `security-reviewer` for untrusted input, validation, limits, and DoS-relevant behavior;
- `qa-engineer` before completion for integration/lifecycle evidence;
- `software-architect` only if a package-boundary decision materially conflicts with existing
  architecture.

## Relevant skills

- `project-orientation`
- `planning-feature`
- `realtime-protocol`
- `testing-quality`
- `security-review`

## Acceptance criteria

- `packages/protocol` exports typed, `zod`-validated schemas for the T2 message surface plus
  protocol-version constants and parse helpers; every schema is deliberately strict about unknown
  fields.
- `services/realtime` starts a real WebSocket server, completes a real handshake with a real
  client, enforces protocol version support, runs heartbeat liveness detection, rejects invalid
  input safely (no process crash), enforces a maximum message size, applies a per-connection rate
  limit, and shuts down gracefully with no leaked sockets/timers.
- A developer can run `pnpm --filter @disco-voador/realtime run dev` and get a clear
  "Realtime server listening on host:port" log line.
- Root `pnpm check` passes; T1's Electron shell still typechecks/builds/checks cleanly.
- No product capability beyond the connection/protocol backbone is claimed or implemented.

## Required tests

- Unit tests for message schema validation (valid/invalid/extra-field/wrong-type cases), protocol
  version support, and config parsing/coercion/failure behavior.
- Unit tests for connection routing logic (state × message-type decision table), the rate limiter,
  and the heartbeat scheduler, independent of any real socket.
- Real WebSocket integration tests: server starts on an ephemeral port; two independent real
  clients complete distinct handshakes; ping/pong round-trips; hostile clients (malformed JSON,
  unknown type, missing/wrong-typed fields, unsupported version, oversized frame, binary frame,
  pre-handshake message, duplicate hello, rate-limit flood) each receive their defined rejection
  and the server remains healthy for subsequent clients; disconnect and server `stop()` leave no
  leaked connections, sockets, or timers.

## Manual verification

Actually launch `pnpm --filter @disco-voador/realtime run dev`, confirm the listen log, and connect
at least one real client outside the pure unit-test path. Record the exact command, listen
address, and result.

## Definition of Done

Meet all acceptance criteria, applicable items in
[`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md), security review, QA review, and actual
runtime verification (not Vitest alone). Update
[`../architecture/REALTIME_PROTOCOL.md`](../architecture/REALTIME_PROTOCOL.md),
[`../ARCHITECTURE.md`](../ARCHITECTURE.md), and relevant ADRs if the envelope/versioning/transport
strategy materially changes from what ADR 0004/0005 already accepted.

## Handoff notes

Implemented. `packages/protocol`, `packages/config`, and `services/realtime` are real (not
markers); see `packages/protocol/src/`, `packages/config/src/index.ts`, and
`services/realtime/src/`. Reviewed by `realtime-backend-engineer`, `security-reviewer`, and
`qa-engineer`; every actionable finding was addressed:

- **Real bug fixes:** none needed in the protocol/connection design itself — both reviewers traced
  state transitions, cleanup, and the routing decision table without finding a defect.
- **Security hardening added post-review:** an uncaught exception inside message-handler dispatch
  now produces `INTERNAL_ERROR` for that one connection instead of crashing the whole
  single-process service (plus a last-resort `uncaughtException`/`unhandledRejection` handler in
  `index.ts`); a new `REALTIME_MAX_CONNECTIONS` cap (default 1000) rejects connections past the
  limit with `SERVER_AT_CAPACITY`/close `4503` before spending any handshake/heartbeat/rate-limiter
  resources on them; `HeartbeatMonitor`'s ping call is now guarded by the same `readyState` check
  `send()` already used, for consistency (not currently exploitable in the pinned `ws` version, but
  cheap to close).
- **QA-added test coverage:** two real-socket heartbeat-liveness tests (a responsive client stays
  connected across real ping/pong cycles; an unresponsive one — `{autoPong:false}`, a genuine `ws`
  option, not a mock — is actually terminated by the server).
- **A security-reviewer finding was a false negative, not a real gap:** their test-suite search was
  scoped only to `services/realtime/`/`packages/protocol/`; this repository's tests live under
  top-level `tests/` (`tests/protocol/`, `tests/config/`, `tests/realtime/`), which the search
  missed. 141 tests exist and pass.

### Manual and scripted verification record

- **Environment:** Windows 11 Pro build 10.0.26200, Node `24.18.1` (local host baseline; project/CI
  target `24.19.0` per T0's documented exception), pnpm `11.22.0`.
- **Development launch:** `corepack pnpm --filter @disco-voador/realtime run dev` (uses `tsx
watch`). Result: structured log `{"event":"server_started",...}` then
  `{"event":"server_listening",...}`, then the human-readable `Realtime server listening on
127.0.0.1:8090`.
- **Real external client (separate OS process, not part of the Vitest run):** a standalone `ws`
  client script connected, sent `client:hello`, received `server:hello` with a real UUID
  `connectionId` and `protocolVersion: 1`, sent `client:ping`, received the matching `server:pong`,
  and closed cleanly (code `1000`). Re-run after the post-review security fixes with the same
  result. The server's own structured log showed the matching `connection_opened` →
  `handshake_completed` → `connection_closed` sequence with the same `connectionId` both times.
- **Graceful shutdown:** `server.stop()` (the same function `SIGINT`/`SIGTERM` call) is exercised
  directly by multiple real-socket integration tests (closes tracked connections with code `1001`,
  awaits each connection's actual close completion, no leaked sockets/timers across 141 tests
  including repeated full-suite runs). The `SIGINT`/`SIGTERM` _signal-handler wiring_ itself could
  not be verified via an automated cross-process signal on Windows — Node's own documentation
  states `child_process.kill(signal)` does not deliver named POSIX signals on Windows (confirmed
  empirically: a spawned child died via default disposition, not the registered handler). The
  handler code is standard, idiomatic Node (`process.on('SIGINT'/'SIGTERM', ...)` calling the same
  `server.stop()` that is thoroughly tested) and was manually reviewed; a real Ctrl+C in an
  interactive terminal is the actual supported path and was not separately re-verified as a manual
  step beyond the automated coverage above.

### Automated tests

141 Vitest tests total: `tests/protocol/*.test.ts` (40 — message schema validation including
extra/unexpected-field strictness, unknown type, wrong types, version support, parse helpers that
never throw); `tests/config/config.test.ts` (6 — the generic `packages/config` primitives);
`tests/realtime/{config,rate-limiter,heartbeat,protocol-handlers,connection}.test.ts` (unit tests:
connection-state × message-type routing, the rate limiter, the heartbeat scheduler with fake
timers, config parsing/coercion/failure, and the `INTERNAL_ERROR` containment safety net using a
fake socket); `tests/realtime/integration.test.ts` (real `ws` server + real `ws` client sockets on
an ephemeral port, no mocked transport — full handshake, two independent clients with distinct
connection IDs, ping/pong, disconnect cleanup, graceful `stop()`, real-socket heartbeat liveness
and timeout, the new connection cap, and an 11-case hostile-client matrix: malformed JSON, unknown
type, missing field, wrong-typed field, unsupported protocol version, pre-handshake message,
handshake timeout, duplicate hello, oversized frame closing `1009`, a binary frame, and a
rate-limit flood — plus a final test proving the server stays healthy for a normal client after a
sequence of hostile ones); plus the pre-existing `tests/repository/*` guardrail tests, which now
also cover the real T2 source instead of markers.
