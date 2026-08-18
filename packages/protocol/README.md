# Protocol package boundary

Canonical realtime wire contracts shared by `services/realtime` and (eventually) `apps/desktop`.
Every message is a `zod` schema with a derived TypeScript type — never a hand-written type without
a matching runtime validator, since network input is untrusted. See
[`docs/architecture/REALTIME_PROTOCOL.md`](../../docs/architecture/REALTIME_PROTOCOL.md) for the
full protocol design (envelope, versioning, handshake, errors, close codes).

This package must stay platform-neutral: no Electron, React, Node-specific filesystem/Windows
APIs, or WebRTC. It depends only on `zod`, which runs unmodified in both Node and a browser-like
Renderer context.
