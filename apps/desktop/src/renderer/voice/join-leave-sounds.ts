/**
 * T13.4 — join/leave sound notifications for the *currently-joined voice channel's own membership
 * transitions only* (never server-wide presence, never other channels — this module only ever
 * receives the already-scoped `participantId` set `use-voice-channel.ts`'s own `state.participants`
 * tracks, which is exactly that).
 *
 * ### Exact dedup semantics (deliberate, documented per this task's own "decide and document"
 * requirement — not accidental)
 *
 * {@link diffParticipantsForSound} treats "no previously-known set at all" (`previousKnownIds ===
 * undefined`) as a silent baseline: the very first participant snapshot after any (re)join —
 * whether a fresh join into a room that already has people in it, or a T11 reconnect restoring the
 * same channel — establishes the known-participants baseline with **zero** sounds, never a storm of
 * "join" notifications for everyone already present. Only participants observed joining or leaving
 * *after* that baseline is established produce a sound. `use-voice-channel.ts` is responsible for
 * resetting the baseline back to `undefined` (via `resetParticipantSoundBaseline`-shaped logic) at
 * every point a "first snapshot after this" moment genuinely begins: an explicit `leave()`, the
 * server confirming this connection left (`onLeft`), an unexpected connection loss entering
 * `'reconnecting'`, and a policy-forced channel removal — never merely inferred from the
 * participants list becoming empty (a room legitimately going empty while the local user is still
 * in it must still play a leave sound for the last person who left).
 *
 * Self-join/self-leave never produce a sound at all — `state.participants` already excludes the
 * local user entirely (see `VoiceChannelState.participants`'s own doc comment), so this module
 * structurally cannot observe a self-transition to begin with; no separate self-exclusion logic is
 * needed here.
 */

export interface ParticipantSoundDiff {
  readonly joined: readonly string[];
  readonly left: readonly string[];
}

/**
 * Pure, side-effect-free — computes which participant ids genuinely joined/left since
 * `previousKnownIds`, per the dedup semantics documented above. Exported so this decision logic is
 * directly unit-testable without a real voice session, a real reconnect, or real audio playback.
 */
export function diffParticipantsForSound(
  previousKnownIds: ReadonlySet<string> | undefined,
  currentIds: ReadonlySet<string>,
): ParticipantSoundDiff {
  if (previousKnownIds === undefined) {
    // First observation since a (re)join — establish the baseline silently.
    return { joined: [], left: [] };
  }
  const joined = [...currentIds].filter((id) => !previousKnownIds.has(id));
  const left = [...previousKnownIds].filter((id) => !currentIds.has(id));
  return { joined, left };
}

export type JoinLeaveSoundKind = 'join' | 'leave';

/**
 * Short (~130-150ms), subtle, project-owned synthesized tones — plain sine tones with a linear
 * fade-in/fade-out envelope, generated for this task (never copied from Discord/TeamSpeak or any
 * other product's assets), gain-conservative (peak ~35% of full scale) to avoid clipping. Encoded as
 * tiny inline 8-bit-PCM/8kHz-mono WAV bytes (base64) so this feature needs no separate binary asset
 * file shipped alongside the app. `join` (660Hz) and `leave` (300Hz) are deliberately distinct
 * pitches so the two are never confused by ear.
 *
 * **Real bug found and fixed via `e2e:voice-smoke`, not merely reasoned about**: the first version of
 * this module played these via `new Audio('data:audio/wav;base64,...')` — a real Electron instance
 * (not a unit test, which never exercises this app's actual CSP) rejected every `data:` URI in the
 * app's `default-src 'self'` policy (`content-security-policy.ts` sets no separate `media-src`, so
 * `default-src` governs `<audio>`'s resource loading too), throwing a genuine `DOMException` and
 * silently never playing anything. Fixed by decoding these bytes directly with
 * `AudioContext.decodeAudioData` and playing them through an `AudioBufferSourceNode` instead — this
 * operates entirely on already-in-memory bytes with no resource-fetch step of any kind, so it is not
 * subject to `media-src`/`default-src` at all, and the app's CSP did not need to be loosened for this
 * feature (keeping it as restrictive as `docs/SECURITY.md` requires).
 */
