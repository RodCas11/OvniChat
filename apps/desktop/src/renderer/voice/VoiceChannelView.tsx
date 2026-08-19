import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';

import type { ScreenQualityPreset } from '@disco-voador/media-core';

import type { DesktopE2EVoiceConfig, DesktopRealtimeConfig } from '../../shared/ipc-contract.js';
import { probeRemoteAudioLevel } from './e2e-audio-probe.js';
import { probeRemoteScreenFrames } from './e2e-screen-probe.js';
import { probeRemoteVideoFrames } from './e2e-video-probe.js';
import { LocalCameraPreview } from './LocalCameraPreview.js';
import { LocalScreenPreview } from './LocalScreenPreview.js';
import { RemoteAudio } from './RemoteAudio.js';
import { RemoteCamera } from './RemoteCamera.js';
import { RemoteScreen } from './RemoteScreen.js';
import { ScreenSourcePicker } from './ScreenSourcePicker.js';
import { useVoiceChannel } from './use-voice-channel.js';

interface VoiceChannelViewProps {
  readonly realtimeConfig: DesktopRealtimeConfig | undefined;
  readonly e2eAutoJoin?: DesktopE2EVoiceConfig | undefined;
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
}: VoiceChannelViewProps): ReactElement {
  const [state, actions] = useVoiceChannel(realtimeConfig);
  const [displayName, setDisplayName] = useState('');
  const [showScreenPicker, setShowScreenPicker] = useState(false);

  const canJoin =
    state.connectionStatus === 'connected' && displayName.trim().length > 0 && !state.joining;

  function handleDisplayNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setDisplayName(event.target.value);
  }

  function handleScreenShareSelected(quality: ScreenQualityPreset): void {
    setShowScreenPicker(false);
    actions.enableScreenShare(quality);
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
  const autoStartScreenShare = useCallback(async (): Promise<void> => {
    try {
      const sources = await window.desktopApp.listScreenShareSources();
      const sourceId = firstScreenSourceId(sources);
      if (!sourceId) {
        console.error('E2E screen-share auto-select found no screen source');
        return;
      }
      const accepted = await window.desktopApp.selectScreenShareSource(sourceId);
      if (!accepted) {
        console.error('E2E screen-share auto-select: selectScreenShareSource was rejected');
        return;
      }
      // 'standard' (720p30), not the default 'high' (1080p30): a lighter quality preset leaves more
      // headroom on the publishing instance, which is still doing real screen capture even in T5
      // stabilization's one-publisher/one-viewer topology.
      actions.enableScreenShare('standard');
    } catch (error) {
      console.error('E2E screen-share auto-select failed', error);
    }
  }, [actions]);

  const autoScreenShareAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoScreenShare || autoScreenShareAttempted.current) return;
    if (!voiceReady) return;
    // Sequenced after camera specifically when this same instance also auto-enables one — screen
    // sharing should layer onto an already-stable camera+voice session, not race it.
    if (e2eAutoJoin.autoCamera && !state.cameraEnabled) return;

    autoScreenShareAttempted.current = true;
    void autoStartScreenShare();
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
        probeRemoteScreenFrames(stream, participantId, state.selfParticipantId);
      }
    }
  }, [
    e2eAutoJoin,
    state.remoteScreenStreams,
    state.remoteAudioStreams,
    state.remoteCameraStreams,
    state.selfParticipantId,
    state.participants,
  ]);

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
      void autoStartScreenShare();
    }, e2eAutoJoin.autoScreenShareReshareAfterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [e2eAutoJoin, state.screenSharingState, autoStartScreenShare]);

  return (
    <section>
      <h2>Voice</h2>
      <p>Realtime connection: {state.connectionStatus}</p>

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
              ? 'Stop sharing'
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
            />
          )}

          <ul>
            {state.participants.map((participant) => (
              <li key={participant.participantId}>
                {participant.displayName}
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
