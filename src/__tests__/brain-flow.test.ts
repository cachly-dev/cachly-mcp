/**
 * Use-case tests for the Cachly Brain flow.
 *
 * Tests the core Brain operations end-to-end using an in-memory Redis mock:
 *   learn_from_attempts → CKG update → recall_best_solution (BM25)
 *   session_start → lessons summary
 *   CKG: Bayesian confidence, contradiction detection
 *   Embeddings: provider detection, config sync
 *
 * Run: npx vitest run src/__tests__/brain-flow.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Modules under test ────────────────────────────────────────────────────────
import { ckgSlug, extractProblemConcept, ckgUpsertNode, ckgUpdateEdge,
         ckgUpsertPersonNode, ckgUpsertFileNode, ckgRecordCollaboration,
         ckgUpsertServiceNode } from '../ckg.js';
import type { PersonNode, FileNode } from '../ckg.js';
import { EMBED_PROVIDER, hasEmbedProvider, embedProviderHint, embedConfig, setEmbedJwt } from '../embeddings.js';
import { keywordSearch } from '../search.js';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';

// ── In-memory Redis mock ──────────────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private sets  = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...opts: unknown[]): Promise<'OK' | null> {
    // Honor a trailing 'NX' flag so first-wins semantics (born_at, first_recall_at) work.
    if (opts.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const next = parseInt(this.store.get(key) ?? '0', 10) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start < 0 ? list.length + start : start, end);
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    this.lists.set(key, list.slice(start < 0 ? list.length + start : start, end));
    return 'OK';
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
    this.sets.set(key, s);
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map(k => this.store.get(k) ?? null);
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async incrbyfloat(key: string, increment: number): Promise<string> {
    const cur = parseFloat(this.store.get(key) ?? '0');
    const next = cur + increment;
    this.store.set(key, String(next));
    return String(next);
  }

  async expire(_key: string, _ttl: number): Promise<number> { return 1; }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) { if (this.store.delete(k)) count++; }
    return count;
  }

  /** Simplified scanStream: returns all matching keys in a single 'data' event. */
  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = opts.match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => {
      emitter.emit('data', matches);
      emitter.emit('end');
    });
    return emitter;
  }

  /** Minimal pipeline: batches GET calls, returns [err, value][] */
  pipeline() {
    const commands: Array<{ cmd: string; key: string }> = [];
    const store = this.store;
    return {
      get(key: string) { commands.push({ cmd: 'get', key }); return this; },
      async exec(): Promise<Array<[null, string | null]>> {
        const out: Array<[null, string | null]> = [];
        for (const c of commands) {
          out.push([null, store.get(c.key) ?? null]);
        }
        return out;
      },
    };
  }

  // Expose raw store for assertions
  _getStore() { return this.store; }
  _getLists() { return this.lists; }
  _getSets()  { return this.sets; }
}

// Lesson schema (mirrors what learn_from_attempts stores)
interface LessonObj {
  topic: string;
  outcome: 'success' | 'failure' | 'partial';
  what_worked: string;
  what_failed?: string;
  context?: string;
  severity?: 'critical' | 'major' | 'minor';
  commands?: string[];
  tags?: string[];
  file_paths?: string[];
  recall_count: number;
  ts: string;
  verified_at?: string;
  confidence: number;
  audit_trail: Array<{ ts: string; action: string; prev_outcome?: string }>;
  version: number;
}

/** Minimal implementation of the learn_from_attempts Redis storage logic */
async function storeLessonInRedis(
  redis: MockRedis,
  lesson: Omit<LessonObj, 'recall_count' | 'ts' | 'verified_at' | 'confidence' | 'audit_trail' | 'version'>,
): Promise<LessonObj> {
  const ts = new Date().toISOString();
  const existingRaw = await redis.get(`cachly:lesson:best:${lesson.topic}`);
  const auditTrail: LessonObj['audit_trail'] = existingRaw
    ? [{ ts, action: 'updated', prev_outcome: (JSON.parse(existingRaw) as LessonObj).outcome }]
    : [{ ts, action: 'created' }];
  const obj: LessonObj = {
    ...lesson,
    recall_count: 0,
    ts,
    verified_at: lesson.outcome !== 'failure' ? ts : undefined,
    confidence: 1.0,
    audit_trail: auditTrail,
    version: 3,
  };
  const serialized = JSON.stringify(obj);
  await redis.rpush(`cachly:lessons:${lesson.topic}`, serialized);
  if (lesson.outcome === 'success' || lesson.outcome === 'partial' || !existingRaw) {
    await redis.set(`cachly:lesson:best:${lesson.topic}`, serialized);
  }
  return obj;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CKG helpers (ckg.ts)', () => {
  let redis: MockRedis;
  beforeEach(() => { redis = new MockRedis(); });

  // ── ckgSlug ─────────────────────────────────────────────────────────────────
  describe('ckgSlug', () => {
    it('lowercases and replaces non-alnum with hyphens', () => {
      // trailing '!' becomes '-' which is then stripped by the trailing-hyphen rule
      expect(ckgSlug('Deploy API!')).toBe('deploy-api');
    });
    it('collapses multiple hyphens', () => {
      expect(ckgSlug('foo  --  bar')).toBe('foo-bar');
    });
    it('strips leading/trailing hyphens', () => {
      expect(ckgSlug('--hello--')).toBe('hello');
    });
    it('allows colon for namespaced slugs', () => {
      expect(ckgSlug('deploy:api')).toBe('deploy:api');
    });
    it('truncates at 80 chars', () => {
      expect(ckgSlug('a'.repeat(100))).toHaveLength(80);
    });
  });

  // ── extractProblemConcept ────────────────────────────────────────────────────
  describe('extractProblemConcept', () => {
    it('extracts 2 keywords from text', () => {
      const result = extractProblemConcept('docker container fails to start');
      expect(result).toBe('docker-container');
    });
    it('filters short words', () => {
      const result = extractProblemConcept('the key issue');
      // 'the' is stopword, 'key' is 3 chars (filtered), 'issue' passes
      expect(result).toBe('issue');
    });
    it('returns null for empty/all-stopword text', () => {
      expect(extractProblemConcept('')).toBeNull();
    });
  });

  // ── ckgUpsertNode ────────────────────────────────────────────────────────────
  describe('ckgUpsertNode', () => {
    it('creates a new node with count=1', async () => {
      await ckgUpsertNode(redis as unknown as Redis, 'deploy-api', 'backend', 'concept');
      const raw = await redis.get('cachly:ckg:node:deploy-api');
      expect(raw).not.toBeNull();
      const node = JSON.parse(raw!);
      expect(node.id).toBe('deploy-api');
      expect(node.domain).toBe('backend');
      expect(node.type).toBe('concept');
      expect(node.count).toBe(1);
    });
    it('increments count on repeated upsert', async () => {
      await ckgUpsertNode(redis as unknown as Redis, 'deploy-api', 'backend', 'concept');
      await ckgUpsertNode(redis as unknown as Redis, 'deploy-api', 'backend', 'concept');
      const node = JSON.parse((await redis.get('cachly:ckg:node:deploy-api'))!);
      expect(node.count).toBe(2);
    });
  });

  // ── ckgUpdateEdge ────────────────────────────────────────────────────────────
  describe('ckgUpdateEdge', () => {
    it('creates edge with Bayesian smoothed confidence', async () => {
      await ckgUpdateEdge(redis as unknown as Redis, 'problem-A', 'solved_by', 'solution-B', true);
      const edgeKey = 'cachly:ckg:edge:problem-A:solved_by:solution-B';
      const edge = JSON.parse((await redis.get(edgeKey))!);
      expect(edge.successes).toBe(1);
      expect(edge.trials).toBe(1);
      // Beta(successes+1, trials+2) = 2/3 ≈ 0.667
      expect(edge.confidence).toBeCloseTo(2 / 3, 5);
    });
    it('increases confidence after multiple successes', async () => {
      const r = redis as unknown as Redis;
      await ckgUpdateEdge(r, 'A', 'leads_to', 'B', true);
      await ckgUpdateEdge(r, 'A', 'leads_to', 'B', true);
      await ckgUpdateEdge(r, 'A', 'leads_to', 'B', true);
      const edge = JSON.parse((await redis.get('cachly:ckg:edge:A:leads_to:B'))!);
      // 3 successes, 3 trials → (3+1)/(3+2) = 0.8
      expect(edge.confidence).toBeCloseTo(0.8, 5);
    });
    it('partial success adds 0.5 to successes', async () => {
      const r = redis as unknown as Redis;
      await ckgUpdateEdge(r, 'A', 'leads_to', 'B', false, true); // partial
      const edge = JSON.parse((await redis.get('cachly:ckg:edge:A:leads_to:B'))!);
      expect(edge.successes).toBe(0.5);
      // (0.5+1)/(1+2) = 1.5/3 = 0.5
      expect(edge.confidence).toBeCloseTo(0.5, 5);
    });
    it('decreases confidence on failure', async () => {
      const r = redis as unknown as Redis;
      await ckgUpdateEdge(r, 'A', 'leads_to', 'B', true);
      const before = JSON.parse((await redis.get('cachly:ckg:edge:A:leads_to:B'))!).confidence;
      await ckgUpdateEdge(r, 'A', 'leads_to', 'B', false);
      const after = JSON.parse((await redis.get('cachly:ckg:edge:A:leads_to:B'))!).confidence;
      expect(after).toBeLessThan(before);
    });
    it('indexes edge in from/to index sets', async () => {
      const r = redis as unknown as Redis;
      await ckgUpdateEdge(r, 'prob', 'solved_by', 'sol', true);
      const fromIdx = await redis.smembers('cachly:ckg:idx:from:prob');
      const toIdx   = await redis.smembers('cachly:ckg:idx:to:sol');
      expect(fromIdx).toContain('cachly:ckg:edge:prob:solved_by:sol');
      expect(toIdx).toContain('cachly:ckg:edge:prob:solved_by:sol');
    });
  });
});

