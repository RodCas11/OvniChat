import type { RemoteTrackEvent } from '@disco-voador/rtc-core';
import type { TrackSource } from '@disco-voador/protocol';

/**
 * Every remote source `useVoiceChannel` tracks per participant, keyed by semantic source rather
 * than `track.kind` — see `stateKeyForSource`'s doc comment for why. Each map holds at most one
 * entry per participant, mirroring this app's own design invariant (one local microphone, one local
 * camera, one local screen-video, one local screen-audio source at a time).
 */
export interface RemoteMediaStreamsState {
  readonly remoteAudioStreams: ReadonlyMap<string, MediaStream>;
  readonly remoteCameraStreams: ReadonlyMap<string, MediaStream>;
  readonly remoteScreenStreams: ReadonlyMap<string, MediaStream>;
  readonly remoteScreenAudioStreams: ReadonlyMap<string, MediaStream>;
}

export function createEmptyRemoteMediaStreamsState(): RemoteMediaStreamsState {
  return {
    remoteAudioStreams: new Map(),
    remoteCameraStreams: new Map(),
    remoteScreenStreams: new Map(),
    remoteScreenAudioStreams: new Map(),
  };
}

type RemoteMediaStateKey = keyof RemoteMediaStreamsState;

function withoutParticipant(
  streams: ReadonlyMap<string, MediaStream>,
  participantId: string,
): ReadonlyMap<string, MediaStream> {
  if (!streams.has(participantId)) return streams;
  const next = new Map(streams);
  next.delete(participantId);
  return next;
}

/**
 * T5 introduced this discriminator for video (`track.kind === 'video'` stopped identifying content
 * once both camera and screen-video existed); T6 extends it to audio for the identical reason, once
 * both microphone and screen-audio exist. `'microphone'` maps to the same `remoteAudioStreams` field
 * this app has always used for it — T6 does not rename that field, only stops treating it as an
 * unannounced default (see `TrackSource`'s doc comment in `packages/protocol`).
 */
function stateKeyForSource(source: TrackSource): RemoteMediaStateKey {
  switch (source) {
    case 'microphone':
      return 'remoteAudioStreams';
    case 'camera':
      return 'remoteCameraStreams';
    case 'screen-video':
      return 'remoteScreenStreams';
    case 'screen-audio':
      return 'remoteScreenAudioStreams';
  }
}

export interface RemoteMediaReconcilerCallbacks {
  updateStreams(updater: (prev: RemoteMediaStreamsState) => RemoteMediaStreamsState): void;
  /** Diagnostic only: a remote track's `media:track-source` announcement never arrived within the
   * grace window — see `handleRemoteTrack`'s doc comment. Never a correctness fallback. */
  onMissingAnnouncement?(participantId: string, mid: string, kind: 'audio' | 'video'): void;
}

// Mirrors the original T5 video-only design's grace window — see `handleRemoteTrack`.
const ANNOUNCEMENT_GRACE_MS = 5000;

/**
 * Owns the `mid`-based reconciliation between `ontrack` (rtc-core's `remoteTrack` event) and
 * `media:track-source` announcements, for every remote source kind — audio and video alike — for
 * one realtime/transport connection's lifetime. See `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s
 * "Reconciliation on the receiving side" and `docs/architecture/WEBRTC_SCREEN_AUDIO.md` for the full
 * design rationale, including two real, live-found bugs this exact logic has already produced
 * (mid reuse across sources, and an unrelated source's stream being deleted as a side effect of
 * wiring in an unrelated new source) — both fixed, both reasons this module now has direct unit
 * coverage instead of relying solely on a live two-instance E2E run.
 *
 * Deliberately a plain class with no React/DOM-beyond-`MediaStreamTrack` dependency (no hooks, no
 * JSX, no `useState`) — `updateStreams` is injected so `useVoiceChannel` can drive this with its own
 * `setState`, and a test can drive it with a plain array-capturing stub instead. `useVoiceChannel`
 * owns exactly one instance per connection lifetime and calls `reset()` on reconnect/rejoin.
 */
