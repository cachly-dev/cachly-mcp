import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { safeJsonParse, withTimeout, normalizeGitPath, scanKeys } from '../utils.js';

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
  });
  it('returns fallback on null/empty/malformed', () => {
    expect(safeJsonParse(null, 'fb')).toBe('fb');
    expect(safeJsonParse('', 'fb')).toBe('fb');
    expect(safeJsonParse('{not json', 'fb')).toBe('fb');
  });
});

describe('withTimeout', () => {
  it('resolves with the promise value when it settles in time', async () => {
    const out = await withTimeout(Promise.resolve('ok'), 1000, 'fallback');
    expect(out).toBe('ok');
  });
  it('resolves with fallback when the promise is too slow', async () => {
    const slow = new Promise<string>((r) => setTimeout(() => r('late'), 100));
    const out = await withTimeout(slow, 10, 'fallback');
    expect(out).toBe('fallback');
  });
  it('resolves with fallback when the promise rejects', async () => {
    const out = await withTimeout(Promise.reject(new Error('boom')), 1000, 'fallback');
    expect(out).toBe('fallback');
  });
});

describe('normalizeGitPath', () => {
  it('passes a normal path through', () => {
    expect(normalizeGitPath('src/auth/jwt.ts')).toBe('src/auth/jwt.ts');
  });
  it('resolves brace rename notation to the post-rename path', () => {
    expect(normalizeGitPath('src/{old => new}/file.ts')).toBe('src/new/file.ts');
  });
  it('resolves bare rename notation', () => {
    expect(normalizeGitPath('old/path.ts => new/path.ts')).toBe('new/path.ts');
  });
  it('collapses an empty rename segment cleanly', () => {
    // dir/{ => sub}/f.ts → dir/sub/f.ts
    expect(normalizeGitPath('dir/{ => sub}/f.ts')).toBe('dir/sub/f.ts');
  });
  it('trims whitespace', () => {
    expect(normalizeGitPath('  src/x.ts  ')).toBe('src/x.ts');
  });
});

// Minimal scan-capable mock
class ScanMock {
  constructor(private keys: string[], private opts: { hang?: boolean } = {}) {}
  scanStream(_o: { match: string; count?: number }) {
    const em = new EventEmitter();
    if (this.opts.hang) return em; // never emits — exercises the timeout path
    setImmediate(() => {
      em.emit('data', this.keys);
      em.emit('end');
    });
    return em;
  }
}

describe('scanKeys', () => {
  it('collects all matching keys', async () => {
    const mock = new ScanMock(['a', 'b', 'c']);
    const out = await scanKeys(mock, 'pattern:*');
    expect(out).toEqual(['a', 'b', 'c']);
  });
  it('caps at max keys', async () => {
    const mock = new ScanMock(['a', 'b', 'c', 'd', 'e']);
    const out = await scanKeys(mock, 'pattern:*', { max: 3 });
    expect(out).toHaveLength(3);
  });
  it('resolves with gathered keys on timeout instead of hanging', async () => {
    const mock = new ScanMock([], { hang: true });
    const out = await scanKeys(mock, 'pattern:*', { timeoutMs: 20 });
    expect(out).toEqual([]);
  });
});