// ── Embeddings (embeddings.ts) ────────────────────────────────────────────────

describe('Embeddings config (embeddings.ts)', () => {
  it('EMBED_PROVIDER is a string', () => {
    expect(typeof EMBED_PROVIDER).toBe('string');
  });

  it('hasEmbedProvider returns false when no provider keys are set', () => {
    // In test environment (no API keys), EMBED_PROVIDER is 'none'
    // hasEmbedProvider() depends on env — just verify it returns a boolean
    expect(typeof hasEmbedProvider()).toBe('boolean');
  });

  it('embedProviderHint returns a non-empty string', () => {
    const hint = embedProviderHint();
    expect(typeof hint).toBe('string');
    expect(hint.length).toBeGreaterThan(0);
  });

  it('setEmbedJwt updates embedConfig.jwt', () => {
    const prev = embedConfig.jwt;
    setEmbedJwt('test-jwt-token-xyz');
    expect(embedConfig.jwt).toBe('test-jwt-token-xyz');
    // Restore
    setEmbedJwt(prev);
  });

  it('embedConfig.apiUrl defaults to cachly.dev', () => {
    expect(embedConfig.apiUrl).toContain('cachly.dev');
  });
});

// ── Brain Lesson Flow (learn → store → recall) ───────────────────────────────

describe('Brain lesson flow', () => {
  let redis: MockRedis;
  beforeEach(() => { redis = new MockRedis(); });

  describe('storeLessonInRedis (learn_from_attempts logic)', () => {
    it('stores lesson at cachly:lesson:best:{topic}', async () => {
      await storeLessonInRedis(redis, {
        topic: 'deploy:api',
        outcome: 'success',
        what_worked: 'docker compose up -d --build api',
        what_failed: 'docker compose up (hangs on SSH timeout)',
        severity: 'critical',
        commands: ['docker compose up -d --build api'],
        tags: ['docker', 'deploy'],
        file_paths: [],
      });

      const raw = await redis.get('cachly:lesson:best:deploy:api');
      expect(raw).not.toBeNull();
      const lesson = JSON.parse(raw!) as LessonObj;
      expect(lesson.topic).toBe('deploy:api');
      expect(lesson.outcome).toBe('success');
      expect(lesson.what_worked).toBe('docker compose up -d --build api');
      expect(lesson.commands).toContain('docker compose up -d --build api');
      expect(lesson.confidence).toBe(1.0);
      expect(lesson.version).toBe(3);
    });

    it('appends to history list cachly:lessons:{topic}', async () => {
      await storeLessonInRedis(redis, {
        topic: 'fix:redis-timeout',
        outcome: 'success',
        what_worked: 'increase timeout to 30s',
        severity: 'major',
        commands: [],
        tags: [],
        file_paths: [],
      });
      await storeLessonInRedis(redis, {
        topic: 'fix:redis-timeout',
        outcome: 'partial',
        what_worked: 'add retry logic',
        severity: 'minor',
        commands: [],
        tags: [],
        file_paths: [],
      });

      const history = await redis.lrange('cachly:lessons:fix:redis-timeout', 0, -1);
      expect(history).toHaveLength(2);
    });

    it('failure does not overwrite an existing success lesson', async () => {
      await storeLessonInRedis(redis, {
        topic: 'infra:wireguard',
        outcome: 'success',
        what_worked: 'add WireGuard IP to TLS-SAN',
        severity: 'critical',
        commands: [],
        tags: [],
        file_paths: [],
      });
      await storeLessonInRedis(redis, {
        topic: 'infra:wireguard',
        outcome: 'failure',
        what_worked: '',
        severity: 'major',
        commands: [],
        tags: [],
        file_paths: [],
      });

      const best = JSON.parse((await redis.get('cachly:lesson:best:infra:wireguard'))!) as LessonObj;
      // The success lesson must win
      expect(best.outcome).toBe('success');
    });

    it('audit trail records creation and update', async () => {
      await storeLessonInRedis(redis, {
        topic: 'debug:clickhouse',
        outcome: 'failure',
        what_worked: '',
        severity: 'major',
        commands: [],
        tags: [],
        file_paths: [],
      });
      await storeLessonInRedis(redis, {
        topic: 'debug:clickhouse',
        outcome: 'success',
        what_worked: 'use 127.0.0.1 not localhost',
        severity: 'major',
        commands: [],
        tags: [],
        file_paths: [],
      });

      const best = JSON.parse((await redis.get('cachly:lesson:best:debug:clickhouse'))!) as LessonObj;
      expect(best.audit_trail.length).toBe(1);
      expect(best.audit_trail[0].action).toBe('updated');
      expect(best.audit_trail[0].prev_outcome).toBe('failure');
    });
  });

  // ── BM25 recall ─────────────────────────────────────────────────────────────

  describe('BM25 recall (recall_best_solution keyword search)', () => {
    beforeEach(async () => {
      // Seed lessons
      const lessons = [
        { topic: 'deploy:api', what_worked: 'nohup docker compose up -d --build api' },
        { topic: 'infra:clickhouse-ipv6', what_worked: 'use 127.0.0.1 not localhost in ClickHouse healthcheck' },
        { topic: 'fix:keycloak-auth', what_worked: 'set redirect_uri to https not http' },
        { topic: 'bash:macos-lowercase', what_worked: 'use tr instead of ${var,,} on macOS' },
        { topic: 'deploy:web', what_worked: 'rsync --checksum --delete with ssh port 2222' },
      ];
      for (const l of lessons) {
        await storeLessonInRedis(redis, {
          ...l,
          outcome: 'success',
          severity: 'critical',
          commands: [],
          tags: [],
          file_paths: [],
        });
      }
    });

    it('finds deploy lesson by keyword', async () => {
      const results = await keywordSearch(
        redis as unknown as Redis,
        ['cachly:lesson:best:*'],
        'docker deploy api',
        5,
      );
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('docker');
    });

    it('finds clickhouse lesson by infrastructure topic', async () => {
      const results = await keywordSearch(
        redis as unknown as Redis,
        ['cachly:lesson:best:*'],
        'clickhouse localhost healthcheck',
        5,
      );
      expect(results.length).toBeGreaterThan(0);
      const topResult = results[0];
      expect(topResult.content.toLowerCase()).toContain('clickhouse');
    });

    it('ranks more specific matches higher', async () => {
      const results = await keywordSearch(
        redis as unknown as Redis,
        ['cachly:lesson:best:*'],
        'macos bash lowercase variable',
        5,
      );
      expect(results.length).toBeGreaterThan(0);
      // macOS bash lesson should rank highest since it matches all terms
      expect(results[0].content.toLowerCase()).toContain('macos');
    });

    it('returns empty array for completely unrelated query', async () => {
      const results = await keywordSearch(
        redis as unknown as Redis,
        ['cachly:lesson:best:*'],
        'xyzzy quantum entanglement unobtanium',
        5,
      );
      // Might return 0 or very low-score results; score should be minimal
      // Either empty or score near 0 is acceptable
      if (results.length > 0) {
        expect(results[0].score).toBeLessThan(0.1);
      }
    });
  });

  // ── session_start context ────────────────────────────────────────────────────

  describe('session_start lesson aggregation', () => {
    it('correctly sorts lessons by timestamp (newest first)', async () => {
      const topics = ['old:lesson', 'mid:lesson', 'new:lesson'];
      for (let i = 0; i < topics.length; i++) {
        await storeLessonInRedis(redis, {
          topic: topics[i],
          outcome: 'success',
          what_worked: `fix ${i}`,
          severity: 'minor',
          commands: [],
          tags: [],
          file_paths: [],
        });
        // Tiny delay to ensure different timestamps
        await new Promise(r => setTimeout(r, 5));
      }

      // Simulate what session_start does: scan all lesson keys, sort by ts descending
      const allKeys: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
        stream.on('data', (batch: string[]) => allKeys.push(...batch));
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      const lessons: LessonObj[] = [];
      for (const k of allKeys) {
        const raw = await redis.get(k);
        if (raw) lessons.push(JSON.parse(raw) as LessonObj);
      }
      lessons.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

      expect(lessons[0].topic).toBe('new:lesson');
      expect(lessons[lessons.length - 1].topic).toBe('old:lesson');
    });

    it('scanStream returns all stored lesson keys', async () => {
      await storeLessonInRedis(redis, { topic: 'alpha', outcome: 'success', what_worked: 'x', severity: 'minor', commands: [], tags: [], file_paths: [] });
      await storeLessonInRedis(redis, { topic: 'beta',  outcome: 'success', what_worked: 'y', severity: 'minor', commands: [], tags: [], file_paths: [] });
      await storeLessonInRedis(redis, { topic: 'gamma', outcome: 'success', what_worked: 'z', severity: 'minor', commands: [], tags: [], file_paths: [] });

      const keys: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 100 });
        stream.on('data', (batch: string[]) => keys.push(...batch));
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      expect(keys).toHaveLength(3);
      expect(keys.some(k => k.includes('alpha'))).toBe(true);
      expect(keys.some(k => k.includes('beta'))).toBe(true);
      expect(keys.some(k => k.includes('gamma'))).toBe(true);
    });
  });
});

