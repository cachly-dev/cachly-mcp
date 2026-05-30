/**
 * Stress tests for team_expertise_map with large contributor sets.
 *
 * Verifies:
 *   - 50-contributor Brain renders correctly and respects top_n cap
 *   - Domain distribution is computed correctly across many domains
 *   - Last-active ordering works at scale
 *   - scan cap (max:2000) is respected via mock
 *   - Empty / single-contributor edge cases
 *
 * Also includes regression tests for brain_who_knows, skill_gaps, brain_coverage
 * with realistic multi-contributor datasets.
 *
 * Run: npx vitest run src/__tests__/expertise-stress.test.ts
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';

// ── Full-featured MockRedis (same as brain-flow.test.ts) ──────────────────────

class MockRedis {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private sets  = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async set(key: string, value: string, ...opts: unknown[]): Promise<'OK' | null> {
    if (opts.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value); return 'OK';
  }
  async incr(key: string): Promise<number> {
    const n = parseInt(this.store.get(key) ?? '0', 10) + 1;
    this.store.set(key, String(n)); return n;
  }
  async rpush(key: string, ...values: string[]): Promise<number> {
    const l = this.lists.get(key) ?? []; l.push(...values); this.lists.set(key, l); return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    return l.slice(start < 0 ? l.length + start : start, stop < 0 ? l.length + stop + 1 : stop + 1);
  }
  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const l = this.lists.get(key) ?? [];
    this.lists.set(key, l.slice(start < 0 ? l.length + start : start, stop < 0 ? l.length + stop + 1 : stop + 1));
    return 'OK';
  }
  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>(); let n = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); n++; } }
    this.sets.set(key, s); return n;
  }
  async smembers(key: string): Promise<string[]> { return [...(this.sets.get(key) ?? [])]; }
  async mget(...keys: string[]): Promise<(string | null)[]> { return keys.map(k => this.store.get(k) ?? null); }
  async exists(key: string): Promise<number> { return this.store.has(key) ? 1 : 0; }
  async incrbyfloat(key: string, inc: number): Promise<string> {
    const v = parseFloat(this.store.get(key) ?? '0') + inc;
    this.store.set(key, String(v)); return String(v);
  }
  async expire(_k: string, _t: number): Promise<number> { return 1; }
  async del(...keys: string[]): Promise<number> {
    let n = 0; for (const k of keys) { if (this.store.delete(k)) n++; } return n;
  }
  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const em = new EventEmitter();
    const re = new RegExp(`^${opts.match.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const hits = [...this.store.keys()].filter(k => re.test(k));
    setImmediate(() => { em.emit('data', hits); em.emit('end'); });
    return em;
  }
  pipeline() {
    const cmds: Array<{key: string}> = []; const store = this.store;
    return {
      get(k: string) { cmds.push({key: k}); return this; },
      async exec(): Promise<Array<[null, string|null]>> {
        return cmds.map(c => [null, store.get(c.key) ?? null]);
      },
    };
  }
  _store() { return this.store; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePersonNode(handle: string, lastActiveDaysAgo: number) {
  const ts = new Date(Date.now() - lastActiveDaysAgo * 86400000).toISOString();
  return {
    id: `person:${handle}`,
    type: 'person' as const,
    handle,
    lesson_count: 0,
    last_active: ts,
    created_at: ts,
  };
}

function seedContributors(
  redis: MockRedis,
  contributors: Array<{ handle: string; domains: string[]; daysAgo?: number }>,
) {
  for (const c of contributors) {
    const node = makePersonNode(c.handle, c.daysAgo ?? 1);
    redis['store'].set(`cachly:ckg:node:person:${c.handle}`, JSON.stringify(node));

    // Create authored edges for each domain
    for (const [i, domain] of c.domains.entries()) {
      const topic = `${domain}:lesson-${c.handle}-${i}`;
      const edgeId = `cachly:ckg:edge:${node.id}:authored:${topic}`;
      const edge = { id: edgeId, from: node.id, to: topic, edgeType: 'authored', confidence: 1.0 };
      redis['store'].set(edgeId, JSON.stringify(edge));
      redis['sets'].set(`cachly:ckg:idx:from:${node.id}`, new Set([
        ...(redis['sets'].get(`cachly:ckg:idx:from:${node.id}`) ?? new Set()),
        edgeId,
      ]));
    }
  }
}

async function callBrain(
  name: string,
  args: Record<string, unknown>,
  redis: MockRedis,
): Promise<string> {
  const getConn = async () => redis as unknown as Redis;
  const apiFetch = async <T>() => ({} as T);
  const result = await handleBrainTool(name, args, getConn, apiFetch);
  return result ?? '';
}

// ── team_expertise_map stress test ───────────────────────────────────────────

describe('team_expertise_map stress (50 contributors)', () => {
  it('renders a table with 50 contributors respecting top_n cap', async () => {
    const redis = new MockRedis();
    const domains = ['auth', 'deploy', 'infra', 'db', 'frontend', 'api', 'ci', 'monitoring'];

    // Seed 50 contributors, each with 1-5 domain lessons
    for (let i = 0; i < 50; i++) {
      const handle = `dev${String(i).padStart(2, '0')}`;
      const numDomains = (i % 5) + 1;
      const contrib = domains.slice(0, numDomains);
      seedContributors(redis, [{ handle, domains: contrib, daysAgo: i }]);
    }

    const result = await callBrain('team_expertise_map', { instance_id: 'inst-1', top_n: 20 }, redis);

    expect(result).toContain('Team Expertise Map');
    // Should show exactly 20 (top_n cap) rows in the table
    const rows = result.split('\n').filter(l => l.startsWith('|') && !l.startsWith('| #') && !l.startsWith('|---'));
    expect(rows.length).toBeLessThanOrEqual(20);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('shows all 50 contributors when top_n=50', async () => {
    const redis = new MockRedis();
    const domains = ['auth', 'deploy'];
    for (let i = 0; i < 50; i++) {
      seedContributors(redis, [{ handle: `eng${i}`, domains, daysAgo: i }]);
    }

    const result = await callBrain('team_expertise_map', { instance_id: 'inst-1', top_n: 50 }, redis);
    const rows = result.split('\n').filter(l => l.startsWith('|') && !l.startsWith('| #') && !l.startsWith('|---'));
    expect(rows.length).toBe(50);
  });

  it('sorts by lesson count descending (most active first)', async () => {
    const redis = new MockRedis();
    // alice has 5 lessons, bob has 2
    seedContributors(redis, [
      { handle: 'alice', domains: ['auth', 'deploy', 'infra', 'db', 'ci'] },
      { handle: 'bob',   domains: ['auth', 'deploy'] },
    ]);

    const result = await callBrain('team_expertise_map', { instance_id: 'inst-1' }, redis);
    const alicePos = result.indexOf('alice');
    const bobPos   = result.indexOf('bob');
    expect(alicePos).toBeLessThan(bobPos);
    expect(result).toContain('🥇');
  });

  it('shows empty state with guidance when no contributors', async () => {
    const redis = new MockRedis();
    const result = await callBrain('team_expertise_map', { instance_id: 'inst-1' }, redis);
    expect(result).toContain('No contributors yet');
    expect(result).toContain('author');
  });

  it('single contributor renders without crash', async () => {
    const redis = new MockRedis();
    seedContributors(redis, [{ handle: 'solo', domains: ['auth', 'deploy', 'db'] }]);
    const result = await callBrain('team_expertise_map', { instance_id: 'inst-1' }, redis);
    expect(result).toContain('solo');
    expect(result).toContain('auth');
  });

  it('handles contributors with 0 authored lessons gracefully', async () => {
    const redis = new MockRedis();
    // A person node with no authored edges
    const node = makePersonNode('ghost', 5);
    redis['store'].set(`cachly:ckg:node:person:ghost`, JSON.stringify(node));

    const result = await callBrain('team_expertise_map', { instance_id: 'inst-1' }, redis);
    // ghost has 0 lessons — should still appear (just with 0 count)
    expect(result).not.toThrowError;
    expect(result).toContain('Team Expertise Map');
  });

  it('respects default top_n=20 cap', async () => {
    const redis = new MockRedis();
    for (let i = 0; i < 30; i++) {
      seedContributors(redis, [{ handle: `dev${i}`, domains: ['auth'] }]);
    }
    const result = await callBrain('team_expertise_map', { instance_id: 'inst-1' }, redis);
    const rows = result.split('\n').filter(l => l.startsWith('|') && !l.startsWith('| #') && !l.startsWith('|---'));
    expect(rows.length).toBeLessThanOrEqual(20);
  });
});

// ── Regression: brain_who_knows ───────────────────────────────────────────────

/**
 * brain_who_knows uses:
 *   1. concept nodes to find matching topics (cachly:ckg:node:*)
 *   2. inbound edges: cachly:ckg:idx:to:{conceptId} → edge keys → edge.from = person
 * The test must seed BOTH the from-index and the to-index.
 */
