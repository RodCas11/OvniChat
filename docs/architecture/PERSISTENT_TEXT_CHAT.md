# Persistent server-side text chat (T10)

Canonical contracts live in code at
[`services/dedicated-server/src/chat/`](../../services/dedicated-server/src/chat/),
[`services/realtime/src/chat-port.ts`](../../services/realtime/src/chat-port.ts), and
[`packages/protocol/src/chat.ts`](../../packages/protocol/src/chat.ts) /
[`packages/protocol/src/messages/chat.ts`](../../packages/protocol/src/messages/chat.ts); this
document explains the design and is not itself authoritative. See
[`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md) for the connection/handshake envelope this
integrates into, [`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md) for the T9 groups/permissions
this reuses, [`DEDICATED_SERVER.md`](DEDICATED_SERVER.md) for the product boundary this task
extends, and [`../adr/0014-persistent-server-owned-chat-history.md`](../adr/0014-persistent-server-owned-chat-history.md)
for the storage-topology decision this document elaborates.

## Core product rule

Chat history is **persistent**, and persistent does not mean centralized. Each independently
operated OvniChat Dedicated Server owns its own chat data, in its own data directory, with no
relationship to any other server's data:

```text
Server A (voice.rodrigo.com)  ->  stores only Server A's messages
Server B (voice.guild-b.example)  ->  stores only Server B's messages
```

No OvniChat-operated service receives or stores messages from either. The Client renders and
requests history; it never becomes the authoritative store — after a client restart (or a
completely different client with a different local identity), history is retrieved again from
whichever Dedicated Server the user connects to, not from anything cached locally.

## Chat scopes

Two scopes only — no independent Discord-style text-channel hierarchy yet:

```text
Server
├── Server Chat                (scope: 'server', server-wide)
│
├── Lobby   (existing voice channel)
│   └── Chat            (scope: 'channel', channelId: 'lobby')
│
├── Games   (existing voice channel)
│   └── Chat            (scope: 'channel', channelId: 'games')
│
└── AFK     (existing voice channel)
    └── Chat            (scope: 'channel', channelId: 'afk')
```

A channel's chat is attached to an existing server-owned voice channel (the same `channelId`
`voice:*` already uses) — there is no separate text-channel creation/management surface in T10.

## Data split

| Data                                      | Lives where                      | Lifetime                                                                                                                            |
| ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Message body, scope, channelId, createdAt | Dedicated Server's `chat.sqlite` | Persistent, per-server (until a future retention feature, if any, removes it)                                                       |
| Sender identityId (server-internal)       | Dedicated Server's `chat.sqlite` | Persistent, per-server; never returned to any client by the port                                                                    |
| Sender nickname-at-send                   | Dedicated Server's `chat.sqlite` | Persistent, fixed forever at send time — never rewritten by a later nickname change                                                 |
| Sender participantId                      | Nowhere                          | Runtime-only; attached to a _live_ broadcast when the sender happens to be online, never persisted, never present on a history page |
| Currently-loaded pages                    | Client memory only               | Cleared on disconnect/unmount; re-requested on reconnect                                                                            |

