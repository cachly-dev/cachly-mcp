/**
 * brain_hygiene — autonomous Brain maintenance sweep.
 *
 * Tests the three hygiene rules:
 *  1. Decay flagging: low-confidence active lessons → provisional
 *  2. Archival: provisional + low-recall + old → archived
 *  3. Contradiction resolution: success dominates failure → failure archived
 *
 * Also verifies that brain_hygiene respects dry_run=true (no writes).
 *
 * Uses an in-memory Redis stub (get, mget, set, pipeline, scanStream).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleTeamTool } from '../handlers/team.js';

// ── Minimal Redis stub ────────────────────────────────────────────────────────

class MiniRedis {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map(k => this.store.get(k) ?? null);
  }
  pipeline() {
    const ops: Array<() => void> = [];
    return {
      set: (key: string, value: string) => { ops.push(() => this.store.set(key, value)); return this; },
      exec: async () => { ops.forEach(op => op()); return []; },
    };
  }
  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = opts.match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => { emitter.emit('data', matches); emitter.emit('end'); });
    return emitter;
  }
}

function makeConnection(redis: MiniRedis) {
  return async (_id: string) => redis as unknown as ReturnType<Parameters<typeof handleTeamTool>[2]>;
}

// ── Lesson factory helpers ────────────────────────────────────────────────────

function freshLesson(topic: string, outcome = 'success', recallCount = 5): Record<string, unknown> {
  return {
    topic, outcome,
    what_worked: 'it works',
    what_failed: '',
    ts: new Date().toISOString(),
    verified_at: new Date().toISOString(), // just now → confidence 1.0
    recall_count: recallCount,
    state: 'active',
    audit_trail: [],
  };
}

function staleLesson(topic: string, outcome = 'success', recallCount = 0, daysAgo = 15): Record<string, unknown> {
  const old = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return {
    topic, outcome,
    what_worked: 'stale fix',
    what_failed: '',
    ts: old,
    verified_at: old,
    recall_count: recallCount,
    state: 'active',
    audit_trail: [],
  };
}

function provisionalLesson(topic: string, daysAgo = 35): Record<string, unknown> {
  const old = new Date(Date.now() - daysAgo * 86400000).toISOString();
  return {
    topic, outcome: 'success',
    what_worked: 'provisional fix',
    what_failed: '',
    ts: old,
    verified_at: old,
    recall_count: 0,
    state: 'provisional',
    audit_trail: [],
  };
}

function seed(redis: MiniRedis, lesson: Record<string, unknown> & { topic: string }) {
  redis.store.set(`cachly:lesson:best:${lesson.topic}`, JSON.stringify(lesson));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('brain_hygiene', () => {
  let redis: MiniRedis;
  const INSTANCE = 'test-instance-id';

  beforeEach(() => { redis = new MiniRedis(); });

  async function runHygiene(opts: Record<string, unknown> = {}) {
    return handleTeamTool(
      'brain_hygiene',
      { instance_id: INSTANCE, ...opts },
      makeConnection(redis) as unknown as Parameters<typeof handleTeamTool>[2],
      (() => {}) as unknown as Parameters<typeof handleTeamTool>[3],
    );
  }

  it('returns "no lessons" message for an empty Brain', async () => {
    const result = await runHygiene();
    expect(result).toContain('no lessons found');
  });

  it('flags stale active lesson as provisional', async () => {
    seed(redis, { ...staleLesson('deploy:k8s', 'success', 0, 12), state: 'active' });
    const result = await runHygiene({ dry_run: false });
    expect(result).toContain('Flagged provisional');
    // The lesson should now have state=provisional
    const raw = redis.store.get('cachly:lesson:best:deploy:k8s');
    const updated = JSON.parse(raw!);
    expect(updated.state).toBe('provisional');
    expect(updated.audit_trail.at(-1).action).toBe('flagged_provisional');
  });

  it('does not flag a fresh lesson', async () => {
    seed(redis, freshLesson('api:auth'));
    const result = await runHygiene({ dry_run: false });
    expect(result).not.toContain('api:auth');
    const raw = redis.store.get('cachly:lesson:best:api:auth');
    const unchanged = JSON.parse(raw!);
    expect(unchanged.state).toBe('active');
  });

  it('archives a provisional lesson that is old + low-recall', async () => {
    seed(redis, provisionalLesson('infra:old-topic', 40)); // provisional + 40d old + 0 recalls
    const result = await runHygiene({ dry_run: false, archive_days: 30 });
    expect(result).toContain('Archived');
    const raw = redis.store.get('cachly:lesson:best:infra:old-topic');
    const updated = JSON.parse(raw!);
    expect(updated.state).toBe('archived');
    expect(updated.audit_trail.at(-1).action).toBe('archived');
  });

  it('does not archive a provisional lesson that has enough recalls', async () => {
    // provisional + 40 days old BUT recall_count=5 → should not be archived
    const lesson = { ...provisionalLesson('infra:used-topic', 40), recall_count: 5 };
    seed(redis, lesson);
    await runHygiene({ dry_run: false, archive_days: 30 });
    const raw = redis.store.get('cachly:lesson:best:infra:used-topic');
    const updated = JSON.parse(raw!);
    // state should remain provisional (not upgraded to archived)
    expect(updated.state).not.toBe('archived');
  });

  it('archives an orphan failure lesson (never recalled, old)', async () => {
    // failure + recall_count=0 + older than archive_days → should be archived
    const old = new Date(Date.now() - 35 * 86400000).toISOString();
    seed(redis, {
      topic: 'auth:jwt-orphan',
      outcome: 'failure',
      what_worked: '',
      what_failed: 'jwt expired silently',
      ts: old,
      verified_at: old,
      recall_count: 0,
      state: 'active',
      audit_trail: [],
    });
    const result = await runHygiene({ dry_run: false, archive_days: 30 });
    expect(result).toContain('Contradictions resolved');
    expect(result).toContain('auth:jwt-orphan');
    const raw = redis.store.get('cachly:lesson:best:auth:jwt-orphan');
    const updated = JSON.parse(raw!);
    expect(updated.state).toBe('archived');
    expect(updated.audit_trail.at(-1).action).toBe('orphan_failure_archived');
  });

  it('does not archive a failure lesson that was recalled at least once', async () => {
    const old = new Date(Date.now() - 35 * 86400000).toISOString();
    seed(redis, {
      topic: 'auth:jwt-used',
      outcome: 'failure',
      what_worked: '',
      what_failed: 'jwt expired',
      ts: old,
      verified_at: old,
      recall_count: 1, // recalled → should NOT be archived
      state: 'active',
      audit_trail: [],
    });
    await runHygiene({ dry_run: false, archive_days: 30 });
    const raw = redis.store.get('cachly:lesson:best:auth:jwt-used');
    const updated = JSON.parse(raw!);
    expect(updated.state).not.toBe('archived');
  });

  it('dry_run does not modify any lesson', async () => {
    seed(redis, { ...staleLesson('deploy:ci', 'success', 0, 12), state: 'active' });
    const before = new Map(redis.store);
    const result = await runHygiene({ dry_run: true });
    expect(result).toContain('dry run');
    // Store must be identical
    expect(redis.store.size).toBe(before.size);
    for (const [k, v] of before) {
      expect(redis.store.get(k)).toBe(v);
    }
  });

  it('dry_run still reports what would change', async () => {
    seed(redis, { ...staleLesson('deploy:ci', 'success', 0, 12), state: 'active' });
    const result = await runHygiene({ dry_run: true });
    expect(result).toContain('Flagged provisional');
    expect(result).toContain('apply these changes');
  });

  it('respects custom provisional_threshold', async () => {
    // A 3-day-old lesson: default threshold flags it provisional (confidence ~0.7-1.0 at 3d — NOT stale)
    // But with threshold=0.99 it should be flagged.
    const threeDayOld = new Date(Date.now() - 3 * 86400000).toISOString();
    seed(redis, {
      topic: 'api:rate-limit',
      outcome: 'success',
      what_worked: 'add retry',
      ts: threeDayOld,
      verified_at: threeDayOld,
      recall_count: 1,
      state: 'active',
      audit_trail: [],
    });
    const result = await runHygiene({ dry_run: true, provisional_threshold: 0.99 });
    // At 3 days, confidence is below 0.99 → should be flagged
    expect(result).toContain('api:rate-limit');
  });

  it('skips lessons that are already archived', async () => {
    seed(redis, { ...staleLesson('old:topic', 'success', 0, 60), state: 'archived' });
    const result = await runHygiene({ dry_run: false });
    // Already archived → no new provisional/archived actions
    const raw = redis.store.get('cachly:lesson:best:old:topic');
    const unchanged = JSON.parse(raw!);
    expect(unchanged.state).toBe('archived'); // unchanged
    expect(result).toContain('scanned');
  });

  it('report always contains scanned count', async () => {
    seed(redis, freshLesson('api:auth'));
    seed(redis, freshLesson('deploy:k8s'));
    const result = await runHygiene({ dry_run: true });
    expect(result).toMatch(/scanned \*\*2\*\* lessons/);
  });
});
