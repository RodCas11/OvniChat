/**
 * How the local user currently controls when their microphone transmits. `'voice-activity'` gates
 * on a caller-supplied energy/hysteresis signal (see `setVoiceActivityDetected`); `'push-to-talk'`
 * gates on a physically-held key (see `setPttHeld`).
 */
export type VoiceInputMode = 'voice-activity' | 'push-to-talk';

/**
 * The four independent inputs `TransmitGate` combines. All four are plain, framework-neutral values
 * — no audio analysis, no DOM/Electron dependency, and no knowledge of *how* any of them were
 * produced (a UI mute button, a native global-hotkey listener, an `AnalyserNode`-based detector —
 * all outside this package's concern; see `docs/adr/0021-global-ptt-in-process-keyboard-hook.md` and
 * T13.4's own task doc for what produces `pttHeld`/`voiceActivityDetected` in practice).
 */
export interface TransmitGateState {
  readonly userMuted: boolean;
  readonly inputMode: VoiceInputMode;
  readonly pttHeld: boolean;
  readonly voiceActivityDetected: boolean;
}

/**
 * Seed state for a freshly-constructed `TransmitGate`. `pttHeld` is deliberately **not** part of
 * this type — see `TransmitGate`'s constructor doc comment for why a fresh gate must always start
 * with `pttHeld: false`, unconditionally, with no caller-provided override.
 */
export type TransmitGateInitialState = Partial<Omit<TransmitGateState, 'pttHeld'>>;

/**
 * The narrow slice of `Microphone` (see `microphone.ts`) this class actually needs. `TransmitGate`
 * never adds/removes tracks, never calls `replaceTrack`, and never touches an `RTCRtpSender` or
 * transceiver — `track.enabled` toggling via `Microphone.setMuted` is the only mechanism it uses to
 * start/stop transmission, matching this repository's existing mute precedent
 * (`docs/architecture/WEBRTC_VOICE.md`'s "Microphone lifecycle" section): instant, no renegotiation,
 * no device reacquisition.
 */
export interface MutableMicrophone {
  setMuted(muted: boolean): void;
}

const DEFAULT_STATE: TransmitGateState = {
  userMuted: false,
  inputMode: 'voice-activity',
  pttHeld: false,
  voiceActivityDetected: false,
};

/**
 * Owns the single source of truth for "should the local microphone actually be transmitting right
 * now," deriving it from exactly four inputs (explicit mute, input mode, PTT-held, and
 * voice-activity-detected) and applying the result to one underlying `Microphone` via
 * `setMuted(!shouldTransmit)` — never anything else.
 *
 * ### Derivation (binding product rule)
 *
 * ```text
 * shouldTransmit =
 *   !userMuted
 *   AND (
 *     (inputMode === 'voice-activity' AND voiceActivityDetected)
 *     OR
 *     (inputMode === 'push-to-talk' AND pttHeld)
 *   )
 * ```
 *
 * Explicit mute always wins: a muted user holding PTT still does not transmit. This is intentional
 * — mute is a stronger explicit state than PTT (T13.4 product spec).
 *
 * ### Edge-triggered PTT and why a fresh instance is required per session
 *
 * `pttHeld` always starts `false` and can only become `true` via an explicit `setPttHeld(true)`
 * call representing a genuinely fresh key-press — never inferred, never restored. `initial` (the
 * constructor's second argument) structurally cannot set `pttHeld`: `TransmitGateInitialState`
 * omits the field entirely, so there is no accidental or convenience path to constructing an
 * already-"held" gate, in tests or otherwise. The practical consequence lives one level up (a later
 * Renderer-side integration, not this class): every fresh microphone acquisition — initial
 * voice-channel join, or a reconnect's fresh reacquire — must construct a *new* `TransmitGate`
 * rather than resurrecting a previous instance's `pttHeld`, so a key physically still held across a
 * reconnect can never silently resume transmission; a fresh press is always required after a new
 * session begins. This class only holds up its half of that contract (no restore path exists here);
 * it cannot prevent a caller from reusing a stale instance.
 *
 * ### Device switch vs. reconnect: why `rebind` preserves state and reconstruction does not
 *
 * T11 device switching (`docs/architecture/WEBRTC_VOICE.md`'s "T11 device switching" section)
 * acquires a new `Microphone` for a different physical device but keeps the same logical voice
 * session — the transport swaps tracks via `replaceTrack` without renegotiation. `rebind` mirrors
 * that: it swaps this gate's underlying `Microphone` reference but **preserves every field of
 * `TransmitGateState`, including `pttHeld` and `voiceActivityDetected`**. Reasoning: the user's
 * finger/mouse-button state and their actual voice activity have not changed — only which physical
 * microphone is capturing them — so resetting either would incorrectly cut off a user mid-sentence
 * (holding PTT, or still speaking) for a reason that has nothing to do with their input state. A
 * reconnect is different in kind, not degree: it is a new session (a fresh `voice:join`, a fresh
 * `acquireMicrophone()` call, a fresh set of peer connections), and the caller is expected to
 * construct a brand-new `TransmitGate` for it — which, per the rule above, always starts with
 * `pttHeld: false` — rather than calling `rebind` on the old one. `rebind` itself never resets
 * `pttHeld`; it is not the mechanism that makes reconnect safe, a fresh construction is.
 *
 * After swapping the reference, `rebind` unconditionally re-applies the gate's current
 * `shouldTransmit` value to the *new* microphone via `setMuted` — unconditionally, not only on a net
 * change, because the new `Microphone` instance starts fresh (unmuted, per `microphone.ts`) and
 * knows nothing about this gate's prior decisions; skipping the call whenever the derived value
 * happens not to have changed since the *previous* microphone would leave the new device
 * incorrectly un-gated.
 */
