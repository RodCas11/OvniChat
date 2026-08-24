import { AnalyserActivitySampler, type AnalyserLike } from './voice-activity-detector.js';

/**
 * T13.4 Decision 3 — the Web Audio playback/analysis graph for every *remote microphone* stream in
 * the current voice session, owning per-participant volume (0-200%) and speaking detection.
 *
 * ### Spike finding (recorded here, the load-bearing decision this whole module depends on)
 *
 * `AudioContext.prototype.setSinkId` **is supported** on this app's pinned Electron 43.4.0 build.
 * Verified via two independent sources, not assumed: (1) Electron 43 ships Chromium 150 (per
 * `electronjs.org`'s own release notes), and (2) `AudioContext.setSinkId()` shipped in Chromium 110
 * (Chrome for Developers' own "Change the destination output device in Web Audio" post, and the
 * `blink-dev` "Intent to Ship" thread) — Chromium 150 is far past that. This means the *first*
 * (preferred) path in this task's brief applies: `<audio>` elements are retired as the playback
 * mechanism for remote microphone audio in favor of this Web Audio graph, with
 * `audioContext.setSinkId()` called once at the context level (see `setOutputDevice`) rather than
 * per-`<audio>`-element `setSinkId()` calls.
 *
 * ### Exactly one audible path per remote stream
 *
 * Per participant: `MediaStreamAudioSourceNode -> GainNode -> AudioContext.destination` is the
 * *only* connection that ever reaches `destination` — this is the one and only audible path.  A
 * second `AnalyserNode` is tapped directly off the same source node for speaking detection and is
 * **never** connected onward to `destination` or anything else (`AnalyserNode` is a pass-through
 * node with no side effect on what it is *not* connected to) — verified by inspection of this
 * module's own connection graph below (`source.connect(gain)` and `source.connect(analyser)` are the
 * only two `connect()` calls this module ever makes per participant, and `analyser` itself has no
 * outgoing `connect()` call anywhere in this file). `VoiceChannelView.tsx`'s own `<RemoteAudio>`
 * elements must never also be mounted for a stream this controller has attached, or the same audio
 * would double/echo — see that component's own doc comment for the T13.4-era split (screen/system
 * audio keeps using `<audio>`; only microphone audio for in-voice participants goes through this
 * graph, since only that class of audio has a per-participant-volume/speaking-detection product
 * requirement).
 *
 * ### Ownership and lifecycle
 *
 * One `AudioContext` per connection/session (constructed once per `use-voice-channel.ts` hook
 * instance's lifetime, closed only in `disposeAll()` on full session teardown — server disconnect/
 * switch, app shutdown), never recreated on ordinary participant churn. `attachParticipant`/
 * `detachParticipant` are safe to call any number of times, matching `P2PMeshTransport`'s own
 * `addParticipant`/`removeParticipant` churn-vs-full-teardown distinction
 * (`docs/architecture/WEBRTC_VOICE.md`'s "Mid-session participant changes are not `closeAll()`").
 *
 * ### A real, live-verified Chromium decode-pipeline requirement: the silent "decode keep-alive" element
 *
 * A genuine regression was found and fixed via `e2e:voice-smoke` after this module first retired
 * `<audio>` elements for microphone playback: on this app's pinned Electron 43.4.0/Chromium 150
 * build, a remote `RTCRtpReceiver`'s audio track is never actually decoded — `RTCInboundRtpStreamStats`'
 * `totalSamplesReceived`/`audioLevel`/`totalAudioEnergy` stay pinned at exactly `0` forever, even
 * while `bytesReceived`/`packetsReceived` climb in lockstep with the sender's own `bytesSent`/
 * `packetsSent` (proving full, healthy RTP delivery) — unless at least one real `HTMLMediaElement`
 * (`<audio>`/`<video>`) is attached to the stream and actually playing. A pure Web Audio consumption
 * graph (`MediaStreamAudioSourceNode -> ... -> AudioContext.destination`) does **not** trigger decode
 * on its own in this build, even when the `AudioContext` itself genuinely reports `'running'` with
 * `currentTime` advancing at real wall-clock rate (verified directly, not assumed, before concluding
 * this) — decode simply never starts, so every consumer of that stream (this class's own gain path,
 * its analyser, and even a wholly separate probe's independent `AnalyserNode`) reads permanent
 * silence. This reproduced with Chromium's plain `--use-fake-device-for-media-stream` generator (no
 * file-backed fake audio involved) and was independent of any mute/Push-to-Talk timing — confirmed
 * by a differential test: attaching a muted, autoplaying `<audio>` element to the exact same stream
 * immediately and reliably unblocked decode for every consumer, with no other change.
 *
 * `attachParticipant` therefore also creates one hidden, `muted = true` `HTMLAudioElement` per
 * participant purely to keep this decode pipeline alive — it is **never** an audible path (the class
 * doc comment's "exactly one audible path" invariant above is unchanged: this element's own audio
 * output is unconditionally muted, so it can never double/echo whatever `source -> gain -> destination`
 * already renders) and is never inserted into the DOM (a detached `new Audio()` is a complete, valid
 * `HTMLMediaElement` sink on its own). `play()`'s returned promise is deliberately not awaited by the
 * caller and any rejection is caught and logged, never thrown — matching this class's own existing
 * "a speaking-detection/decode-keep-alive failure must never take the audible path down with it"
 * precedent for the sampler right below.
 */