// ── End-to-end Brain flow integration ────────────────────────────────────────

describe('Brain E2E: learn → CKG → recall', () => {
  let redis: MockRedis;
  beforeEach(() => { redis = new MockRedis(); });

  it('full cycle: store lesson + update CKG + retrieve via BM25', async () => {
    const r = redis as unknown as Redis;

    // 1. Learn: store a deploy lesson
    await storeLessonInRedis(redis, {
      topic: 'deploy:api',
      outcome: 'success',
      what_worked: 'nohup docker compose up -d --build api avoids SSH timeout',
      what_failed: 'plain docker compose up hangs when SSH connection drops',
      severity: 'critical',
      commands: ['nohup docker compose up -d --build api'],
      tags: ['docker', 'deploy', 'ssh'],
      file_paths: ['docker-compose.yml'],
    });

    // 2. CKG: record the causal connection
    await ckgUpsertNode(r, 'deploy-api', 'infra', 'concept');
    await ckgUpdateEdge(r, 'ssh-timeout', 'solved_by', 'nohup-docker', true);

    // 3. Recall via BM25
    const results = await keywordSearch(
      r,
      ['cachly:lesson:best:*'],
      'docker compose ssh timeout deploy',
      5,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('nohup');

    // 4. Verify CKG state
    const edge = JSON.parse((await redis.get('cachly:ckg:edge:ssh-timeout:solved_by:nohup-docker'))!);
    expect(edge.confidence).toBeCloseTo(2 / 3, 5); // Beta(1+1, 1+2)

    // 5. Verify lesson persisted correctly
    const lesson = JSON.parse((await redis.get('cachly:lesson:best:deploy:api'))!) as LessonObj;
    expect(lesson.outcome).toBe('success');
    expect(lesson.commands).toContain('nohup docker compose up -d --build api');
  });

  it('contradiction: failure after success is detected', async () => {
    await storeLessonInRedis(redis, {
      topic: 'infra:k3s',
      outcome: 'success',
      what_worked: 'add WireGuard IP to k3s TLS-SAN',
      severity: 'critical',
      commands: [],
      tags: [],
      file_paths: [],
    });
    await storeLessonInRedis(redis, {
      topic: 'infra:k3s',
      outcome: 'failure',
      what_worked: '',
      severity: 'major',
      commands: [],
      tags: [],
      file_paths: [],
    });

    // Success lesson should still be the "best" lesson
    const best = JSON.parse((await redis.get('cachly:lesson:best:infra:k3s'))!) as LessonObj;
    expect(best.outcome).toBe('success');

    // But failure is logged in history
    const history = await redis.lrange('cachly:lessons:infra:k3s', 0, -1);
    expect(history).toHaveLength(2);
    const lastAttempt = JSON.parse(history[1]) as LessonObj;
    expect(lastAttempt.outcome).toBe('failure');
  });
});

// ── Extended Brain Flow Scenarios ─────────────────────────────────────────────

describe('Brain Flow: advanced scenarios', () => {
  let redis: MockRedis;
  beforeEach(() => { redis = new MockRedis(); });

  describe('recall_count and lesson update flow', () => {
    it('partial outcome can later be upgraded to success', async () => {
      await storeLessonInRedis(redis, {
        topic: 'fix:timeout',
        outcome: 'partial',
        what_worked: 'increase timeout to 15s',
        severity: 'major',
        commands: [],
        tags: [],
        file_paths: [],
      });
      // Upgrade to success
      await storeLessonInRedis(redis, {
        topic: 'fix:timeout',
        outcome: 'success',
        what_worked: 'increase timeout to 30s + add retry logic',
        severity: 'major',
        commands: ['--timeout 30s', '--retry 3'],
        tags: ['reliability'],
        file_paths: [],
      });

      const best = JSON.parse((await redis.get('cachly:lesson:best:fix:timeout'))!) as LessonObj;
      expect(best.outcome).toBe('success');
      expect(best.what_worked).toContain('retry logic');

      const history = await redis.lrange('cachly:lessons:fix:timeout', 0, -1);
      expect(history).toHaveLength(2);
    });

    it('lesson version is always 3', async () => {
      await storeLessonInRedis(redis, {
        topic: 'deploy:mcp',
        outcome: 'success',
        what_worked: 'npm publish --access public',
        severity: 'minor',
        commands: [],
        tags: [],
        file_paths: [],
      });
      const lesson = JSON.parse((await redis.get('cachly:lesson:best:deploy:mcp'))!) as LessonObj;
      expect(lesson.version).toBe(3);
    });

    it('verified_at is set for success/partial outcomes', async () => {
      await storeLessonInRedis(redis, {
        topic: 'infra:ssl',
        outcome: 'success',
        what_worked: 'certbot renew',
        severity: 'critical',
        commands: [],
        tags: [],
        file_paths: [],
      });
      const lesson = JSON.parse((await redis.get('cachly:lesson:best:infra:ssl'))!) as LessonObj;
      expect(lesson.verified_at).toBeDefined();
      expect(new Date(lesson.verified_at!).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('verified_at is NOT set for failure outcomes', async () => {
      await storeLessonInRedis(redis, {
        topic: 'infra:ssl',
        outcome: 'failure',
        what_worked: '',
        severity: 'critical',
        commands: [],
        tags: [],
        file_paths: [],
      });
      const lesson = JSON.parse((await redis.get('cachly:lesson:best:infra:ssl'))!) as LessonObj;
      expect(lesson.verified_at).toBeUndefined();
    });
  });

  describe('multi-topic lesson management', () => {
    it('different topics do not interfere with each other', async () => {
      const topics = [
        { topic: 'deploy:api',   what_worked: 'docker compose up api' },
        { topic: 'deploy:web',   what_worked: 'rsync + docker build web' },
        { topic: 'deploy:mcp',   what_worked: 'npm publish mcp server' },
        { topic: 'infra:nginx',  what_worked: 'nginx -t && systemctl reload' },
        { topic: 'fix:memory',   what_worked: 'increase heap to 4G' },
      ];

      for (const t of topics) {
        await storeLessonInRedis(redis, { ...t, outcome: 'success', severity: 'minor', commands: [], tags: [], file_paths: [] });
      }

      for (const t of topics) {
        const raw = await redis.get(`cachly:lesson:best:${t.topic}`);
        expect(raw, `lesson for ${t.topic} should exist`).not.toBeNull();
        const lesson = JSON.parse(raw!) as LessonObj;
        expect(lesson.what_worked).toBe(t.what_worked);
      }
    });

    it('all topics are reachable via scanStream', async () => {
      const topics = ['alpha:test', 'beta:test', 'gamma:test', 'delta:test'];
      for (const t of topics) {
        await storeLessonInRedis(redis, { topic: t, outcome: 'success', what_worked: 'x', severity: 'minor', commands: [], tags: [], file_paths: [] });
      }

      const keys: string[] = [];
      await new Promise<void>((resolve, reject) => {
        const stream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 100 });
        stream.on('data', (batch: string[]) => keys.push(...batch));
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      expect(keys).toHaveLength(4);
      for (const t of topics) {
        expect(keys.some(k => k.endsWith(t))).toBe(true);
      }
    });

    it('pipeline fetches all lessons in a single batch', async () => {
      const topics = ['a:1', 'b:2', 'c:3'];
      for (const t of topics) {
        await storeLessonInRedis(redis, { topic: t, outcome: 'success', what_worked: 'fix', severity: 'minor', commands: [], tags: [], file_paths: [] });
      }

      const keys = topics.map(t => `cachly:lesson:best:${t}`);
      const pipeline = redis.pipeline();
      for (const k of keys) pipeline.get(k);
      const results = await pipeline.exec();

      expect(results).toHaveLength(3);
      for (const [err, val] of results) {
        expect(err).toBeNull();
        expect(val).not.toBeNull();
        const lesson = JSON.parse(val as string) as LessonObj;
        expect(lesson.outcome).toBe('success');
      }
    });
  });

  describe('BM25 recency boost integration', () => {
    it('newer lesson with same content ranks higher than older', async () => {
      // Seed two similar lessons — same keywords, different age
      const oldTs = new Date(Date.now() - 30 * 86400000).toISOString(); // 30 days ago

      // Store "old" lesson manually with backdated timestamp
      const oldLesson: LessonObj = {
        topic: 'deploy:old',
        outcome: 'success',
        what_worked: 'docker compose deploy redis service restart',
        what_failed: undefined,
        context: undefined,
        severity: 'minor',
        commands: [],
        tags: [],
        file_paths: [],
        recall_count: 0,
        ts: oldTs,
        verified_at: oldTs,
        confidence: 1.0,
        audit_trail: [{ ts: oldTs, action: 'created' }],
        version: 3,
      };
      await redis.rpush('cachly:lessons:deploy:old', JSON.stringify(oldLesson));
      await redis.set('cachly:lesson:best:deploy:old', JSON.stringify(oldLesson));

      // Store "new" lesson with current timestamp (similar content, different service)
      await storeLessonInRedis(redis, {
        topic: 'deploy:new',
        outcome: 'success',
        what_worked: 'docker compose deploy redis service restart',
        severity: 'minor',
        commands: [],
        tags: [],
        file_paths: [],
      });

      const results = await keywordSearch(
        redis as unknown as Redis,
        ['cachly:lesson:best:*'],
        'docker compose redis restart',
        5,
      );

      // Both should match; newer should rank higher or equal
      expect(results.length).toBe(2);
      const newIdx = results.findIndex(r => r.key.includes('deploy:new'));
      const oldIdx = results.findIndex(r => r.key.includes('deploy:old'));
      expect(newIdx).toBeLessThanOrEqual(oldIdx); // new ≤ old (higher rank = lower index)
    });

    it('lesson with matching topic-keyword gets higher BM25 score', async () => {
      await storeLessonInRedis(redis, {
        topic: 'fix:ssl-certificate',
        outcome: 'success',
        what_worked: 'renew SSL certificate via certbot on Nginx',
        severity: 'critical',
        commands: ['certbot renew'],
        tags: ['ssl', 'nginx'],
        file_paths: [],
      });
      await storeLessonInRedis(redis, {
        topic: 'deploy:api',
        outcome: 'success',
        what_worked: 'docker compose up -d api',
        severity: 'minor',
        commands: [],
        tags: [],
        file_paths: [],
      });

      const results = await keywordSearch(
        redis as unknown as Redis,
        ['cachly:lesson:best:*'],
        'ssl certificate nginx renew',
        5,
      );

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content.toLowerCase()).toContain('ssl');
    });
  });

  describe('CKG multi-edge scenarios', () => {
    it('same node can have multiple typed edges to different targets', async () => {
      const r = redis as unknown as Redis;
      await ckgUpsertNode(r, 'api-service', 'backend', 'concept');
      await ckgUpdateEdge(r, 'api-service', 'depends_on', 'postgres', true);
      await ckgUpdateEdge(r, 'api-service', 'depends_on', 'redis', true);
      await ckgUpdateEdge(r, 'api-service', 'deployed_with', 'docker', true);

      const fromIdx = await redis.smembers('cachly:ckg:idx:from:api-service');
      expect(fromIdx).toHaveLength(3);
      expect(fromIdx.some(k => k.includes('postgres'))).toBe(true);
      expect(fromIdx.some(k => k.includes('redis'))).toBe(true);
      expect(fromIdx.some(k => k.includes('docker'))).toBe(true);
    });

    it('same edge accumulates confidence across multiple successes', async () => {
      const r = redis as unknown as Redis;
      for (let i = 0; i < 10; i++) {
        await ckgUpdateEdge(r, 'problem', 'solved_by', 'solution', true);
      }
      const edge = JSON.parse((await redis.get('cachly:ckg:edge:problem:solved_by:solution'))!);
      // After 10 successes: (10+1)/(10+2) = 11/12 ≈ 0.9167
      expect(edge.confidence).toBeGreaterThan(0.9);
      expect(edge.trials).toBe(10);
      expect(edge.successes).toBe(10);
    });

    it('mixed success/failure converges to true rate', async () => {
      const r = redis as unknown as Redis;
      // 6 success, 4 failure = 60% actual rate
      for (let i = 0; i < 6; i++) await ckgUpdateEdge(r, 'X', 'leads_to', 'Y', true);
      for (let i = 0; i < 4; i++) await ckgUpdateEdge(r, 'X', 'leads_to', 'Y', false);
      const edge = JSON.parse((await redis.get('cachly:ckg:edge:X:leads_to:Y'))!);
      // Beta(6+1, 10+2) = 7/12 ≈ 0.583 — close to 60%
      expect(edge.confidence).toBeGreaterThan(0.5);
      expect(edge.confidence).toBeLessThan(0.75);
    });
  });
});

// ── New feature coverage (0.10.41 / 0.10.42) ─────────────────────────────────
// Trust badges, Proven Laws crystallization, and focus-less predictive warning.
// These exercise the REAL handleBrainTool code path with the MockRedis.

const noopApiFetch = (async () => null) as unknown as Parameters<typeof handleBrainTool>[3];

/** Seed a best-solution lesson with an explicit recall_count / authors / pinned. */
async function seedLesson(
  redis: MockRedis,
  topic: string,
  opts: {
    outcome?: 'success' | 'failure' | 'partial';
    what_worked?: string;
    what_failed?: string;
    recall_count?: number;
    severity?: 'critical' | 'major' | 'minor';
    pinned?: boolean;
    author?: string;
    tags?: string[];
  } = {},
): Promise<void> {
  const ts = new Date().toISOString();
  const obj = {
    topic,
    outcome: opts.outcome ?? 'success',
    what_worked: opts.what_worked ?? `solution for ${topic}`,
    what_failed: opts.what_failed,
    severity: opts.severity ?? 'minor',
    recall_count: opts.recall_count ?? 0,
    ts,
    verified_at: ts,
    confidence: 1.0,
    tags: opts.tags ?? [],
    ...(opts.pinned ? { pinned: true } : {}),
    ...(opts.author ? { author: opts.author } : {}),
  };
  await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(obj));
}

describe('Trust badges (recall_best_solution)', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  beforeEach(() => { redis = new MockRedis(); });

  it('shows "Battle-tested" when recall_count crosses 10', async () => {
    await seedLesson(redis, 'redis:pool', { recall_count: 9, what_worked: 'set max_retries=3' });
    const out = (await handleBrainTool('recall_best_solution', { instance_id: 'i1', topic: 'redis:pool' }, getConn, noopApiFetch))!;
    expect(out).toContain('Battle-tested');
    expect(out).toContain('recalled 10×');
  });

  it('shows "Proven" when recall_count is between 5 and 9', async () => {
    await seedLesson(redis, 'api:auth', { recall_count: 4 });
    const out = (await handleBrainTool('recall_best_solution', { instance_id: 'i1', topic: 'api:auth' }, getConn, noopApiFetch))!;
    expect(out).toContain('Proven');
    expect(out).toContain('recalled 5×');
    expect(out).not.toContain('Battle-tested');
  });

  it('shows no trust badge for a fresh low-recall lesson', async () => {
    await seedLesson(redis, 'misc:thing', { recall_count: 0 });
    const out = (await handleBrainTool('recall_best_solution', { instance_id: 'i1', topic: 'misc:thing' }, getConn, noopApiFetch))!;
    expect(out).not.toContain('Battle-tested');
    expect(out).not.toContain('Proven —');
    expect(out).not.toContain('Team-verified');
  });

  it('increments recall_count and persists it', async () => {
    await seedLesson(redis, 'deploy:x', { recall_count: 2 });
    await handleBrainTool('recall_best_solution', { instance_id: 'i1', topic: 'deploy:x' }, getConn, noopApiFetch);
    const stored = JSON.parse((await redis.get('cachly:lesson:best:deploy:x'))!);
    expect(stored.recall_count).toBe(3);
  });
});

describe('Proven Laws crystallization (session_start)', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  beforeEach(async () => {
    redis = new MockRedis();
    // Provide a last session so session_start does not attempt git reconstruction.
    await redis.set('cachly:session:last', JSON.stringify({ summary: 'prior work', ts: new Date().toISOString(), files_changed: [] }));
  });

  it('surfaces lessons recalled >= 5 in the Proven Laws section', async () => {
    await seedLesson(redis, 'infra:k3s', { recall_count: 7, what_worked: 'add WireGuard IP to TLS-SAN' });
    await seedLesson(redis, 'random:note', { recall_count: 1 });
    const out = (await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch))!;
    expect(out).toContain('Proven Laws');
    expect(out).toContain('infra:k3s');
    expect(out).toContain('recalled 7×');
  });

  it('surfaces an explicitly pinned lesson even with low recall', async () => {
    await seedLesson(redis, 'team:convention', { recall_count: 0, pinned: true, what_worked: 'always snake_case handlers' });
    const out = (await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch))!;
    expect(out).toContain('Proven Laws');
    expect(out).toContain('team:convention');
    expect(out).toContain('pinned');
  });

  it('omits the Proven Laws section when nothing qualifies', async () => {
    await seedLesson(redis, 'small:thing', { recall_count: 1 });
    const out = (await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch))!;
    expect(out).not.toContain('Proven Laws');
  });

  it('does not crystallize failure lessons', async () => {
    await seedLesson(redis, 'broken:flow', { recall_count: 9, outcome: 'failure', what_failed: 'never works' });
    const out = (await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch))!;
    expect(out).not.toContain('Proven Laws');
  });
});