const JOIN_SOUND_BASE64 =
  'UklGRjQEAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAEAACAgICAgYCAf359fX5/gYOEhIKAfXt6enx/goWHh4WBfHh2dnl+g4iKioeCfHZzc3Z8g4qOjoqEfHVwb3N6g4uRkY6GfHNtbHB4goyTlZGIfXJqaGx1gY2WmZWLfnFoZWhygI6YnJmOgHFmYWRvfo6an52SgnFkXmBrfI2co6GWhXJjW1xneYydpqWaiHNiWFhjdoueqamei3VhVVRfcomeqquhjndjVlRdcIabqayjkXplV1NbbYSZqKykk31nWFNaa4GXp6ymloBpWVNYaH6UpaynmIJsW1NXZnuSpKyomoVuXFNWZHmPoqupnIhxXlRVYXaNoKuqn4t0YFRUX3OKnqqroY12YlVUXnCHnKmsopB5ZFZTXG6EmqispJN8ZldTWmuCl6esppV/aVlTWWl/laasp5eCa1pTV2Z8k6SsqJqEblxTVmR5kKKsqZyHcF5UVWJ2jaGrqp6Kc19UVGB0i5+qq6CNdmFVVF5xiJypq6KPeWRWU1xuhZqorKSSe2ZXU1tsgpinrKWUfmhYU1lpf5amrKeXgWtaU1hnfZOkrKiZhG1bU1dlepGjrKmbhnBdVFZjd46hq6qeiXJfVFVgdIufq6ugjHVhVVRecomdqquhj3hjVlNdb4abqayjkXtlV1NbbIOZqKyllH1oWFNZaoCWpqymloBqWVNYaH2UpayomYNsW1NXZXuRo6ypm4ZvXVNWY3iPoauqnYlyXlRVYXWMoKurn4t0YFVUX3KJnqqroY53Y1ZUXXCGm6mso5F6ZVdTW22EmaispJN9Z1hTWmuBl6esppaAaVlTWGh+lKWsp5iCbFtTV2Z7kqSsqJqFblxTVmR5j6KrqZyIcV5UVWF2jaCrqp+LdGBUVF9zip6qq6GNdmJVVF5wh5yprKKQeWRWU1xuhJqorKSTfGZXU1prgpenrKaVf2lZU1lpf5WmrKeXgmtaU1dmfJOkrKiahG5cU1ZkeZCirKmch3BeVFVido2hq6qeinNfVFRgdIufqqugjXZhVVRecYicqauij3lkVlNcboWaqKykkntmV1NbbIKYp6yllH5oWFNZaX+Wpqynl4FrWlNYZ32TpKyomYRtW1NXZXqRo6ypm4ZwXVRWY3eOoauqnolyX1RVYHSLn6uroIx1YVVUXnKJnaqroY94Y1ZTXW+Gm6mso5F7ZVdTW2yDmKerpJN9aVpWXGyAlKOoopSAbV9ZXmt+kJ6koJSCcGNdYGt8jZqgnpOEdGdgYmx6ipadm5OFd2tkZW15h5OZmZKGeW5oaG55hY+VlpCHe3Jsa3B4g4ySko6HfXVvbnJ5gYmOj4yGf3dzcXR5gIaLjIqFgHp2dXZ6f4SHiIeEgHx5eHl8f4KEhYSCgH58fHx+f4CBgYGAgH9/fw==';

const LEAVE_SOUND_BASE64 =
  'UklGRtQEAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YbAEAACAgICAgIGBgYGBgYGAgH9+fXx8e3t6e3t8fX6AgoOFhoeIiIiHhYSCgH17eXd1dHR0dXd5fH6ChYiKjI6Ojo2LiYaCfnp3c3BvbW1ucHN3e3+EiY2Qk5WVlJKPi4eBfHZybWpoZ2dpbHB2e4KIjpOXmpubmpeSjYaAeHJsZ2NhYGFkaW91fYWMk5meoaKhn5qUjYV9dGxlYFxaWlxgZm52f4mSmqClqKmno52WjYN5b2ZeWFRTVFheZW55g42Xn6aqrKyppJyUin91a2NbVlNTVVlgaHJ8hpGaoaerrKunoZqRhnxyaGBZVVNTVltja3V/ipScpKmsrKqmn5eNg3luZV5YVFNUWF5lbnmDjZefpqqsrKmknJSKf3VrY1tWU1NVWWBocnyGkZqhp6usq6ehmpGGfHJoYFlVU1NWW2NrdX+KlJykqaysqqafl42DeW5lXlhUU1RYXmVueYONl5+mqqysqaSclIqAdWtjW1ZTU1VZYGhyfIaRmqGnq6yrp6GakYZ8cmhgWVVTU1ZbY2t1gIqUnKSprKyqpp+XjYN5bmVeWFRTVFheZW55g42Xn6aqrKyppJyUioB1a2NbVlNTVVlgaHJ8hpGaoaerrKunoZqRhnxyaGBZVVNTVltja3V/ipScpKmsrKqmn5eNg3luZV5YVFNUWF5lbnmDjZefpqqsrKmknJSKgHVrY1tWU1NVWWBocnyGkZqhp6usq6ehmpGGfHJoYFlVU1NWW2NrdYCKlJykqaysqqafl42DeW5lXlhUU1RYXmVueYONl5+mqqysqaSclIqAdWtjW1ZTU1VZYGhyfIaRmqGnq6yrp6GakYZ8cmhgWVVTU1ZbY2t1f4qUnKSprKyqpp+XjYN5bmVeWFRTVFheZW55g42Xn6aqrKyppJyUioB1a2NbVlNTVVlgaHJ8hpGaoaerrKunoZqRhnxyaGBZVVNTVltja3V/ipScpKmsrKqmn5eNg3luZV5YVFNUWF5lbnmDjZefpqqsrKmknJSKgHVrY1tWU1NVWWBocnyGkZqhp6usq6ehmpGGfHJoYFlVU1NWW2NrdYCKlJykqaysqqafl42DeW5lXlhUU1RYXmVueYONl5+mqqysqaSclIqAdWtjW1ZTU1VZYGhyfIaRmqGnq6yrp6GakYZ8cmhgWVVTU1ZbY2t1f4qUnKSprKyqpp+XjYN5bmVeWFRTVFheZW55g42Xn6aqrKyppJyUioB1a2NbVlNTVVlgaHJ8hpGaoaerrKunoZqRhnxyaGBZVVNTVltja3V/ipScpKmsrKqmn5eNg3luZV5YVFNUWF5lbnmDjZefpqqsrKmknJSKgHVrY1tWU1NVWWBocnyGkZqhp6usq6ehmZCGfHJpYlxYVldaX2Vtdn+JkZmfo6Wlo5+ak4uCenJrZWBeXV5hZmxzeoKKkJabnp+enJiTjYd/eXJtaGVkZGVobHF3fYSJj5OWmJiXlZKNiYN+eHRwbWtqamxvcnZ7gISIjI+RkpKQj4yIhYF9eXZ0cnFxcXN1d3p9gYOGiIqLi4uKiIaEgoB9e3p4d3d3eHl6fH1/gYKDhISFhISDg4KBgH9/fn5+fn5+fn9/f38=';

