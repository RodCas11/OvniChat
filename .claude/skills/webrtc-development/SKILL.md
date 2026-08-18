---
name: webrtc-development
description: Plan, implement, debug, or review Disco Voador WebRTC transport, peer connections, negotiation, transceivers, tracks, codecs, bitrate, ICE, STUN/TURN, statistics, recovery, or media publication lifecycle.
---

# Develop WebRTC behavior

Read `docs/ARCHITECTURE.md`, `docs/references/WEBRTC.md`, the active task, and applicable ADRs.
Consult `webrtc-media-engineer`. Use `vdo-ninja-reference` only for a specific unresolved behavior.

1. Keep transport ownership in `packages/rtc-core`; do not expose mesh peers to React.
2. Name every track by semantic source: microphone, camera, screen-video, or screen-audio. Preserve
   independent publication and cleanup; never replace camera with screen by convenience.
3. Define peer/transceiver ownership, negotiation roles, collision handling, and idempotency.
4. Treat ICE states carefully: `disconnected` can be transient; define restart/failure thresholds.
5. Exercise STUN and forced TURN paths. Never place TURN shared secrets in clients.
6. Apply codec/encoding preferences through standards APIs; avoid SDP munging unless an ADR and
   browser tests justify it.
7. Collect privacy-safe stats as sampled deltas and tolerate optional/unknown fields.
8. Stop owned tracks, close connections, cancel timers/promises, and remove listeners deterministically.
9. Test with two real clients: success, collision, source start/stop, network interruption, relay,
   reconnect, teardown, and simultaneous sources as applicable.

Report the state machine, semantic-source effects, failure/recovery behavior, actual two-client
evidence, diagnostics, and cleanup proof. Do not claim media works from signaling mocks alone.