See [Privacy](#privacy-and-data-minimization) below for the full, explicit statement of what T10
changes about the previous "a Guest creates no persistent server data" claim.

## Permission registry additions

Two new keys added to T9's closed permission registry (see
[`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md#permission-registry)):

```text
chat.server.send    — send a message to Server Chat
chat.channel.send   — send a message to a voice channel's chat
```

**Reading history requires no permission** — any `ready` (admitted) connection may request history
for a scope it can otherwise see (T10 Section 8). This repository has no channel-visibility ACL
beyond server admission itself, and building one was explicitly out of scope for T10 — avoiding
unnecessary permission explosion, matching T9's own registry-design discipline. Both `guest` and
`member`'s built-in default permission sets now include both send permissions (previously just
`voice.channel.join`) — an ordinary self-hosted community server where anyone admitted can talk is
the expected default UX, not a lockdown posture an operator has to opt into. This seeding only
applies to a genuinely fresh authorization database; an existing server upgraded from a pre-T10
build keeps its operator's already-customized Guest/Member permissions unchanged.

## Sending: authorization and membership

**Server Chat** — requires `chat.server.send`. No voice-channel membership requirement; server
chat is independent of voice.

**Channel Chat** — requires **both** current membership in that exact voice channel **and**
`chat.channel.send`. This is a deliberate design choice (T10 Section 8 explicitly allows it): this
repository's existing model already scopes signaling/track-source announcements to same-channel
membership, so requiring current membership to _send_ channel chat is consistent with how "being in
a channel" already means something elsewhere in this protocol. A client that is not currently a
member of the target channel is rejected with the existing `NOT_IN_VOICE_CHANNEL` code (non-fatal —
matches every other membership-related rejection T3 already established), never a new code.

**Reading is asymmetric with sending, deliberately** — a client may request a channel's history
without being a current member of that channel (T10 Section 8's preferred behavior: "a user who can
see/access a voice channel may read its chat history even when not currently connected to that voice
channel"). The only check on a history request is that the named `channelId` exists in the server's
channel catalog (`CHANNEL_NOT_FOUND` otherwise).

## Persistence and ordering

`chat.sqlite`'s `chat_messages` table uses `message_id INTEGER PRIMARY KEY AUTOINCREMENT` as the
**ordering and pagination-cursor authority** — never wall-clock `created_at` alone, which two
messages can share to the millisecond. `created_at` (epoch-milliseconds, server-assigned, UTC) is
stored purely for display. See [ADR 0014](../adr/0014-persistent-server-owned-chat-history.md) for
why this lives in its own physical file, separate from T9's `authorization.sqlite`.

`sendMessage` on the send path: validate (schema) -> authorize (permission + membership) -> persist
(the single source of truth) -> broadcast the _persisted_ canonical record. A message that fails to
persist is never broadcast — the caller only ever constructs the outgoing `server:chat-message` from
an already-successful store result (T10 Section 40/41, mandatory). A storage failure surfaces to the
sender as a generic `INTERNAL_ERROR` (the same code every other unexpected handler failure in this
codebase already uses) — never a partial/optimistic "sent" state, and the failure is never logged
with the message body attached (see [Logging](#logging) below).

## Pagination

`client:chat-history-request` accepts an optional `beforeMessageId` cursor and a bounded `limit`
(schema-capped at 100; server defaults to 50 when omitted) — never an unbounded page (T10 Section
25/39/61, mandatory). The store fetches `limit + 1` rows ordered by `message_id` descending (cheapest
way to determine `hasMore` without a separate `COUNT` query), returns the first `limit` reversed
into ascending (oldest-first, matching how a chat UI renders a page), and reports `nextCursor` as
the oldest message's own id in that page — the client passes it back as the next request's
`beforeMessageId` to page further back. A stable id-based cursor, never fragile offset pagination
(T10 Section 27).

## Live delivery and reconciliation

**Server Chat** broadcasts to every currently-`ready` connection (a new `OutgoingAction` variant,
`'broadcast-ready'`, since a server-wide roster has no bounded membership set the way a voice
channel does). **Channel Chat** broadcasts only to the voice channel's current members, reusing the
exact same per-recipient `deliver` fan-out `voice:participant-joined` already uses. A client not
currently a member of a channel — and therefore not subscribed to its live chat — still sees that
channel's _history_ whenever it explicitly requests it; there is no separate "watch this channel's
chat without joining voice" subscription mechanism in T10 (see [Known limitations](#known-limitations)).

The sender receives the exact same broadcast every other recipient does — there is no separate
"ack" reply to a chat send; the broadcast itself is the send-succeeded confirmation (a failed send
never produces a broadcast at all, so the client observing a `server:chat-message` echo of its own
send is itself the proof it worked).

One canonical shape, `ChatMessageView`, is used for both a live broadcast and a history page
(T10 Section 72) — this is why a client-side merge function is enough to reconcile the two without
special-casing: every message, live or historical, has a stable `messageId`; the client-side merge
deduplicates by that id and re-sorts ascending, so a history page arriving after (or interleaved
with) a live message for the same thread can never produce a duplicate or a misordered list (T10
Section 27/28, mandatory).

## Client-side state

`use-voice-channel.ts`'s `chatThreads: ReadonlyMap<string, ChatThreadState>` holds only threads the
UI has actually requested (keyed by scope/channelId) — never preloaded for every channel on
connection (T10 Section 26/39). A live message for a thread never opened is dropped, not used to
lazily create one; nothing is lost, since it is already persisted server-side and arrives normally
the next time that thread is opened. Cleared entirely on disconnect and on every fresh connection —
the Client is never the authoritative store, so nothing survives a reconnect, including a reconnect
to the _same_ server, without being re-requested (T10 Section 9/10/46/47).

## Rate limiting

A separate, smaller rate-limit bucket than the existing generic per-connection transport limiter
(`RealtimeConfig.chatSendRateLimit`/`chatHistoryRateLimit`, defaults 10 sends / 10s and 20 history
requests / 10s) — persistent storage makes spam more expensive than T2's original in-memory-only
threat model assumed (T10 Section 60/61, mandatory). Exceeding either bucket is the new non-fatal
`CHAT_RATE_LIMITED` code — the connection stays open, matching the generic transport limiter's own
distinction between a fatal transport-level flood and a merely-too-chatty client at the application
level.

## Content safety

Plain UTF-8 text only — no Markdown, HTML, attachments, or rich embeds (T10 Section 22). Message
bodies allow ordinary multi-line composition (tab/LF/CR) but reject every other C0 control character
and DEL, and are bounded to 4000 characters, enforced at the schema layer (so an oversized/malformed
body fails `INVALID_MESSAGE` before ever reaching domain logic, the same two-layer
structural-vs-semantic split this package already uses elsewhere).

**Stored content is hostile content.** A persisted `<script>...</script>` body must still render as
literal, inert text tomorrow, not only today. `ChatPanel.tsx` never uses `dangerouslySetInnerHTML` —
every message body renders as plain React text content, which is HTML-escaped by construction,
identically for a live message and one loaded from history days (or a server restart) later, since
both use the same canonical `ChatMessageView` shape and the same rendering code path.

## Data minimization change from T9

T9 established: "a Guest connection alone creates no persistent authorization profile." **T10 does
not weaken that guarantee, but it does add a new, independent fact that can become persistent**: if
that same Guest sends a chat message, the Dedicated Server stores the message and its minimal
authorship metadata (identityId, nickname-at-send, body, timestamp, scope). This is the entire
point of persistent chat, not a regression — but it means the precise T9-era claim "a Guest creates
no persistent server data" is no longer accurate without qualification, and this document states the
correction explicitly rather than leaving stale documentation in place (T10 Section 52/53,
mandatory). The two facts remain genuinely independent: sending a chat message never creates a T9
`identity_group_memberships` row, and holding a T9 group membership implies nothing about whether
that identity has ever sent a message.

## Server-side enforcement

Every send is authorization-checked server-side in `services/realtime/src/protocol-handlers.ts`
before `ChatPort.sendMessage` is ever called — client UI (`ChatPanel.tsx`) hiding the composer when
`myPermissions` lacks the relevant key is a presentation courtesy only, never the actual boundary,
matching T9's own established precedent for every other permission-gated action in this codebase.

## Cross-server isolation

Each `ChatStore` instance owns its own SQLite connection with no module-level shared state — the
same guarantee T9's `AuthorizationStore` already established, extended to chat. Two
`createDedicatedServer(...)` calls in the same process share nothing; a message sent on Server A has
no row in Server B's `chat.sqlite`, proven directly over real sockets
(`tests/dedicated-server/integration.test.ts`'s "two independent servers share no chat history").

## Logging

**Server-side, message bodies are never logged** (T10 Section 65, mandatory) — the chat store is the
one place a body is intentionally persisted; the Dedicated Server's own application logs are not a
second, harder-to-manage copy of the same content. A storage failure on send is contained by the
same outer `try/catch` every other unexpected handler failure in `Connection.handleRawMessage`
already goes through, which logs only `error.message`, never any part of the message that triggered
it. Verified directly: `ChatStore.sendMessage` never catches or logs a SQL error itself.

**Client-side, one documented exception**: `use-voice-channel.ts`'s `onChatMessage`/
`onChatHistoryPage` handlers log an unconditional `console.info` marker that includes the message
body — the same `disco-voador:*` diagnostic-marker convention every other T7-T10 E2E scenario in
this codebase already uses (`disco-voador:my-groups:`, `disco-voador:server-error:`, etc.), which
these two E2E scripts (`e2e-text-chat-persistence.mjs`) depend on to verify a specific persisted
string actually reappeared. Flagged by `security-reviewer` during T10's own review as contradicting
an earlier, too-absolute version of this section's wording — this is the corrected statement.
Practical exposure is low: a packaged build always has `devToolsEnabled: false`
(`apps/desktop/src/main/window.ts`), so there is no way to observe this Renderer console output in a
real end-user install; the corresponding Main-process _relay_ to Node's own stdout
(`armE2ETextChatRelay`) additionally requires an explicit env var **and** `!app.isPackaged`. The
content logged is also never a third party's private data newly exposed — only messages the
receiving client is already authorized to see and already renders in its own chat panel.

## Protocol messages

All additive to the existing discriminated unions — no protocol version bump (see
[`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md#versioning)). Full schemas:
`packages/protocol/src/messages/chat.ts`.

```text
client:chat-send             -> server:chat-message          (broadcast to every recipient, sender included)
client:chat-history-request  -> server:chat-history-page      (bounded, paginated; reply echoes the request id)
```

Neither client message ever carries a sender field — the server always derives `senderIdentityId`
and the current nickname from the already-authenticated connection (T10 Section 29/30/74). A raw
protocol client hand-crafting `senderNickname`/`senderIdentityId`/`senderParticipantId` fields on
`client:chat-send` is rejected outright by `.strict()` schema validation (`INVALID_MESSAGE`) — there
is no such field to populate in the first place.

### Error codes

One new **non-fatal** code: `CHAT_RATE_LIMITED` (see [Rate limiting](#rate-limiting) above).
Everything else T10 needs already existed: `CHANNEL_NOT_FOUND` (unknown channel), `NOT_IN_VOICE_CHANNEL`
(channel-chat send without current membership), `AUTHORIZATION_DENIED` (missing send permission),
`INTERNAL_ERROR` (a storage failure).

## Known limitations

- A client not currently a member of a voice channel can read that channel's chat history on
  request, but does not receive _live_ pushes for it unless it joins the channel — there is no
  separate "watch this channel's chat" subscription mechanism independent of voice membership in
  T10. A future task could add one if a real product need arises.
- No message editing or deletion (see [ADR 0014](../adr/0014-persistent-server-owned-chat-history.md)) —
  message ids are architected so this can be added later without a schema migration.
- No retention-policy configuration (`retentionDays`, `maxMessagesPerChannel`) — chat is persistent
  by default and stays that way until a future task adds operator-configurable retention; the schema
  does not prevent this.
- No read receipts/unread tracking, typing indicators, reactions, mention notifications, attachments,
  or full-text search — all explicitly out of scope for T10.
- `ChatPanel.tsx`'s channel tab only ever targets the voice channel the user is _currently_ joined
  to — there is no channel browser for reading an arbitrary channel's history without first joining
  it, even though the underlying protocol/server already supports that read (proven directly at the
  Vitest integration layer). A future UX task can add a channel picker; T10 kept the UI
  "functional, not polished" per its own scope guidance.
- **Unbounded storage growth, by design** (flagged as a residual risk, not a bug, during T10's
  security review): with no retention policy yet, `chat.sqlite` grows without bound under ordinary
  use. The per-connection chat rate limiters (see [Rate limiting](#rate-limiting)) bound one
  connection's write rate, not the server's aggregate rate across many connections — an operator
  who admits many identities (any number of Guests on an `open` server, or many invited Members on
  an `invite-only` one) has no built-in cap on total chat storage. This is the same class of
  operator-managed tradeoff `REALTIME_MAX_CONNECTIONS` already represents for connection count; a
  future retention feature (see above) is the intended mitigation, not a T10 fix.