/** `atob`-decodes a base64 string into raw bytes — plain, environment-neutral, no `fetch`/network
 * involved (Electron's Renderer, like any Chromium context, has `atob` globally). */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** One shared, lazily-constructed `AudioContext` for join/leave-sound playback only — kept alive for
 * the Renderer's lifetime (there is no "session" concept these sounds need to scope to; unlike
 * `remote-audio-graph.ts`'s per-connection graph, a fresh context isn't needed on reconnect/server
 * switch). Never shared with `remote-audio-graph.ts`'s own per-connection `AudioContext` — this one
 * has nothing to do with any live participant stream, so keeping it fully separate means a future
 * change to one's lifecycle can never accidentally affect the other's. */
/** The bundled `lib.dom.d.ts` does not yet declare `AudioContext.setSinkId` (a newer "Audio Output
 * Devices" spec extension — see `remote-audio-graph.ts`'s own identical `AudioContextLike.setSinkId`
 * for the same real-and-supported-but-not-yet-typed situation), so this narrow local type carries
 * exactly the one extra optional method this file actually calls. */
type AudioContextWithSinkId = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

let sharedAudioContext: AudioContextWithSinkId | undefined;
const decodedBuffers = new Map<JoinLeaveSoundKind, AudioBuffer>();

function getSharedAudioContext(): AudioContextWithSinkId {
  if (!sharedAudioContext) {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    sharedAudioContext = new AudioContextCtor() as AudioContextWithSinkId;
  }
  return sharedAudioContext;
}

async function getDecodedBuffer(
  kind: JoinLeaveSoundKind,
  audioContext: AudioContext,
): Promise<AudioBuffer> {
  const cached = decodedBuffers.get(kind);
  if (cached) return cached;
  const base64 = kind === 'join' ? JOIN_SOUND_BASE64 : LEAVE_SOUND_BASE64;
  const decoded = await audioContext.decodeAudioData(base64ToArrayBuffer(base64));
  decodedBuffers.set(kind, decoded);
  return decoded;
}

/**
 * Actually plays one sound through the given output device (mirrors this app's existing T11
 * device-selection convention — the same output device voice/screen audio uses), via
 * `AudioBufferSourceNode -> GainNode -> destination` (never `<audio>` — see this file's own "real bug
 * found" doc comment above for why). Never throws; playback failures (autoplay policy edge cases, an
 * invalid device id, a decode failure) are logged, never surfaced as a call-affecting error — a
 * missed notification chime is not worth disrupting the voice session over.
 */
export function playJoinLeaveSound(kind: JoinLeaveSoundKind, outputDeviceId: string | null): void {
  void (async () => {
    try {
      const audioContext = getSharedAudioContext();
      if (typeof audioContext.setSinkId === 'function') {
        await audioContext.setSinkId(outputDeviceId ?? '');
      }
      const buffer = await getDecodedBuffer(kind, audioContext);

      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      const gain = audioContext.createGain();
      gain.gain.value = 0.6; // The source tone itself is already gain-conservative (~35% full scale).
      source.connect(gain);
      gain.connect(audioContext.destination);
      source.start();
    } catch (error) {
      console.error(`voice: failed to play the ${kind} sound`, error);
    }
  })();
}
