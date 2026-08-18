---
name: realtime-protocol
description: Add, change, review, or debug Disco Voador realtime WebSocket messages, schemas, envelopes, versioning, presence events, voice signaling, text events, or client/server protocol handlers.
---

# Change the realtime protocol

Read `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, the active task, and existing schemas/handlers.
Consult `realtime-backend-engineer`.

1. Define the contract once in `packages/protocol` with runtime schemas and derived TypeScript types.
2. Bound payload size, strings, arrays, nesting, identifiers, and numeric ranges.
3. Define direction, authorization context, request/event identity, error behavior, ordering,
   idempotency, and reconnect/replay semantics where applicable.
4. Consider compatibility with deployed client/server versions; version or stage breaking changes.
5. Update every producer and consumer in the same coherent change.
6. Reject unknown/invalid messages before domain dispatch and avoid reflecting sensitive payloads in
   logs/errors.
7. Test valid round trips plus malformed, unknown, oversized, unauthorized, duplicated, and
   reordered cases relevant to the message.
8. Run a two-client integration scenario for behavior claims.
9. Update protocol/architecture/task docs and an ADR if envelope/version strategy changes.

Report schema changes, compatibility strategy, affected handlers, rejection behavior, and exact
client/server test evidence.
