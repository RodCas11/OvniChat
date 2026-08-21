import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ScreenQualityPreset } from '@disco-voador/media-core';

import type { DesktopE2EVoiceConfig, DesktopIdentity } from '../../shared/ipc-contract.js';
import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import { ChannelSidebar } from '../workspace/ChannelSidebar.js';
import { MainContent } from '../workspace/MainContent.js';
import { MemberPanel } from '../workspace/MemberPanel.js';
import { UserControlBar } from '../workspace/UserControlBar.js';
import type { ChatTarget } from '../workspace/chat-target.js';
import { AuthorizationPanel } from './AuthorizationPanel.js';
import { probeRemoteAudioLevel } from './e2e-audio-probe.js';
import { probeRemoteAudioFrequency } from './e2e-frequency-probe.js';
import { probeRemoteScreenFrames } from './e2e-screen-probe.js';
import { probeRemoteVideoFrames } from './e2e-video-probe.js';
import { RemoteAudio } from './RemoteAudio.js';
import { ScreenSourcePicker, type ScreenShareAudioMode } from './ScreenSourcePicker.js';
import { SettingsPanel } from './SettingsPanel.js';
import {
  useVoiceChannel,
  type VoiceChannelConnectionConfig,
  type VoiceParticipantView,
} from './use-voice-channel.js';
import styles from './VoiceChannelView.module.css';

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
  /** T13.1 — threaded down from `App.tsx` (via `AppShell.tsx`) so the relocated Identity section of
   * the redesigned `SettingsPanel.tsx` can render without duplicating `useIdentity()` ownership,
   * which stays entirely in `App.tsx` as it always has. */
  readonly identity: DesktopIdentity;
  readonly nickname: string;
  readonly onNicknameChange: (nickname: string) => Promise<boolean>;
  readonly onRegenerateIdentity: () => Promise<void>;
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
  identity,
  nickname,
  onNicknameChange,
  onRegenerateIdentity,
}: VoiceChannelViewProps): ReactElement {
  const [state, actions] = useVoiceChannel(realtimeConfig);
  const [displayName, setDisplayName] = useState(defaultDisplayName ?? '');
  const [showScreenPicker, setShowScreenPicker] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAuthorization, setShowAuthorization] = useState(false);
  // T13.1 — which chat thread the workspace shows, entirely independent of voice-join status (see
  // `workspace/chat-target.ts`'s own doc comment for the hard "click never joins voice" rule this
  // exists to satisfy). Local, presentation-only UI state — never persisted, never affects the
  // underlying `useVoiceChannel` hook contract above.
  const [selectedChatTarget, setSelectedChatTarget] = useState<ChatTarget>({ scope: 'server' });
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

  // T13.1 — presentation-only derived sets so `ChannelSidebar`/`ChannelRow`/`ParticipantRow` can
  // check "does this participant have an active camera/screen" via a plain `Set.has` instead of each
  // nested component re-deriving it from the raw stream maps.
  const remoteCameraParticipantIds = useMemo(
    () => new Set(state.remoteCameraStreams.keys()),
    [state.remoteCameraStreams],
  );
  const remoteScreenParticipantIds = useMemo(
    () => new Set(state.remoteScreenStreams.keys()),
    [state.remoteScreenStreams],
  );

  function handleJoinChannel(channelId: string): void {
    actions.join(channelId, displayName.trim());
  }

  function handleScreenShareSelected(
    quality: ScreenQualityPreset,
    audioMode: ScreenShareAudioMode,
  ): void {
    setShowScreenPicker(false);
    actions.enableScreenShare(quality, audioMode);
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

  /**
   * T13.1 product-shell-smoke only (`e2e-product-shell-smoke.mjs`) — proves a fresh `VoiceChannelView`
   * instance mounts on every connection sequence (the `AppShell` remount-key fix's own correctness,
   * see `App.tsx`/`shell/AppShell.tsx`'s doc comments): a component instance incorrectly *reused*
   * across a server switch would never re-run this empty-dependency, mount-only effect a second
   * time, so the orchestrating script requiring two distinct occurrences (one per server) is itself
   * the proof, not merely the printed value. Gated by the `workspaceMountLogged` ref (not the empty
   * dependency array alone) so it still fires exactly once per real mount even though `e2eAutoJoin`/
   * `realtimeConfig` are listed as honest dependencies.
   */
  const workspaceMountLogged = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.productShellSmoke || workspaceMountLogged.current) return;
    workspaceMountLogged.current = true;
    console.info(`E2E_PRODUCT_SHELL_WORKSPACE_MOUNTED:${realtimeConfig?.url ?? ''}`);
  }, [e2eAutoJoin, realtimeConfig]);

  /**
   * T13.1 product-shell-smoke only — selects (never joins) the auto-join target channel's chat as
   * soon as it is known to exist, through the exact same production `setSelectedChatTarget` path a
   * real click on `ChannelRow`'s chat-bubble icon drives (see `ChannelSidebar.tsx`'s
   * `onSelectChatTarget`). Deliberately independent of `autoJoinAttempted` above — never delays or
   * otherwise alters the real join effect — so the orchestrating script can observe this
   * selection's own `E2E_PRODUCT_SHELL_CHAT_TARGET_SELECTED` marker (a synchronous, zero-network-
   * round-trip `console.info`) land before the network-round-trip-gated
   * `disco-voador:voice-joined:<channelId>` marker the real join produces — real, non-flaky
   * evidence for the task's hard "a single click/selection shows a channel's chat and never joins
   * its voice" rule, exercised end to end through an actual Electron instance and a real Dedicated
   * Server rather than only at the component level (see `tests/desktop/components/channel-row.test.tsx`
   * for that boundary).
   */
  const pssChatTargetSelected = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.productShellSmoke || pssChatTargetSelected.current) return;
    if (state.connectionStatus !== 'connected') return;
    if (!state.channels.some((channel) => channel.channelId === e2eAutoJoin.channelId)) return;

    pssChatTargetSelected.current = true;
    setSelectedChatTarget({ scope: 'channel', channelId: e2eAutoJoin.channelId });
    console.info(`E2E_PRODUCT_SHELL_CHAT_TARGET_SELECTED:${e2eAutoJoin.channelId}`);
  }, [e2eAutoJoin, state.connectionStatus, state.channels]);

  /**
   * T13.1 product-shell-smoke only — once actually joined (the real `autoJoinAttempted` effect
   * above succeeded, evidenced by `state.currentChannelId` matching the target channel), opens then
   * closes Settings via the exact same `showSettings` state the bottom control bar's Settings
   * button drives, proving the modal is reachable end to end without a human present.
   */
  const pssSettingsOpenScheduled = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.productShellSmoke || pssSettingsOpenScheduled.current) return;
    if (state.currentChannelId !== e2eAutoJoin.channelId) return;
    pssSettingsOpenScheduled.current = true;

    const timer = setTimeout(() => {
      setShowSettings(true);
      console.info('E2E_PRODUCT_SHELL_SETTINGS_OPENED');
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [e2eAutoJoin, state.currentChannelId]);

  const pssSettingsCloseScheduled = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.productShellSmoke || !showSettings || pssSettingsCloseScheduled.current) {
      return;
    }
    pssSettingsCloseScheduled.current = true;

    const timer = setTimeout(() => {
      setShowSettings(false);
      console.info('E2E_PRODUCT_SHELL_SETTINGS_CLOSED');
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [e2eAutoJoin, showSettings]);

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

  // T10 E2E-only automation, any scenario that auto-joins a channel: `ChatView`'s own
  // channel-history load only happens once a human selects that channel's chat in the sidebar
  // (never auto-selected — see `workspace/ChatView.tsx`). This drives the exact same production
  // `loadChatHistory` action directly, so a channel-persistence E2E script does not need to simulate
  // a DOM click to prove the channel history API actually returns real, previously-persisted
  // messages.
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
        // one-publisher/one-viewer topology. E2E scenarios only ever exercise system audio (T6) or
        // no audio — T12's 'process' mode is exercised only through the real UI picker for now (see
        // `docs/tasks/T12_WINDOWS_PROCESS_AUDIO.md`'s "not yet built" list).
        actions.enableScreenShare('standard', shareAudio ? { type: 'system' } : { type: 'none' });
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
    // T12: a process-audio-targeted scenario (`e2e-process-audio-smoke.mjs`) owns the entire
    // screen-share start end to end itself (see the `processAudioScenarioStarted` effect below,
    // which selects the video source *and* the application-audio candidate before calling
    // `enableScreenShare`) — this generic effect fires from the exact same `voiceReady` transition
    // but reaches its own `enableScreenShare('standard', { type: 'none' })` call sooner (it needs
    // one fewer awaited IPC round trip: no `listProcessAudioCandidates` step), so without this
    // exclusion it always wins the race and silently claims `enableScreenShare`'s single-share
    // guard (`screenAcquiringRef`/`screenRef`) first, turning the process-audio effect's own later
    // `enableScreenShare` call into a permanent, silent no-op — a real, previously-latent bug this
    // task's own T12 process-audio E2E smoke test surfaced (screen video published normally from
    // this effect's video-only share; the intentionally-selected application-audio track was never
    // acquired or published at all, with no error anywhere, because its `enableScreenShare` call
    // never got past the concurrent-acquisition guard). `e2e:screen-audio-smoke` (T6) is not
    // affected by the same race in practice — its own scripted phase 1 also shares audio-off,
    // functionally identical to what this effect would do, so either one "winning" produces the
    // same share; it only becomes an observable bug when the two effects want different audio
    // modes for the very first share, as T12 does.
    if (e2eAutoJoin.processAudioTargetPid !== undefined || e2eAutoJoin.processAudioTargetExe) {
      return;
    }

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

  // T12 automated process-loopback isolation smoke test only, viewer role: fires the
  // frequency-domain probe (see `e2e-frequency-probe.ts`'s own doc comment for why this is required
  // evidence, not the plain RMS probe above) on every remote screen-audio stream, in addition to
  // (never instead of) `probedScreenAudioStreams`'s existing RMS proof above — both proofs running
  // independently means a process-audio run still exercises T6's original non-silence check too,
  // and neither probe's marker output can be confused with the other's. Only active when both
  // `processAudioExpectedHz`/`processAudioRejectedHz` are set (see `desktop-config.ts`) — absent for
  // every other scenario, including T6's own system-audio smoke test.
  const probedProcessAudioFrequencies = useRef(new Set<string>());
  useEffect(() => {
    const expectedHz = e2eAutoJoin?.processAudioExpectedHz;
    const rejectedHz = e2eAutoJoin?.processAudioRejectedHz;
    if (expectedHz === undefined || rejectedHz === undefined) return;
    for (const [participantId, stream] of state.remoteScreenAudioStreams) {
      if (!probedProcessAudioFrequencies.current.has(participantId)) {
        probedProcessAudioFrequencies.current.add(participantId);
        probeRemoteAudioFrequency(stream, participantId, expectedHz, rejectedHz);
      }
    }
  }, [e2eAutoJoin, state.remoteScreenAudioStreams]);

  // T12 automated process-loopback isolation smoke test only, viewer role: a second, later
  // frequency-domain re-probe of the SAME still-active process-audio stream, timed to land during
  // the publisher's scripted mic-mute phase (see `processAudioLifecycleScenarioStarted` below) —
  // proves process-audio remains correctly isolated (not merely non-silent, mirroring T6's own
  // `screenAudioPostMuteProbed` pattern but with the stronger frequency-identity proof) while the
  // publisher's microphone is muted. A distinct marker prefix (`E2E_FREQ_PROBE_POST_MUTE`) so it can
  // never be confused with the initial `E2E_FREQ_PROBE` proof. Fires once per participant's
  // process-audio appearance. The fixed 25s delay assumes the publisher's own lifecycle scenario
  // mutes at ~20s after share start (see that effect's `PHASE_WAIT_MS`) — comfortably inside the
  // muted window before it unmutes at ~40s.
  const probedProcessAudioPostMute = useRef(new Set<string>());
  useEffect(() => {
    const expectedHz = e2eAutoJoin?.processAudioExpectedHz;
    const rejectedHz = e2eAutoJoin?.processAudioRejectedHz;
    if (expectedHz === undefined || rejectedHz === undefined) return;
    if (!e2eAutoJoin?.processAudioLifecycleScenario) return;
    for (const [participantId, stream] of state.remoteScreenAudioStreams) {
      if (!probedProcessAudioPostMute.current.has(participantId)) {
        probedProcessAudioPostMute.current.add(participantId);
        setTimeout(() => {
          probeRemoteAudioFrequency(
            stream,
            participantId,
            expectedHz,
            rejectedHz,
            'E2E_FREQ_PROBE_POST_MUTE',
          );
        }, 25_000);
      }
    }
  }, [e2eAutoJoin, state.remoteScreenAudioStreams]);

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

  // T12 automated process-loopback isolation smoke test only, publisher role: drives the exact same
  // production path a real user's "Application audio" picker choice does —
  // `listScreenShareSources` -> `selectScreenShareSource(id, false)` for the video half (never
  // `true`: process audio never also requests Windows system-loopback, matching
  // `use-voice-channel.ts`'s own "process-audio never rides system-loopback" contract) — then
  // `listProcessAudioCandidates` -> a matching candidate (exact `processAudioTargetPid` takes
  // priority over a `processAudioTargetExe` substring match — see `desktop-config.ts`'s doc comment
  // for why PID-exact-matching is what this harness actually needs) ->
  // `enableScreenShare('standard', { type: 'process', pid })`, the same call `ScreenSourcePicker`'s
  // real UI makes. Deliberately a separate effect/guard from both the plain T5 video-only auto-share
  // and T6's system-audio scripted sequence — this only ever fires when one of the two target
  // fields is explicitly set, which no other scenario's env vars set. Logs
  // `E2E_PROCESS_AUDIO_SELECTED:pid=<pid>:exe=<exeName>` once capture is requested, or a descriptive
  // `console.error` (never a silent no-op) if capability is unsupported or no matching candidate is
  // enumerated — this scenario must fail loudly, not quietly fall back to sharing nothing or to
  // System audio (T12's own "never silently broaden capture scope" rule, applied to test honesty).
  const processAudioScenarioStarted = useRef(false);
  useEffect(() => {
    const targetPid = e2eAutoJoin?.processAudioTargetPid;
    const targetExe = e2eAutoJoin?.processAudioTargetExe;
    if ((targetPid === undefined && !targetExe) || !e2eAutoJoin?.autoScreenShare) return;
    if (!voiceReady || processAudioScenarioStarted.current) return;
    processAudioScenarioStarted.current = true;

    void (async () => {
      try {
        const sources = await window.desktopApp.listScreenShareSources();
        const sourceId = firstScreenSourceId(sources);
        if (!sourceId) {
          console.error('E2E process-audio auto-select found no screen (video) source');
          return;
        }
        const accepted = await window.desktopApp.selectScreenShareSource(sourceId, false);
        if (!accepted) {
          console.error('E2E process-audio auto-select: selectScreenShareSource was rejected');
          return;
        }

        const candidatesResult = await window.desktopApp.listProcessAudioCandidates();
        if (!candidatesResult.supported) {
          console.error(
            `E2E process-audio auto-select: capability unsupported (${candidatesResult.reason})`,
          );
          return;
        }
        const candidate =
          targetPid !== undefined
            ? candidatesResult.candidates.find((c) => c.pid === targetPid)
            : candidatesResult.candidates.find((c) => c.exeName.includes(targetExe ?? ''));
        if (!candidate) {
          const wanted =
            targetPid !== undefined ? `pid=${String(targetPid)}` : `exe~="${targetExe}"`;
          console.error(
            `E2E process-audio auto-select found no candidate matching ${wanted} ` +
              `(enumerated: ${candidatesResult.candidates.map((c) => `${c.exeName}(${String(c.pid)})`).join(', ') || '<none>'})`,
          );
          return;
        }

        actions.enableScreenShare('standard', { type: 'process', pid: candidate.pid });
        console.info(
          `E2E_PROCESS_AUDIO_SELECTED:pid=${String(candidate.pid)}:exe=${candidate.exeName}`,
        );
      } catch (error) {
        console.error('E2E process-audio auto-select failed', error);
      }
    })();
  }, [e2eAutoJoin, voiceReady, actions]);

  // T12 automated process-loopback isolation smoke test only, publisher role: a scripted post-share
  // lifecycle sequence — mute microphone -> wait -> unmute -> wait -> stop sharing — proving
  // mic-mute independence and clean-stop behavior for process audio, mirroring T6's own scripted
  // sequence (see the `screenAudioScenarioStarted` effect above) but far simpler: process audio has
  // no on/off/re-share cycle to script, only mute-independence and a final clean stop. Gated on
  // `screenShareAudioActive` (not merely "share attempted") so this never starts mutating mic/share
  // state before the process-audio track has actually finished acquiring. The 20s initial wait gives
  // the viewer's own frequency probe (up to ~30s ceiling, typically much faster) generous room to
  // reach its own pass/fail conclusion before this sequence starts touching shared state.
  const processAudioLifecycleScenarioStarted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.processAudioLifecycleScenario) return;
    if (!state.screenShareAudioActive || processAudioLifecycleScenarioStarted.current) return;
    processAudioLifecycleScenarioStarted.current = true;

    const PHASE_WAIT_MS = 20_000;
    let cancelled = false;
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    void (async () => {
      await wait(PHASE_WAIT_MS);
      if (cancelled) return;

      actions.setMuted(true);
      console.info('E2E_LOCAL_MIC_MUTED');
      await wait(PHASE_WAIT_MS);
      if (cancelled) return;

      actions.setMuted(false);
      console.info('E2E_LOCAL_MIC_UNMUTED');
      await wait(8000);
      if (cancelled) return;

      actions.disableScreenShare();
    })();

    return () => {
      cancelled = true;
    };
  }, [e2eAutoJoin, state.screenShareAudioActive, actions]);

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

  const effectiveDisplayName = displayName.trim().length > 0 ? displayName.trim() : nickname;

  // Visual QA (T13.1): `state.participants` is populated only from the server's roster of *other*
  // participants (used to set up peer connections) — the local user is never in it, so
  // `ChannelSidebar`/`ChannelRow`/`MemberPanel`/`MemberRow`'s existing, already-built `isSelf`/"(you)"
  // rendering never had anything to render. This synthesizes a self entry from data this component
  // already owns for real (its own `effectiveDisplayName`, `state.selfParticipantId`,
  // `state.myGroups`) — not fabricated data — purely so the local user appears in their own member
  // list and joined-channel roster, the way a Discord-familiar user expects. `connectionState` is
  // genuinely `undefined` for self: there is no `RTCPeerConnection` to oneself to report a state for.
  const participantsWithSelf = useMemo<readonly VoiceParticipantView[]>(() => {
    if (!state.selfParticipantId) return state.participants;
    const selfEntry: VoiceParticipantView = {
      participantId: state.selfParticipantId,
      displayName: effectiveDisplayName,
      connectionState: undefined,
      groups: state.myGroups,
    };
    return [...state.participants, selfEntry];
  }, [state.participants, state.selfParticipantId, effectiveDisplayName, state.myGroups]);

  return (
    <div className={styles.workspace}>
      {(state.micError ?? state.cameraError ?? state.screenShareError ?? state.lastError) && (
        <div className={styles.alertBanner}>
          {state.micError && <p role="alert">Microphone error: {state.micError}</p>}
          {state.cameraError && <p role="alert">Camera error: {state.cameraError}</p>}
          {state.screenShareError && (
            <p role="alert">Screen share error: {state.screenShareError}</p>
          )}
          {state.lastError && <p role="alert">{state.lastError}</p>}
        </div>
      )}

      {state.connectionStatus !== 'connected' ? (
        <div className={styles.statusScreen}>
          {state.connectionStatus === 'reconnecting' && (
            <>
              <p role="status">
                Connection lost. Reconnecting…
                {state.reconnectAttempt !== undefined &&
                  ` (attempt ${String(state.reconnectAttempt)})`}
              </p>
              <Button variant="secondary" onClick={actions.cancelReconnect}>
                Cancel
              </Button>
            </>
          )}
          {state.connectionStatus === 'disconnected' && state.connectionError && (
            <p role="alert">{state.connectionError}</p>
          )}
          {(state.connectionStatus === 'connecting' ||
            state.connectionStatus === 'authenticating') && <p>Connecting…</p>}
        </div>
      ) : (
        <>
          <ChannelSidebar
            serverName={state.serverInfo?.serverName}
            channels={state.channels}
            participants={participantsWithSelf}
            currentChannelId={state.currentChannelId}
            selfParticipantId={state.selfParticipantId}
            remoteCameraParticipantIds={remoteCameraParticipantIds}
            remoteScreenParticipantIds={remoteScreenParticipantIds}
            selfCameraEnabled={state.cameraEnabled}
            selfSharingScreen={state.screenSharingState === 'sharing'}
            canJoin={canJoin}
            joining={state.joining}
            selectedChatTarget={selectedChatTarget}
            onSelectChatTarget={setSelectedChatTarget}
            onJoinChannel={handleJoinChannel}
            onLeaveChannel={actions.leave}
          />

          <div className={styles.center}>
            <MainContent
              state={state}
              actions={actions}
              channels={state.channels}
              selectedChatTarget={selectedChatTarget}
              onOpenAuthorization={() => {
                setShowAuthorization(true);
              }}
            />
            <UserControlBar
              state={state}
              actions={actions}
              displayName={effectiveDisplayName}
              onOpenSettings={() => {
                setShowSettings(true);
              }}
              onOpenScreenPicker={() => {
                setShowScreenPicker(true);
              }}
            />
          </div>

          <MemberPanel
            inChannel={Boolean(state.currentChannelId)}
            participants={participantsWithSelf}
            selfParticipantId={state.selfParticipantId}
          />
        </>
      )}

      {showScreenPicker && (
        <Modal
          open
          onClose={() => {
            setShowScreenPicker(false);
          }}
          title="Share your screen"
          size="large"
          testId="screen-picker-modal"
        >
          <ScreenSourcePicker
            onSourceSelected={handleScreenShareSelected}
            onCancel={() => {
              setShowScreenPicker(false);
            }}
            defaultQuality={screenQualityPreset}
          />
        </Modal>
      )}

      {showSettings && (
        <Modal
          open
          onClose={() => {
            setShowSettings(false);
          }}
          title="Settings"
          size="large"
          testId="settings-modal"
        >
          <SettingsPanel
            state={state}
            actions={actions}
            outputDeviceId={outputDeviceId}
            onOutputDeviceChange={setOutputDeviceId}
            screenQualityPreset={screenQualityPreset}
            onScreenQualityPresetChange={setScreenQualityPreset}
            outputDeviceSelectionSupported={OUTPUT_DEVICE_SELECTION_SUPPORTED}
            identity={identity}
            nickname={nickname}
            onNicknameChange={onNicknameChange}
            onRegenerateIdentity={onRegenerateIdentity}
            voiceDisplayName={displayName}
            onVoiceDisplayNameChange={setDisplayName}
          />
        </Modal>
      )}

      {showAuthorization && (
        <Modal
          open
          onClose={() => {
            setShowAuthorization(false);
          }}
          title="Authorization"
          size="large"
          testId="authorization-modal"
        >
          <AuthorizationPanel state={state} actions={actions} />
        </Modal>
      )}

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

      {state.joining && (
        <div className={styles.joiningNotice} role="status">
          Joining…
        </div>
      )}
    </div>
  );
}
