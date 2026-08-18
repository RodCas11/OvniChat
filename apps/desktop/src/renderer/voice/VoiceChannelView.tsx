import { useEffect, useRef, useState, type ChangeEvent, type ReactElement } from 'react';

import type { DesktopE2EVoiceConfig, DesktopRealtimeConfig } from '../../shared/ipc-contract.js';
import { probeRemoteAudioLevel } from './e2e-audio-probe.js';
import { RemoteAudio } from './RemoteAudio.js';
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

  const probedStreams = useRef(new Set<string>());
  useEffect(() => {
    if (!e2eAutoJoin) return;
    for (const [participantId, stream] of state.remoteStreams) {
      if (!probedStreams.current.has(participantId)) {
        probedStreams.current.add(participantId);
        probeRemoteAudioLevel(stream, participantId);
      }
    }
  }, [e2eAutoJoin, state.remoteStreams]);

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

          {[...state.remoteStreams.entries()].map(([participantId, stream]) => (
            <RemoteAudio
              key={participantId}
              participantId={participantId}
              stream={stream}
              muted={state.deafened}
            />
          ))}
        </>
      )}

      {state.joining && <p>Joining…</p>}
      {state.micError && <p role="alert">Microphone error: {state.micError}</p>}
      {state.lastError && <p role="alert">{state.lastError}</p>}
    </section>
  );
}
