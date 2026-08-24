import { beforeEach, describe, expect, it } from 'vitest';

import {
  TransmitGate,
  type MutableMicrophone,
  type VoiceInputMode,
} from '../../packages/media-core/src/transmit-gate.js';

/**
 * `TransmitGate` only ever needs `setMuted` from a real `Microphone` (`microphone.ts`) — this fake
 * implements exactly that narrow interface (`MutableMicrophone`) and records every call so tests can
 * assert both the final muted state and that no redundant call was made.
 */
function fakeMicrophone(): MutableMicrophone & { calls: boolean[]; muted: boolean | undefined } {
  const fake = {
    calls: [] as boolean[],
    muted: undefined as boolean | undefined,
    setMuted(muted: boolean): void {
      fake.calls.push(muted);
      fake.muted = muted;
    },
  };
  return fake;
}

describe('TransmitGate — construction', () => {
  it('starts muted (not transmitting) by default, applying that to the microphone immediately', () => {
    const mic = fakeMicrophone();
    const gate = new TransmitGate(mic);

    expect(gate.shouldTransmit).toBe(false);
    expect(mic.calls).toEqual([true]); // setMuted(true) — not transmitting
  });

  it('always starts with pttHeld: false regardless of inputMode, even in push-to-talk mode', () => {
    const mic = fakeMicrophone();
    const gate = new TransmitGate(mic, { inputMode: 'push-to-talk' });

    expect(gate.pttHeld).toBe(false);
    expect(gate.shouldTransmit).toBe(false);
  });

  it('accepts initial userMuted/inputMode/voiceActivityDetected overrides', () => {
    const mic = fakeMicrophone();
    const gate = new TransmitGate(mic, {
      userMuted: false,
      inputMode: 'voice-activity',
      voiceActivityDetected: true,
    });

    expect(gate.shouldTransmit).toBe(true);
    expect(mic.calls).toEqual([false]); // setMuted(false) — transmitting immediately
  });

  it('has no constructor path that can set pttHeld to true — TransmitGateInitialState omits the field entirely', () => {
    const mic = fakeMicrophone();
    // @ts-expect-error — pttHeld is intentionally not part of TransmitGateInitialState.
    const gate = new TransmitGate(mic, { pttHeld: true });

    expect(gate.pttHeld).toBe(false);
  });
});

describe('TransmitGate — derivation truth table', () => {
  const cases: Array<{
    userMuted: boolean;
    inputMode: VoiceInputMode;
    pttHeld: boolean;
    voiceActivityDetected: boolean;
    expected: boolean;
  }> = [
    // voice-activity mode
    {
      userMuted: false,
      inputMode: 'voice-activity',
      pttHeld: false,
      voiceActivityDetected: false,
      expected: false,
    },
    {
      userMuted: false,
      inputMode: 'voice-activity',
      pttHeld: false,
      voiceActivityDetected: true,
      expected: true,
    },
    {
      userMuted: false,
      inputMode: 'voice-activity',
      pttHeld: true,
      voiceActivityDetected: false,
      expected: false,
    },
    {
      userMuted: false,
      inputMode: 'voice-activity',
      pttHeld: true,
      voiceActivityDetected: true,
      expected: true,
    },
    {
      userMuted: true,
      inputMode: 'voice-activity',
      pttHeld: false,
      voiceActivityDetected: true,
      expected: false,
    },
    {
      userMuted: true,
      inputMode: 'voice-activity',
      pttHeld: true,
      voiceActivityDetected: true,
      expected: false,
    },
    // push-to-talk mode
    {
      userMuted: false,
      inputMode: 'push-to-talk',
      pttHeld: false,
      voiceActivityDetected: false,
      expected: false,
    },
    {
      userMuted: false,
      inputMode: 'push-to-talk',
      pttHeld: true,
      voiceActivityDetected: false,
      expected: true,
    },
    {
      userMuted: false,
      inputMode: 'push-to-talk',
      pttHeld: false,
      voiceActivityDetected: true,
      expected: false,
    },
    {
      userMuted: false,
      inputMode: 'push-to-talk',
      pttHeld: true,
      voiceActivityDetected: true,
      expected: true,
    },
    {
      userMuted: true,
      inputMode: 'push-to-talk',
      pttHeld: true,
      voiceActivityDetected: false,
      expected: false,
    },
    {
      userMuted: true,
      inputMode: 'push-to-talk',
      pttHeld: true,
      voiceActivityDetected: true,
      expected: false,
    },
  ];

  it.each(cases)(
    'userMuted=$userMuted inputMode=$inputMode pttHeld=$pttHeld voiceActivityDetected=$voiceActivityDetected -> shouldTransmit=$expected',
    ({ userMuted, inputMode, pttHeld, voiceActivityDetected, expected }) => {
      const mic = fakeMicrophone();
      const gate = new TransmitGate(mic, { inputMode });

      gate.setUserMuted(userMuted);
      gate.setInputMode(inputMode);
      gate.setPttHeld(pttHeld);
      gate.setVoiceActivityDetected(voiceActivityDetected);

      expect(gate.shouldTransmit).toBe(expected);
      expect(mic.muted).toBe(!expected);
    },
  );

  it('explicit mute overrides a held PTT key even when set after the PTT press', () => {
    const mic = fakeMicrophone();
    const gate = new TransmitGate(mic, { inputMode: 'push-to-talk' });

    gate.setPttHeld(true);
    expect(gate.shouldTransmit).toBe(true);

    gate.setUserMuted(true);
    expect(gate.shouldTransmit).toBe(false);
    expect(mic.muted).toBe(true);

    // Holding PTT harder while muted still does not transmit.
    gate.setPttHeld(false);
    gate.setPttHeld(true);
    expect(gate.shouldTransmit).toBe(false);
  });

  it('explicit mute overrides voice-activity detection', () => {
    const mic = fakeMicrophone();
    const gate = new TransmitGate(mic);

    gate.setUserMuted(true);
    gate.setVoiceActivityDetected(true);

    expect(gate.shouldTransmit).toBe(false);
  });
});