export class RemoteMediaReconciler {
  private readonly sourceByKey = new Map<string, TrackSource>();
  private readonly pendingByKey = new Map<string, RemoteTrackEvent>();
  private readonly wiredByKey = new Map<string, RemoteTrackEvent>();

  constructor(private readonly callbacks: RemoteMediaReconcilerCallbacks) {}

  /** Clears all reconciliation state — call when the underlying connection/transport is torn down
   * and replaced (a fresh join), never mid-session. */
  reset(): void {
    this.sourceByKey.clear();
    this.pendingByKey.clear();
    this.wiredByKey.clear();
  }

  private key(participantId: string, mid: string): string {
    return `${participantId}:${mid}`;
  }

  /**
   * Sets `event`'s stream into the map matching `source` — no other map is touched. Used both for a
   * brand-new key's initial wire and for an `'unmute'` re-add on an already-known key. Must never
   * assume another key's map entry for this participant is stale just because *this* key is being
   * (re)wired — up to four independent sources can be concurrently live for one participant now
   * (microphone, camera, screen-video, screen-audio); a different, still-live key's entry must never
   * be touched as a side effect (this was a real bug — see this class's doc comment).
   */
  private setStream(event: RemoteTrackEvent, source: TrackSource): void {
    const stateKey = stateKeyForSource(source);
    this.callbacks.updateStreams((prev) => {
      const streams = new Map(prev[stateKey]);
      streams.set(event.participantId, event.stream);
      return { ...prev, [stateKey]: streams };
    });
  }

  /**
   * Moves one key's rendered stream from its previous source's map to its new source's map — the
   * mid-reuse case: a `mid` was previously classified as `previousSource` and a later
   * `media:track-source` announcement reclassifies the *same* key as `newSource`. Only here is it
   * correct to remove the previous classification's entry, because it is *this key's own* prior
   * entry being superseded, not a guess about "the other map" in general.
   */
  private reclassifyStream(
    event: RemoteTrackEvent,
    previousSource: TrackSource,
    newSource: TrackSource,
  ): void {
    const previousKey = stateKeyForSource(previousSource);
    const newKey = stateKeyForSource(newSource);
    this.callbacks.updateStreams((prev) => {
      const previousStreams = new Map(prev[previousKey]);
      previousStreams.delete(event.participantId);
      const newStreams = new Map(prev[newKey]);
      newStreams.set(event.participantId, event.stream);
      return { ...prev, [previousKey]: previousStreams, [newKey]: newStreams };
    });
  }

  private removeStream(event: RemoteTrackEvent, source: TrackSource): void {
    const stateKey = stateKeyForSource(source);
    this.callbacks.updateStreams((prev) => {
      const streams = new Map(prev[stateKey]);
      streams.delete(event.participantId);
      return { ...prev, [stateKey]: streams };
    });
  }

  /**
   * Wires a reconciled remote track (source now known for `key`) into the right state map — never
   * inferred, always driven by this key's most recently known `TrackSource` in `sourceByKey`,
   * looked up *dynamically* every time a mute/unmute/ended event actually fires rather than
   * captured once in a closure (closing the mid-reuse misrouting class of bug).
   *
   * All three of `'ended'`, `'mute'`, and `'unmute'` are wired for every track kind, not only video:
   * `'ended'` is this app's original, live-verified removal signal (still correct for a genuine
   * unpublish/participant-leave, on both audio and video); `'mute'`/`'unmute'` were added for video
   * after live testing found `'ended'` alone unreliable for a track renegotiated away and reused by
   * a different source (see `docs/architecture/WEBRTC_SCREEN_SHARE.md`). Attaching all three to
   * audio too is a superset, not a behavior change for microphone specifically — an application-
   * level mute (`track.enabled = false`) sends silence rather than muting the track at the WebRTC
   * level, so it was never expected to fire `'mute'`/`'unmute'` and still won't; `'ended'` remains
   * the operative signal there, unchanged from T3/T4.
   */
  private wireTrack(event: RemoteTrackEvent, key: string): void {
    this.wiredByKey.set(key, event);

    event.track.addEventListener('ended', () => {
      const source = this.sourceByKey.get(key);
      if (source) this.removeStream(event, source);
    });
    event.track.addEventListener('mute', () => {
      const source = this.sourceByKey.get(key);
      if (source) this.removeStream(event, source);
    });
    event.track.addEventListener('unmute', () => {
      const source = this.sourceByKey.get(key);
      if (source) this.setStream(event, source);
    });

    const initialSource = this.sourceByKey.get(key);
    if (initialSource) this.setStream(event, initialSource);
  }

