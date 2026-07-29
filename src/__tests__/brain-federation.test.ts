/**
 * brain_contribute_signal + brain_import_meta — Move 5 privacy-preserving federation.
 *
 * Verifies:
 * - contribute_signal validates inputs and never sends raw lesson text
 * - import_meta stores meta-lessons with state='meta' and never overwrites existing lessons
 * - Both tools handle API unavailability gracefully
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleFedbrainTool } from '../handlers/fedbrain.js';

class MiniRedis {
  store = new Map<string, string>();
  lists = new Map<string, string[]>();

  async get(key: string) { return this.store.get(key) ?? null; }
  async set(key: string, value: string, ..._rest: unknown[]) { this.store.set(key, value); return 'OK' as const; }
  async mget(...keys: string[]) { return keys.map(k => this.store.get(k) ?? null); }
  async lrange(key: string, _start: number, _stop: number) { return this.lists.get(key) ?? []; }
  async rpush(key: string, ...vals: string[]) { const a = this.lists.get(key) ?? []; a.push(...vals); this.lists.set(key, a); return a.length; }
  async ltrim(_key: string, _start: number, _stop: number) { return 'OK' as const; }
  async sadd(_key: string, ..._members: string[]) { return 1; }
  scanStream(_opts: { match: string; count?: number }): EventEmitter {
    const em = new EventEmitter();
    setImmediate(() => { em.emit('data', []); em.emit('end'); });
    return em;
  }
}

const INSTANCE = 'test-instance';

function makeConn(redis: MiniRedis) {
  return (async (_id: string) => redis) as unknown as Parameters<typeof handleFedbrainTool>[2];
}

async function callTool(redis: MiniRedis, name: string, args: Record<string, unknown>, apiFetch?: Parameters<typeof handleFedbrainTool>[3]) {
  const fetch = apiFetch ?? ((async () => ({ accepted: true, k_threshold: 3, meta_lessons: [], signal_count: 0 })) as unknown as Parameters<typeof handleFedbrainTool>[3]);
  return handleFedbrainTool(name, { instance_id: INSTANCE, ...args }, makeConn(redis), fetch);
}

// ── brain_contribute_signal ─────────────────────────────────────────────────

describe('brain_contribute_signal', () => {
  let redis: MiniRedis;
  beforeEach(() => { redis = new MiniRedis(); });

  it('rejects empty topic_category', async () => {
    await expect(callTool(redis, 'brain_contribute_signal', { topic_category: '', outcome: 'failure' }))
      .rejects.toThrow(/topic_category is required/);
  });

  it('rejects invalid outcome', async () => {
    await expect(callTool(redis, 'brain_contribute_signal', { topic_category: 'auth:jwt', outcome: 'maybe' }))
      .rejects.toThrow(/outcome must be/);
  });

  it('reports the confidence bucket, not the raw value', async () => {
    const result = await callTool(redis, 'brain_contribute_signal', {
      topic_category: 'auth:jwt', outcome: 'failure', confidence: 0.9,
    });
    expect(result).toContain('high');
    expect(result).not.toContain('0.9');
  });

  it('mentions privacy guarantee in the output', async () => {
    const result = await callTool(redis, 'brain_contribute_signal', {
      topic_category: 'deploy:k8s', outcome: 'success', confidence: 0.8,
    });
    expect(result).toContain('Privacy');
    expect(result).toContain('no lesson text');
  });

  it('succeeds when API is available', async () => {
    const apiFetch = (async () => ({ accepted: true, k_threshold: 3 })) as unknown as Parameters<typeof handleFedbrainTool>[3];
    const result = await callTool(redis, 'brain_contribute_signal', {
      topic_category: 'auth:jwt', outcome: 'failure', confidence: 0.85,
    }, apiFetch);
    expect(result).toContain('global commons');
    expect(result).toContain('✅');
  });

  it('falls back to local outbox when API fails', async () => {
    const failFetch = (async () => { throw new Error('API down'); }) as unknown as Parameters<typeof handleFedbrainTool>[3];
    const result = await callTool(redis, 'brain_contribute_signal', {
      topic_category: 'auth:jwt', outcome: 'failure', confidence: 0.85,
    }, failFetch);
    // No crash, returns graceful message with the topic
    expect(result).toContain('auth:jwt');
    // outbox entry written
    const outboxKeys = [...redis.store.keys()].filter(k => k.startsWith('cachly:fed:outbox:'));
    expect(outboxKeys.length).toBe(1);
  });

  it('medium bucket for confidence 0.6', async () => {
    const result = await callTool(redis, 'brain_contribute_signal', {
      topic_category: 'auth:jwt', outcome: 'partial', confidence: 0.6,
    });
    expect(result).toContain('medium');
  });

  it('low bucket for confidence 0.3', async () => {
    const result = await callTool(redis, 'brain_contribute_signal', {
      topic_category: 'auth:jwt', outcome: 'success', confidence: 0.3,
    });
    expect(result).toContain('low');
  });
});

// ── brain_import_meta ───────────────────────────────────────────────────────

describe('brain_import_meta', () => {
  let redis: MiniRedis;
  beforeEach(() => { redis = new MiniRedis(); });

  it('returns empty message when no meta-lessons exist', async () => {
    const apiFetch = (async () => ({ meta_lessons: [], k_threshold: 3 })) as unknown as Parameters<typeof handleFedbrainTool>[3];
    const result = await callTool(redis, 'brain_import_meta', {}, apiFetch);
    expect(result).toContain('No meta-lessons available');
    expect(result).toContain('k-threshold');
  });

  it('imports meta-lessons with state=meta', async () => {
    const apiFetch = (async () => ({
      k_threshold: 3,
      meta_lessons: [{
        topic_category: 'auth:jwt', dominant_outcome: 'failure',
        avg_confidence: 0.82, signal_count: 5, derived_at: new Date().toISOString(),
      }],
    })) as unknown as Parameters<typeof handleFedbrainTool>[3];

    const result = await callTool(redis, 'brain_import_meta', {}, apiFetch);
    expect(result).toContain('auth:jwt');
    expect(result).toContain('1');

    const stored = redis.store.get('cachly:lesson:best:meta:auth:jwt');
    expect(stored).toBeTruthy();
    const lesson = JSON.parse(stored!);
    expect(lesson.state).toBe('meta');
    expect(lesson.signal_count).toBe(5);
  });

  it('does not overwrite an already-imported meta-lesson', async () => {
    redis.store.set('cachly:lesson:best:meta:auth:jwt', JSON.stringify({ state: 'meta', signal_count: 5 }));

    const apiFetch = (async () => ({
      k_threshold: 3,
      meta_lessons: [{ topic_category: 'auth:jwt', dominant_outcome: 'success', avg_confidence: 0.9, signal_count: 10, derived_at: new Date().toISOString() }],
    })) as unknown as Parameters<typeof handleFedbrainTool>[3];

    await callTool(redis, 'brain_import_meta', {}, apiFetch);

    // original not overwritten
    const stored = JSON.parse(redis.store.get('cachly:lesson:best:meta:auth:jwt')!);
    expect(stored.signal_count).toBe(5);
  });

  it('shows error when API is unavailable', async () => {
    const failFetch = (async () => { throw new Error('API down'); }) as unknown as Parameters<typeof handleFedbrainTool>[3];
    const result = await callTool(redis, 'brain_import_meta', {}, failFetch);
    expect(result).toContain('❌');
  });
});

// ── fedbrain_confirm ─────────────────────────────────────────────────────────
// Regression guard for #227: confirmations must hit the id-scoped commons route
// POST /api/v1/syndication/:id/confirm. The earlier bug POSTed to
// /api/v1/syndication/confirm (no id), which 404s, so cross-org confirmations
// silently never propagated and always fell to the local queue.
describe('fedbrain_confirm', () => {
  let redis: MiniRedis;
  beforeEach(() => { redis = new MiniRedis(); });

  it('requires the lesson id from fedbrain_search', async () => {
    const calls: string[] = [];
    const spy = (async (path: string) => { calls.push(path); return {}; }) as unknown as Parameters<typeof handleFedbrainTool>[3];
    const result = await callTool(redis, 'fedbrain_confirm', { topic: 't', outcome: 'worked' }, spy);
    expect(result).toMatch(/needs the lesson/i);
    expect(calls).toHaveLength(0); // no propagation without an id
  });

  it('propagates to the id-scoped commons endpoint, not /syndication/confirm', async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const spy = (async (path: string, init?: { method?: string }) => {
      calls.push({ path, method: init?.method }); return {};
    }) as unknown as Parameters<typeof handleFedbrainTool>[3];
    // id-only (no topic) keeps the CKG edge path out of this endpoint assertion.
    const result = await callTool(redis, 'fedbrain_confirm', { id: 'abc 123', outcome: 'worked' }, spy);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/v1/syndication/abc%20123/confirm'); // id encoded IN the path
    expect(calls[0].method).toBe('POST');
    expect(result).toContain('propagated');
  });

  it('queues the confirmation locally when the commons API is unavailable', async () => {
    const spy = (async () => { throw new Error('offline'); }) as unknown as Parameters<typeof handleFedbrainTool>[3];
    const result = await callTool(redis, 'fedbrain_confirm', { id: 'x1', outcome: 'worked' }, spy);
    expect(result).toMatch(/Queued locally/i);
    expect(redis.lists.get('cachly:fedbrain:pending_confirms')).toHaveLength(1);
  });
});
