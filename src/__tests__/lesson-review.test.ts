/**
 * Lessons-Review workflow (P1-1) — MCP-side pending writes.
 *
 * When an org enables review mode, the API mirrors the setting to the instance
 * as cachly:team:review_mode = "1". team_learn and learn_from_attempts must
 * then write proposals under cachly:lesson:proposed:<topic> instead of the
 * recall keyspace (cachly:lesson:best:*). Flag absent = direct writes, exactly
 * as before — this is what keeps existing single-user/team flows untouched.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  handleTeamTool,
  reviewModeEnabled,
  REVIEW_MODE_KEY,
  PROPOSED_LESSON_PREFIX,
} from '../handlers/team.js';
import { handleBrainTool } from '../handlers/brain.js';

// ── Minimal Redis mock (same shape as roles.test.ts) ─────────────────────────
class MockRedis {
  store = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private sets = new Map<string, Set<string>>();
  private lists = new Map<string, string[]>();

  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string, ..._rest: unknown[]) { this.store.set(k, v); return 'OK'; }
  async del(k: string) { return this.store.delete(k) ? 1 : 0; }
  async mget(...ks: string[]) { return ks.map(k => this.store.get(k) ?? null); }
  async hset(k: string, f: string, v: string) {
    if (!this.hashes.has(k)) this.hashes.set(k, new Map());
    this.hashes.get(k)!.set(f, v); return 1;
  }
  async hget(k: string, f: string) { return this.hashes.get(k)?.get(f) ?? null; }
  async hgetall(k: string): Promise<Record<string, string>> {
    const h = this.hashes.get(k);
    return h ? Object.fromEntries(h.entries()) : {};
  }
  async expire(_k: string, _s: number) { return 1; }
  async rpush(k: string, ...vals: string[]) {
    if (!this.lists.has(k)) this.lists.set(k, []);
    this.lists.get(k)!.push(...vals);
    return this.lists.get(k)!.length;
  }
  async lpush(k: string, ...vals: string[]) {
    if (!this.lists.has(k)) this.lists.set(k, []);
    this.lists.get(k)!.unshift(...vals);
    return this.lists.get(k)!.length;
  }
  async ltrim(_k: string, _s: number, _e: number) { return 'OK'; }
  async lrange(k: string, start: number, end: number) {
    const l = this.lists.get(k) ?? [];
    const s = start < 0 ? Math.max(0, l.length + start) : start;
    const e = end < 0 ? l.length + end : end;
    return l.slice(s, e + 1);
  }
  async sadd(k: string, ...members: string[]) {
    if (!this.sets.has(k)) this.sets.set(k, new Set());
    const s = this.sets.get(k)!;
    let added = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
    return added;
  }
  async scard(k: string) { return this.sets.get(k)?.size ?? 0; }
  async smembers(k: string) { return [...(this.sets.get(k) ?? [])]; }
  async sismember(k: string, m: string) { return this.sets.get(k)?.has(m) ? 1 : 0; }
  scanStream() {
    const e = { handlers: {} as Record<string, ((...a: unknown[]) => void)> };
    setTimeout(() => { e.handlers['data']?.([]); e.handlers['end']?.(); }, 0);
    return { on: (ev: string, fn: (...a: unknown[]) => void) => { e.handlers[ev] = fn; return { on: () => {} }; } };
  }
}

const noopApiFetch = async <T>(_p: string): Promise<T> => ({ data: [] } as unknown as T);
const iid = 'review-instance';

let redis: MockRedis;
const getConn = async () => redis as unknown as Redis;

beforeEach(() => { redis = new MockRedis(); });

describe('reviewModeEnabled', () => {
  it('is false when the flag is absent (default = direct writes)', async () => {
    expect(await reviewModeEnabled(redis as unknown as Redis, iid)).toBe(false);
  });
  it('accepts "1", "true" and "on"', async () => {
    for (const v of ['1', 'true', 'on']) {
      await redis.set(REVIEW_MODE_KEY, v);
      expect(await reviewModeEnabled(redis as unknown as Redis, iid)).toBe(true);
    }
    await redis.set(REVIEW_MODE_KEY, '0');
    expect(await reviewModeEnabled(redis as unknown as Redis, iid)).toBe(false);
  });
});

describe('team_learn under review mode', () => {
  const args = {
    instance_id: iid, author: 'alice', topic: 'deploy:web',
    outcome: 'success', what_worked: 'canary first',
  };

  it('writes directly when the flag is absent (unchanged behavior)', async () => {
    const out = (await handleTeamTool('team_learn', args, getConn, noopApiFetch))!;
    expect(out).toContain('Team lesson stored');
    expect(redis.store.get('cachly:lesson:best:deploy:web')).toBeTruthy();
    expect(redis.store.get(`${PROPOSED_LESSON_PREFIX}deploy:web`)).toBeUndefined();
  });

  it('writes a pending proposal instead of a best-lesson when enabled', async () => {
    await redis.set(REVIEW_MODE_KEY, '1');
    const out = (await handleTeamTool('team_learn', args, getConn, noopApiFetch))!;
    expect(out).toContain('submitted for review');
    expect(out).toContain('Team → Review');
    // Recall keyspace untouched — smart_recall/team_recall ignore the proposal.
    expect(redis.store.get('cachly:lesson:best:deploy:web')).toBeUndefined();
    const raw = redis.store.get(`${PROPOSED_LESSON_PREFIX}deploy:web`);
    expect(raw).toBeTruthy();
    const proposal = JSON.parse(raw!);
    expect(proposal.status).toBe('pending');
    expect(proposal.author).toBe('alice');
    expect(proposal.outcome).toBe('success');
    expect(proposal.proposed_at).toBeTruthy();
    // History list must stay clean too — nothing entered the team brain yet.
    expect(await redis.lrange('cachly:lessons:deploy:web', 0, -1)).toHaveLength(0);
  });
});

describe('learn_from_attempts under review mode', () => {
  const args = {
    instance_id: iid, topic: 'fix:auth', outcome: 'failure' as const,
    what_worked: '', what_failed: 'clock skew broke JWT validation',
    severity: 'critical' as const, author: 'bob',
  };

  it('writes a pending proposal when enabled', async () => {
    await redis.set(REVIEW_MODE_KEY, '1');
    const out = (await handleBrainTool('learn_from_attempts', args, getConn, noopApiFetch))!;
    expect(out).toContain('submitted for review');
    expect(redis.store.get('cachly:lesson:best:fix:auth')).toBeUndefined();
    const proposal = JSON.parse(redis.store.get(`${PROPOSED_LESSON_PREFIX}fix:auth`)!);
    expect(proposal.topic).toBe('fix:auth');
    expect(proposal.what_failed).toBe('clock skew broke JWT validation');
    expect(proposal.author).toBe('bob');
  });

  it('keeps private notes direct — they never surface in team recall', async () => {
    await redis.set(REVIEW_MODE_KEY, '1');
    const out = (await handleBrainTool('learn_from_attempts',
      { ...args, visibility: 'private' }, getConn, noopApiFetch))!;
    expect(out).not.toContain('submitted for review');
    expect(redis.store.get(`${PROPOSED_LESSON_PREFIX}fix:auth`)).toBeUndefined();
    expect(redis.store.get('cachly:lesson:best:fix:auth')).toBeTruthy();
  });

  it('writes directly when the flag is absent (unchanged behavior)', async () => {
    const out = (await handleBrainTool('learn_from_attempts', args, getConn, noopApiFetch))!;
    expect(out).not.toContain('submitted for review');
    expect(redis.store.get('cachly:lesson:best:fix:auth')).toBeTruthy();
  });
});
