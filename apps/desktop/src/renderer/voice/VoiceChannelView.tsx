import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';

import type { DesktopE2EVoiceConfig, DesktopRealtimeConfig } from '../../shared/ipc-contract.js';
import { probeRemoteAudioLevel } from './e2e-audio-probe.js';
import { probeRemoteVideoFrames } from './e2e-video-probe.js';
import { LocalCameraPreview } from './LocalCameraPreview.js';
import { RemoteAudio } from './RemoteAudio.js';
import { RemoteCamera } from './RemoteCamera.js';
import { useVoiceChannel } from './use-voice-channel.js';

interface VoiceChannelViewProps {
  readonly realtimeConfig: DesktopRealtimeConfig | undefined;
  readonly e2eAutoJoin?: DesktopE2EVoiceConfig | undefined;
}

export function VoiceChannelView({
  realtimeConfig,
  e2eAutoJoin,
}: VoiceChannelViewProps): ReactElement {
  const [state, actions] = useVoiceChannel(realtimeConfig);
  const [displayName, setDisplayName] = useState('');

  const canJoin =
    state.connectionStatus === 'connected' && displayName.trim().length > 0 && !state.joining;

  function handleDisplayNameChange(event: ChangeEvent<HTMLInputElement>): void {
    setDisplayName(event.target.value);
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

  // T4 automated camera smoke test only: once auto-joined, also auto-enable the camera.
  const autoCameraAttempted = useRef(false);
  useEffect(() => {
    if (!e2eAutoJoin?.autoCamera || autoCameraAttempted.current) return;
    if (!state.currentChannelId) return;

    autoCameraAttempted.current = true;
    actions.enableCamera();
  }, [e2eAutoJoin, state.currentChannelId, actions]);

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

  const probedVideoStreams = useRef(new Set<string>());
  useEffect(() => {
    if (!e2eAutoJoin) return;
    const stillPresent = new Set(state.remoteVideoStreams.keys());
    for (const participantId of probedVideoStreams.current) {
      if (!stillPresent.has(participantId)) {
        probedVideoStreams.current.delete(participantId);
        // Includes the peer's live connection state at the moment the camera track ended — the
        // deterministic proof that disabling a remote camera did not disconnect the peer (T4 is
        // not complete if stopping camera tears down voice).
        const peerState =
          state.participants.find((p) => p.participantId === participantId)?.connectionState ??
          'unknown';
        console.info(`E2E_REMOTE_VIDEO_ENDED:${participantId}:peerState=${peerState}`);
      }
    }
    for (const [participantId, stream] of state.remoteVideoStreams) {
      if (!probedVideoStreams.current.has(participantId)) {
        probedVideoStreams.current.add(participantId);
        probeRemoteVideoFrames(stream, participantId, state.selfParticipantId);
      }
    }
  }, [e2eAutoJoin, state.remoteVideoStreams, state.selfParticipantId, state.participants]);

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
          <button type="button" onClick={actions.leave}>
            Leave
          </button>

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
            {[...state.remoteVideoStreams.entries()].map(([participantId, stream]) => {
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
        </>
      )}

      {state.joining && <p>Joining…</p>}
      {state.micError && <p role="alert">Microphone error: {state.micError}</p>}
      {state.cameraError && <p role="alert">Camera error: {state.cameraError}</p>}
      {state.lastError && <p role="alert">{state.lastError}</p>}
    </section>
  );
}
