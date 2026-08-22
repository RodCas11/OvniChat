import { randomUUID } from 'node:crypto';

export interface VoiceParticipantRecord {
  readonly connectionId: string;
  readonly participantId: string;
  readonly channelId: string;
  readonly displayName: string;
  /** T9 — the server-verified identity behind this participant, never exposed on the wire directly
   * (see `packages/protocol`'s `voiceParticipantSchema`, which carries only `participantId`/
   * `displayName`/`groups`). Used server-side only, to resolve moderation targets
   * (`findByParticipantId`) and to look up authorization badges/permissions. */
  readonly identityId: string;
}

export interface LeaveOutcome {
  readonly channelId: string;
  readonly participantId: string;
  /** Other connections still in `channelId` after this departure — who to notify. */
  readonly remainingMemberConnectionIds: readonly string[];
}

export type JoinOutcome =
  | {
      readonly ok: true;
      readonly channelId: string;
      readonly participantId: string;
      readonly displayName: string;
      /** Members already in the channel before this join — for the joiner's snapshot. Full
       * server-side records (T9: including `identityId`), not yet the wire `VoiceParticipant`
       * shape — `protocol-handlers.ts` maps each one to the wire shape itself, attaching
       * authorization badges via the injected `AuthorizationPort`. */
      readonly existingParticipants: readonly VoiceParticipantRecord[];
      /** Connection ids of those same existing members — who to notify of the newcomer. */
      readonly existingMemberConnectionIds: readonly string[];
      /** Set only if this connection was already in a different channel, which it just left. */
      readonly previous?: LeaveOutcome;
    }
  | {
      readonly ok: false;
      readonly code: 'CHANNEL_FULL';
      readonly reason: string;
    };

export type ResolveSignalingTargetOutcome =
  | { readonly ok: true; readonly targetConnectionId: string; readonly sourceParticipantId: string }
  | {
      readonly ok: false;
      readonly code: 'NOT_IN_VOICE_CHANNEL' | 'SIGNALING_TARGET_INVALID';
      readonly reason: string;
    };

/**
 * Authoritative, in-memory voice-channel membership. Deliberately Electron/WebSocket-free — it
 * only knows about `connectionId` strings and channel/participant data, so the full join/leave/
 * switch/isolation matrix (`docs/tasks/T3_VOICE_WEBRTC.md`'s required tests) is unit-testable
 * without any real socket. A connection belongs to zero or one channel at a time; joining a new
 * one cleanly leaves the old one first (see `join`).
 *
 * T13.2 — this class no longer owns any channel *catalog* at all: whether a channel exists, is
 * visible, or is joinable is entirely `ChannelPort`'s concern now (see `channel-port.ts`), and a
 * voice channel's occupancy ceiling is no longer a single hardcoded constant — it is computed by
 * the caller (`handleVoiceJoin` in `protocol-handlers.ts`) per-channel from `ChannelNodeView.
 * userLimit`, and passed into {@link join} as `capacityLimit`. `MAX_CHANNEL_PARTICIPANTS` remains
 * the one hard technical ceiling no channel can ever exceed (also the wire-schema array-size bound
 * for a join snapshot) — the caller is responsible for never passing a `capacityLimit` above it.
 */
export class VoiceRegistry {
  private readonly participantsByConnection = new Map<string, VoiceParticipantRecord>();
  private readonly membersByChannel = new Map<string, Set<string>>();

  getParticipant(connectionId: string): VoiceParticipantRecord | undefined {
    return this.participantsByConnection.get(connectionId);
  }

  /** T9 — resolves an admin-supplied `targetParticipantId` (moderation actions never accept a
   * client-supplied `identityId`/`connectionId` directly, see
   * `docs/architecture/SERVER_AUTHORIZATION.md`). Only ever finds a participant currently in *some*
   * voice channel — moderation targets an online participant, matching this app's only current
   * presence surface. */
  findByParticipantId(participantId: string): VoiceParticipantRecord | undefined {
    for (const record of this.participantsByConnection.values()) {
      if (record.participantId === participantId) return record;
    }
    return undefined;
  }

  /** T10 — connection ids of every current member of `channelId`, for broadcasting a channel-scoped
   * chat message to exactly the connections currently subscribed to it by being in that voice
   * channel (T10 Section 41: no separate "watching this channel's chat without being in voice"
   * subscription concept exists — see `docs/architecture/PERSISTENT_TEXT_CHAT.md`'s "Live delivery"
   * section). Empty array for an unknown or currently-empty channel — callers check
   * {@link isKnownChannel} separately when that distinction matters. */
  getChannelMemberConnectionIds(channelId: string): readonly string[] {
    return [...(this.membersByChannel.get(channelId) ?? [])];
  }