describe('TransmitGate — setMuted is only called on an actual net transition', () => {
  let mic: ReturnType<typeof fakeMicrophone>;
  let gate: TransmitGate;

  beforeEach(() => {
    mic = fakeMicrophone();
    gate = new TransmitGate(mic, { inputMode: 'push-to-talk' });
    mic.calls.length = 0; // ignore the constructor's own initial application
  });

  it('does not call setMuted again when a setter does not change the derived value', () => {
    // Muted is currently false-transmit (pttHeld false) — setting voiceActivityDetected has no
    // effect in push-to-talk mode, so shouldTransmit stays false and setMuted must not fire again.
    gate.setVoiceActivityDetected(true);
    gate.setVoiceActivityDetected(false);
    gate.setVoiceActivityDetected(true);

    expect(mic.calls).toEqual([]);
  });

  it('calls setMuted exactly once per real transition, not once per setter call', () => {
    gate.setPttHeld(true); // false -> true transmit
    gate.setPttHeld(true); // already true — no change
    gate.setPttHeld(true); // already true — no change
    gate.setPttHeld(false); // true -> false transmit

    expect(mic.calls).toEqual([false, true]);
  });

  it('setting userMuted to the same value repeatedly never calls setMuted redundantly', () => {
    gate.setUserMuted(false);
    gate.setUserMuted(false);
    gate.setUserMuted(false);

    expect(mic.calls).toEqual([]);
  });
});

describe('TransmitGate — rebind (device switch)', () => {
  it('preserves pttHeld and voiceActivityDetected across a device switch, applying current transmit state to the new microphone', () => {
    const oldMic = fakeMicrophone();
    const gate = new TransmitGate(oldMic, { inputMode: 'push-to-talk' });
    gate.setPttHeld(true);
    expect(gate.shouldTransmit).toBe(true);

    const newMic = fakeMicrophone();
    gate.rebind(newMic);

    expect(gate.pttHeld).toBe(true);
    expect(gate.shouldTransmit).toBe(true);
    expect(newMic.calls).toEqual([false]); // setMuted(false) reapplied unconditionally on the new mic
  });

  it('unconditionally reapplies setMuted on rebind even when shouldTransmit has not changed', () => {
    const oldMic = fakeMicrophone();
    const gate = new TransmitGate(oldMic); // shouldTransmit stays false (voice-activity, nothing detected)

    const newMic = fakeMicrophone();
    gate.rebind(newMic);

    // Even though shouldTransmit is still false, the new microphone must be told explicitly —
    // it does not inherit the old microphone's muted state.
    expect(newMic.calls).toEqual([true]);
  });

  it('preserves userMuted and inputMode across rebind as well', () => {
    const oldMic = fakeMicrophone();
    const gate = new TransmitGate(oldMic, { inputMode: 'voice-activity' });
    gate.setUserMuted(true);
    gate.setVoiceActivityDetected(true);

    const newMic = fakeMicrophone();
    gate.rebind(newMic);

    expect(gate.userMuted).toBe(true);
    expect(gate.inputMode).toBe('voice-activity');
    expect(gate.voiceActivityDetected).toBe(true);
    expect(gate.shouldTransmit).toBe(false); // still muted overrides
    expect(newMic.calls).toEqual([true]);
  });

  it('continues to gate correctly through the new microphone after rebind', () => {
    const oldMic = fakeMicrophone();
    const gate = new TransmitGate(oldMic, { inputMode: 'push-to-talk' });
    gate.setPttHeld(true);

    const newMic = fakeMicrophone();
    gate.rebind(newMic);
    newMic.calls.length = 0;

    gate.setPttHeld(false);
    expect(newMic.calls).toEqual([true]);

    gate.setPttHeld(true);
    expect(newMic.calls).toEqual([true, false]);

    // The old microphone must never be touched again after rebind.
    expect(oldMic.calls).toEqual([true, false]); // constructor(true) + setPttHeld(true)(false)
  });
});

describe('TransmitGate — reconnect semantics (fresh instance, not rebind)', () => {
  it('a brand-new TransmitGate for a reconnect always starts with pttHeld: false, unlike rebind', () => {
    const oldMic = fakeMicrophone();
    const oldGate = new TransmitGate(oldMic, { inputMode: 'push-to-talk' });
    oldGate.setPttHeld(true);
    expect(oldGate.shouldTransmit).toBe(true);

    // Simulate a reconnect: a fresh microphone acquisition constructs a fresh TransmitGate,
    // rather than calling rebind on the old one.
    const newMic = fakeMicrophone();
    const newGate = new TransmitGate(newMic, { inputMode: 'push-to-talk' });

    expect(newGate.pttHeld).toBe(false);
    expect(newGate.shouldTransmit).toBe(false);
    expect(newMic.calls).toEqual([true]);
  });
});