export class TransmitGate {
  private microphone: MutableMicrophone;
  private state: TransmitGateState;

  constructor(microphone: MutableMicrophone, initial: TransmitGateInitialState = {}) {
    this.microphone = microphone;
    this.state = {
      ...DEFAULT_STATE,
      ...initial,
      pttHeld: false,
    };
    // Apply the initial derived state immediately — a freshly-acquired `Microphone` starts
    // unmuted (see `microphone.ts`), so without this, a gate that should not yet be transmitting
    // (the common case: nothing has happened yet) would leave the track enabled until the first
    // setter call.
    this.microphone.setMuted(!this.shouldTransmit);
  }

  get userMuted(): boolean {
    return this.state.userMuted;
  }

  get inputMode(): VoiceInputMode {
    return this.state.inputMode;
  }

  get pttHeld(): boolean {
    return this.state.pttHeld;
  }

  get voiceActivityDetected(): boolean {
    return this.state.voiceActivityDetected;
  }

  get shouldTransmit(): boolean {
    return computeShouldTransmit(this.state);
  }

  setUserMuted(muted: boolean): void {
    this.applyState({ ...this.state, userMuted: muted });
  }

  setInputMode(mode: VoiceInputMode): void {
    this.applyState({ ...this.state, inputMode: mode });
  }

  /** See the class doc comment's "Edge-triggered PTT" section — only ever call this with `true` for a genuinely fresh key-press event. */
  setPttHeld(held: boolean): void {
    this.applyState({ ...this.state, pttHeld: held });
  }

  setVoiceActivityDetected(detected: boolean): void {
    this.applyState({ ...this.state, voiceActivityDetected: detected });
  }

  /**
   * Swaps the underlying `Microphone` in place (T11 device switch) without resetting `pttHeld` or
   * `voiceActivityDetected`. See the class doc comment's "Device switch vs. reconnect" section for
   * the full reasoning. Do not call this for a reconnect — construct a new `TransmitGate` instead.
   */
  rebind(microphone: MutableMicrophone): void {
    this.microphone = microphone;
    this.microphone.setMuted(!this.shouldTransmit);
  }

  private applyState(next: TransmitGateState): void {
    const previousShouldTransmit = computeShouldTransmit(this.state);
    this.state = next;
    const nextShouldTransmit = computeShouldTransmit(next);
    if (nextShouldTransmit !== previousShouldTransmit) {
      this.microphone.setMuted(!nextShouldTransmit);
    }
  }
}

function computeShouldTransmit(state: TransmitGateState): boolean {
  if (state.userMuted) return false;
  return state.inputMode === 'voice-activity' ? state.voiceActivityDetected : state.pttHeld;
}
