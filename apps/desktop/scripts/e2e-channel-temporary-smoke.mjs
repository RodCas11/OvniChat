// T13.2 temporary ("quick channel") voice-channel lifecycle proof — see
// `services/realtime/src/voice/temporary-channels.ts`'s own doc comment for the full design this
// mirrors: a temporary channel is added to the in-memory `TemporaryChannelRegistry` at creation time
// (never persisted to SQLite), merged into every catalog rebuild alongside the persisted tree, and
// destroyed (its ephemeral chat history purged, then forgotten) the moment its last member leaves —
// `maybeDestroyEmptyTemporaryChannel`, shared by `voice:leave` and abrupt-disconnect cleanup. Every
// participant here is a lightweight raw WebSocket client (T9's established precedent — see
// `e2e-authorization.mjs`'s own doc comment) since this scenario is entirely about server-side
// channel/registry lifecycle, not media or the Electron/Renderer stack; `tests/realtime/
// temporary-channels.test.ts` already covers the registry's own unit behavior deeply, so this
// script's job is only the real product-boundary proof: an actual Dedicated Server process, actual
// TCP connections, an actual restart.
//
// Like `e2e-channel-hidden-smoke.mjs`, every failure path throws instead of calling `process.exit()`
// mid-flight, so this script always reaches its own `finally` (closes every socket, kills the
// server) before terminating.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build`.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  bufferLength,
  connectAdmin,
  connectAndAuthenticate,
  freshId,
  joinVoice,
  leaveVoice,
  sendChatMessage,
  sendRequest,
  waitForMessage,
  waitForMessageOfType,
} from './lib/raw-protocol-client.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

function catalogHasNode(catalogMessage, nodeId) {
  return catalogMessage.nodes.some((node) => node.nodeId === nodeId);
}

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.child.once('exit', () => resolve());
    });
  }
}