/** The narrow slice of the real Web Audio API this module depends on, declared locally so tests can
 * inject a fully fake implementation — neither `AudioContext` nor any of its node types exist under
 * Vitest/jsdom, and this codebase's own convention (mirroring `voice-activity-detector.ts`'s
 * `AnalyserLike`) is to mock at this narrow interface boundary rather than skip testing entirely. */
export interface AudioContextLike {
  readonly destination: unknown;
  createMediaStreamSource(stream: MediaStream): MediaStreamAudioSourceNodeLike;
  createGain(): GainNodeLike;
  createAnalyser(): AnalyserNodeLike;
  /** Real `AudioContext.setSinkId` — optional because it is a genuinely feature-detected method (see
   * this file's own "spike finding" doc comment above for why it is expected to exist on this app's
   * pinned build, but this module still guards defensively, mirroring `RemoteAudio.tsx`'s own
   * pre-T13.4 `typeof audio.setSinkId === 'function'` guard). */
  setSinkId?: (sinkId: string) => Promise<void>;
  close(): Promise<void>;
}

export interface AudioNodeLike {
  connect(destination: unknown): void;
  disconnect(): void;
}

export type MediaStreamAudioSourceNodeLike = AudioNodeLike;

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: { value: number };
}

export interface AnalyserNodeLike extends AudioNodeLike, AnalyserLike {
  fftSize: number;
}

/** The narrow slice of `HTMLMediaElement` the decode-keep-alive mechanism (see this file's own
 * top doc comment) needs — declared locally for the same test-injection reason as `AudioContextLike`
 * (`HTMLAudioElement` does not exist under Vitest/jsdom either). */
export interface AudioElementLike {
  srcObject: MediaStream | null;
  muted: boolean;
  play(): Promise<void>;
  pause(): void;
}

/** `Math.min`/`Math.max` clamp shared by volume get/set — 0-200% per this task's product spec. */
function clampVolumePercent(percent: number): number {
  return Math.max(0, Math.min(200, percent));
}

interface ParticipantNodes {
  readonly source: MediaStreamAudioSourceNodeLike;
  readonly gain: GainNodeLike;
  readonly analyser: AnalyserNodeLike;
  readonly sampler: AnalyserActivitySampler;
  /** See this file's own top doc comment's "decode keep-alive" section — never an audible path. */
  readonly decodeKeepAlive: AudioElementLike;
  volumePercent: number;
  muted: boolean;
}

export interface RemoteAudioGraphOptions {
  /** Called on every real speaking-state *transition* for a participant (never on every raw sample —
   * see `AnalyserActivitySampler`'s own doc comment). `use-voice-channel.ts` is expected to fold
   * these into a `ReadonlySet<string>` of currently-speaking participant ids. */
  readonly onSpeakingChange?: (participantId: string, speaking: boolean) => void;
  /** 0-1, shared across every remote participant — mirrors the local mic's own
   * `voiceActivitySensitivity` setting, though remote detection has no product requirement to expose
   * a separate per-remote-participant sensitivity control. Defaults to `0.5`. */
  readonly sensitivity?: number;
  /** Test-only injection point — defaults to constructing a real `AudioContext` (cast through
   * `AudioContextLike`, which is a strict narrowing of the real type, not a structural mismatch). */
  readonly createAudioContext?: () => AudioContextLike;
  /** Test-only injection point for the decode-keep-alive element (see this file's own top doc
   * comment) — defaults to constructing a real, detached `HTMLAudioElement`, never inserted into the
   * DOM. */
  readonly createAudioElement?: () => AudioElementLike;
  /** Seeds the deafen override at construction time (see `setDeafened`) — lets a caller construct an
   * already-deafened graph (e.g. the user was deafened before ever joining voice) without a separate
   * follow-up call. Defaults to `false`. */
  readonly initialDeafened?: boolean;
}

