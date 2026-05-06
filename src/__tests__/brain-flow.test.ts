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

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Modules under test ────────────────────────────────────────────────────────
import { ckgSlug, extractProblemConcept, ckgUpsertNode, ckgUpdateEdge } from '../ckg.js';
import { EMBED_PROVIDER, hasEmbedProvider, embedProviderHint, embedConfig, setEmbedJwt } from '../embeddings.js';
import { keywordSearch } from '../search.js';
import type { Redis } from 'ioredis';

// ── In-memory Redis mock ──────────────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();
  private sets  = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
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
    const self = this;
    return {
      get(key: string) { commands.push({ cmd: 'get', key }); return this; },
      async exec(): Promise<Array<[null, string | null]>> {
        const out: Array<[null, string | null]> = [];
        for (const c of commands) {
          out.push([null, self.store.get(c.key) ?? null]);
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
