import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';

import type { ScreenQualityPreset } from '@disco-voador/media-core';

import type { DesktopE2EVoiceConfig } from '../../shared/ipc-contract.js';
import { AuthorizationPanel } from './AuthorizationPanel.js';
import { ChatPanel } from './ChatPanel.js';
import { probeRemoteAudioLevel } from './e2e-audio-probe.js';
import { probeRemoteScreenFrames } from './e2e-screen-probe.js';
import { probeRemoteVideoFrames } from './e2e-video-probe.js';
import { LocalCameraPreview } from './LocalCameraPreview.js';
import { LocalScreenPreview } from './LocalScreenPreview.js';
import { RemoteAudio } from './RemoteAudio.js';
import { RemoteCamera } from './RemoteCamera.js';
import { RemoteScreen } from './RemoteScreen.js';
import { ScreenSourcePicker } from './ScreenSourcePicker.js';
import { SettingsPanel } from './SettingsPanel.js';
import { useVoiceChannel, type VoiceChannelConnectionConfig } from './use-voice-channel.js';

/** T11 — checked once, at module load: `HTMLMediaElement.prototype.setSinkId` is either present or
 * it is not, on a given Electron/Chromium build — this can never change at runtime, so there is no
 * need to re-check it per component instance. See `SettingsPanel.tsx`'s doc comment for the actual
 * finding (supported on this app's pinned Electron 43.4.0 build) and how it was checked. */
const OUTPUT_DEVICE_SELECTION_SUPPORTED =
  typeof HTMLMediaElement !== 'undefined' &&
  typeof HTMLMediaElement.prototype.setSinkId === 'function';

interface VoiceChannelViewProps {
  readonly realtimeConfig: VoiceChannelConnectionConfig | undefined;
  readonly e2eAutoJoin?: DesktopE2EVoiceConfig | undefined;
  /** Pre-fills the join-flow's `displayName` field with the persisted identity nickname (T7,
   * Section 41) — a UX convenience only, never a protocol merge: `displayName` (per-channel-join,
   * validated by `clientVoiceJoinMessageSchema`) and `nickname` (identity-level, sent once at
   * `client:hello`) stay two independent concepts, the user can still edit this field freely. */
  readonly defaultDisplayName?: string | undefined;
}

/** Finds the first enumerated *screen* (never a window) source — used only by the E2E
 * auto-screen-share flow below, which otherwise goes through the exact same production
 * `listScreenShareSources`/`selectScreenShareSource` IPC a real user's picker uses. Taking
 * whichever screen sorts first requires no foreknowledge of the test machine's monitor layout. */
function firstScreenSourceId(
  sources: readonly { readonly id: string; readonly type: 'screen' | 'window' }[],
): string | undefined {
  return sources.find((source) => source.type === 'screen')?.id;
}

