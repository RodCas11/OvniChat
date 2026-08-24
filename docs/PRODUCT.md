# Product definition

## Goal

Build a lightweight, low-latency, self-hosted Windows desktop communication application, marketed
as **Chantivo** (official domain: chantivo.app). It should retain the useful communication core of
Discord while remaining simpler to operate, inspect, and debug.

> **Naming note (updated T13.5):** the product's official public name is **Chantivo**
> (chantivo.app). It was marketed as "OvniChat" from T10 through T13.4 — historical task documents
> and ADRs from that period legitimately still say "OvniChat," describing what was true at the time,
> and are not rewritten. The internal `@disco-voador/*` npm package scope and repository/workspace
> names remain intentionally unchanged (an internal technical namespace, never the public product
> name — see [`BRANDING.md`](BRANDING.md)). Current product-facing UI, documentation, and titles use
> "Chantivo."

The primary experience is:

```text
open app -> choose a nickname (first run only) -> select server -> click channel -> communicate
```

There is no account creation step — the client generates a local cryptographic identity on first
run (T7) and proves it to whichever server it connects to; a nickname is a freely editable local
preference, not a credential. Configuration belongs primarily to the server operator. A normal
participant should not need to understand WebRTC, signaling, TURN, audio-routing, or cryptographic
identity details.

Chantivo ships **two independent products**: the **Chantivo Client** (this desktop app) and the
**Chantivo Dedicated Server** (`services/dedicated-server`, T8) — a self-hoster's own process, run
on their own machine or network. A client connects to a server address the user enters manually;
there is no Chantivo–operated infrastructure (no accounts service, no directory, no relay) required
or assumed between them, and no relationship between two independently operated servers. See
[`architecture/DEDICATED_SERVER.md`](architecture/DEDICATED_SERVER.md).

A Dedicated Server may optionally restrict who can join (invite-only) and designate administrators
via server-local groups/permissions (T9) — but this remains server-local authorization, not a
central account system: no email, no password, and no cross-server relationship for the same
identity. See [`architecture/SERVER_AUTHORIZATION.md`](architecture/SERVER_AUTHORIZATION.md).

Text chat (T10) is **persistent**, not ephemeral — each Dedicated Server stores its own Server Chat
and per-voice-channel Chat history, in its own data directory, with the same server-local ownership
philosophy as T9's authorization state: decentralized ownership of persistent data, never absence of
persistent data, and never a central Chantivo chat service. See
[`architecture/PERSISTENT_TEXT_CHAT.md`](architecture/PERSISTENT_TEXT_CHAT.md).

T11 made the Client practical for daily use: local device preferences, server bookmarks, and automatic
reconnect after an unexpected network/server loss — all entirely client-local (never sent to any
Dedicated Server), and reconnect always performs a fresh T7 identity handshake, never a cached or
replayed one. See
[`architecture/CLIENT_SETTINGS_AND_RECONNECT.md`](architecture/CLIENT_SETTINGS_AND_RECONNECT.md).

T13.1 gave the Client its actual visual identity: a dark, modern, Discord-familiar layout (server
picker, server rail, channel sidebar, chat, member panel, persistent voice controls) with Chantivo
green used sparingly as an accent — never a pixel-for-pixel Discord clone, and never Discord's own
assets or branding. Technical internals a normal participant never needs (identity fingerprint,
connection protocol details) live behind an explicit Advanced/Diagnostics area, not the main flow.
T13.1.1 then polished that foundation into a substantial desktop settings experience (sidebar
navigation, a real Danger Zone for Regenerate Identity), a Home with real presence, and quieter,
hover-revealed secondary channel actions — visual refinement only, no new product capability. See
[`architecture/PRODUCT_UI_FOUNDATION.md`](architecture/PRODUCT_UI_FOUNDATION.md).