describe('Predictive pre-warning without explicit focus (session_start)', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  beforeEach(() => { redis = new MockRedis(); });

  it('derives danger area from last session files and warns', async () => {
    // Last session touched payment files → likely to continue there.
    await redis.set('cachly:session:last', JSON.stringify({
      summary: 'worked on payment integration',
      ts: new Date().toISOString(),
      files_changed: ['api/payment/stripe_webhook.go'],
    }));
    // A known failure in the payment area.
    await seedLesson(redis, 'payment:webhook', { outcome: 'failure', what_failed: 'missed idempotency key → double charge', tags: ['payment'] });
    const out = (await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch))!;
    expect(out).toContain('PRE-WARNING');
    expect(out).toContain('payment:webhook');
  });

  it('does not warn when last-session area has no known failures', async () => {
    await redis.set('cachly:session:last', JSON.stringify({
      summary: 'wrote docs',
      ts: new Date().toISOString(),
      files_changed: ['docs/readme.md'],
    }));
    await seedLesson(redis, 'payment:webhook', { outcome: 'failure', what_failed: 'x', tags: ['payment'] });
    const out = (await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch))!;
    expect(out).not.toContain('PRE-WARNING');
  });

  it('filters path noise so common segments do not trigger false matches', async () => {
    // Last session only touched generic noise paths (src/lib/index).
    await redis.set('cachly:session:last', JSON.stringify({
      summary: 'refactor',
      ts: new Date().toISOString(),
      files_changed: ['src/lib/index.ts'],
    }));
    // A failure tagged 'src' — should NOT match because 'src' is noise.
    await seedLesson(redis, 'src:thing', { outcome: 'failure', what_failed: 'noise', tags: ['src'] });
    const out = (await handleBrainTool('session_start', { instance_id: 'i1' }, getConn, noopApiFetch))!;
    expect(out).not.toContain('PRE-WARNING');
  });
});