function defaultAudioContextFactory(): AudioContextLike {
  const AudioContextCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new AudioContextCtor() as unknown as AudioContextLike;
}

/** See this file's own top doc comment's "decode keep-alive" section. A detached `Audio()` element —
 * never inserted into the DOM — is a complete, valid `HTMLMediaElement` sink on its own; `muted` is
 * set before `srcObject` is ever assigned so this element can never be audible even for one frame. */
function defaultAudioElementFactory(): AudioElementLike {
  const audio = new Audio();
  audio.muted = true;
  // Cast through `AudioElementLike` (a strict narrowing of the real type down to `MediaStream | null`
  // for `srcObject`, mirroring `defaultAudioContextFactory`'s identical cast above) — this module
  // only ever assigns a `MediaStream`, never a `MediaSource`/`Blob`, so the narrower type is accurate
  // for every real caller even though the DOM's own `srcObject` type is the wider `MediaProvider`.
  return audio as unknown as AudioElementLike;
}

export class RemoteAudioGraphController {
  private readonly audioContext: AudioContextLike;
  private readonly createAudioElement: () => AudioElementLike;
  private readonly participants = new Map<string, ParticipantNodes>();
  private readonly onSpeakingChange: RemoteAudioGraphOptions['onSpeakingChange'];
  private readonly sensitivity: number;
  private disposed = false;
  /** T13.4 — a top-level override applied on top of every participant's own `volumePercent`/`muted`
   * (see `applyGain`), never mutating either — this is deliberately a separate flag rather than
   * iterating every participant and setting `muted = true`, precisely so un-deafening can restore
   * exactly what was there before (each participant's own volume and local-mute) with a single flag
   * flip, mirroring deafen's existing "instant, no renegotiation, remote side never told anything
   * changed" semantics (`docs/architecture/WEBRTC_VOICE.md`'s "Microphone lifecycle" section, applied
   * here to playback instead of the local mic). */
  private deafened: boolean;

  constructor(options: RemoteAudioGraphOptions = {}) {
    this.audioContext = (options.createAudioContext ?? defaultAudioContextFactory)();
    this.createAudioElement = options.createAudioElement ?? defaultAudioElementFactory;
    this.onSpeakingChange = options.onSpeakingChange;
    this.sensitivity = options.sensitivity ?? 0.5;
    this.deafened = options.initialDeafened ?? false;
  }

  /**
   * Wires up playback + analysis for one remote participant's microphone stream. Safe to call again
   * for an already-attached `participantId` (e.g. a reconnect's fresh stream for the same logical
   * participant slot) — the previous nodes are fully detached first, never left dangling alongside
   * the new ones.
   *
   * `initialVolumePercent`/`initialMuted` let a caller apply a persisted local voice preference (T13.4
   * — see `use-voice-channel.ts`'s own attach-with-preference logic) *before* the first audible
   * frame, rather than starting at the 100%/unmuted product default and correcting a moment later.
   */
  attachParticipant(
    participantId: string,
    stream: MediaStream,
    initialVolumePercent = 100,
    initialMuted = false,
  ): void {
    if (this.disposed) return;
    if (this.participants.has(participantId)) this.detachParticipant(participantId);

    const source = this.audioContext.createMediaStreamSource(stream);
    const gain = this.audioContext.createGain();
    const analyser = this.audioContext.createAnalyser();
    analyser.fftSize = 256;

    // The one and only audible path for this participant (see this file's own top doc comment).
    source.connect(gain);
    gain.connect(this.audioContext.destination);
    // Analysis-only tap — deliberately never connected onward to anything.
    source.connect(analyser);

    // Decode keep-alive (see this file's own top doc comment) — never an audible path. `muted` is
    // already `true` from `defaultAudioElementFactory`/the test-injected fake before `srcObject` is
    // ever assigned; setting it again here defensively covers a caller-injected `createAudioElement`
    // that did not already do so.
    const decodeKeepAlive = this.createAudioElement();
    decodeKeepAlive.muted = true;
    decodeKeepAlive.srcObject = stream;
    decodeKeepAlive.play().catch((error: unknown) => {
      // Defense-in-depth, mirroring the sampler's own try/catch just below: this element is not the
      // audible path (that is already wired above via `source -> gain -> destination`), so a failure
      // here must never be treated as a playback failure — only decode-pipeline "liveness" degrades.
      console.error('voice: failed to start remote-audio decode keep-alive', participantId, error);
    });

    const nodes: ParticipantNodes = {
      source,
      gain,
      analyser,
      decodeKeepAlive,
      volumePercent: clampVolumePercent(initialVolumePercent),
      muted: initialMuted,
      sampler: new AnalyserActivitySampler(analyser, this.sensitivity, (speaking) => {
        this.onSpeakingChange?.(participantId, speaking);
      }),
    };
    this.applyGain(nodes);
    // Defense-in-depth: the audible path (`source -> gain -> destination`) is already wired above
    // this point — a speaking-detection failure must never take playback down with it. Registered in
    // `this.participants` regardless of whether the sampler started, so volume/mute controls still
    // work for this participant even if speaking detection alone failed to start.
    try {
      nodes.sampler.start();
    } catch (error) {
      console.error('voice: failed to start remote speaking detection', participantId, error);
    }
    this.participants.set(participantId, nodes);
  }

