import { describe, expect, it } from 'vitest';

import { createNoopChatPort, type ChatPort } from '../../services/realtime/src/chat-port.js';
import {
  TEMP_CHANNEL_GRACE_MS,
  TemporaryChannelRegistry,
  maybeDestroyEmptyTemporaryChannel,
} from '../../services/realtime/src/voice/temporary-channels.js';
import { VoiceRegistry } from '../../services/realtime/src/voice/registry.js';

function mockChat(overrides: Partial<ChatPort> = {}): ChatPort {
  return { ...createNoopChatPort(), ...overrides };
}

describe('TemporaryChannelRegistry — basic CRUD', () => {
  it('create assigns a unique channelId per call', () => {
    const registry = new TemporaryChannelRegistry();
    const a = registry.create({
      name: 'Quick Room',
      parentId: undefined,
      createdByIdentityId: 'dv1_a',
      now: 1000,
    });
    const b = registry.create({
      name: 'Quick Room',
      parentId: undefined,
      createdByIdentityId: 'dv1_a',
      now: 1000,
    });
    expect(a.channelId).not.toBe(b.channelId);
  });

  it('get/remove/list round-trip', () => {
    const registry = new TemporaryChannelRegistry();
    const record = registry.create({
      name: 'Quick Room',
      parentId: undefined,
      createdByIdentityId: 'dv1_a',
      now: 1000,
    });
    expect(registry.get(record.channelId)).toEqual(record);
    expect(registry.list()).toEqual([record]);
    registry.remove(record.channelId);
    expect(registry.get(record.channelId)).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });
});

describe('TemporaryChannelRegistry.pruneAndList — opportunistic zombie pruning', () => {
  it('keeps a freshly-created, still-empty channel before the grace window elapses', () => {
    const registry = new TemporaryChannelRegistry();
    const voiceRegistry = new VoiceRegistry();
    const chat = mockChat();
    const record = registry.create({
      name: 'Zombie-to-be',
      parentId: undefined,
      createdByIdentityId: 'dv1_a',
      now: 1000,
    });

    const alive = registry.pruneAndList(voiceRegistry, chat, 1000 + TEMP_CHANNEL_GRACE_MS - 1);
    expect(alive).toEqual([record]);
    expect(registry.get(record.channelId)).toBeDefined();
  });

  it('prunes a channel that was created but never joined, once past the grace window', () => {
    const registry = new TemporaryChannelRegistry();
    const voiceRegistry = new VoiceRegistry();
    let deletedHistoryFor: string | undefined;
    const chat = mockChat({
      deleteChannelHistory: (channelId) => {
        deletedHistoryFor = channelId;
      },
    });
    const record = registry.create({
      name: 'Zombie',
      parentId: undefined,
      createdByIdentityId: 'dv1_a',
      now: 1000,
    });

    const alive = registry.pruneAndList(voiceRegistry, chat, 1000 + TEMP_CHANNEL_GRACE_MS + 1);
    expect(alive).toEqual([]);
    expect(registry.get(record.channelId)).toBeUndefined();
    // Pruning purges any ephemeral chat history the same way a normal empty-on-leave destroy does.
    expect(deletedHistoryFor).toBe(record.channelId);
  });

  it('never prunes a channel that is old but still has live members', () => {
    const registry = new TemporaryChannelRegistry();
    const voiceRegistry = new VoiceRegistry();
    const chat = mockChat();
    const record = registry.create({
      name: 'Still Active',
      parentId: undefined,
      createdByIdentityId: 'dv1_a',
      now: 1000,
    });
    voiceRegistry.join('conn-a', record.channelId, 'A', 'dv1_a', 10);

    const alive = registry.pruneAndList(voiceRegistry, chat, 1000 + TEMP_CHANNEL_GRACE_MS + 1);
    expect(alive).toEqual([record]);
    expect(registry.get(record.channelId)).toBeDefined();
  });

  it('does not disturb an unrelated, still-fresh temporary channel while pruning a stale one', () => {
    const registry = new TemporaryChannelRegistry();
    const voiceRegistry = new VoiceRegistry();
    const chat = mockChat();
    const stale = registry.create({
      name: 'Stale',
      parentId: undefined,
      createdByIdentityId: 'dv1_a',
      now: 1000,
    });
    const fresh = registry.create({
      name: 'Fresh',
      parentId: undefined,
      createdByIdentityId: 'dv1_b',
      now: 1000 + TEMP_CHANNEL_GRACE_MS,
    });

    const alive = registry.pruneAndList(voiceRegistry, chat, 1000 + TEMP_CHANNEL_GRACE_MS + 1);
    expect(alive).toEqual([fresh]);
    expect(registry.get(stale.channelId)).toBeUndefined();
    expect(registry.get(fresh.channelId)).toBeDefined();
  });
});

describe('maybeDestroyEmptyTemporaryChannel — unaffected by pruning changes', () => {
  it('still destroys immediately on last-participant-leave, independent of the grace window', () => {
    const registry = new TemporaryChannelRegistry();
    const voiceRegistry = new VoiceRegistry();
    const chat = mockChat();
    const record = registry.create({
      name: 'Room',
      parentId: undefined,
      createdByIdentityId: 'dv1_a',
      now: 1000,
    });
    voiceRegistry.join('conn-a', record.channelId, 'A', 'dv1_a', 10);
    voiceRegistry.leave('conn-a');

    const result = maybeDestroyEmptyTemporaryChannel(
      record.channelId,
      registry,
      voiceRegistry,
      chat,
    );
    expect(result).toEqual({ destroyed: true });
    expect(registry.get(record.channelId)).toBeUndefined();
  });
});