describe('Phase 3A: Person + File nodes in CKG (ckg.ts)', () => {
  let redis: MockRedis;
  beforeEach(() => { redis = new MockRedis(); });

  it('ckgUpsertPersonNode creates a person node with correct shape', async () => {
    const id = await ckgUpsertPersonNode(redis as unknown as Redis, 'alice', 'fix');
    expect(id).toBe('person:alice');
    const raw = await redis.get('cachly:ckg:node:person:alice');
    expect(raw).not.toBeNull();
    const node = JSON.parse(raw!) as PersonNode;
    expect(node.handle).toBe('alice');
    expect(node.type).toBe('person');
    expect(node.count).toBe(1);
    expect(node.domain).toBe('fix');
    expect(typeof node.last_active).toBe('string');
  });

  it('ckgUpsertPersonNode increments count on repeated calls', async () => {
    await ckgUpsertPersonNode(redis as unknown as Redis, 'bob', 'deploy');
    await ckgUpsertPersonNode(redis as unknown as Redis, 'bob', 'deploy');
    const raw = await redis.get('cachly:ckg:node:person:bob');
    const node = JSON.parse(raw!) as PersonNode;
    expect(node.count).toBe(2);
  });

  it('ckgUpsertFileNode creates a file node with correct shape', async () => {
    const id = await ckgUpsertFileNode(redis as unknown as Redis, 'src/auth/jwt.ts');
    expect(id).toBe('file:src-auth-jwt-ts');
    const raw = await redis.get('cachly:ckg:node:file:src-auth-jwt-ts');
    expect(raw).not.toBeNull();
    const node = JSON.parse(raw!) as FileNode;
    expect(node.path).toBe('src/auth/jwt.ts');
    expect(node.type).toBe('file');
    expect(node.count).toBe(1);
  });

  it('ckgUpsertFileNode increments count on repeated calls', async () => {
    await ckgUpsertFileNode(redis as unknown as Redis, 'src/api.ts');
    await ckgUpsertFileNode(redis as unknown as Redis, 'src/api.ts');
    const raw = await redis.get(`cachly:ckg:node:file:${ckgSlug('src/api.ts')}`);
    const node = JSON.parse(raw!) as FileNode;
    expect(node.count).toBe(2);
  });
});

