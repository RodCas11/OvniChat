# Product definition

## Goal

Build a lightweight, low-latency, self-hosted Windows desktop communication application. It should
retain the useful communication core of Discord while remaining simpler to operate, inspect, and
debug.

The primary experience is:

```text
open app -> select server -> click channel -> communicate
```

Configuration belongs primarily to the server operator. A normal participant should not need to
understand WebRTC, signaling, TURN, or audio-routing details.

## Primary capabilities

The target product will provide:

- servers with text and voice channels;
- text messages, history, editing, and deletion;
- low-latency microphone communication, mute, deafen, and participant state;
- camera publishing independent of voice and screen sharing;
- monitor and window streaming with configurable quality;
- optional screen/game audio;
- Windows system-loopback audio first and process-tree audio later;
- self-hosted signaling, messaging, persistence, and TURN fallback.

None of these product capabilities is implemented in T0.

## Product qualities

- **Windows-first and desktop-first:** target Windows 10/11 x64; React is the Electron UI, not a
  separately deployed web product.
- **Simple:** prioritize a short path to joining a channel and communicating.
- **Fast and low-latency:** avoid routing media through application servers.
- **Self-hosted:** operators can run all services required for core communication.
- **Debuggable:** diagnostics, lifecycle visibility, and reproducible failure tests are product
  requirements.
- **Modular:** platform-specific capture, generic media, RTC transport, protocol, and UI remain
  separable.

## Initial non-goals

- a Discord-style social network or public server discovery;
- Nitro, stores, advertising, or monetized cosmetic systems;
- bots or a public extension marketplace;
- a general streaming platform;
- mobile, macOS, Linux, or a browser deployment;
- telemetry-heavy SaaS operation;
- an SFU in the first media vertical slice;
- process-specific audio on ordinary Windows 10 builds where the platform API is unavailable.

Non-goals may be reconsidered only through an explicit task and architecture decision. They are
not permission to weaken future portability boundaries: P2P is first, while the UI remains
transport-neutral enough to introduce an SFU later.

## Product principles

1. Voice must remain active when camera or screen sharing starts or stops.
2. Microphone, camera, screen-video, and screen-audio are distinct semantic sources.
3. Text chat uses the realtime service, not WebRTC media transport.
4. Signaling carries session descriptions, ICE, presence, and control—not media payloads.
5. Optional media failure should degrade explicitly rather than silently ending unrelated media.
6. Capture requires clear user intent and a visible way to stop it.
7. External SaaS may be optional, but cannot be mandatory for core communication.
