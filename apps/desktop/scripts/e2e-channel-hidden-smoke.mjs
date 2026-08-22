// T13.2 channel-visibility privacy proof (see `services/realtime/src/channel-port.ts`'s own doc
// comment, rule 3: "Existence and visibility are the same method"). This is a protocol-level
// privacy guarantee, not a UI one, so — deliberately, per this task's own "do not accept 'React
// didn't render it' as proof" instruction — every party here is a lightweight raw WebSocket client,
// never an Electron instance: the strongest possible evidence that nothing leaks is inspecting the
// *raw wire bytes* a hostile client actually receives, not whether some Renderer component chose to
// display them. T13.2's admin-side protocol surface already has deep coverage elsewhere
// (`tests/dedicated-server/channel-store.test.ts`, `tests/dedicated-server/channels-integration.test.ts`)
// — this script's job is only the specific, real end-to-end wire-level proof those unit/integration
// suites cannot give on their own: an actual second TCP connection, from a hostile Guest identity
// that never held any elevated group, observing the real server's real replies.
//
// Scenario (mirrors `channel-port.ts`'s own worked "Officers"/"Raid Planning" example almost
// exactly): a `STAFF` category (`visibilityPolicy: 'selected-groups'`, only `server-admin`)
// contains a `Raid Leaders` voice channel (`visibilityPolicy: 'inherit'`) — per the ACL-resolution
// algorithm, this makes `Raid Leaders` invisible to anyone not in `server-admin`, regardless of its
// own policy, because Visibility is evaluated top-down across the whole ancestor chain.
//
// Unlike most other scripts in this directory, every failure path here throws a plain `Error`
// instead of calling `process.exit()` mid-flight — this script always reaches its own top-level
// `finally` (closes both sockets, kills the server) before ever actually terminating the process, so
// a mid-run assertion failure can never orphan the Dedicated Server child process.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` (this script never
// launches Electron, so packaging the desktop app is not required).

import { randomUUID } from 'node:crypto';

import {
  connectAdmin,
  connectAndAuthenticate,
  freshId,
  joinVoice,
  sendChatMessage,
  sendRequest,
  waitForMessage,
  waitForMessageOfType,
} from './lib/raw-protocol-client.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

/** Attaches a permanent raw-bytes recorder to `ws` — every message this connection ever receives,
 * verbatim, for as long as the connection lives. Deliberately separate from any scoped
 * `waitForMessageOfType`-style listener (both can coexist; `ws` supports multiple `'message'`
 * listeners). This is the actual evidence this script's central assertion rests on: the *raw JSON
 * text*, not a parsed/re-serialized approximation of it. */
function recordRawMessages(ws) {
  const raw = [];
  ws.on('message', (data) => {
    raw.push(data.toString('utf8'));
  });
  return raw;
}

function assertNoLeak(rawMessages, forbiddenSubstrings, contextLabel) {
  for (const line of rawMessages) {
    for (const forbidden of forbiddenSubstrings) {
      if (line.includes(forbidden)) {
        throw new Error(
          `${contextLabel}: a raw message contains forbidden substring "${forbidden}": ${line}`,
        );
      }
    }
  }
}