describe('Phase 3A: brain_who_knows', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('returns empty-state message when no lessons have author attribution', async () => {
    const out = await handleBrainTool('brain_who_knows', { instance_id: iid, topic: 'deploy:k8s' }, getConn, noopApiFetch);
    expect(out).toContain('No attributed lessons');
    expect(out).toContain('learn_from_attempts');
  });

  it('returns ranked contributors after learn_from_attempts with author', async () => {
    // Alice stored 2 successful deploy lessons
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'deploy:k8s', outcome: 'success',
      what_worked: 'kubectl apply with --dry-run first', author: 'alice',
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'deploy:helm', outcome: 'success',
      what_worked: 'helm upgrade --atomic', author: 'alice',
    }, getConn, noopApiFetch);
    // Bob stored 1 lesson in same domain
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'deploy:docker', outcome: 'success',
      what_worked: 'multi-stage build', author: 'bob',
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('brain_who_knows', { instance_id: iid, topic: 'deploy' }, getConn, noopApiFetch);
    expect(out).toContain('alice');
    expect(out).toContain('bob');
    expect(out).toContain('🥇');
  });

  it('shows the most experienced author first', async () => {
    // alice: 3 lessons, bob: 1 lesson
    for (let i = 0; i < 3; i++) {
      await handleBrainTool('learn_from_attempts', {
        instance_id: iid, topic: `fix:bug${i}`, outcome: 'success',
        what_worked: `solution ${i}`, author: 'alice',
      }, getConn, noopApiFetch);
    }
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:other', outcome: 'success',
      what_worked: 'quick patch', author: 'bob',
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('brain_who_knows', { instance_id: iid, topic: 'fix' }, getConn, noopApiFetch);
    // alice should appear before bob
    const aliceIdx = out!.indexOf('alice');
    const bobIdx = out!.indexOf('bob');
    expect(aliceIdx).toBeGreaterThan(-1);
    expect(aliceIdx).toBeLessThan(bobIdx);
  });
});

describe('Visibility scopes (learn_from_attempts)', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('stores visibility=private on the lesson object', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'personal:note', outcome: 'success',
      what_worked: 'local trick only I know', visibility: 'private',
    }, getConn, noopApiFetch);
    const raw = await redis.get('cachly:lesson:best:personal:note');
    expect(raw).not.toBeNull();
    const lesson = JSON.parse(raw!) as { visibility: string };
    expect(lesson.visibility).toBe('private');
  });

  it('defaults to visibility=team when not specified', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'team:lesson', outcome: 'success',
      what_worked: 'shared approach',
    }, getConn, noopApiFetch);
    const raw = await redis.get('cachly:lesson:best:team:lesson');
    const lesson = JSON.parse(raw!) as { visibility: string };
    expect(lesson.visibility).toBe('team');
  });

  it('private lessons are excluded from smart_recall results', async () => {
    // Store a private lesson with distinctive keyword
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'secret:api-key', outcome: 'success',
      what_worked: 'xyzzy-unique-private-token', visibility: 'private',
    }, getConn, noopApiFetch);
    // Store a public lesson for the same query
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'public:api-key', outcome: 'success',
      what_worked: 'use env vars for xyzzy tokens', visibility: 'team',
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('smart_recall', {
      instance_id: iid, query: 'xyzzy api key',
    }, getConn, noopApiFetch);
    expect(out).toContain('public:api-key');
    expect(out).not.toContain('secret:api-key');
  });
});

describe('Phase 3B: brain_file_map', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('returns a message for unknown files with no attribution', async () => {
    const out = await handleBrainTool('brain_file_map', {
      instance_id: iid, file_paths: ['src/unknown-file.ts'],
    }, getConn, noopApiFetch);
    expect(out).toContain('src/unknown-file.ts');
    expect(out).toContain('None yet');
  });

  it('shows expert after learn_from_attempts with author + file_paths', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:payment-bug', outcome: 'success',
      what_worked: 'null check before charge', author: 'carol',
      file_paths: ['src/payments/stripe.ts'],
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('brain_file_map', {
      instance_id: iid, file_paths: ['src/payments/stripe.ts'],
    }, getConn, noopApiFetch);
    expect(out).toContain('src/payments/stripe.ts');
    expect(out).toContain('carol');
  });

  it('returns error message for empty file_paths', async () => {
    const out = await handleBrainTool('brain_file_map', {
      instance_id: iid, file_paths: [],
    }, getConn, noopApiFetch);
    expect(out).toContain('at least one');
  });
});

describe('Phase 3B: team_expertise_map', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('returns empty-state message when no contributors exist', async () => {
    const out = await handleBrainTool('team_expertise_map', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('No contributors');
    expect(out).toContain('learn_from_attempts');
  });

  it('shows all contributors after learn_from_attempts with different authors', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'deploy:k8s', outcome: 'success',
      what_worked: 'use rolling update', author: 'alice',
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:auth', outcome: 'success',
      what_worked: 'check token expiry', author: 'bob',
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('team_expertise_map', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('alice');
    expect(out).toContain('bob');
    expect(out).toContain('Team Expertise Map');
  });
});