  /**
   * Call from `MediaTransport`'s `remoteTrack` event, for every remote track regardless of kind.
   * `event.mid === null` is a defensive fallback for a platform that genuinely did not report one
   * (should not happen once negotiation has completed) — the track is logged and otherwise dropped
   * rather than guessed at; there is nothing to reconcile against without it.
   */
  handleRemoteTrack(event: RemoteTrackEvent): void {
    if (event.mid === null) {
      console.error('voice: a remote track arrived with no mid — cannot identify its source', {
        participantId: event.participantId,
        kind: event.track.kind,
      });
      return;
    }

    const key = this.key(event.participantId, event.mid);
    if (this.sourceByKey.has(key)) {
      this.wireTrack(event, key);
      return;
    }

    this.pendingByKey.set(key, event);
    // Diagnostic only, not a correctness fallback — if the announcement never arrives (a sender-
    // side bug, not an expected race), this leaves a trace instead of the track silently never
    // appearing anywhere with no explanation.
    const mid = event.mid;
    setTimeout(() => {
      if (this.pendingByKey.get(key) === event) {
        this.callbacks.onMissingAnnouncement?.(
          event.participantId,
          mid,
          event.track.kind as 'audio' | 'video',
        );
      }
    }, ANNOUNCEMENT_GRACE_MS);
  }

  /**
   * Removes one participant's entry from all four remote-stream maps at once — call when a
   * participant fully leaves (server `voice:participant-left`, or a client-side rejoin/teardown).
   * Deliberately a single method covering every map, not left to each caller to reconstruct the
   * same four-map diff inline: this is exactly the kind of "obviously correct" bookkeeping that has
   * already been wrong twice in this codebase's history (the T5 stabilization `moveRemoteVideoStream`
   * bug and the `Peer.handleRemoteOffer` mid-reporting gap were both cases where a seemingly safe,
   * uncontroversial piece of code silently missed a case) — centralizing it here gives it the same
   * direct unit coverage the rest of this class already has, instead of relying on each call site
   * remembering to update all four maps whenever a fifth source is ever added.
   */
  removeParticipant(participantId: string): void {
    this.callbacks.updateStreams((prev) => ({
      remoteAudioStreams: withoutParticipant(prev.remoteAudioStreams, participantId),
      remoteCameraStreams: withoutParticipant(prev.remoteCameraStreams, participantId),
      remoteScreenStreams: withoutParticipant(prev.remoteScreenStreams, participantId),
      remoteScreenAudioStreams: withoutParticipant(prev.remoteScreenAudioStreams, participantId),
    }));
  }

  /** Call from `RealtimeClient`'s `mediaTrackSource` event (a `media:track-source` message). */
  handleMediaTrackSource(participantId: string, mid: string, source: TrackSource): void {
    const key = this.key(participantId, mid);
    const previousSource = this.sourceByKey.get(key);
    this.sourceByKey.set(key, source);

    const pendingEvent = this.pendingByKey.get(key);
    if (pendingEvent) {
      this.pendingByKey.delete(key);
      this.wireTrack(pendingEvent, key);
      return;
    }

    // Not a first-time reconciliation — this key was already wired. A later announcement with a
    // *different* source than before means the sender's `mid` got reused for a different track —
    // move the already-rendered stream to the correct map now, rather than only self-correcting on
    // that track's next mute/unmute event, which could otherwise leave a brief window where the
    // wrong content is displayed under the wrong label.
    const wiredEvent = this.wiredByKey.get(key);
    if (wiredEvent && previousSource !== undefined && previousSource !== source) {
      this.reclassifyStream(wiredEvent, previousSource, source);
    }
  }
}
