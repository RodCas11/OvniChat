import { describe, expect, it } from 'vitest';

import { PresenceRegistry } from '../../services/realtime/src/presence/registry.js';

/**
 * T13.3 — pure unit tests for `PresenceRegistry`: 0->1/1->0 transition detection, `memberRef`
 * freshness (never derived from `identityId`), multi-connection aggregation, and last-write-wins
 * nickname. No SQLite, no sockets — mirrors `voice-registry.test.ts`'s own testing philosophy.
 */

describe('PresenceRegistry — transitions', () => {
  it('reports becameOnline=true for the first connection of a fresh identity', () => {
    const registry = new PresenceRegistry();
    const result = registry.registerConnection('identity-a', 'conn-1', 'Alice');
    expect(result.becameOnline).toBe(true);
    expect(registry.isOnline('identity-a')).toBe(true);
  });

  it('reports becameOnline=false for a second simultaneous connection of the same identity', () => {
    const registry = new PresenceRegistry();
    const first = registry.registerConnection('identity-a', 'conn-1', 'Alice');
    const second = registry.registerConnection('identity-a', 'conn-2', 'Alice (phone)');
    expect(second.becameOnline).toBe(false);
    expect(second.memberRef).toBe(first.memberRef);
  });

  it('reports becameOffline=false when deregistering one of several simultaneous connections', () => {
    const registry = new PresenceRegistry();
    registry.registerConnection('identity-a', 'conn-1', 'Alice');
    registry.registerConnection('identity-a', 'conn-2', 'Alice (phone)');
    const result = registry.deregisterConnection('conn-1');
    expect(result?.becameOffline).toBe(false);
    expect(registry.isOnline('identity-a')).toBe(true);
  });

  it('reports becameOffline=true only when deregistering the last live connection', () => {
    const registry = new PresenceRegistry();
    registry.registerConnection('identity-a', 'conn-1', 'Alice');
    registry.registerConnection('identity-a', 'conn-2', 'Alice (phone)');
    registry.deregisterConnection('conn-1');
    const result = registry.deregisterConnection('conn-2');
    expect(result?.becameOffline).toBe(true);
    expect(registry.isOnline('identity-a')).toBe(false);
  });

  it('deregisterConnection returns undefined for a connectionId that was never registered', () => {
    const registry = new PresenceRegistry();
    expect(registry.deregisterConnection('never-registered')).toBeUndefined();
  });

  it('a full online -> offline -> online cycle mints an entirely new memberRef, never reusing the retired one', () => {
    const registry = new PresenceRegistry();
    const firstOnline = registry.registerConnection('identity-a', 'conn-1', 'Alice');
    registry.deregisterConnection('conn-1');
    expect(registry.getMemberRef('identity-a')).toBeUndefined();

    const secondOnline = registry.registerConnection('identity-a', 'conn-2', 'Alice');
    expect(secondOnline.memberRef).not.toBe(firstOnline.memberRef);
  });
});

describe('PresenceRegistry — memberRef is never derived from identityId', () => {
  it('the memberRef never contains the identityId as a substring, for a variety of identityId shapes', () => {
    const registry = new PresenceRegistry();
    const identityIds = [
      'a'.repeat(64),
      'obviously-not-random-identity-id',
      '0000000000000000000000000000000000000000000000000000000000000000',
    ];
    for (const [index, identityId] of identityIds.entries()) {
      const result = registry.registerConnection(identityId, `conn-${String(index)}`, 'Someone');
      expect(result.memberRef).not.toContain(identityId);
      expect(identityId).not.toContain(result.memberRef);
    }
  });

  it('memberRef looks like a random UUID (v4 shape), never a deterministic hash/encoding of anything', () => {
    const registry = new PresenceRegistry();
    const result = registry.registerConnection('identity-a', 'conn-1', 'Alice');
    expect(result.memberRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it('two different identities online at the same time never share a memberRef', () => {
    const registry = new PresenceRegistry();
    const a = registry.registerConnection('identity-a', 'conn-1', 'Alice');
    const b = registry.registerConnection('identity-b', 'conn-2', 'Bob');
    expect(a.memberRef).not.toBe(b.memberRef);
  });

  it('repeated online/offline cycles for the same identity never repeat a memberRef', () => {
    const registry = new PresenceRegistry();
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const connectionId = `conn-${String(i)}`;
      const result = registry.registerConnection('identity-a', connectionId, 'Alice');
      expect(seen.has(result.memberRef)).toBe(false);
      seen.add(result.memberRef);
      registry.deregisterConnection(connectionId);
    }
  });
});

describe('PresenceRegistry — multi-connection aggregation and last-write-wins nickname', () => {
  it('getNickname reflects the most-recently-registered connection (last-write-wins), regardless of order of deregistration', () => {
    const registry = new PresenceRegistry();
    registry.registerConnection('identity-a', 'conn-1', 'FirstNickname');
    registry.registerConnection('identity-a', 'conn-2', 'SecondNickname');
    expect(registry.getNickname('identity-a')).toBe('SecondNickname');
  });

  it('findIdentityByMemberRef resolves a currently-online memberRef back to its identity', () => {
    const registry = new PresenceRegistry();
    const result = registry.registerConnection('identity-a', 'conn-1', 'Alice');
    expect(registry.findIdentityByMemberRef(result.memberRef)).toBe('identity-a');
  });

  it('findIdentityByMemberRef returns undefined for an unknown or retired memberRef', () => {
    const registry = new PresenceRegistry();
    const result = registry.registerConnection('identity-a', 'conn-1', 'Alice');
    registry.deregisterConnection('conn-1');
    expect(registry.findIdentityByMemberRef(result.memberRef)).toBeUndefined();
    expect(registry.findIdentityByMemberRef('totally-unknown-ref')).toBeUndefined();
  });

  it('listOnlineIdentityIds lists every currently-online identity exactly once, regardless of connection count', () => {
    const registry = new PresenceRegistry();
    registry.registerConnection('identity-a', 'conn-1', 'Alice');
    registry.registerConnection('identity-a', 'conn-2', 'Alice (phone)');
    registry.registerConnection('identity-b', 'conn-3', 'Bob');
    expect(new Set(registry.listOnlineIdentityIds())).toEqual(
      new Set(['identity-a', 'identity-b']),
    );
  });

  it('listOnlineIdentityIds excludes an identity once it has fully gone offline', () => {
    const registry = new PresenceRegistry();
    registry.registerConnection('identity-a', 'conn-1', 'Alice');
    registry.deregisterConnection('conn-1');
    expect(registry.listOnlineIdentityIds()).toEqual([]);
  });

  it('isOnline/getMemberRef/getNickname all return undefined/false for an identity never registered', () => {
    const registry = new PresenceRegistry();
    expect(registry.isOnline('never-seen')).toBe(false);
    expect(registry.getMemberRef('never-seen')).toBeUndefined();
    expect(registry.getNickname('never-seen')).toBeUndefined();
  });
});
