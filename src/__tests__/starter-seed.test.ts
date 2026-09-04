/**
 * Tests for brain_seed_starter and the curated starter corpus.
 *
 * Verifies (no real network or Redis required):
 *   - Corpus integrity: unique topics, required fields, no PII markers
 *   - Seeding writes lessons to best + history keys
 *   - Idempotency: won't double-seed without force
 *   - topic_filter narrows the seed set (by topic OR tag)
 *   - User lessons are never overwritten (source != 'starter')
 *   - force=true re-seeds and overwrites
 *   - dry_run previews without writing
 *   - born_at is stamped so time-to-first-recall starts
 *   - Seeded lessons are findable by the keyword search engine
 *
 * Run: npx vitest run src/__tests__/starter-seed.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleShareTool } from '../handlers/share.js';
import { STARTER_CORPUS, STARTER_CORPUS_SIZE } from '../starter-corpus.js';
import { keywordSearch } from '../search.js';
import type { Redis } from 'ioredis';

// ── In-memory Redis mock ──────────────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async set(key: string, value: string, ...opts: unknown[]): Promise<'OK' | null> {
    if (opts.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value); return 'OK';
  }
  async rpush(key: string, ...values: string[]): Promise<number> {
    const l = this.lists.get(key) ?? []; l.push(...values); this.lists.set(key, l); return l.length;
  }
  // 0.10.153: die Saat pflanzt write-ahead-Heilvermerke (sadd auf
  // cachly:vek:nachtrag) — der Stummel muss koennen, was der Code benutzt.
  public sets = new Map<string, Set<string>>();
  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    let neu = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); neu++; } }
    this.sets.set(key, s);
    return neu;
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
  async del(...keys: string[]): Promise<number> {
    let n = 0; for (const k of keys) { if (this.lists.delete(k) || this.store.delete(k)) n++; } return n;
  }
  async expire(_k: string, _t: number): Promise<number> { return 1; }
  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const em = new EventEmitter();
    const re = new RegExp(`^${opts.match.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const hits = [...this.store.keys()].filter(k => re.test(k));
    setImmediate(() => { em.emit('data', hits); em.emit('end'); });
    return em;
  }
  pipeline() {
    const cmds: Array<{ key: string }> = []; const store = this.store;
    return {
      get(k: string) { cmds.push({ key: k }); return this; },
      async exec(): Promise<Array<[null, string | null]>> {
        return cmds.map(c => [null, store.get(c.key) ?? null]);
      },
    };
  }
  _store() { return this.store; }
  _lists() { return this.lists; }
}

const noopApi = async <T>() => ({} as T);

// ── Corpus integrity ──────────────────────────────────────────────────────────

describe('STARTER_CORPUS integrity', () => {
  it('exports a non-trivial number of lessons', () => {
    expect(STARTER_CORPUS_SIZE).toBeGreaterThanOrEqual(12);
    expect(STARTER_CORPUS.length).toBe(STARTER_CORPUS_SIZE);
  });

  it('has unique topics', () => {
    const topics = STARTER_CORPUS.map(l => l.topic);
    expect(new Set(topics).size).toBe(topics.length);
  });

  it('every lesson has all required fields populated', () => {
    for (const l of STARTER_CORPUS) {
      expect(l.topic).toMatch(/^[a-z0-9]+:[a-z0-9-]+$/); // domain:slug
      expect(l.outcome).toBe('success');
      expect(l.what_worked.length).toBeGreaterThan(20);
      expect(l.what_failed.length).toBeGreaterThan(20);
      expect(l.ctx.length).toBeGreaterThan(10);
      expect(Array.isArray(l.tags)).toBe(true);
      expect(l.tags.length).toBeGreaterThan(0);
      expect(l.confidence).toBeGreaterThan(0.5);
      expect(l.confidence).toBeLessThanOrEqual(1.0);
    }
  });

  it('contains no obvious secrets or PII markers', () => {
    const blob = JSON.stringify(STARTER_CORPUS).toLowerCase();
    expect(blob).not.toMatch(/password\s*[=:]\s*\S+|api[_-]?key\s*[=:]\s*\S+|bearer\s+ey/);
    // No real-looking emails
    expect(blob).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.(com|net|org|io)/);
  });
});

// ── brain_seed_starter behavior ───────────────────────────────────────────────

describe('brain_seed_starter', () => {
  let redis: MockRedis;
  const getConn = async (_id: string) => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('seeds all lessons into best + history keys', async () => {
    const result = await handleShareTool('brain_seed_starter', { instance_id: 'inst-1' }, getConn, noopApi);

    expect(result).toContain('Brain seeded');
    expect(result).toContain(`${STARTER_CORPUS_SIZE}`);

    // Each lesson should be in best + history
    for (const l of STARTER_CORPUS) {
      expect(redis._store().has(`cachly:lesson:best:${l.topic}`)).toBe(true);
      expect(redis._lists().has(`cachly:lessons:${l.topic}`)).toBe(true);
    }

    // 0.10.153: jede gesaete Lektion traegt einen Heil-Vermerk — sonst ist
    // sie fuer den Lese-Heiler unsichtbar und deckelt die semantische
    // Deckung jeder frischen Instanz (gemessen 02.09.2026: bei 16 %).
    const vermerke = redis.sets.get('cachly:vek:nachtrag') ?? new Set();
    for (const l of STARTER_CORPUS) {
      expect(vermerke.has(l.topic), `Vermerk fehlt: ${l.topic}`).toBe(true);
    }
  });

  it('tags every seeded lesson with source:"starter"', async () => {
    await handleShareTool('brain_seed_starter', { instance_id: 'inst-1' }, getConn, noopApi);
    const stored = JSON.parse(redis._store().get(`cachly:lesson:best:${STARTER_CORPUS[0].topic}`)!);
    expect(stored.source).toBe('starter');
    expect(stored.verified_at).toBeDefined();
  });

  it('stamps born_at so time-to-first-recall starts', async () => {
    await handleShareTool('brain_seed_starter', { instance_id: 'inst-1' }, getConn, noopApi);
    expect(redis._store().has('cachly:stats:born_at:inst-1')).toBe(true);
  });

  it('is idempotent — refuses to double-seed without force', async () => {
    await handleShareTool('brain_seed_starter', { instance_id: 'inst-1' }, getConn, noopApi);
    const second = await handleShareTool('brain_seed_starter', { instance_id: 'inst-1' }, getConn, noopApi);
    expect(second).toContain('already seeded');
  });

  it('force=true re-seeds even after a prior seed', async () => {
    await handleShareTool('brain_seed_starter', { instance_id: 'inst-1' }, getConn, noopApi);
    const forced = await handleShareTool('brain_seed_starter', { instance_id: 'inst-1', force: true }, getConn, noopApi);
    expect(forced).toContain('Brain seeded');
    expect(forced).not.toContain('already seeded');
  });

  it('never overwrites a user\'s own lesson on the same topic', async () => {
    const topic = STARTER_CORPUS[0].topic;
    // Pre-seed a user lesson (no source:"starter")
    redis._store().set(`cachly:lesson:best:${topic}`, JSON.stringify({
      topic, outcome: 'success', what_worked: 'MY OWN FIX', confidence: 1.0,
    }));

    const result = await handleShareTool('brain_seed_starter', { instance_id: 'inst-1' }, getConn, noopApi);
    expect(result).toContain('skipped');

    const stored = JSON.parse(redis._store().get(`cachly:lesson:best:${topic}`)!);
    expect(stored.what_worked).toBe('MY OWN FIX'); // untouched
    expect(stored.source).toBeUndefined();
  });

  it('topic_filter narrows the seed set by topic substring', async () => {
    const result = await handleShareTool('brain_seed_starter', {
      instance_id: 'inst-1', topic_filter: ['docker'],
    }, getConn, noopApi);

    expect(result).toContain('Brain seeded');
    // docker lesson seeded
    expect(redis._store().has('cachly:lesson:best:docker:layer-cache')).toBe(true);
    // a non-docker lesson NOT seeded
    expect(redis._store().has('cachly:lesson:best:jwt:clock-skew')).toBe(false);
  });

  it('topic_filter also matches by tag', async () => {
    const result = await handleShareTool('brain_seed_starter', {
      instance_id: 'inst-1', topic_filter: ['security'],
    }, getConn, noopApi);
    expect(result).toContain('Brain seeded');
    // The no-secrets-in-logs lesson has a 'security' tag
    expect(redis._store().has('cachly:lesson:best:security:no-secrets-in-logs')).toBe(true);
  });

  it('returns no-match message for an unknown topic_filter', async () => {
    const result = await handleShareTool('brain_seed_starter', {
      instance_id: 'inst-1', topic_filter: ['nonexistent-xyz'],
    }, getConn, noopApi);
    expect(result).toContain('no matching starter lessons');
  });

  it('dry_run previews without writing', async () => {
    const result = await handleShareTool('brain_seed_starter', {
      instance_id: 'inst-1', dry_run: true,
    }, getConn, noopApi);

    expect(result).toContain('DRY RUN');
    expect(redis._store().size).toBe(0); // nothing written
  });

  it('requires instance_id', async () => {
    const result = await handleShareTool('brain_seed_starter', {}, getConn, noopApi);
    expect(result).toContain('requires `instance_id`');
  });
});

// ── Seeded lessons are actually recall-able ───────────────────────────────────

describe('starter lessons are findable by the real search engine', () => {
  async function seedAndSearch(query: string) {
    const redis = new MockRedis();
    await handleShareTool('brain_seed_starter', { instance_id: 'inst-1' }, async () => redis as unknown as Redis, noopApi);
    return keywordSearch(redis as unknown as Redis, ['cachly:lesson:best:*'], query, 5);
  }

  it('surfaces the docker layer-cache lesson for "docker build slow cache"', async () => {
    const results = await seedAndSearch('docker build slow cache dependencies');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].key).toContain('docker:layer-cache');
  });

  it('surfaces the k8s OOM lesson for "pod OOMKilled memory limit"', async () => {
    const results = await seedAndSearch('kubernetes pod OOMKilled memory limit restart');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].key).toContain('k8s:oom-limits');
  });

  it('surfaces the jwt clock-skew lesson for "jwt token rejected expired"', async () => {
    const results = await seedAndSearch('jwt token rejected expired clock');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some(r => r.key.includes('jwt:clock-skew'))).toBe(true);
  });
});