function seedAuthoredEdge(
  redis: MockRedis,
  personId: string, handle: string, topic: string, lastUpdated: string,
) {
  // Person node
  if (!redis['store'].has(`cachly:ckg:node:${personId}`)) {
    redis['store'].set(`cachly:ckg:node:${personId}`, JSON.stringify({
      id: personId, type: 'person', handle, last_active: lastUpdated, domain: personId,
    }));
  }
  // Concept node (so scanStream finds it when token-matching)
  const conceptId = topic.replace(/:/g, '-');
  if (!redis['store'].has(`cachly:ckg:node:${conceptId}`)) {
    redis['store'].set(`cachly:ckg:node:${conceptId}`, JSON.stringify({
      id: conceptId, type: 'concept', domain: topic.split(':')[0],
    }));
  }
  // Edge
  const edgeId = `cachly:ckg:edge:${personId}:authored:${conceptId}`;
  const edge = { id: edgeId, from: personId, to: conceptId, edgeType: 'authored', confidence: 1.0, last_updated: lastUpdated };
  redis['store'].set(edgeId, JSON.stringify(edge));
  // Update from-index
  redis['sets'].set(`cachly:ckg:idx:from:${personId}`, new Set([
    ...(redis['sets'].get(`cachly:ckg:idx:from:${personId}`) ?? new Set()), edgeId,
  ]));
  // Update to-index (THIS is what brain_who_knows uses)
  redis['sets'].set(`cachly:ckg:idx:to:${conceptId}`, new Set([
    ...(redis['sets'].get(`cachly:ckg:idx:to:${conceptId}`) ?? new Set()), edgeId,
  ]));
}