  /** Full node cleanup (disconnect every node, stop the sampler's timer, release the decode
   * keep-alive element) — no leaks across a repeated attach/detach cycle. Safe to call for an id that
   * was never attached (or already detached) — a silent no-op. */
  detachParticipant(participantId: string): void {
    const nodes = this.participants.get(participantId);
    if (!nodes) return;
    nodes.sampler.stop();
    nodes.source.disconnect();
    nodes.gain.disconnect();
    nodes.analyser.disconnect();
    nodes.decodeKeepAlive.pause();
    nodes.decodeKeepAlive.srcObject = null;
    this.participants.delete(participantId);
  }

  /** 0-200%; out-of-range values are clamped, never rejected outright (mirrors this app's existing
   * "clamp, don't throw, for a local UI-only preference" convention). A no-op for an unattached id. */
  setParticipantVolume(participantId: string, percent: number): void {
    const nodes = this.participants.get(participantId);
    if (!nodes) return;
    nodes.volumePercent = clampVolumePercent(percent);
    this.applyGain(nodes);
  }

  /** "Mute for Me" / "Unmute for Me" — purely local playback gating, independent of `volumePercent`
   * (see this method's own doc comment on `ParticipantNodes.volumePercent` above): un-muting always
   * restores exactly the volume that was configured before muting, never resets to 100%. A no-op for
   * an unattached id. */
  setParticipantMuted(participantId: string, muted: boolean): void {
    const nodes = this.participants.get(participantId);
    if (!nodes) return;
    nodes.muted = muted;
    this.applyGain(nodes);
  }

  getParticipantVolume(participantId: string): number | undefined {
    return this.participants.get(participantId)?.volumePercent;
  }

  isParticipantMuted(participantId: string): boolean {
    return this.participants.get(participantId)?.muted ?? false;
  }

  /**
   * Deafen/un-deafen every currently- and future-attached participant's playback at once, without
   * ever touching any participant's own `volumePercent`/`muted` — see this class's own field doc
   * comment on `deafened` for why a separate override flag (not a per-participant mutation) is what
   * makes un-deafening restore each participant's own prior configuration exactly. Instant — no
   * `AudioContext` suspend/resume, no renegotiation, nothing sent to any remote peer (this is a pure
   * local-playback concern, mirroring `RemoteAudio.tsx`'s pre-T13.4 `audio.muted` deafen behavior).
   */
  setDeafened(deafened: boolean): void {
    if (this.deafened === deafened) return;
    this.deafened = deafened;
    for (const nodes of this.participants.values()) this.applyGain(nodes);
  }

  isDeafened(): boolean {
    return this.deafened;
  }

  /** T11 output-device selection, applied once at the context level — replaces every per-`<audio>`-
   * element `setSinkId()` call this app used before T13.4 for microphone-audio playback (screen/
   * system audio, still played via `<audio>`, is unaffected — see this file's own top doc comment).
   * A no-op (never throws) if `setSinkId` is unsupported, mirroring `RemoteAudio.tsx`'s own
   * pre-T13.4 defensive guard. */
  async setOutputDevice(deviceId: string | null): Promise<void> {
    if (typeof this.audioContext.setSinkId !== 'function') return;
    await this.audioContext.setSinkId(deviceId ?? '');
  }

  /** Session teardown only (server disconnect/switch, app shutdown) — never called for ordinary
   * participant churn (see this file's own top doc comment). Detaches every remaining participant
   * first (no leaked nodes), then closes the shared `AudioContext` itself. Idempotent. */
  disposeAll(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const participantId of [...this.participants.keys()])
      this.detachParticipant(participantId);
    void this.audioContext.close();
  }

  private applyGain(nodes: ParticipantNodes): void {
    nodes.gain.gain.value = nodes.muted || this.deafened ? 0 : nodes.volumePercent / 100;
  }
}
