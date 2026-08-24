# Media stage and stream UX (T13.5)

> This document describes the Renderer presentation layer T13.5 built on top of the already-existing
> (T3-T6, T13.4) camera/screen-share/speaking capabilities. It introduces **no protocol change, no
> capture/negotiation change, and no new IPC surface** — every claim below concerns how already-proven
> `MediaStream`s and already-proven state get _rendered_, never how they get acquired or delivered.

## Why this exists

Through T13.4, `MainContent.tsx` rendered every active camera/screen stream as a flat, wrapping row
of tiles above chat — functional, but explicitly marked in its own doc comment as deferred: "a full
Discord-style 'stage' layout for calls is explicitly deferred to T13.5." This task builds that stage.

## Component architecture

```text
MainContent.tsx (layout decision only)
  ├─ no media active → full-width ChatView (unchanged default, Section 18/80)
  └─ media active     → MediaStage (primary area) + toggleable side ChatView (Section 43/44)

MediaStage.tsx (grid/focus orchestration, presentation state only — useState, never WebRTC)
  ├─ screen(s) present → focused screen (+ switcher if >1) + camera filmstrip if cameras also active
  └─ no screen         → adaptive camera grid, or a focused camera + filmstrip once one is clicked

MediaTile.tsx (the one shared "real video, or a real avatar fallback" tile)
  └─ real <video> (attach/detach via useEffect, mirrors RemoteCamera.tsx's own proven pattern)
     or UserAvatar (camera off — never a black rectangle, Section 23)
```

`MediaStage`/`MediaTile` own **no capture, negotiation, or renegotiation logic of any kind** (Section
57/58). They read exclusively from `VoiceChannelState` fields `use-voice-channel.ts` already
populated before this task (`localCameraStream`, `remoteCameraStreams`, `localScreenStream`,
`remoteScreenStreams`, `speakingParticipantIds`, `selfSpeaking`, `avatarCache`) and the already
avatar-resolved `participants` list (`VoiceChannelView.tsx`'s pre-existing `participantsWithSelf`,
threaded one prop deeper into `MainContent` — the only change to that file). Grid/focus/chat-visible
switching is local `useState`; none of it can trigger a peer-connection renegotiation, because none of
it ever calls into `use-voice-channel.ts`'s own actions except the pre-existing `requestAvatar`.

## Chat-primary default (Section 18/80)

`MainContent`'s own `hasMedia` check (`Boolean(cameraEnabled && localCameraStream) ||
remoteCameraStreams.size > 0 || Boolean(screenSharingState === 'sharing' && localScreenStream) ||
remoteScreenStreams.size > 0`) mirrors `MediaStage`'s own identical check exactly. When connected to
voice but nobody has an actually active camera/screen stream, chat renders full-width — the
deliberate default, not a fallback state.

## Camera grid and camera-off avatar tiles (Section 22-24)

`MediaStage` builds one tile per voice participant (self + remote), not merely per active camera —
so a participant without a camera renders as a real `UserAvatar` fallback tile (name, deterministic
color, and — where applicable — the same T13.4 speaking ring), never an empty/black tile. CSS Grid's
`auto-fit`/`minmax(240px, 1fr)` with a fixed `aspect-ratio: 16/9` handles 1 through N participants
without a JS-computed column count.

## Screen share as primary content (Section 21)

Any active screen share is always the primary content — never merely another grid tile. If the same
participant (or a different one) also has an active camera, it appears in a slim filmstrip alongside
the focused screen (Section 38), never competing for primary space. Multiple simultaneous screen
shares (the P2P mesh architecture allows this — Section 37) are represented explicitly via a
`role="tablist"` switcher, defaulting to the first; this is not a server-enforced limit, only a local
"one screen focused at a time" presentation choice.

## Focus / return to grid (Section 35-36)

Clicking a camera tile with real video sets a local `focusedCameraId`; the stage then renders that
tile large plus a filmstrip of the others, with an explicit "Back to grid" control. A focus target
that stops streaming (track ended, participant left) clears itself automatically via a `useEffect`
that checks whether the focused id still exists among currently-active entries — never a frozen/stale
tile (Section 65).

## Speaking + avatars on media tiles (Section 24, 90)

`MediaTile` reuses the exact same `state.speakingParticipantIds`/`state.selfSpeaking` source and the
exact same `UserAvatar`/`avatarCache` mechanism `ParticipantRow`/`MemberRow` already use — no second
detector, no second avatar-resolution path. A subtle border (not a full-screen flash) indicates
speaking on both real-video tiles and avatar-fallback tiles.

## Picture-in-Picture (Section 53-56)

**Chosen strategy: native `HTMLVideoElement.requestPictureInPicture()`**, not a secondary Electron
window. This was a deliberate architecture choice, not an oversight: T13.5's own brief explicitly asks
to "choose the smallest robust architecture" and to evaluate current Electron/Chromium capabilities
first. A second Electron window would need its own `contextIsolation`/`sandbox`/preload/IPC/CSP
trust-boundary review, its own WebRTC-peer-duplication-avoidance design, and its own lifecycle
management — none of which is justified when the standard Chromium PiP API already satisfies every
concrete requirement in the brief (a stream stays visible while using other windows/apps). Because
PiP operates directly on the existing `<video>` element (the same one already attached to the real
`MediaStream`), it inherently cannot duplicate a peer connection, resubscribe to media, or restart
capture — there is no second network/media session to create in the first place. `pictureInPictureEnabled`
is feature-detected once; the button is omitted entirely (never shown disabled) when unsupported or
when a tile has no real stream to show.

## Reconnect / server switch (Section 61, 91)

`MediaStage` reads only from `state`; it has no reference to, and cannot call, any acquire/publish/
reconnect action. The pre-existing T11 invariant (camera/screen never auto-restart after a reconnect,
ADR 0016) is therefore structurally unaffected by this task — there is nothing in the new presentation
layer that could restart capture even by accident, since it never initiates capture at all.

## Hidden-channel privacy (Section 48, 103)

`state.remoteCameraStreams`/`state.remoteScreenStreams`/`state.participants` are populated only for
the one voice channel a connection is itself joined to (the same T3 same-channel-only signaling
scoping that already backs T13.4's speaking-privacy guarantee). `MediaStage` introduces no second data
source and performs no additional filtering of its own — there is structurally nothing from a hidden
channel for it to ever receive.

## What this task deliberately did not change

- No change to `packages/rtc-core`, `packages/media-core`, `packages/windows-media`, or any WebRTC
  negotiation/capture code.
- No change to `use-voice-channel.ts`'s own capture/publish/reconnect logic.
- No new IPC channel — `MediaStage`/`MediaTile` call only the pre-existing `actions.requestAvatar`.
- `ScreenSourcePicker.tsx`, `UserControlBar.tsx`, and `ParticipantRow.tsx`'s camera/screen status
  icons were already in a good, product-consistent state from earlier tasks (T4/T5/T12/T13.1/T13.4)
  and needed no rework for this task's own scope.
