# WebRTC and media semantics

Snapshot: **2026-08-17**. This note records standards and design guidance only; it deliberately does not define TypeScript interfaces or commit T0 to a topology.

## Standards state

| Area                                 | Snapshot status                                   | Primary source                                                           |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------ |
| WebRTC peer connection               | W3C Recommendation, 13 March 2025                 | [WebRTC 1.0](https://www.w3.org/TR/webrtc/)                              |
| Camera/microphone capture and tracks | Candidate Recommendation Draft, 9 October 2025    | [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/) |
| Display capture                      | Working Draft, 23 July 2026; still evolving       | [Screen Capture](https://www.w3.org/TR/screen-capture/)                  |
| Connection statistics                | Candidate Recommendation Draft, 25 September 2025 | [WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/)                 |

Treat experimental display constraints as capability-detected hints, not stable behavior. Electron/Chromium integration and operating-system behavior must also be tested.

## Semantic media model

Reason about four independent sources: **microphone**, **camera**, **screen video**, and **screen audio**. Camera and screen are both video tracks, so casually replacing one sender track with the other prevents simultaneous publication. A transceiver can provide a durable sender/receiver pairing, but its exact abstraction belongs to a later implementation task.

Keep UI and shared packages free of assumptions that every participant owns exactly one audio and one video track, or that the first implementation's peer-to-peer topology is permanent. The first transport may be P2P, but contracts should remain TURN-ready and SFU-ready.

## Signaling and negotiation

WebRTC does not define signaling. Use the self-hosted WebSocket service for SDP, ICE candidates, presence, room control, and text messages; audio/video flows peer-to-peer where ICE permits it. Do not relay media through the realtime WebSocket service, and do not silently move text chat onto a WebRTC data channel.

- Follow the [perfect negotiation pattern](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation) to handle offer collisions rather than relying on timing.
- Configure STUN/TURN through validated deployment configuration; never hard-code credentials in the client.
- Treat `disconnected` as potentially transient and `failed` as a stronger recovery signal. [`restartIce()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce) schedules renegotiation through `negotiationneeded`.
- [`replaceTrack()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/replaceTrack) requires the same media kind and can reject changes that require renegotiation. Do not assume every camera or screen switch is negotiation-free.

## Ownership and lifecycle

Make capture ownership and transport ownership explicit in later designs. For each acquired source, observe `ended`, `mute`, and `unmute`; react to device changes where relevant; stop and detach tracks deterministically on replacement, leave, failure, and shutdown. Removing or pausing a preview is not cleanup. Close peer connections and unregister listeners during teardown.

Display-capture consent is user-driven and non-persistent. See [MDN `getDisplayMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia) and the Electron-specific source and permission rules in [ELECTRON.md](./ELECTRON.md).

## Quality and diagnostics

- Express capture intent with constraints, but treat the returned track settings as the result. See [MDN `getUserMedia()`](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
- Tune a sender by reading `getParameters()`, changing supported encoding fields, and calling [`setParameters()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters). `maxBitrate` is an upper bound, not a delivery guarantee.
- Prefer [`setCodecPreferences()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpTransceiver/setCodecPreferences) to SDP text rewriting when codec ordering is needed.
- Sample `getStats()` repeatedly and compute deltas using stable report IDs. Tolerate absent, optional, and newly introduced fields instead of treating one browser's report shape as a schema.

API references: [`RTCPeerConnection`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection), [`addTransceiver()`](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/addTransceiver), and [WebRTC 1.0](https://www.w3.org/TR/webrtc/).
