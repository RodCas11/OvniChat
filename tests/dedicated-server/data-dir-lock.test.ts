import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireDataDirLock,
  DataDirLockError,
} from '../../services/dedicated-server/src/storage/data-dir-lock.js';

describe('acquireDataDirLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-data-dir-lock-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a second acquisition against the same real directory throws DataDirLockError while the first is held', () => {
    const first = acquireDataDirLock(dir);
    expect(existsSync(path.join(dir, '.lock'))).toBe(true);

    expect(() => acquireDataDirLock(dir)).toThrow(DataDirLockError);
    expect(() => acquireDataDirLock(dir)).toThrow(/already in use by another running server/);

    first.release();
  });

  it('release() followed by a fresh acquisition on the same directory succeeds', () => {
    const first = acquireDataDirLock(dir);
    first.release();
    expect(existsSync(path.join(dir, '.lock'))).toBe(false);

    const second = acquireDataDirLock(dir);
    expect(existsSync(path.join(dir, '.lock'))).toBe(true);
    second.release();
  });

  it('release() is safe to call twice (double-release is a no-op, not an error)', () => {
    const lock = acquireDataDirLock(dir);
    lock.release();
    expect(() => {
      lock.release();
    }).not.toThrow();
  });

  it('the lock file contains the current process pid', () => {
    const lock = acquireDataDirLock(dir);
    const contents = readFileSync(path.join(dir, '.lock'), 'utf8');
    expect(contents.trim()).toBe(String(process.pid));
    lock.release();
  });

  it('":memory:" is a no-op that never touches the filesystem', () => {
    const lock = acquireDataDirLock(':memory:');
    // No directory was ever created/read for ":memory:" itself — nothing to assert against a real
    // path, but release() must still be safe to call.
    expect(() => {
      lock.release();
    }).not.toThrow();
  });
});
