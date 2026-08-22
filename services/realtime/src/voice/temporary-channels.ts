import { randomUUID } from 'node:crypto';

import type { ChatPort } from '../chat-port.js';
import type { VoiceRegistry } from './registry.js';

/**
 * T13.2 — a temporary, in-memory-only voice channel: a user-created "quick channel" that
 * structurally cannot survive a restart, so persisting it would buy nothing and would add a
 * crash-recovery hazard (an orphaned row nobody remembers to clean up). No database row exists for
 * one anywhere, ever.
 *
 * A temporary channel's `parentId` must resolve to a real, currently-visible persisted node (or
 * `undefined` for root) at creation time; its policy is *always* `'inherit'` by construction — no
 * override field exists on this record at all, so the ACL-resolution algorithm
 * (`channel-port.ts`'s doc comment) treats it identically to any other inherit-everything node once
 * merged into the tree view by `protocol-handlers.ts`'s `buildFilteredVoiceCatalogMessage`.
 */
export interface TemporaryChannelRecord {
  readonly channelId: string;
  readonly name: string;
  readonly parentId: string | undefined;
  readonly createdByIdentityId: string;
  readonly createdAt: number;
}

/**
 * How long a temporary channel is allowed to sit with zero members before it is treated as a
 * zombie and swept — see {@link TemporaryChannelRegistry.pruneAndList}'s doc comment for the full
 * reasoning. Generous enough that a normal create-then-join round trip (two separate client
 * messages, per the design) never races it under any realistic network condition, short enough
 * that a crashed/abandoned create doesn't linger meaningfully.
 */
export const TEMP_CHANNEL_GRACE_MS = 30_000;

export class TemporaryChannelRegistry {
  private readonly channels = new Map<string, TemporaryChannelRecord>();

  create(params: {
    readonly name: string;
    readonly parentId: string | undefined;
    readonly createdByIdentityId: string;
    readonly now: number;
  }): TemporaryChannelRecord {
    const record: TemporaryChannelRecord = {
      channelId: randomUUID(),
      name: params.name,
      parentId: params.parentId,
      createdByIdentityId: params.createdByIdentityId,
      createdAt: params.now,
    };
    this.channels.set(record.channelId, record);
    return record;
  }

  get(channelId: string): TemporaryChannelRecord | undefined {
    return this.channels.get(channelId);
  }

  remove(channelId: string): void {
    this.channels.delete(channelId);
  }

  list(): readonly TemporaryChannelRecord[] {
    return [...this.channels.values()];
  }

  /**
   * Opportunistic zombie-channel pruning — deliberately not a `setInterval`/background sweep. A
   * temporary channel that was created but never actually joined (a client crash or dropped
   * connection between `client:channel-create-voice{temporary:true}` and the follow-up
   * `voice:join`, or a follow-up join that was itself rejected) would otherwise sit in this
   * registry forever, since {@link maybeDestroyEmptyTemporaryChannel}'s destroy-on-empty rule only
   * ever fires reactively on an actual `leave` event — which never happens for a channel nobody
   * ever joined in the first place.
   *
   * Instead, this is called from `protocol-handlers.ts`'s `buildFilteredVoiceCatalogMessage`,
   * which already iterates every temporary channel on *every* catalog rebuild — and catalog
   * rebuilds already happen frequently (every connect, every channel mutation, every
   * group-membership change) — so pruning piggybacks on work already being done rather than
   * introducing a second, independent periodic job with its own lifecycle to manage/leak/test.
   *
   * A channel is pruned iff it is older than {@link TEMP_CHANNEL_GRACE_MS} *and* currently has zero
   * live members — so a channel that *was* promptly joined and is still genuinely active, however
   * old it gets, is never touched here (only `maybeDestroyEmptyTemporaryChannel`'s reactive leave
   * path ever destroys an active one, exactly when its last member actually leaves). Removes each
   * pruned entry from the registry as a side effect (mirroring `maybeDestroyEmptyTemporaryChannel`,
   * a zombie's chat history — if any was ever sent to it — is also purged the same way) and returns
   * only the still-alive entries, ready to merge into the catalog.
   */
  pruneAndList(
    voiceRegistry: VoiceRegistry,
    chat: ChatPort,
    now: number,
  ): readonly TemporaryChannelRecord[] {
    const alive: TemporaryChannelRecord[] = [];
    for (const record of this.channels.values()) {
      const isStale =
        now - record.createdAt > TEMP_CHANNEL_GRACE_MS &&
        voiceRegistry.getChannelMemberConnectionIds(record.channelId).length === 0;
      if (isStale) {
        chat.deleteChannelHistory(record.channelId);
        this.channels.delete(record.channelId);
        continue;
      }
      alive.push(record);
    }
    return alive;
  }
}

/**
 * Shared by both call sites that can produce an empty temporary channel — `handleVoiceLeave`
 * (explicit leave) and `Connection.cleanupVoiceMembership` (abrupt disconnect) — so the destroy-on
 * -last-participant-leave rule is implemented exactly once, never duplicated. Destroys the channel
 * (deletes its ephemeral chat history, then forgets it) iff the registry actually has this
 * `channelId` *and* `VoiceRegistry` reports zero remaining members after the departure that just
 * happened. A no-op (and `destroyed: false`) for a permanent channel, or a temporary one that still
 * has members.
 */
export function maybeDestroyEmptyTemporaryChannel(
  channelId: string,
  temporaryChannels: TemporaryChannelRegistry,
  voiceRegistry: VoiceRegistry,
  chat: ChatPort,
): { readonly destroyed: boolean } {
  if (!temporaryChannels.get(channelId)) return { destroyed: false };
  if (voiceRegistry.getChannelMemberConnectionIds(channelId).length > 0) {
    return { destroyed: false };
  }
  chat.deleteChannelHistory(channelId);
  temporaryChannels.remove(channelId);
  return { destroyed: true };
}