T13.2 turned the visual foundation into a real TeamSpeak-style channel administration system: an
authorized server administrator creates, renames, moves, and deletes categories and voice channels
(including subchannels) live, from the Client, with no server restart and no hand-edited config file.
Each channel supports optional group-based visibility/join/management access policy (against T9's
existing server-local groups, never a second permission system), an optional user limit, and an
optional password — all enforced authoritatively by the Dedicated Server, never merely hidden in the
UI. TeamSpeak-style temporary channels exist while at least one participant remains inside and are
destroyed (along with their chat) the moment the last one leaves. See
[`architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md`](architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md).

T13.3 gave every identity a real, server-local visual and social presentation: a static avatar image
(no GIF/animated formats — a deliberate product choice, not merely a technical limitation), one
bounded custom-status string, and manual presence (Online/Away/Do Not Disturb — no Invisible, no
automatic idle/away detection, no game/Rich-Presence detection of any kind). The Member Panel now
shows everyone connected to the server, grouped into two safe role buckets computed from real
permissions, never a private custom group name. A member profile popover shows this presentation but
deliberately has **no message/DM/friend affordance of any kind** — Chantivo is not a social network
and has no such system to safely support one. All of this is entirely server-local per Dedicated
Server, exactly like T9's authorization state and T10's chat history: no global profile, no
cross-server correlation for the same identity. See
[`architecture/SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](architecture/SERVER_LOCAL_PROFILES_AND_PRESENCE.md).

T13.4 turned the working P2P voice stack into a comfortable, gamer-oriented daily-use experience:
Voice Activity and genuine hold-to-talk Push to Talk (with a real global hotkey usable while a game
has focus — never a toggle disguised as hold-to-talk), speaking indicators driven by real audio
activity, per-participant local volume and "Mute for Me" (100% client-local, never sent to the
server, never visible to anyone else), and subtle, disable-able join/leave sounds. This remains
client-side UX only: there is still no server-authoritative "who may speak" control, for the same
reason T13.2 already established — the P2P media transport has no choke point capable of enforcing
one. See [`architecture/GAMER_VOICE_EXPERIENCE.md`](architecture/GAMER_VOICE_EXPERIENCE.md).

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
   account service, or Chantivo-operated control plane is required or provided (T8; see
   `docs/adr/0012-dedicated-server-product-boundary.md`).
10. Authorization is server-local, never a central authority: a Dedicated Server remembers which
    cryptographic identities hold which of its own groups/permissions, never "this human owns a
    Chantivo account" — the same identity may be Server Admin on one server and an ordinary
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
13. Channel structure is server-owned and server-authoritative, never a client preference or a
    hardcoded default: an administrator manages a Dedicated Server's category/channel hierarchy,
    access policy, capacity, and passwords entirely from the Client, live, with no server restart —
    but every mutation and every join decision is validated and enforced by the Dedicated Server
    itself, and a channel hidden from an identity by policy is indistinguishable from one that does
    not exist, through every protocol path (T13.2; see
    `docs/adr/0019-channel-hierarchy-storage-and-acl.md`). A control this product cannot
    authoritatively enforce (such as who may speak, given the current P2P media transport) is omitted
    entirely rather than shipped as a misleading checkbox.
14. Visual/social identity (avatar, custom status, presence) is server-local per Dedicated Server and
    structurally distinct from cryptographic identity: an identity's avatar/status/presence changes
    never touch its Ed25519 keypair or `identityId`, and a server-wide presence identifier is a
    fresh, session-scoped token unrelated to `identityId` — the same cross-server-correlation
    property T7 established is never reintroduced by presenting who is online (T13.3; see
    `docs/adr/0020-profile-presence-storage-and-privacy-boundary.md`). There is no DM, friend, or
    social-graph system anywhere in this product, and a member's own profile popover never implies
    one exists.
15. Voice ergonomics (Push to Talk, Voice Activity, speaking indicators, per-participant local
    volume, local "Mute for Me," join/leave sounds) are client-local presentation and playback
    choices, never server-authoritative speech control: this product still has no way to
    authoritatively enforce who may speak, given its P2P media transport, and T13.4 does not
    introduce one — a local "Mute for Me" silences only the muting user's own playback and is never
    communicated to the server or the muted person (T13.4; see
    `docs/adr/0021-global-ptt-in-process-keyboard-hook.md`).