async function run() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-temp-channel-data-'));
  let server;
  let adminWs;
  let bWs;

  try {
    console.info('Starting Dedicated Server (real, file-backed data directory)...');
    server = await startDedicatedServer({ DISCO_VOADOR_SERVER_DATA_DIR: dataDir });
    const url = `ws://${server.host}:${String(server.port)}`;
    console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);
    if (!server.bootstrapToken) throw new Error('Expected a bootstrap token on first startup');

    console.info('Connecting A (admin, redeems the bootstrap token) and B...');
    const admin = await connectAdmin(url, 'A', server.bootstrapToken);
    adminWs = admin.ws;
    const b = await connectAndAuthenticate(url, 'B');
    bWs = b.ws;
    // Drain each connection's own initial catalog before the real scenario starts, so the
    // `waitForMessageOfType` calls below can never accidentally resolve against this stale one.
    await waitForMessageOfType(adminWs, 'voice:catalog');
    await waitForMessageOfType(bWs, 'voice:catalog');

    console.info('A creates a temporary voice channel...');
    const created = await sendRequest(
      adminWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-temp'),
        name: 'Quick Chat',
        temporary: true,
      },
      ['server:channel-created'],
    );
    const tempChannelId = created.node.nodeId;
    if (created.node.temporary !== true) {
      throw new Error(
        `Expected the created node to be marked temporary: ${JSON.stringify(created.node)}`,
      );
    }
    console.info(`Temporary channel created: ${tempChannelId}`);

    console.info(
      "Confirming the temporary channel appears in B's catalog immediately on creation " +
        '(before anyone has joined it — see TemporaryChannelRegistry.create)...',
    );
    // Content-based predicate (not a bare type match): the create request's own reply and its
    // `catalogRefreshAction` broadcast are sent as two separate messages on B's connection; by the
    // time this line runs, the catalog broadcast may already be buffered (matches immediately) or
    // still in flight (the predicate-based wait picks it up the moment it arrives) — either way this
    // is correct, unlike a bare "next/first voice:catalog" match, which could resolve against B's
    // earlier, already-drained (pre-creation) snapshot instead.
    await waitForMessage(
      bWs,
      (m) => m.type === 'voice:catalog' && catalogHasNode(m, tempChannelId),
      "a voice:catalog containing the temporary channel on B's connection",
    );
    console.info('Confirmed: B sees the temporary channel before anyone has joined it.');

    console.info('A joins the temporary channel...');
    await joinVoice(adminWs, tempChannelId, 'A');

    console.info('B also joins the temporary channel...');
    await joinVoice(bWs, tempChannelId, 'B');

    console.info('A sends one chat message in the temporary channel...');
    const ephemeralChatBody = `EPHEMERAL_${String(Date.now())}`;
    await sendChatMessage(adminWs, 'channel', tempChannelId, ephemeralChatBody);
    const historyWhileAliveP = await sendRequest(
      adminWs,
      {
        type: 'client:chat-history-request',
        id: freshId('chat-history'),
        scope: 'channel',
        channelId: tempChannelId,
      },
      ['server:chat-history-page'],
    );
    if (!historyWhileAliveP.messages.some((m) => m.body === ephemeralChatBody)) {
      throw new Error(
        'Chat history did not include the message just sent while the channel is alive.',
      );
    }
    console.info('Confirmed the message is readable while the channel is still alive.');

    console.info('A leaves — the channel must still exist (B remains a member)...');
    await leaveVoice(adminWs);
    // A's departure does not itself mutate the tree (only creation/deletion/ACL changes trigger a
    // `catalogRefreshAction` broadcast — see `protocol-handlers.ts`'s call sites), so no fresh
    // `voice:catalog` push is actually expected here at all; the real, unambiguous proof of
    // continued existence is the direct re-join check right below.
    // `client:channel-get-editable-node` is deliberately NOT used here: `ChannelPort.getEditableNode`
    // is backed by `services/dedicated-server`'s persisted `ChannelStore` only — a temporary channel
    // is never inserted there at all (see `temporary-channels.ts`'s own doc comment), so that call
    // would report "not found" regardless of whether the temporary channel is actually still alive
    // in the registry. The real, unambiguous proof of continued existence is the same mechanism a
    // real client relies on: A can still successfully `voice:join` it again.
    console.info(
      'A rejoins the still-alive temporary channel, confirming it truly still exists...',
    );
    await joinVoice(adminWs, tempChannelId, 'A');
    console.info('A leaves again, returning to the "only B remains" state...');
    await leaveVoice(adminWs);
    console.info('Confirmed: the temporary channel still exists — B is still a member.');

    console.info('B also leaves — the channel must now be destroyed (zero members remain)...');
    // Captured *before* B leaves: every catalog admin has received up to and including this point
    // still legitimately contains the temp channel (it was alive) — the actual proof this script
    // needs is a catalog *from this point on* that no longer does, never a coincidentally-matching
    // stale one already sitting in the buffer from before the channel even existed.
    const cursorBeforeBLeaves = bufferLength(adminWs);
    await leaveVoice(bWs);

    console.info(
      'Triggering a fresh catalog rebuild (creating and immediately deleting a throwaway ' +
        'persisted channel) to observe the opportunistic pruning this design relies on ' +
        "(see TemporaryChannelRegistry.pruneAndList's own doc comment)...",
    );
    // `maybeDestroyEmptyTemporaryChannel` already runs reactively on B's own `voice:leave` above (it
    // is the *last* member leaving), so the temporary channel record is already gone at this point —
    // this extra mutation only forces a fresh `voice:catalog` broadcast so this script can observe
    // the resulting tree without guessing at timing.
    const throwaway = await sendRequest(
      adminWs,
      { type: 'client:channel-create-category', id: freshId('throwaway'), name: 'Throwaway' },
      ['server:channel-created'],
    );
    await sendRequest(
      adminWs,
      {
        type: 'client:channel-delete',
        id: freshId('throwaway-delete'),
        nodeId: throwaway.node.nodeId,
      },
      ['server:channel-ack'],
    );
    await waitForMessage(
      adminWs,
      (m) => m.type === 'voice:catalog' && !catalogHasNode(m, tempChannelId),
      'a voice:catalog (after B left) no longer containing the temporary channel',
      { since: cursorBeforeBLeaves },
    );
    console.info('Confirmed: the temporary channel is gone from the catalog once empty.');

    console.info(
      "Confirming the temporary channel's chat history was genuinely purged, not merely hidden " +
        "(see `maybeDestroyEmptyTemporaryChannel`'s call to `chat.deleteChannelHistory`)...",
    );
    let purgeConfirmed = false;
    try {
      const historyAfterDestroy = await sendRequest(
        adminWs,
        {
          type: 'client:chat-history-request',
          id: freshId('chat-history-after'),
          scope: 'channel',
          channelId: tempChannelId,
        },
        ['server:chat-history-page'],
      );
      // If the request is *accepted* (no `CHANNEL_NOT_FOUND`, since the node no longer exists to
      // resolve a visibility check against it might legitimately be rejected instead — see below),
      // the real requirement is that the purged message is actually gone, not merely unreachable via
      // a still-existing channel record.
      if (historyAfterDestroy.messages.some((m) => m.body === ephemeralChatBody)) {
        throw new Error(
          'The ephemeral chat message survived the destruction of its temporary channel.',
        );
      }
      purgeConfirmed = true;
    } catch (error) {
      if (error.code === 'CHANNEL_NOT_FOUND') {
        // The channel node itself no longer resolves at all (it was never persisted, so there is
        // nothing left to even address a history request against) — this is itself consistent with
        // "genuinely gone," not merely "orphaned but technically still reachable."
        purgeConfirmed = true;
      } else {
        throw error;
      }
    }
    if (!purgeConfirmed)
      throw new Error('Could not confirm the ephemeral chat history was purged.');
    console.info(
      "Confirmed at the wire level: the destroyed temporary channel's chat is never reachable " +
        'again (CHANNEL_NOT_FOUND, no content). Note: a black-box wire client cannot itself ' +
        'distinguish "actively deleted from storage" from "merely orphaned and unreachable" — both ' +
        'look identical over the protocol. Reading `maybeDestroyEmptyTemporaryChannel` in ' +
        '`services/realtime/src/voice/temporary-channels.ts` confirms it is the former: it calls ' +
        '`chat.deleteChannelHistory(channelId)` before forgetting the record, a real, active purge.',
    );

    console.info('Restarting the Dedicated Server against the SAME data directory...');
    adminWs.close();
    bWs.close();
    await stopServer(server);
    server = await startDedicatedServer({ DISCO_VOADOR_SERVER_DATA_DIR: dataDir });
    const restartedUrl = `ws://${server.host}:${String(server.port)}`;
    console.info(`Dedicated Server listening again on ${server.host}:${String(server.port)}`);

    console.info(
      'Connecting fresh and confirming the temporary channel is gone (it was never persisted — ' +
        'restart is not the mechanism that removed it, but this is a real regression guard regardless)...',
    );
    const fresh = await connectAndAuthenticate(restartedUrl, 'C');
    const freshCatalog = await waitForMessageOfType(fresh.ws, 'voice:catalog');
    fresh.ws.close();
    if (catalogHasNode(freshCatalog, tempChannelId)) {
      throw new Error(
        'The temporary channel reappeared after a server restart — it must never persist.',
      );
    }
    console.info('Confirmed: the temporary channel is gone after a restart, as expected.');

    console.info(
      "E2E channel-temporary-smoke test passed: a temporary channel appears in every connection's " +
        'catalog immediately on creation, survives while at least one member remains, is destroyed ' +
        '(including a real chat-history purge) the instant its last member leaves, and never ' +
        'reappears after a server restart.',
    );
  } finally {
    adminWs?.close();
    bWs?.close();
    if (server) await stopServer(server);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `E2E channel-temporary-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