export function VoiceChannelView({
  realtimeConfig,
  e2eAutoJoin,
  defaultDisplayName,
}: VoiceChannelViewProps): ReactElement {
  const [state, actions] = useVoiceChannel(realtimeConfig);
  const [displayName, setDisplayName] = useState(defaultDisplayName ?? '');
  const [showScreenPicker, setShowScreenPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // T11 — the user's persisted output-device and screen-share-quality preferences, loaded once on
  // mount and updated live from `SettingsPanel.tsx`. Kept here (not inside `use-voice-channel.ts`)
  // because neither is a `MediaTransport`/WebRTC concern: output-device selection is a plain
  // `<audio>` element property (`RemoteAudio.tsx`'s `setSinkId`), and the screen-quality preference
  // only ever pre-fills `ScreenSourcePicker`'s own dropdown default, never auto-starts anything.
  const [outputDeviceId, setOutputDeviceId] = useState<string | null>(null);
  const [screenQualityPreset, setScreenQualityPreset] = useState<ScreenQualityPreset>('high');

  useEffect(() => {
    let cancelled = false;
    window.desktopApp
      .getClientSettings()
      .then((settings) => {
        if (cancelled) return;
        setOutputDeviceId(settings.audio.outputDeviceId);
        setScreenQualityPreset(settings.screenShare.qualityPreset);
      })
      .catch((error: unknown) => {
        console.error('voice: failed to load persisted output/screen-quality settings', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canJoin =
    state.connectionStatus === 'connected' && displayName.trim().length > 0 && !state.joining;

  function handleDisplayNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setDisplayName(event.target.value);
  }

  function handleScreenShareSelected(quality: ScreenQualityPreset, shareAudio: boolean): void {
    setShowScreenPicker(false);
    actions.enableScreenShare(quality, shareAudio);
  }

  // Automated two-Electron-instance voice smoke test only (see
  // `apps/desktop/scripts/e2e-voice-smoke.mjs`); `e2eAutoJoin` is `undefined` for every real user.
  const autoJoinAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin || autoJoinAttempted.current) return;
    if (state.connectionStatus !== 'connected' || state.currentChannelId || state.joining) return;
    if (!state.channels.some((channel) => channel.channelId === e2eAutoJoin.channelId)) return;

    autoJoinAttempted.current = true;
    actions.join(e2eAutoJoin.channelId, e2eAutoJoin.displayName);
  }, [
    e2eAutoJoin,
    state.connectionStatus,
    state.currentChannelId,
    state.joining,
    state.channels,
    actions,
  ]);

  // T5 stabilization: the shared minimum bar every auto-media action (camera, screen) waits for —
  // at least one remote peer's `RTCPeerConnection` has reached `'connected'`. Sequences auto-media
  // deterministically (voice stable -> camera -> screen) instead of racing everything off the same
  // `currentChannelId` trigger — matching what an actual product user's flow would naturally do
  // (nobody shares a screen before the call itself has connected), and avoiding negotiation for
  // camera/screen landing before the initial voice offer/answer has even settled.
  const voiceReady = state.participants.some((p) => p.connectionState === 'connected');

  // T9 automated authorization E2E test only (`apps/desktop/scripts/e2e-authorization.mjs`): once
  // connected (voice channel membership not required), automatically redeem a bearer token via the
  // exact same production `redeemToken` action the "Use Privilege Key" panel drives.
  const autoRedeemAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.redeemToken || autoRedeemAttempted.current) return;
    if (state.connectionStatus !== 'connected') return;

    autoRedeemAttempted.current = true;
    actions.redeemToken(e2eAutoJoin.redeemToken);
  }, [e2eAutoJoin, state.connectionStatus, actions]);

  // T10 automated persistent-text-chat E2E tests only (`e2e-text-chat-persistence.mjs`): once
  // connected, automatically send a Server Chat message via the exact same production
  // `sendChatMessage` action the chat composer drives.
  const autoChatSendServerAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoChatSendServerBody || autoChatSendServerAttempted.current) return;
    if (state.connectionStatus !== 'connected') return;

    autoChatSendServerAttempted.current = true;
    actions.sendChatMessage('server', undefined, e2eAutoJoin.autoChatSendServerBody);
  }, [e2eAutoJoin, state.connectionStatus, actions]);

  // T10 automated channel-chat persistence E2E test only (`e2e-text-chat-channel-persistence.mjs`):
  // once joined to the auto-join channel, automatically send a message to that channel's chat.
  const autoChatSendChannelAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoChatSendChannelBody || autoChatSendChannelAttempted.current) return;
    if (!state.currentChannelId) return;

    autoChatSendChannelAttempted.current = true;
    actions.sendChatMessage('channel', state.currentChannelId, e2eAutoJoin.autoChatSendChannelBody);
  }, [e2eAutoJoin, state.currentChannelId, actions]);

  // T10 E2E-only automation, any scenario that auto-joins a channel: `ChatPanel`'s own
  // channel-history load only happens once a human clicks that channel's tab (never auto-selected —
  // see `ChatPanel.tsx`). This drives the exact same production `loadChatHistory` action directly,
  // so a channel-persistence E2E script does not need to simulate a DOM click to prove the channel
  // history API actually returns real, previously-persisted messages.
  const autoChatLoadChannelHistoryAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin || autoChatLoadChannelHistoryAttempted.current) return;
    if (!state.currentChannelId) return;

    autoChatLoadChannelHistoryAttempted.current = true;
    actions.loadChatHistory('channel', state.currentChannelId);
  }, [e2eAutoJoin, state.currentChannelId, actions]);

  // T4 automated camera smoke test only: once voice is stable, also auto-enable the camera.
  const autoCameraAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoCamera || autoCameraAttempted.current) return;
    if (!voiceReady) return;

    autoCameraAttempted.current = true;
    actions.enableCamera();
  }, [e2eAutoJoin, voiceReady, actions]);

  // T5 automated screen-share smoke test only: drives the exact same production IPC
  // (`listScreenShareSources` -> `selectScreenShareSource`) a real user's picker uses, picking the
  // first enumerated *screen* source deterministically, then acquires/publishes it exactly like a
  // human clicking "Share" in `ScreenSourcePicker` would. Extracted into a stable `useCallback`
  // (rather than an inline effect body) so the re-share effect below can reuse the exact same
  // sequence as a dependency both effects can list honestly.
  const autoStartScreenShare = useCallback(
    async (shareAudio: boolean): Promise<void> => {
      try {
        const sources = await window.desktopApp.listScreenShareSources();
        const sourceId = firstScreenSourceId(sources);
        if (!sourceId) {
          console.error('E2E screen-share auto-select found no screen source');
          return;
        }
        const accepted = await window.desktopApp.selectScreenShareSource(sourceId, shareAudio);
        if (!accepted) {
          console.error('E2E screen-share auto-select: selectScreenShareSource was rejected');
          return;
        }
        // 'standard' (720p30), not the default 'high' (1080p30): a lighter quality preset leaves
        // more headroom on the publishing instance, which is still doing real screen (and,
        // optionally, system-audio loopback) capture even in T5 stabilization's
        // one-publisher/one-viewer topology.
        actions.enableScreenShare('standard', shareAudio);
      } catch (error) {
        console.error('E2E screen-share auto-select failed', error);
      }
    },
    [actions],
  );

  const autoScreenShareAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoScreenShare || autoScreenShareAttempted.current) return;
    if (!voiceReady) return;
    // Sequenced after camera specifically when this same instance also auto-enables one — screen
    // sharing should layer onto an already-stable camera+voice session, not race it.
    if (e2eAutoJoin.autoCamera && !state.cameraEnabled) return;

    autoScreenShareAttempted.current = true;
    // This scenario (`e2e:screen-smoke`) stays screen-video-only, unchanged from T5 —
    // `e2e:screen-audio-smoke` is a separate, dedicated scenario (see the
    // `screenAudioScenarioStarted` effect below) so this one's behavior/gate is not disturbed by
    // the new source.
    void autoStartScreenShare(false);
  }, [e2eAutoJoin, voiceReady, state.cameraEnabled, autoStartScreenShare]);

  // T5 stabilization: local screen-share lifecycle markers — proof that *this* instance's own
  // capture actually transitioned through starting/sharing/stopping, independent of anything the
  // remote side observes. `E2E_LOCAL_SCREEN_ON:<n>`/`E2E_LOCAL_SCREEN_OFF:<n>` are numbered per
  // share cycle (1 = first share, 2 = re-share, ...) so the orchestrating script can require a
  // specific cycle count rather than just "happened at least once."
  const localCameraOnReported = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin || !state.cameraEnabled || localCameraOnReported.current) return;
    localCameraOnReported.current = true;
    console.info('E2E_LOCAL_CAMERA_ON');
  }, [e2eAutoJoin, state.cameraEnabled]);

  const screenShareCycleCount = useRef(0);
  const lastReportedScreenSharingState = useRef<typeof state.screenSharingState | undefined>(
    undefined,
  );
  useEffect(() => {
    if (!e2eAutoJoin) return;
    const previous = lastReportedScreenSharingState.current;
    lastReportedScreenSharingState.current = state.screenSharingState;

    if (state.screenSharingState === 'sharing' && previous !== 'sharing') {
      screenShareCycleCount.current += 1;
      console.info(`E2E_LOCAL_SCREEN_ON:${String(screenShareCycleCount.current)}`);
    }
    if (state.screenSharingState === 'idle' && previous === 'sharing') {
      console.info(`E2E_LOCAL_SCREEN_OFF:${String(screenShareCycleCount.current)}`);
    }
  }, [e2eAutoJoin, state.screenSharingState]);

  // T6: local screen-*audio* lifecycle marker, numbered per the *same* share cycle counter above —
  // proof that a given share cycle specifically did (or did not) include audio, distinguishing an
  // audio-off cycle from an audio-on one for the orchestrating script.
  const lastReportedScreenShareAudioActive = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin) return;
    const previous = lastReportedScreenShareAudioActive.current;
    lastReportedScreenShareAudioActive.current = state.screenShareAudioActive;

    if (state.screenShareAudioActive && !previous) {
      console.info(`E2E_LOCAL_SCREEN_AUDIO_ON:${String(screenShareCycleCount.current)}`);
    }
    if (!state.screenShareAudioActive && previous) {
      console.info(`E2E_LOCAL_SCREEN_AUDIO_OFF:${String(screenShareCycleCount.current)}`);
    }
  }, [e2eAutoJoin, state.screenShareAudioActive]);

  const reportedConnected = useRef(new Set<string>());
  useEffect(() => {
    if (!e2eAutoJoin) return;
    for (const participant of state.participants) {
      if (
        participant.connectionState === 'connected' &&
        !reportedConnected.current.has(participant.participantId)
      ) {
        reportedConnected.current.add(participant.participantId);
        console.info(`E2E_PEER_CONNECTED:${participant.participantId}`);
      }
    }
  }, [e2eAutoJoin, state.participants]);

  const probedAudioStreams = useRef(new Set<string>());
  useEffect(() => {
    if (!e2eAutoJoin) return;
    for (const [participantId, stream] of state.remoteAudioStreams) {
      if (!probedAudioStreams.current.has(participantId)) {
        probedAudioStreams.current.add(participantId);
        probeRemoteAudioLevel(stream, participantId);
      }
    }
  }, [e2eAutoJoin, state.remoteAudioStreams]);

  const probedCameraStreams = useRef(new Set<string>());
  useEffect(() => {
    if (!e2eAutoJoin) return;
    const stillPresent = new Set(state.remoteCameraStreams.keys());
    for (const participantId of probedCameraStreams.current) {
      if (!stillPresent.has(participantId)) {
        probedCameraStreams.current.delete(participantId);
        // Includes the peer's live connection state at the moment the camera track ended — the
        // deterministic proof that disabling a remote camera did not disconnect the peer (T4 is
        // not complete if stopping camera tears down voice).
        const peerState =
          state.participants.find((p) => p.participantId === participantId)?.connectionState ??
          'unknown';
        console.info(`E2E_REMOTE_VIDEO_ENDED:${participantId}:peerState=${peerState}`);
      }
    }
    for (const [participantId, stream] of state.remoteCameraStreams) {
      if (!probedCameraStreams.current.has(participantId)) {
        probedCameraStreams.current.add(participantId);
        probeRemoteVideoFrames(stream, participantId, state.selfParticipantId);
      }
    }
  }, [e2eAutoJoin, state.remoteCameraStreams, state.selfParticipantId, state.participants]);

  const probedScreenStreams = useRef(new Set<string>());
  // T6: counts this viewer's own *observed* screen-share appearances, independent of the
  // publisher's local cycle count — lets `E2E_SCREEN_AUDIO_ABSENT` below be tied to a specific
  // observed cycle (`main/index.ts`'s exit-watcher requires cycle 1 specifically, the audio-off
  // cycle) rather than accepted from any cycle, since a later audio-*on* cycle's video can settle
  // one render tick before its audio does, which would otherwise make this check ambiguous evidence
  // for "audio was genuinely off," not just "hadn't arrived yet at this instant."
  const viewerScreenCycleCount = useRef(0);
  useEffect(() => {
    if (!e2eAutoJoin) return;
    const stillPresent = new Set(state.remoteScreenStreams.keys());
    for (const participantId of probedScreenStreams.current) {
      if (!stillPresent.has(participantId)) {
        probedScreenStreams.current.delete(participantId);
        // Mirrors camera's `E2E_REMOTE_VIDEO_ENDED` proof above, for screen-video — deterministic
        // evidence that a remote screen share ending did not disconnect the peer or affect voice/
        // camera. `main/index.ts`'s `armE2EScreenSmokeExit` watches for this exact marker shape.
        const peerState =
          state.participants.find((p) => p.participantId === participantId)?.connectionState ??
          'unknown';
        console.info(`E2E_SCREEN_SHARE_ENDED:${participantId}:peerState=${peerState}`);

        // T5 stabilization: re-prove voice/camera continuity specifically *after* the remote
        // screen share ends, using fresh evidence rather than relying on the original one-shot
        // proof from whenever those streams first appeared — the whole point of this phase is to
        // prove screen ending did not regress voice/camera, so it needs its own proof, taken now.
        const audioStream = state.remoteAudioStreams.get(participantId);
        if (audioStream) {
          probeRemoteAudioLevel(audioStream, participantId, 'E2E_AUDIO_LEVEL_POST_SCREEN');
        }
        const cameraStream = state.remoteCameraStreams.get(participantId);
        if (cameraStream) {
          probeRemoteVideoFrames(
            cameraStream,
            participantId,
            state.selfParticipantId,
            'E2E_REMOTE_VIDEO_POST_SCREEN',
          );
        }
      }
    }
    for (const [participantId, stream] of state.remoteScreenStreams) {
      if (!probedScreenStreams.current.has(participantId)) {
        probedScreenStreams.current.add(participantId);
        viewerScreenCycleCount.current += 1;
        probeRemoteScreenFrames(stream, participantId, state.selfParticipantId);
        // T6: recorded at the same moment screen-video is first confirmed present for this cycle
        // — if screen-audio has not also appeared yet, this cycle is (at this instant) audio-less.
        // Tagged with this viewer's own observed cycle number so the exit-watcher can require it
        // specifically for cycle 1 (the audio-off cycle) rather than accept it from any cycle — a
        // later audio-on cycle's video can settle one render tick before its audio does, which
        // would otherwise be ambiguous evidence. Combined with `E2E_SCREEN_AUDIO_OK` below (which
        // the probe keeps retrying for up to its own timeout window), the orchestrating script
        // distinguishes an audio-off cycle from an audio-on one using the *viewer's* own
        // observation, not just the publisher's stated intent — see
        // `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "E2E strategy".
        if (!state.remoteScreenAudioStreams.has(participantId)) {
          console.info(
            `E2E_SCREEN_AUDIO_ABSENT:${participantId}:cycle=${String(viewerScreenCycleCount.current)}`,
          );
        }
      }
    }
  }, [
    e2eAutoJoin,
    state.remoteScreenStreams,
    state.remoteAudioStreams,
    state.remoteCameraStreams,
    state.remoteScreenAudioStreams,
    state.selfParticipantId,
    state.participants,
  ]);

  // T6: mirrors `probedScreenStreams` above, for screen-*audio* — a deliberately separate marker
  // family (`E2E_SCREEN_AUDIO_OK`/`E2E_SCREEN_AUDIO_SILENT`, via `probeRemoteAudioLevel`'s
  // `markerPrefix`) from microphone's `E2E_AUDIO_LEVEL_OK`/`E2E_AUDIO_LEVEL_SILENT`, so a
  // microphone-path success can never be mistaken for screen-audio proof (see
  // `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "Media identity"). `E2E_SCREEN_AUDIO_ENDED`
  // mirrors camera/screen-video's own ended-with-healthy-peer proof: screen-audio disappearing
  // must not disconnect the peer or affect voice/camera/screen-video.
  const probedScreenAudioStreams = useRef(new Set<string>());
  useEffect(() => {
    if (!e2eAutoJoin) return;
    const stillPresent = new Set(state.remoteScreenAudioStreams.keys());
    for (const participantId of probedScreenAudioStreams.current) {
      if (!stillPresent.has(participantId)) {
        probedScreenAudioStreams.current.delete(participantId);
        const peerState =
          state.participants.find((p) => p.participantId === participantId)?.connectionState ??
          'unknown';
        console.info(`E2E_SCREEN_AUDIO_ENDED:${participantId}:peerState=${peerState}`);
      }
    }
    for (const [participantId, stream] of state.remoteScreenAudioStreams) {
      if (!probedScreenAudioStreams.current.has(participantId)) {
        probedScreenAudioStreams.current.add(participantId);
        probeRemoteAudioLevel(stream, participantId, 'E2E_SCREEN_AUDIO');
      }
    }
  }, [e2eAutoJoin, state.remoteScreenAudioStreams, state.participants]);

  // T4 automated camera smoke test only: auto-disables the camera again a fixed delay after
  // enabling it, so the two-instance smoke can deterministically exercise and prove camera-off
  // behavior (remote tile disappears, voice/peer connection survives) without a human involved.
  const autoCameraOffScheduled = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoCameraOffAfterMs || autoCameraOffScheduled.current) return;
    if (!state.cameraEnabled) return;

    autoCameraOffScheduled.current = true;
    const timer = setTimeout(() => {
      actions.disableCamera();
    }, e2eAutoJoin.autoCameraOffAfterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [e2eAutoJoin, state.cameraEnabled, actions]);

  // T5 automated screen-share smoke test only: mirrors `autoCameraOffScheduled` exactly, for the
  // *first* screen-share cycle — the re-share effect below owns arming the off-timer for the
  // second cycle, since `autoScreenShareOffScheduled.current` is a one-shot guard.
  const autoScreenShareOffScheduled = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoScreenShareOffAfterMs || autoScreenShareOffScheduled.current) return;
    if (state.screenSharingState !== 'sharing') return;

    autoScreenShareOffScheduled.current = true;
    const timer = setTimeout(() => {
      actions.disableScreenShare();
    }, e2eAutoJoin.autoScreenShareOffAfterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [e2eAutoJoin, state.screenSharingState, actions]);

  // T5 stabilization: re-share proof — once the first auto-off cycle has genuinely completed
  // (`screenSharingState` returned to `'idle'` after having been `'sharing'`; the
  // `autoScreenShareOffScheduled` guard specifically excludes the initial mount, when state is
  // also `'idle'` but no share has happened yet), wait `autoScreenShareReshareAfterMs` and start a
  // second share cycle through the exact same production select-then-enable path
  // (`autoStartScreenShare`). Proves a second share still produces real decoded remote frames,
  // guarding against stale mid/transceiver/sender state left over from the first cycle (see
  // `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s mid-reuse finding and its regression test).
  const autoScreenShareReshareScheduled = useRef(false);
  useEffect(() => {
    if (
      !e2eAutoJoin?.autoScreenShareReshareAfterMs ||
      autoScreenShareReshareScheduled.current ||
      !autoScreenShareOffScheduled.current
    ) {
      return;
    }
    if (state.screenSharingState !== 'idle') return;

    autoScreenShareReshareScheduled.current = true;
    const timer = setTimeout(() => {
      void autoStartScreenShare(false);
    }, e2eAutoJoin.autoScreenShareReshareAfterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [e2eAutoJoin, state.screenSharingState, autoStartScreenShare]);

  // T6 automated screen-audio smoke test only (`e2e:screen-audio-smoke`) — both roles auto-deafen
  // immediately once voice is stable, so this machine's own remote-audio playback never re-enters
  // the publisher's system-audio loopback capture (same-machine feedback avoidance; deafen is
  // local-playback-only, so the underlying tracks/probes stay fully live regardless — see
  // `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "Same-machine feedback" section).
  const autoDeafenAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoScreenShareAudio || autoDeafenAttempted.current) return;
    if (!voiceReady) return;

    autoDeafenAttempted.current = true;
    actions.setDeafened(true);
    console.info('E2E_LOCAL_DEAFENED');
  }, [e2eAutoJoin, voiceReady, actions]);

  // T6 automated screen-audio smoke test only, publisher role: a continuous, deterministic,
  // *real* audio source for the scenario's screen-audio proof to depend on — plays through the
  // actual OS default audio output device via a normal `AudioContext` destination (never a fake
  // device, never a `MediaStreamTrack` injected directly into rtc-core), so this instance's own
  // Windows system-audio loopback capture (`main/screen-share.ts`) picks it up through the exact
  // same production path a real user's shared system sound would take. See
  // `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "E2E strategy" section for why this is required
  // (Chromium's fake-media-device switches only fake `getUserMedia` camera/microphone devices —
  // there is no equivalent "fake loopback" switch to depend on instead).
  const screenAudioToneStarted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoScreenShareAudio || !e2eAutoJoin.autoScreenShare) return;
    if (!voiceReady || screenAudioToneStarted.current) return;
    screenAudioToneStarted.current = true;

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioContext = new AudioContextCtor();
    const oscillator = audioContext.createOscillator();
    oscillator.frequency.value = 440;
    oscillator.connect(audioContext.destination);
    oscillator.start();
    console.info('E2E_LOCAL_TONE_STARTED');

    return () => {
      oscillator.stop();
      void audioContext.close();
    };
  }, [e2eAutoJoin, voiceReady]);

  // T6 automated screen-audio smoke test only, publisher role: the scripted phase sequence —
  // share (audio off) -> stop -> share (audio on) -> mute mic -> unmute mic -> stop -> re-share
  // (audio on) — proving, in order: video-only sharing still works, optional audio actually
  // publishes when requested, microphone mute does not affect screen-audio, stopping cleans up
  // both tracks, and re-sharing with audio works again. Explicit numbered phases via sequential
  // `await`s (not a chain of independent timer effects) — this scenario has too many ordered steps
  // for T5 stabilization's simpler single-timer-per-effect pattern to stay readable. Each phase's
  // own wait is a starting value, not yet independently measured against this scenario's real
  // negotiation/capture timing (see `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "E2E strategy" —
  // to be tuned from live measurement, following T5 stabilization's "measure, don't guess"
  // discipline, once this scenario has actually been run).
  const screenAudioScenarioStarted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoScreenShareAudio || !e2eAutoJoin.autoScreenShare) return;
    if (!voiceReady || screenAudioScenarioStarted.current) return;
    screenAudioScenarioStarted.current = true;

    const PHASE_WAIT_MS = 8000;
    let cancelled = false;
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    void (async () => {
      // Phase 1: share screen, audio OFF.
      await autoStartScreenShare(false);
      await wait(PHASE_WAIT_MS);
      if (cancelled) return;

      // Phase 2: stop sharing.
      actions.disableScreenShare();
      await wait(PHASE_WAIT_MS);
      if (cancelled) return;

      // Phase 3: share screen, audio ON.
      await autoStartScreenShare(true);
      await wait(PHASE_WAIT_MS);
      if (cancelled) return;

      // Phase 4: mute microphone — screen-audio must be unaffected (Section 19's mute-independence
      // requirement; see the viewer-side `screenAudioPostMuteProbed` effect below).
      actions.setMuted(true);
      console.info('E2E_LOCAL_MIC_MUTED');
      await wait(PHASE_WAIT_MS);
      if (cancelled) return;

      // Phase 5: unmute microphone.
      actions.setMuted(false);
      console.info('E2E_LOCAL_MIC_UNMUTED');
      await wait(PHASE_WAIT_MS);
      if (cancelled) return;

      // Phase 6: stop sharing (removes both screen-video and screen-audio; voice/peer must survive).
      actions.disableScreenShare();
      await wait(PHASE_WAIT_MS);
      if (cancelled) return;

      // Phase 7: re-share with audio ON — proves a second cycle still produces real decoded
      // screen-video *and* screen-audio, guarding against stale mid/transceiver/sender state left
      // over from the first cycle (mirrors T5 stabilization's screen-video-only re-share proof).
      await autoStartScreenShare(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [e2eAutoJoin, voiceReady, actions, autoStartScreenShare]);

  // T6 automated screen-audio smoke test only, viewer role: a second, later re-probe of the SAME
  // still-active screen-audio stream, timed to land during the publisher's scripted mic-mute phase
  // — proves screen-audio remains non-silent while the publisher's microphone is muted, using a
  // distinct marker family (`E2E_SCREEN_AUDIO_POST_MUTE_OK`) so it can never be confused with the
  // original `E2E_SCREEN_AUDIO_OK` proof. Fires once per participant's screen-audio appearance, not
  // re-armed on every render (`screenAudioPostMuteProbed` guard).
  const screenAudioPostMuteProbed = useRef(new Set<string>());
  useEffect(() => {
    if (!e2eAutoJoin?.autoScreenShareAudio || e2eAutoJoin.autoScreenShare) return; // viewer role only
    for (const [participantId, stream] of state.remoteScreenAudioStreams) {
      if (!screenAudioPostMuteProbed.current.has(participantId)) {
        screenAudioPostMuteProbed.current.add(participantId);
        setTimeout(() => {
          probeRemoteAudioLevel(stream, participantId, 'E2E_SCREEN_AUDIO_POST_MUTE');
        }, 12_000);
      }
    }
  }, [e2eAutoJoin, state.remoteScreenAudioStreams]);

  return (
    <section>
      <h2>Voice</h2>
      <p>Realtime connection: {state.connectionStatus}</p>
      {state.connectionStatus === 'reconnecting' && (
        <p role="status">
          Connection lost. Reconnecting…
          {state.reconnectAttempt !== undefined &&
            ` (attempt ${String(state.reconnectAttempt)})`}{' '}
          <button type="button" onClick={actions.cancelReconnect}>
            Cancel
          </button>
        </p>
      )}
      {state.connectionStatus === 'disconnected' && state.connectionError && (
        <p role="alert">{state.connectionError}</p>
      )}
      {state.serverInfo && (
        <p>
          Server: {state.serverInfo.serverName} (capabilities:{' '}
          {state.serverInfo.serverCapabilities.join(', ') || 'none'})
        </p>
      )}

      {state.connectionStatus === 'connected' && (
        <>
          <ChatPanel state={state} actions={actions} />
          <AuthorizationPanel state={state} actions={actions} />
          <button
            type="button"
            onClick={() => {
              setShowSettings((prev) => !prev);
            }}
          >
            {showSettings ? 'Hide settings' : 'Settings'}
          </button>
          {showSettings && (
            <SettingsPanel
              state={state}
              actions={actions}
              outputDeviceId={outputDeviceId}
              onOutputDeviceChange={setOutputDeviceId}
              screenQualityPreset={screenQualityPreset}
              onScreenQualityPresetChange={setScreenQualityPreset}
              outputDeviceSelectionSupported={OUTPUT_DEVICE_SELECTION_SUPPORTED}
            />
          )}
        </>
      )}

      {!state.currentChannelId && (
        <>
          <label>
            Display name
            <input value={displayName} onChange={handleDisplayNameChange} maxLength={32} />
          </label>

          <ul>
            {state.channels.map((channel) => (
              <li key={channel.channelId}>
                {channel.name}{' '}
                <button
                  type="button"
                  disabled={!canJoin}
                  onClick={() => {
                    actions.join(channel.channelId, displayName.trim());
                  }}
                >
                  Join
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {state.currentChannelId && (
        <>
          <p>
            Connected to <strong>{state.currentChannelId}</strong>
          </p>
          <button
            type="button"
            onClick={() => {
              actions.setMuted(!state.muted);
            }}
          >
            {state.muted ? 'Unmute' : 'Mute'}
          </button>
          <button
            type="button"
            onClick={() => {
              actions.setDeafened(!state.deafened);
            }}
          >
            {state.deafened ? 'Undeafen' : 'Deafen'}
          </button>
          <button
            type="button"
            disabled={state.cameraAcquiring}
            onClick={() => {
              if (state.cameraEnabled) actions.disableCamera();
              else actions.enableCamera();
            }}
          >
            {state.cameraEnabled ? 'Camera off' : 'Camera'}
          </button>
          <button
            type="button"
            disabled={state.screenSharingState === 'starting'}
            onClick={() => {
              if (state.screenSharingState === 'sharing') actions.disableScreenShare();
              else setShowScreenPicker(true);
            }}
          >
            {state.screenSharingState === 'sharing'
              ? state.screenShareAudioActive
                ? 'Stop sharing (+ audio)'
                : 'Stop sharing'
              : state.screenSharingState === 'starting'
                ? 'Starting…'
                : 'Share screen'}
          </button>
          <button type="button" onClick={actions.leave}>
            Leave
          </button>

          {showScreenPicker && (
            <ScreenSourcePicker
              onSourceSelected={handleScreenShareSelected}
              onCancel={() => {
                setShowScreenPicker(false);
              }}
              defaultQuality={screenQualityPreset}
            />
          )}

          <ul>
            {state.participants.map((participant) => (
              <li key={participant.participantId}>
                {participant.displayName}
                {participant.groups.length > 0 &&
                  ` [${participant.groups.map((g) => g.name).join(', ')}]`}
                {participant.connectionState ? ` — ${participant.connectionState}` : ''}
              </li>
            ))}
          </ul>

          {[...state.remoteAudioStreams.entries()].map(([participantId, stream]) => (
            <RemoteAudio
              key={participantId}
              participantId={participantId}
              stream={stream}
              muted={state.deafened}
              outputDeviceId={outputDeviceId}
            />
          ))}

          {/* T6: screen/system audio has its own independent playback ownership — a distinct
              <audio> element per participant, never mixed into the microphone element above, even
              though both are plain `RemoteAudio` instances. Deafen suppresses both the same way;
              microphone mute never touches this map (see `docs/architecture/WEBRTC_SCREEN_AUDIO.md`). */}
          {[...state.remoteScreenAudioStreams.entries()].map(([participantId, stream]) => (
            <RemoteAudio
              key={`screen-audio-${participantId}`}
              participantId={participantId}
              stream={stream}
              muted={state.deafened}
              outputDeviceId={outputDeviceId}
            />
          ))}

          <div>
            {state.localCameraStream && <LocalCameraPreview stream={state.localCameraStream} />}
            {[...state.remoteCameraStreams.entries()].map(([participantId, stream]) => {
              const participant = state.participants.find((p) => p.participantId === participantId);
              return (
                <RemoteCamera
                  key={participantId}
                  participantId={participantId}
                  displayName={participant?.displayName ?? participantId}
                  stream={stream}
                />
              );
            })}
          </div>

          {/* Screen shares render in their own section, separate from camera tiles — larger, with
              a preserved aspect ratio (see `RemoteScreen.tsx`), never mixed into the camera grid
              even though both are `track.kind === 'video'`. */}
          <div>
            {state.localScreenStream && <LocalScreenPreview stream={state.localScreenStream} />}
            {[...state.remoteScreenStreams.entries()].map(([participantId, stream]) => {
              const participant = state.participants.find((p) => p.participantId === participantId);
              return (
                <RemoteScreen
                  key={participantId}
                  participantId={participantId}
                  displayName={participant?.displayName ?? participantId}
                  stream={stream}
                />
              );
            })}
          </div>
        </>
      )}

      {state.joining && <p>Joining…</p>}
      {state.micError && <p role="alert">Microphone error: {state.micError}</p>}
      {state.cameraError && <p role="alert">Camera error: {state.cameraError}</p>}
      {state.screenShareError && <p role="alert">Screen share error: {state.screenShareError}</p>}
      {state.lastError && <p role="alert">{state.lastError}</p>}
    </section>
  );
}