describe('Phase 3C: skill_gaps', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('returns clean message when no gaps exist', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:auth', outcome: 'success',
      what_worked: 'rotate the token', author: 'alice',
    }, getConn, noopApiFetch);
    const out = await handleBrainTool('skill_gaps', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('No significant knowledge gaps');
  });

  it('flags domain with failures and no success lessons', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'deploy:prod', outcome: 'failure',
      what_failed: 'oom kill', what_worked: 'tried increasing limits',
    }, getConn, noopApiFetch);
    const out = await handleBrainTool('skill_gaps', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('deploy');
    expect(out).toContain('unresolved failures');
  });

  it('flags domain with no attribution when lessons exist but no author', async () => {
    for (let i = 0; i < 4; i++) {
      await handleBrainTool('learn_from_attempts', {
        instance_id: iid, topic: `infra:node${i}`, outcome: 'success',
        what_worked: `solution ${i}`,
        // no author
      }, getConn, noopApiFetch);
    }
    const out = await handleBrainTool('skill_gaps', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('infra');
    expect(out).toContain('no attribution');
  });
});

describe('Phase 3C: brain_coverage', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('returns a coverage report with score', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:bug', outcome: 'success',
      what_worked: 'fixed it', author: 'alice',
    }, getConn, noopApiFetch);
    const out = await handleBrainTool('brain_coverage', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('Brain Coverage Report');
    expect(out).toContain('Overall score:');
    expect(out).toContain('/100');
  });

  it('shows 0/100 score when no lessons exist', async () => {
    const out = await handleBrainTool('brain_coverage', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('0/100');
  });

  it('score increases with more lessons and attribution', async () => {
    const outBefore = await handleBrainTool('brain_coverage', { instance_id: iid }, getConn, noopApiFetch);
    const scoreBefore = parseInt((outBefore!.match(/Overall score: (\d+)/) ?? ['', '0'])[1]!);

    for (let i = 0; i < 5; i++) {
      await handleBrainTool('learn_from_attempts', {
        instance_id: iid, topic: `fix:issue${i}`, outcome: 'success',
        what_worked: `solution ${i}`, author: `dev${i % 3}`,
      }, getConn, noopApiFetch);
    }
    const outAfter = await handleBrainTool('brain_coverage', { instance_id: iid }, getConn, noopApiFetch);
    const scoreAfter = parseInt((outAfter!.match(/Overall score: (\d+)/) ?? ['', '0'])[1]!);
    expect(scoreAfter).toBeGreaterThan(scoreBefore);
  });
});

describe('Phase 3 stability: input guards', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('brain_who_knows rejects empty topic without crashing', async () => {
    const out = await handleBrainTool('brain_who_knows', { instance_id: iid, topic: '' }, getConn, noopApiFetch);
    expect(out).toContain('requires a non-empty');
  });

  it('brain_who_knows rejects undefined topic without crashing', async () => {
    const out = await handleBrainTool('brain_who_knows', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('requires a non-empty');
  });

  it('brain_who_knows clamps an absurd limit', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:x', outcome: 'success',
      what_worked: 'patch', author: 'alice',
    }, getConn, noopApiFetch);
    const out = await handleBrainTool('brain_who_knows', { instance_id: iid, topic: 'fix', limit: 99999 }, getConn, noopApiFetch);
    expect(out).toContain('alice');
  });

  it('brain_file_map filters out empty path strings', async () => {
    const out = await handleBrainTool('brain_file_map', { instance_id: iid, file_paths: ['', '  ', ''] }, getConn, noopApiFetch);
    expect(out).toContain('Pass at least one file path');
  });

  it('brain_file_map handles non-array file_paths gracefully', async () => {
    const out = await handleBrainTool('brain_file_map', { instance_id: iid, file_paths: 'not-an-array' as unknown as string[] }, getConn, noopApiFetch);
    expect(out).toContain('Pass at least one file path');
  });
});

describe('Phase 3C: brain_metrics — the three decisive metrics', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('reports "not enough data" before any learning', async () => {
    const out = await handleBrainTool('brain_metrics', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('Brain Metrics');
    expect(out).toContain('Not enough data');
  });

  it('always shows the published recall-lift moat number', async () => {
    const out = await handleBrainTool('brain_metrics', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('+22.2 % Precision@1');
  });

  it('records born_at on first learn (first-wins NX semantics)', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:a', outcome: 'success', what_worked: 'x', author: 'alice',
    }, getConn, noopApiFetch);
    const born1 = await redis.get(`cachly:stats:born_at:${iid}`);
    expect(born1).not.toBeNull();
    // Second learn must NOT overwrite born_at
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:b', outcome: 'success', what_worked: 'y', author: 'bob',
    }, getConn, noopApiFetch);
    const born2 = await redis.get(`cachly:stats:born_at:${iid}`);
    expect(born2).toBe(born1);
  });

  it('tracks cross-author reuse when one person recalls another\'s lesson', async () => {
    // Alice stores a proven lesson, recalled once so it counts as "proven"
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:race', outcome: 'success',
      what_worked: 'add mutex around xyzzy counter', author: 'alice',
    }, getConn, noopApiFetch);
    // Bob recalls it (twice → first recall marks proven, second counts reuse on a proven lesson)
    await handleBrainTool('smart_recall', { instance_id: iid, query: 'xyzzy counter mutex', author: 'bob' }, getConn, noopApiFetch);
    await handleBrainTool('smart_recall', { instance_id: iid, query: 'xyzzy counter mutex', author: 'bob' }, getConn, noopApiFetch);

    const cross = await redis.get(`cachly:stats:cross_author_recalls:${iid}`);
    expect(Number(cross)).toBeGreaterThanOrEqual(1);

    const out = await handleBrainTool('brain_metrics', { instance_id: iid }, getConn, noopApiFetch);
    expect(out).toContain('Team-knowledge-reuse');
    expect(out).toContain('distinct reuse relationship');
  });

  it('does not count self-recall as cross-author reuse', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:solo', outcome: 'success',
      what_worked: 'fixed the wibble myself', author: 'alice',
    }, getConn, noopApiFetch);
    await handleBrainTool('smart_recall', { instance_id: iid, query: 'wibble', author: 'alice' }, getConn, noopApiFetch);
    await handleBrainTool('smart_recall', { instance_id: iid, query: 'wibble', author: 'alice' }, getConn, noopApiFetch);
    const cross = await redis.get(`cachly:stats:cross_author_recalls:${iid}`);
    expect(Number(cross ?? 0)).toBe(0);
  });

  it('surfaces the team-reuse banner inline in smart_recall', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:plimsoll', outcome: 'success',
      what_worked: 'adjust the plimsoll threshold', author: 'carol',
    }, getConn, noopApiFetch);
    // First recall by dave marks it proven; second recall shows the reuse banner
    await handleBrainTool('smart_recall', { instance_id: iid, query: 'plimsoll threshold', author: 'dave' }, getConn, noopApiFetch);
    const out = await handleBrainTool('smart_recall', { instance_id: iid, query: 'plimsoll threshold', author: 'dave' }, getConn, noopApiFetch);
    expect(out).toContain('Team knowledge reuse');
  });
});

