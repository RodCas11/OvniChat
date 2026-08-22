# Product definition

## Goal

Build a lightweight, low-latency, self-hosted Windows desktop communication application, marketed
as **OvniChat**. It should retain the useful communication core of Discord while remaining simpler
to operate, inspect, and debug.

> **Naming note:** the product's user-facing name is **OvniChat** (project codename "Disco
> Voador" internally; the `@disco-voador/*` npm package scope and repository/workspace names are
> intentionally unchanged for now — a separate, fully verified rename task would migrate those
> later, not this one). Product-facing UI, documentation, and titles use "OvniChat."

The primary experience is:

```text
open app -> choose a nickname (first run only) -> select server -> click channel -> communicate
```

There is no account creation step — the client generates a local cryptographic identity on first
run (T7) and proves it to whichever server it connects to; a nickname is a freely editable local
preference, not a credential. Configuration belongs primarily to the server operator. A normal
participant should not need to understand WebRTC, signaling, TURN, audio-routing, or cryptographic
identity details.

OvniChat ships **two independent products**: the **OvniChat Client** (this desktop app) and the
**OvniChat Dedicated Server** (`services/dedicated-server`, T8) — a self-hoster's own process, run
on their own machine or network. A client connects to a server address the user enters manually;
there is no OvniChat–operated infrastructure (no accounts service, no directory, no relay) required
or assumed between them, and no relationship between two independently operated servers. See
[`architecture/DEDICATED_SERVER.md`](architecture/DEDICATED_SERVER.md).

A Dedicated Server may optionally restrict who can join (invite-only) and designate administrators
via server-local groups/permissions (T9) — but this remains server-local authorization, not a
central account system: no email, no password, and no cross-server relationship for the same
identity. See [`architecture/SERVER_AUTHORIZATION.md`](architecture/SERVER_AUTHORIZATION.md).

Text chat (T10) is **persistent**, not ephemeral — each Dedicated Server stores its own Server Chat
and per-voice-channel Chat history, in its own data directory, with the same server-local ownership
philosophy as T9's authorization state: decentralized ownership of persistent data, never absence of
persistent data, and never a central OvniChat chat service. See
[`architecture/PERSISTENT_TEXT_CHAT.md`](architecture/PERSISTENT_TEXT_CHAT.md).

T11 made the Client practical for daily use: local device preferences, server bookmarks, and automatic
reconnect after an unexpected network/server loss — all entirely client-local (never sent to any
Dedicated Server), and reconnect always performs a fresh T7 identity handshake, never a cached or
replayed one. See
[`architecture/CLIENT_SETTINGS_AND_RECONNECT.md`](architecture/CLIENT_SETTINGS_AND_RECONNECT.md).

T13.1 gave the Client its actual visual identity: a dark, modern, Discord-familiar layout (server
picker, server rail, channel sidebar, chat, member panel, persistent voice controls) with OvniChat
green used sparingly as an accent — never a pixel-for-pixel Discord clone, and never Discord's own
assets or branding. Technical internals a normal participant never needs (identity fingerprint,
connection protocol details) live behind an explicit Advanced/Diagnostics area, not the main flow.
T13.1.1 then polished that foundation into a substantial desktop settings experience (sidebar
navigation, a real Danger Zone for Regenerate Identity), a Home with real presence, and quieter,
hover-revealed secondary channel actions — visual refinement only, no new product capability. See
[`architecture/PRODUCT_UI_FOUNDATION.md`](architecture/PRODUCT_UI_FOUNDATION.md).

## Primary capabilities

The target product will provide:

- servers with text and voice channels;
- persistent text messages and history (T10); editing and deletion remain a later task;
- low-latency microphone communication, mute, deafen, and participant state;
- camera publishing independent of voice and screen sharing;
- monitor and window streaming with configurable quality;
- optional screen/game audio;
- Windows system-loopback audio first and process-tree audio later;
- local device selection, server bookmarks, and automatic reconnect (T11);
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
8. Identity is local and cryptographic, never a central account — no email, password, phone number,
   or global user database (T7; see `docs/adr/0010-no-mandatory-central-control-plane.md` and
   `docs/adr/0011-local-cryptographic-identity-without-central-accounts.md`).
9. The Client and the Dedicated Server are separately distributed, separately operated products with
   no mandatory infrastructure between them — anyone can run a server; no server directory, central
   account service, or Disco Voador-operated control plane is required or provided (T8; see
   `docs/adr/0012-dedicated-server-product-boundary.md`).
10. Authorization is server-local, never a central authority: a Dedicated Server remembers which
    cryptographic identities hold which of its own groups/permissions, never "this human owns a
    Disco Voador account" — the same identity may be Server Admin on one server and an ordinary
    Guest on another, with no relationship between the two (T9; see
    `docs/adr/0013-server-authorization-storage-and-rbac.md`).
11. Persistent product data is server-local, never centrally aggregated: chat history (T10) lives
    on the Dedicated Server that received it, exactly like T9's authorization state — decentralized
    ownership of persistent data is the privacy model, not the absence of persistent data (see
    `docs/adr/0014-persistent-server-owned-chat-history.md`).
12. Local client preferences (selected devices, server bookmarks, UI settings) belong entirely to the
    Client and are never sent to a Dedicated Server or any other destination — the same server-local/
    client-local ownership split T9-T10 already established for authorization and chat data applies
    symmetrically to the Client's own local state (T11; see
    `docs/adr/0015-local-client-settings-and-bookmarks.md`). Reconnecting after a network/server
    interruption never bypasses or caches T7 authentication — every reconnect is a fresh handshake
    (see `docs/adr/0016-automatic-reconnect-and-media-restoration-policy.md`).