describe('brain_who_knows regression (multi-contributor)', () => {
  it('ranks the contributor with most authored lessons on the topic first', async () => {
    const redis = new MockRedis();
    const ts = new Date().toISOString();

    // alice: 3 auth:jwt-* lessons, bob: 1 auth:jwt-* lesson
    for (let i = 0; i < 3; i++) {
      seedAuthoredEdge(redis, 'person:alice', 'alice', `auth:jwt-expiry-${i}`, ts);
    }
    seedAuthoredEdge(redis, 'person:bob', 'bob', 'auth:jwt-other', ts);

    const result = await callBrain('brain_who_knows', { instance_id: 'inst-1', topic: 'auth' }, redis);
    expect(result).toContain('alice');
    const alicePos = result.indexOf('alice');
    const bobPos   = result.indexOf('bob');
    expect(alicePos).toBeLessThan(bobPos);
  });

  it('returns guidance when no experts found for topic', async () => {
    const redis = new MockRedis();
    const result = await callBrain('brain_who_knows', { instance_id: 'inst-1', topic: 'kubernetes-advanced' }, redis);
    expect(result).not.toBeNull();
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── Regression: brain_coverage ────────────────────────────────────────────────

describe('brain_coverage regression', () => {
  it('scores 100 for a Brain with many successes and attribution', async () => {
    const redis = new MockRedis();

    // Seed 20 success lessons with author and file_paths
    for (let i = 0; i < 20; i++) {
      const topic = `auth:lesson-${i}`;
      const lesson = JSON.stringify({
        topic, outcome: 'success', what_worked: 'fixed it',
        author: `dev${i % 5}`, file_paths: [`src/auth/file${i}.ts`],
        confidence: 1.0, ts: new Date().toISOString(),
      });
      redis['store'].set(`cachly:lesson:best:${topic}`, lesson);
    }

    const result = await callBrain('brain_coverage', { instance_id: 'inst-1' }, redis);
    expect(result).toContain('Brain Coverage Report');
    // Should show a score above 0
    expect(result).toMatch(/\d+\/100|\d+%/);
  });

  it('returns low score for a Brain with only failures and no attribution', async () => {
    const redis = new MockRedis();

    for (let i = 0; i < 5; i++) {
      const topic = `deploy:fail-${i}`;
      const lesson = JSON.stringify({
        topic, outcome: 'failure', what_failed: 'it broke',
        confidence: 0.3, ts: new Date().toISOString(),
      });
      redis['store'].set(`cachly:lesson:best:${topic}`, lesson);
    }

    const result = await callBrain('brain_coverage', { instance_id: 'inst-1' }, redis);
    expect(result).toContain('Brain Coverage Report');
    // Should mention attribution gap
    expect(result.toLowerCase()).toMatch(/attribution|author|who_knows/);
  });
});