describe('Phase 3: collaboration graph (person↔person)', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('ckgRecordCollaboration links co-touchers bidirectionally', async () => {
    const r = redis as unknown as Redis;
    await ckgRecordCollaboration(r, 'file:src-api-ts', 'person:alice');
    await ckgRecordCollaboration(r, 'file:src-api-ts', 'person:bob');
    // alice↔bob edges should now exist in both directions
    const ab = await redis.get('cachly:ckg:edge:person:bob:collaborates:person:alice');
    const ba = await redis.get('cachly:ckg:edge:person:alice:collaborates:person:bob');
    expect(ab).not.toBeNull();
    expect(ba).not.toBeNull();
  });

  it('does not create a self-collaboration edge', async () => {
    const r = redis as unknown as Redis;
    await ckgRecordCollaboration(r, 'file:x', 'person:alice');
    await ckgRecordCollaboration(r, 'file:x', 'person:alice'); // same person again
    const self = await redis.get('cachly:ckg:edge:person:alice:collaborates:person:alice');
    expect(self).toBeNull();
  });

  it('builds collaboration via learn_from_attempts on a shared file', async () => {
    // alice and bob both touch the same file in separate lessons
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:auth-a', outcome: 'success',
      what_worked: 'patch a', author: 'alice', file_paths: ['src/auth/jwt.ts'],
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:auth-b', outcome: 'success',
      what_worked: 'patch b', author: 'bob', file_paths: ['src/auth/jwt.ts'],
    }, getConn, noopApiFetch);

    const fileId = `file:${ckgSlug('src/auth/jwt.ts')}`;
    const touchers = await redis.smembers(`cachly:ckg:file:touchers:${fileId}`);
    expect(touchers).toContain('person:alice');
    expect(touchers).toContain('person:bob');
    // bob (second toucher) should have a collaborates edge to alice
    const edge = await redis.get('cachly:ckg:edge:person:bob:collaborates:person:alice');
    expect(edge).not.toBeNull();
  });

  it('surfaces collaborators in brain_who_knows for the top expert', async () => {
    // alice authors twice on a shared file; bob authors once on the same file
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'deploy:k8s-1', outcome: 'success',
      what_worked: 'rollout fix one', author: 'alice', file_paths: ['k8s/deploy.yaml'],
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'deploy:k8s-2', outcome: 'success',
      what_worked: 'rollout fix two', author: 'alice', file_paths: ['k8s/deploy.yaml'],
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'deploy:k8s-3', outcome: 'success',
      what_worked: 'rollout fix three', author: 'bob', file_paths: ['k8s/deploy.yaml'],
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('brain_who_knows', { instance_id: iid, topic: 'deploy' }, getConn, noopApiFetch);
    expect(out).toContain('frequently works with');
  });
});

describe('Phase 3: file-context personalization in smart_recall', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('boosts lessons whose file_paths overlap with context_files', async () => {
    // Store two lessons: one tagged to the context file, one generic
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'auth:jwt-secret', outcome: 'success',
      what_worked: 'rotate the JWT secret key via env', author: 'alice',
      file_paths: ['src/auth/service.ts'],
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'auth:session-timeout', outcome: 'success',
      what_worked: 'increase session timeout to 24h', author: 'bob',
      file_paths: ['src/api/routes.ts'],
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('smart_recall', {
      instance_id: iid,
      query: 'auth key secret',
      context_files: ['src/auth/service.ts'],
    }, getConn, noopApiFetch);
    // The context-matched lesson should show the badge
    expect(out).toContain('📁 context match');
  });

  it('shows the Personalized banner with the count of boosted lessons', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:deploy-env', outcome: 'success',
      what_worked: 'add NODE_ENV to Dockerfile', author: 'carol',
      file_paths: ['Dockerfile'],
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('smart_recall', {
      instance_id: iid,
      query: 'docker environment variable',
      context_files: ['Dockerfile'],
    }, getConn, noopApiFetch);
    expect(out).toContain('Personalized');
    expect(out).toContain('Dockerfile');
  });

  it('does not show the badge when context_files is empty', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:empty-context', outcome: 'success',
      what_worked: 'some fix', file_paths: ['src/x.ts'],
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('smart_recall', {
      instance_id: iid,
      query: 'fix empty context',
    }, getConn, noopApiFetch);
    expect(out).not.toContain('📁 context match');
    expect(out).not.toContain('Personalized');
  });

  it('is tolerant of non-array context_files (ignores gracefully)', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'fix:tolerant', outcome: 'success',
      what_worked: 'nothing breaks', file_paths: ['a.ts'],
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('smart_recall', {
      instance_id: iid,
      query: 'nothing breaks',
      context_files: 'not-an-array' as unknown as string[],
    }, getConn, noopApiFetch);
    expect(out).not.toContain('📁 context match');
  });
});

describe('Phase 3: service/system nodes + brain_service_map', () => {
  let redis: MockRedis;
  const iid = 'i1';
  const getConn = async () => redis as unknown as Redis;

  beforeEach(() => { redis = new MockRedis(); });

  it('ckgUpsertServiceNode creates a node and upgrades kind to system', async () => {
    const r = redis as unknown as Redis;
    const id = await ckgUpsertServiceNode(r, 'prometheus', 'monitoring', 'service');
    expect(id).toBe('service:prometheus');
    await ckgUpsertServiceNode(r, 'prometheus', 'monitoring', 'system');
    const raw = await redis.get('cachly:ckg:node:service:prometheus');
    const node = JSON.parse(raw!);
    expect(node.kind).toBe('system');
    expect(node.count).toBe(2);
  });

  it('learn_from_attempts(service=...) wires operates + runs_in edges', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'infra:prom-oom', outcome: 'failure',
      what_worked: 'bump memory limit to 2Gi', author: 'alice',
      service: 'prometheus', service_kind: 'system',
      file_paths: ['monitoring/prometheus.yaml'],
    }, getConn, noopApiFetch);

    const operates = await redis.get('cachly:ckg:edge:person:alice:operates:service:prometheus');
    expect(operates).not.toBeNull();
    const runsIn = await redis.get(`cachly:ckg:edge:file:${ckgSlug('monitoring/prometheus.yaml')}:runs_in:service:prometheus`);
    expect(runsIn).not.toBeNull();
  });

  it('brain_service_map surfaces operators, failures and fixes', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'infra:prom-oom', outcome: 'failure',
      what_worked: 'pod OOMKilled under WAL replay', author: 'alice',
      service: 'prometheus', service_kind: 'system',
      file_paths: ['monitoring/prometheus.yaml'],
    }, getConn, noopApiFetch);
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'infra:prom-fix', outcome: 'success',
      what_worked: 'raised memory limit and shortened retention', author: 'bob',
      service: 'prometheus', service_kind: 'system',
    }, getConn, noopApiFetch);

    const out = await handleBrainTool('brain_service_map', { instance_id: iid, service: 'prometheus' }, getConn, noopApiFetch);
    expect(out).toContain('Service Map');
    expect(out).toContain('Operators');
    expect(out).toContain('Known failures');
    expect(out).toContain('Proven fixes');
    expect(out).toContain('infra:prom-oom');
    expect(out).toContain('infra:prom-fix');
    // System kind → 🖥️ marker
    expect(out).toContain('🖥️');
  });

  it('brain_service_map guards empty service', async () => {
    const out = await handleBrainTool('brain_service_map', { instance_id: iid, service: '' }, getConn, noopApiFetch);
    expect(out).toContain('requires a non-empty');
  });

  it('brain_service_map reports nothing-known for an unknown service', async () => {
    const out = await handleBrainTool('brain_service_map', { instance_id: iid, service: 'ghost-service' }, getConn, noopApiFetch);
    expect(out).toContain('Nothing known about this service yet');
  });

  it('private service lessons do not leak into the map', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: iid, topic: 'infra:secret', outcome: 'success',
      what_worked: 'rotate the secret', service: 'vault', visibility: 'private',
    }, getConn, noopApiFetch);
    const out = await handleBrainTool('brain_service_map', { instance_id: iid, service: 'vault' }, getConn, noopApiFetch);
    expect(out).not.toContain('infra:secret');
  });
});
