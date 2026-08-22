import type { ChatMessageView, ChatScope } from '@disco-voador/protocol';

/**
 * T13.1.1 — dev/test-only representative chat messages, used purely to visually evaluate real
 * message density (grouping, avatar/timestamp alignment, wrapping, Unicode) — never real user or
 * server data, and never reachable in a packaged build.
 *
 * Genuinely production-safe by construction, not merely by convention: the *only* call site
 * (`ChatView.tsx`) only ever sets the `devFixtureActive` state that switches this in behind an
 * `import.meta.env.DEV` check. Vite statically substitutes `import.meta.env.DEV` with the literal
 * `false` for any `vite build` (production mode) — which is how this app is packaged (see
 * `apps/desktop/vite.renderer.config.ts`) — so that whole `if` branch is dead code, removed by the
 * production build's minifier. Unlike this codebase's existing `DISCO_VOADOR_E2E_*` convention
 * (`!app.isPackaged` checked once in Main, then relayed to the Renderer over IPC), this mechanism
 * needs no new Main/Preload/IPC surface at all — it is a Renderer-only, compile-time constant, so
 * no runtime environment variable on a real user's machine can ever flip it back on.
 *
 * Reachable only via an explicit developer action (typing `/fixture` into the composer and
 * submitting — see `ChatView.tsx`), never automatically whenever `import.meta.env.DEV` happens to
 * be true (e.g. plain `vite dev`) — so ordinary development against a real Dedicated Server is
 * never confused by fixture content appearing unannounced.
 */
export function getChatFixtureMessages(
  scope: ChatScope,
  channelId: string | undefined,
): readonly ChatMessageView[] {
  const now = Date.now();
  const minute = 60_000;
  const scoped = (fields: {
    readonly messageId: number;
    readonly senderNickname: string;
    readonly body: string;
    readonly createdAt: number;
  }): ChatMessageView =>
    scope === 'channel' && channelId !== undefined
      ? { ...fields, scope, channelId }
      : { ...fields, scope: 'server' };

  return [
    scoped({
      messageId: 1,
      senderNickname: 'Nova',
      body: 'anyone else catch the patch notes for tonight?',
      createdAt: now - 42 * minute,
    }),
    // Consecutive same-sender messages — proves grouping/tightness.
    scoped({
      messageId: 2,
      senderNickname: 'Nova',
      body: 'servers back up now too, ping is way better',
      createdAt: now - 41 * minute,
    }),
    scoped({
      messageId: 3,
      senderNickname: 'Kestrel',
      body: 'nice',
      createdAt: now - 38 * minute,
    }),
    scoped({
      messageId: 4,
      senderNickname: 'Kestrel',
      body:
        'honestly the biggest change is the matchmaking rework — queue times dropped a lot for me, ' +
        'though I noticed voice chat still cuts out for a second whenever someone with a bad ' +
        'connection joins mid-game, not sure if that is on our end or theirs',
      createdAt: now - 37 * minute,
    }),
    scoped({
      messageId: 5,
      senderNickname: 'Juniper',
      body: '🚀 gg everyone, that was a close one!! 🎉✨',
      createdAt: now - 12 * minute,
    }),
    scoped({
      messageId: 6,
      senderNickname: 'Rowan',
      body: 'o7',
      createdAt: now - 2 * minute,
    }),
  ];
}
