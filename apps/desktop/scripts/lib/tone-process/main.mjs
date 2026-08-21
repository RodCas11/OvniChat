// T12 — a genuinely independent, standalone Windows process tree that renders one continuous,
// deterministic sine tone through the real OS default audio output device. Used only by
// `e2e-process-audio-smoke.mjs` as "Process A"/"Process B": two of these, launched as two separate
// `spawn(electronPath, ...)` invocations (two distinct PIDs, two distinct process trees — never two
// instances of the same running process, never a synthetic MediaStreamTrack), each playing a
// different frequency, so the mandatory process-loopback isolation proof has two real, independently
// verifiable audio sources to select between.
//
// Deliberately reuses the exact technique `VoiceChannelView.tsx`'s own T6 smoke-test oscillator
// already relies on (a normal Web Audio `AudioContext` connected to the real default destination,
// never a fake/injected track) — the only difference here is that this runs in its own dedicated
// Electron process, entirely outside the real OvniChat app, so it is a genuinely separate candidate
// the process-loopback picker can enumerate and select.
//
// Usage: `electron main.mjs --frequency=<Hz>` (required). Prints `TONE_PROCESS_READY:pid=<pid>` to
// stdout once the renderer's oscillator has actually started (confirmed via a real `console-message`
// event from the page, not merely `did-finish-load`) — the orchestrator waits for this line before
// treating the tone as live. Exits cleanly on SIGTERM/SIGINT (Electron `app.quit()`), which is also
// how the orchestrator ends each tone process once a test phase completes.

import { app, BrowserWindow } from 'electron';

function parseFrequencyArg() {
  const arg = process.argv.find((a) => a.startsWith('--frequency='));
  if (!arg) {
    console.error('tone-process: missing required --frequency=<Hz> argument');
    process.exit(1);
  }
  const value = Number(arg.slice('--frequency='.length));
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`tone-process: invalid --frequency value: ${arg}`);
    process.exit(1);
  }
  return value;
}

const frequencyHz = parseFrequencyArg();

// A pure-audio window never needs to be visible, GPU-composited to screen, or interactive — `show:
// false` avoids any real on-screen window from ever flashing up during an automated test run.
// contextIsolation/sandbox stay at their real, secure defaults even though this is test-only code —
// no reason to weaken them just because nothing here happens to be sensitive.
function createToneWindow(frequency) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });

  // Electron relays a Renderer's `console.*` calls to this event on the owning `webContents` — the
  // only reliable way for this Main-process script to know the oscillator has genuinely started
  // (not merely that the page finished loading), since nothing here needs (or gets) a preload/IPC
  // bridge for a page this simple.
  win.webContents.on('console-message', (event) => {
    if (event.message === 'tone-started') {
      console.info(`TONE_PROCESS_READY:pid=${String(process.pid)}`);
    }
  });

  const html = `<!doctype html><meta charset="utf-8"><title>tone</title><script>
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = ${JSON.stringify(frequency)};
    const gain = ctx.createGain();
    gain.gain.value = 0.4; // audible, non-clipping — real output hardware plays this at real volume.
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    console.log('tone-started');
  </script>`;
  void win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  return win;
}

app.whenReady().then(() => {
  createToneWindow(frequencyHz);
});

// Graceful shutdown: the orchestrator kills each tone process by signal (never by abruptly closing a
// window it never had a handle to across process boundaries) between/after test phases, and also to
// prove "no orphan native/audio process remains after cleanup" doesn't get confused by a leftover
// tone-generator process — this process must itself exit promptly and completely on either signal.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    app.quit();
  });
}