  /** T9 follow-up — resolves every online connection for a given `identityId` (normally zero or
   * one, but not assumed to be at most one: nothing prevents the same identity from holding two
   * simultaneous connections). Used only for authorization-store-driven side effects (e.g. a group
   * deletion that leaves an identity with no admission basis), never for a client-facing lookup. */
  findAllByIdentityId(identityId: string): readonly VoiceParticipantRecord[] {
    const matches: VoiceParticipantRecord[] = [];
    for (const record of this.participantsByConnection.values()) {
      if (record.identityId === identityId) matches.push(record);
    }
    return matches;
  }

  private membersOf(channelId: string): Set<string> {
    let members = this.membersByChannel.get(channelId);
    if (!members) {
      members = new Set();
      this.membersByChannel.set(channelId, members);
    }
    return members;
  }

  /**
   * `capacityLimit` is computed by the caller (never this class) as
   * `Math.min(node.userLimit ?? MAX_CHANNEL_PARTICIPANTS, MAX_CHANNEL_PARTICIPANTS)` — see this
   * class's own doc comment. Existence/visibility/join-policy/password checks have already
   * happened by the time this is called (`ChannelPort.checkJoin`, evaluated by `handleVoiceJoin`
   * before ever reaching here) — this method only enforces membership bookkeeping and the numeric
   * capacity ceiling, so it never returns `CHANNEL_NOT_FOUND` itself anymore.
   */
  join(
    connectionId: string,
    channelId: string,
    displayName: string,
    identityId: string,
    capacityLimit: number,
  ): JoinOutcome {
    // Checked before leaving any previous channel: a switch that would only succeed by first
    // vacating the old channel is still a rejection, not a partial state change. Someone already a
    // member of this exact channel is never blocked by a newly-lowered limit (T13.2: decreasing a
    // limit below current occupancy must never kick existing occupants) — this exemption is
    // unchanged from pre-T13.2 behavior.
    const alreadyMember = this.membersOf(channelId).has(connectionId);
    if (!alreadyMember && this.membersOf(channelId).size >= capacityLimit) {
      return {
        ok: false,
        code: 'CHANNEL_FULL',
        reason: `Voice channel "${channelId}" is full`,
      };
    }

    const previous = this.leaveInternal(connectionId);

    const participantId = randomUUID();
    const record: VoiceParticipantRecord = {
      connectionId,
      participantId,
      channelId,
      displayName,
      identityId,
    };

    const members = this.membersOf(channelId);
    const existingMemberConnectionIds = [...members];
    const existingParticipants: VoiceParticipantRecord[] = existingMemberConnectionIds
      .map((id) => this.participantsByConnection.get(id))
      .filter((p): p is VoiceParticipantRecord => p !== undefined);

    this.participantsByConnection.set(connectionId, record);
    members.add(connectionId);

    return {
      ok: true,
      channelId,
      participantId,
      displayName,
      existingParticipants,
      existingMemberConnectionIds,
      ...(previous ? { previous } : {}),
    };
  }

  /** Explicit `voice:leave` and disconnect cleanup share this. Returns `undefined` if not in a channel. */
  leave(connectionId: string): LeaveOutcome | undefined {
    return this.leaveInternal(connectionId);
  }

  private leaveInternal(connectionId: string): LeaveOutcome | undefined {
    const record = this.participantsByConnection.get(connectionId);
    if (!record) return undefined;

    this.participantsByConnection.delete(connectionId);
    const members = this.membersByChannel.get(record.channelId);
    members?.delete(connectionId);

    return {
      channelId: record.channelId,
      participantId: record.participantId,
      remainingMemberConnectionIds: members ? [...members] : [],
    };
  }

  /**
   * Resolves a signaling target: the target must exist and be in the *same* channel as the
   * sender. A participant in "general" can never reach one in "games" this way, and a sender not
   * currently in any channel can never signal at all.
   */
  resolveSignalingTarget(
    connectionId: string,
    targetParticipantId: string,
  ): ResolveSignalingTargetOutcome {
    const sender = this.participantsByConnection.get(connectionId);
    if (!sender) {
      return {
        ok: false,
        code: 'NOT_IN_VOICE_CHANNEL',
        reason: 'Sender is not currently in a voice channel',
      };
    }

    const members = this.membersByChannel.get(sender.channelId) ?? new Set<string>();
    for (const memberConnectionId of members) {
      if (memberConnectionId === connectionId) continue;
      const candidate = this.participantsByConnection.get(memberConnectionId);
      if (candidate?.participantId === targetParticipantId) {
        return {
          ok: true,
          targetConnectionId: memberConnectionId,
          sourceParticipantId: sender.participantId,
        };
      }
    }

    return {
      ok: false,
      code: 'SIGNALING_TARGET_INVALID',
      reason: 'Target is not in the same voice channel as the sender',
    };
  }
}
