import { describe, expect, it } from 'vitest';

import {
  serverErrorMessageSchema,
  serverHelloMessageSchema,
  serverIdentityChallengeMessageSchema,
  serverMessageSchema,
  serverPongMessageSchema,
} from '../../packages/protocol/src/messages/server.js';

const validIdentityId = `dv1_${'A'.repeat(43)}`;
const validNonce = 'A'.repeat(43);

describe('serverHelloMessageSchema', () => {
  const valid = {
    type: 'server:hello',
    id: 'req-1',
    protocolVersion: 1,
    connectionId: 'conn-abc',
    identityId: validIdentityId,
    serverName: 'Test Server',
    serverCapabilities: ['voice'],
    serverTime: new Date().toISOString(),
    heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
  };

  it('accepts a valid server:hello', () => {
    expect(serverHelloMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a missing serverName', () => {
    const withoutServerName: Record<string, unknown> = { ...valid };
    delete withoutServerName.serverName;
    expect(serverHelloMessageSchema.safeParse(withoutServerName).success).toBe(false);
  });

  it('rejects a blank serverName', () => {
    expect(serverHelloMessageSchema.safeParse({ ...valid, serverName: '' }).success).toBe(false);
  });

  it('rejects an unrecognized server capability', () => {
    expect(
      serverHelloMessageSchema.safeParse({ ...valid, serverCapabilities: ['not-a-capability'] })
        .success,
    ).toBe(false);
  });

  it('accepts an empty server capabilities list', () => {
    expect(serverHelloMessageSchema.safeParse({ ...valid, serverCapabilities: [] }).success).toBe(
      true,
    );
  });

  it('rejects a non-positive heartbeat interval', () => {
    expect(
      serverHelloMessageSchema.safeParse({
        ...valid,
        heartbeat: { intervalMs: 0, timeoutMs: 10000 },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty connectionId', () => {
    expect(serverHelloMessageSchema.safeParse({ ...valid, connectionId: '' }).success).toBe(false);
  });

  it('rejects a malformed identityId', () => {
    expect(
      serverHelloMessageSchema.safeParse({ ...valid, identityId: 'not-an-identity-id' }).success,
    ).toBe(false);
  });

  it('rejects a missing identityId', () => {
    const withoutIdentityId: Record<string, unknown> = { ...valid };
    delete withoutIdentityId.identityId;
    expect(serverHelloMessageSchema.safeParse(withoutIdentityId).success).toBe(false);
  });

  it('rejects extra fields', () => {
    expect(serverHelloMessageSchema.safeParse({ ...valid, presence: 'online' }).success).toBe(
      false,
    );
  });
});

describe('serverIdentityChallengeMessageSchema', () => {
  const valid = {
    type: 'server:identity-challenge',
    id: 'req-1',
    connectionId: 'conn-abc',
    nonce: validNonce,
    expiresAt: Date.now() + 30_000,
  };

  it('accepts a valid server:identity-challenge', () => {
    expect(serverIdentityChallengeMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a nonce of the wrong length', () => {
    expect(
      serverIdentityChallengeMessageSchema.safeParse({ ...valid, nonce: 'too-short' }).success,
    ).toBe(false);
  });

  it('rejects a non-positive expiresAt', () => {
    expect(serverIdentityChallengeMessageSchema.safeParse({ ...valid, expiresAt: 0 }).success).toBe(
      false,
    );
  });

  it('rejects extra fields', () => {
    expect(serverIdentityChallengeMessageSchema.safeParse({ ...valid, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('serverPongMessageSchema', () => {
  it('accepts a valid server:pong that echoes the ping id', () => {
    expect(serverPongMessageSchema.safeParse({ type: 'server:pong', id: 'ping-1' }).success).toBe(
      true,
    );
  });
});

describe('serverErrorMessageSchema', () => {
  it('accepts a valid error with no replyTo', () => {
    const result = serverErrorMessageSchema.safeParse({
      type: 'server:error',
      id: 'err-1',
      code: 'INVALID_MESSAGE',
      message: 'Malformed message',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid error with a replyTo', () => {
    const result = serverErrorMessageSchema.safeParse({
      type: 'server:error',
      id: 'err-1',
      code: 'UNEXPECTED_MESSAGE',
      message: 'Duplicate hello',
      replyTo: 'client-msg-9',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unrecognized error code', () => {
    const result = serverErrorMessageSchema.safeParse({
      type: 'server:error',
      id: 'err-1',
      code: 'SOMETHING_ELSE',
      message: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty message', () => {
    const result = serverErrorMessageSchema.safeParse({
      type: 'server:error',
      id: 'err-1',
      code: 'INVALID_MESSAGE',
      message: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a message over the length bound', () => {
    const result = serverErrorMessageSchema.safeParse({
      type: 'server:error',
      id: 'err-1',
      code: 'INVALID_MESSAGE',
      message: 'x'.repeat(257),
    });
    expect(result.success).toBe(false);
  });
});

describe('serverMessageSchema (discriminated union)', () => {
  it('rejects an unknown type', () => {
    expect(serverMessageSchema.safeParse({ type: 'server:unknown', id: '1' }).success).toBe(false);
  });
});
