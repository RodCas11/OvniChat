import type { VoiceChannelSummary } from '@disco-voador/protocol';

/**
 * T3's predefined voice-channel catalog. A hardcoded constant is explicitly sufficient for T3
 * (no database, no server-management UI) — see `docs/tasks/T3_VOICE_WEBRTC.md`. Revisit as
 * server-operator configuration only when a real need for per-deployment channels arises.
 */
export const DEFAULT_VOICE_CHANNELS: readonly VoiceChannelSummary[] = [
  { channelId: 'general', name: 'General' },
  { channelId: 'games', name: 'Games' },
  { channelId: 'afk', name: 'AFK' },
];