async function run() {
  console.info('Starting Dedicated Server (open access, ephemeral)...');
  const { child: serverChild, host, port, bootstrapToken } = await startDedicatedServer();
  const url = `ws://${host}:${String(port)}`;
  console.info(`Dedicated Server listening on ${host}:${String(port)}`);
  if (!bootstrapToken) throw new Error('Expected a bootstrap token on first startup');

  let adminWs;
  let guestWs;

  try {
    console.info('Connecting Admin and redeeming the bootstrap token...');
    const admin = await connectAdmin(url, 'Admin', bootstrapToken);
    adminWs = admin.ws;

    console.info('Admin creates STAFF (visibility: selected-groups[server-admin])...');
    const staffCategory = await sendRequest(
      adminWs,
      { type: 'client:channel-create-category', id: freshId('create-cat'), name: 'STAFF' },
      ['server:channel-created'],
    );
    const staffId = staffCategory.node.nodeId;
    await sendRequest(
      adminWs,
      {
        type: 'client:channel-update',
        id: freshId('update-cat'),
        nodeId: staffId,
        visibilityPolicy: 'selected-groups',
        visibilityGroupIds: ['server-admin'],
      },
      ['server:channel-ack'],
    );

    console.info('Admin creates "Raid Leaders" under STAFF (visibility: inherit)...');
    const raidLeaders = await sendRequest(
      adminWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-voice'),
        name: 'Raid Leaders',
        parentId: staffId,
      },
      ['server:channel-created'],
    );
    const raidLeadersId = raidLeaders.node.nodeId;
    console.info(`STAFF=${staffId}, Raid Leaders=${raidLeadersId}`);

    console.info('Admin confirms it can see both nodes in its own voice:catalog...');
    // Content-based predicate, not a bare type match: the two `client:channel-create-*` requests
    // above already resolved (their own direct replies), but each one's *own* `catalogRefreshAction`
    // broadcast is a separate message on the same connection that may arrive slightly after — a bare
    // "the next/first voice:catalog" match could otherwise resolve against an earlier, stale
    // (pre-creation) snapshot already sitting in the buffer. Waiting on the actual desired content
    // is correct regardless of exact arrival ordering.
    await waitForMessage(
      adminWs,
      (m) =>
        m.type === 'voice:catalog' &&
        m.nodes.some((n) => n.nodeId === staffId) &&
        m.nodes.some((n) => n.nodeId === raidLeadersId),
      'a voice:catalog containing both newly created nodes',
    );
    console.info('Admin sees both nodes, as expected (server-admin is in the visible group).');

    console.info('Admin joins "Raid Leaders" and seeds one real chat message there...');
    await joinVoice(adminWs, raidLeadersId, 'Admin');
    const seededChatBody = `SECRET_${String(Date.now())}`;
    await sendChatMessage(adminWs, 'channel', raidLeadersId, seededChatBody);
    console.info('Seeded real chat history in the hidden channel.');

    console.info('Connecting Guest (a fresh identity, no elevated group, never authorized)...');
    const guest = await connectAndAuthenticate(url, 'Guest');
    guestWs = guest.ws;
    const rawMessages = recordRawMessages(guestWs);

    console.info("Waiting for Guest's initial voice:catalog...");
    const guestCatalog = await waitForMessageOfType(guestWs, 'voice:catalog');
    const guestNodeIds = guestCatalog.nodes.map((n) => n.nodeId);
    if (guestNodeIds.includes(staffId) || guestNodeIds.includes(raidLeadersId)) {
      throw new Error("Guest's own catalog already reveals the hidden node ids.");
    }

    // Give any other server-initiated push (there should be none relevant) a moment to arrive
    // before scanning the accumulated raw buffer.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const forbiddenSubstrings = ['STAFF', 'Raid Leaders', staffId, raidLeadersId];
    console.info(
      'Scanning every raw message Guest has received so far for any trace of the hidden names/ids...',
    );
    assertNoLeak(rawMessages, forbiddenSubstrings, 'Initial catalog window');
    console.info(
      `Confirmed: none of [${forbiddenSubstrings.join(', ')}] appear in any of the ` +
        `${String(rawMessages.length)} raw message(s) Guest has received so far.`,
    );

    console.info('Guest attempts voice:join with the real, guessed hidden nodeId...');
    let realIdError;
    try {
      await joinVoice(guestWs, raidLeadersId, 'Guest');
      throw new Error('Guest was able to join a channel it can never see.');
    } catch (error) {
      if (!error.code) throw error;
      realIdError = error;
    }
    if (realIdError.code !== 'CHANNEL_NOT_FOUND') {
      throw new Error(
        `Expected CHANNEL_NOT_FOUND joining the real hidden id, got ${realIdError.code}`,
      );
    }

    console.info('Guest attempts voice:join with a genuinely random, nonexistent nodeId...');
    // `channelIdSchema` requires lowercase alphanumeric/hyphen — `randomUUID()` already satisfies
    // this by construction (lowercase hex + hyphens).
    const randomNodeId = randomUUID();
    let randomIdError;
    try {
      await joinVoice(guestWs, randomNodeId, 'Guest');
      throw new Error('Guest was able to join a channel id that was never created at all.');
    } catch (error) {
      if (!error.code) throw error;
      randomIdError = error;
    }
    if (randomIdError.code !== 'CHANNEL_NOT_FOUND') {
      throw new Error(
        `Expected CHANNEL_NOT_FOUND joining a random nonexistent id, got ${randomIdError.code}`,
      );
    }

    // The "existence and visibility are the same method" guarantee: strip each attempt's own
    // queried id out of its message text and compare what remains — a hidden-but-real channel and a
    // channel that was never created at all must produce byte-identical rejection shapes.
    const normalizedReal = realIdError.message.replaceAll(raidLeadersId, '<id>');
    const normalizedRandom = randomIdError.message.replaceAll(randomNodeId, '<id>');
    if (normalizedReal !== normalizedRandom) {
      throw new Error(
        'The hidden-channel rejection and the truly-nonexistent-channel rejection are not ' +
          `structurally identical: "${normalizedReal}" vs "${normalizedRandom}"`,
      );
    }
    console.info(
      'Confirmed: joining the real hidden channel and joining a random nonexistent id produce ' +
        'byte-identical (code + message shape) rejections — a hostile client cannot distinguish ' +
        '"exists but hidden" from "never existed".',
    );

    console.info('Guest attempts client:channel-get-editable-node for the real hidden nodeId...');
    try {
      await sendRequest(
        guestWs,
        {
          type: 'client:channel-get-editable-node',
          id: freshId('get-node'),
          nodeId: raidLeadersId,
        },
        ['server:channel-editable-node'],
      );
      throw new Error(
        'Guest was able to load the admin-detail view of a channel it cannot even see.',
      );
    } catch (error) {
      if (!error.code) throw error;
      // `handleChannelGetEditableNode` checks visibility (`getVisibleNode`) before ever considering
      // Manage rights — a security-review fix (see `services/realtime/src/protocol-handlers.ts`'s
      // "Security fix (T13.2 review)" comments): the handler previously checked Manage rights alone
      // first, which let a caller with real (but hidden-from) delegated Manage on a node leak its
      // existence/admin-detail view via AUTHORIZATION_DENIED instead of CHANNEL_NOT_FOUND. A
      // zero-permission Guest like this one now always gets CHANNEL_NOT_FOUND here too — uniform
      // with `voice:join`'s own code, never a second, distinguishable rejection shape.
      if (error.code !== 'CHANNEL_NOT_FOUND') {
        throw new Error(`Expected CHANNEL_NOT_FOUND, got ${error.code}`, { cause: error });
      }
      console.info(`Rejected with ${error.code}, as expected — no admin-detail content leaked.`);
    }

    console.info(
      'Guest attempts client:chat-history-request for the real hidden nodeId (real chat exists there)...',
    );
    try {
      const page = await sendRequest(
        guestWs,
        {
          type: 'client:chat-history-request',
          id: freshId('chat-history'),
          scope: 'channel',
          channelId: raidLeadersId,
        },
        ['server:chat-history-page'],
      );
      // Some designs might return an empty page instead of an outright rejection — the mandatory
      // requirement either way is that the real seeded content never reaches this connection.
      const bodies = page.messages.map((m) => m.body);
      if (bodies.includes(seededChatBody)) {
        throw new Error('Guest received the real seeded chat content for a channel it cannot see.');
      }
      throw new Error(
        'Expected client:chat-history-request for a hidden channel to be rejected with ' +
          `CHANNEL_NOT_FOUND, but it returned a page instead: ${JSON.stringify(page)}`,
      );
    } catch (error) {
      if (!error.code) throw error;
      if (error.code !== 'CHANNEL_NOT_FOUND') {
        throw new Error(
          `Expected CHANNEL_NOT_FOUND requesting chat history for the hidden channel, got ${error.code}`,
          { cause: error },
        );
      }
      console.info('Rejected with CHANNEL_NOT_FOUND — the real seeded chat content never leaked.');
    }

    // Final, whole-connection-lifetime raw-bytes check, covering every reply this script has
    // provoked above too (not only the initial catalog) — the mandatory "for the life of the
    // connection" requirement. Deliberately excludes `raidLeadersId` from this second pass (unlike
    // the pre-query scan above, which required it absent entirely): once Guest has itself supplied
    // that exact guessed id in a request, the server's own `CHANNEL_NOT_FOUND` reply legitimately
    // echoes back the value the *client itself* already sent (e.g. `Unknown voice channel "<id>"`)
    // — this is not a disclosure (Guest already knew this id; it guessed it), it is the server
    // correlating its reply to the request it just answered. The actual, load-bearing secrets — the
    // node's *name* and the fact that `staffId`'s category even exists at all — must still never
    // appear anywhere, unprompted or otherwise, which this second pass still checks in full.
    console.info(
      'Final scan of every raw message Guest has ever received for the real secrets (names, the ' +
        'never-queried STAFF category id) — excluding the one id Guest itself chose to guess...',
    );
    assertNoLeak(rawMessages, ['STAFF', 'Raid Leaders', staffId], 'Full connection lifetime');
    if (rawMessages.some((line) => line.includes(seededChatBody))) {
      throw new Error("Guest's full message history contains the real seeded chat body.");
    }

    console.info(
      'E2E channel-hidden-smoke test passed: a fully hidden category+channel never appears in a ' +
        "Guest's own catalog or any other raw message it receives; joining, viewing the admin-" +
        'detail node, and reading chat history for the real (guessed) id are all rejected exactly ' +
        'as a genuinely nonexistent id would be, and no real seeded content ever reaches the Guest.',
    );
  } finally {
    adminWs?.close();
    guestWs?.close();
    serverChild.kill();
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `E2E channel-hidden-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
