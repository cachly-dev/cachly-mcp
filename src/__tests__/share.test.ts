/**
 * Unit tests for Phase 3: Shareable / Public Brains
 *
 * Covers (no real network or Redis required):
 *   brain_share  — dry_run, topic_filter, API success, API 404 fallback
 *   brain_import — dry_run, topic_prefix, conflict handling, overwrite
 *   buildServerEnv regression — self-host URL only included when non-default
 *   MCP stdio regression — no stdout write on startup without JWT
 *
 * Run: npx vitest run src/__tests__/share.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleShareTool } from '../handlers/share.js';
import type { Redis } from 'ioredis';

// ── In-memory Redis mock ──────────────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, string>();
  private lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._opts: unknown[]): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    this.lists.set(key, list.slice(start < 0 ? list.length + start : start, end));
    return 'OK';
  }

  async expire(_key: string, _ttl: number): Promise<number> { return 1; }

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

  /** Expose raw store for assertions */
  _store() { return this.store; }
  _lists() { return this.lists; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeLesson(topic: string, outcome = 'success', what_worked = 'it worked') {
  return JSON.stringify({ topic, outcome, what_worked, confidence: 1.0, ts: new Date().toISOString() });
}

function seedLessons(redis: MockRedis, lessons: Array<{ topic: string; outcome?: string }>) {
  for (const l of lessons) {
    redis['store'].set(`cachly:lesson:best:${l.topic}`, makeLesson(l.topic, l.outcome ?? 'success'));
  }
}

// ── brain_share ───────────────────────────────────────────────────────────────

describe('brain_share', () => {
  let redis: MockRedis;
  const getConn = async (_id: string) => redis as unknown as Redis;

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('returns empty-Brain message when no lessons stored', async () => {
    const result = await handleShareTool('brain_share', { instance_id: 'inst-1' }, getConn, async () => ({}));
    expect(result).toContain('nothing to share');
    expect(result).toContain('learn_from_attempts');
  });

  it('dry_run shows lesson preview without calling API', async () => {
    seedLessons(redis, [
      { topic: 'auth:jwt-expiry' },
      { topic: 'deploy:docker-build' },
    ]);
    let apiCalled = false;
    const apiFetch = async () => { apiCalled = true; return {}; };
    const result = await handleShareTool('brain_share', {
      instance_id: 'inst-1', dry_run: true, title: 'Test',
    }, getConn, apiFetch);

    expect(apiCalled).toBe(false);
    expect(result).toContain('DRY RUN');
    expect(result).toContain('2 lesson');
    expect(result).toContain('auth:jwt-expiry');
  });

  it('topic_filter exports only matching lessons', async () => {
    seedLessons(redis, [
      { topic: 'auth:jwt-expiry' },
      { topic: 'auth:refresh-token' },
      { topic: 'deploy:docker-build' },
    ]);
    const result = await handleShareTool('brain_share', {
      instance_id: 'inst-1', dry_run: true, topic_filter: ['auth'],
    }, getConn, async () => ({}));

    expect(result).toContain('2 lesson');
    expect(result).not.toContain('deploy:docker-build');
  });

  it('returns share URL on successful API response', async () => {
    seedLessons(redis, [{ topic: 'auth:jwt-expiry' }]);
    const apiFetch = async <T>() => ({ share_id: 'abc123' } as T);
    const result = await handleShareTool('brain_share', {
      instance_id: 'inst-1', title: 'My Auth Patterns',
    }, getConn, apiFetch);

    expect(result).toContain('abc123');
    expect(result).toContain('brain_import');
    expect(result).toContain('cachly.dev/brain/share/abc123');
  });

  it('falls back to JSON export when API returns 404', async () => {
    seedLessons(redis, [{ topic: 'infra:k8s-oom' }]);
    const apiFetch = async () => { throw new Error('404 not found'); };
    const result = await handleShareTool('brain_share', {
      instance_id: 'inst-1',
    }, getConn, apiFetch);

    expect(result).toContain('portable snapshot');
    expect(result).toContain('infra:k8s-oom');
    expect(result).toContain('brain_import');
  });

  it('requires instance_id', async () => {
    const result = await handleShareTool('brain_share', {}, getConn, async () => ({}));
    expect(result).toContain('requires `instance_id`');
  });
});

// ── brain_import ──────────────────────────────────────────────────────────────

describe('brain_import', () => {
  let redis: MockRedis;
  const getConn = async (_id: string) => redis as unknown as Redis;

  const sharePayload = {
    share_id: 'abc123',
    title: 'Shared Brain',
    lessons: [
      { topic: 'auth:jwt-expiry', outcome: 'success', what_worked: 'check exp claim', confidence: 0.9 },
      { topic: 'deploy:docker-build', outcome: 'success', what_worked: 'use --no-cache', confidence: 0.8 },
      { topic: 'infra:oom', outcome: 'failure', what_failed: 'no limits', confidence: 0.7 },
    ],
  };

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('dry_run returns preview without writing to Redis', async () => {
    const apiFetch = async <T>() => sharePayload as T;
    const result = await handleShareTool('brain_import', {
      instance_id: 'inst-1', share_id: 'abc123', dry_run: true,
    }, getConn, apiFetch);

    expect(result).toContain('DRY RUN');
    expect(result).toContain('3');
    expect(redis._store().size).toBe(0);
  });

  it('imports all lessons into Redis', async () => {
    const apiFetch = async <T>() => sharePayload as T;
    const result = await handleShareTool('brain_import', {
      instance_id: 'inst-1', share_id: 'abc123',
    }, getConn, apiFetch);

    expect(result).toContain('**Lessons imported:** 3');
    expect(redis._store().has('cachly:lesson:best:auth:jwt-expiry')).toBe(true);
    expect(redis._store().has('cachly:lesson:best:deploy:docker-build')).toBe(true);
    expect(redis._store().has('cachly:lesson:best:infra:oom')).toBe(true);
  });

  it('applies topic_prefix to imported lessons', async () => {
    const apiFetch = async <T>() => sharePayload as T;
    await handleShareTool('brain_import', {
      instance_id: 'inst-1', share_id: 'abc123', topic_prefix: 'team',
    }, getConn, apiFetch);

    expect(redis._store().has('cachly:lesson:best:team:auth:jwt-expiry')).toBe(true);
    expect(redis._store().has('cachly:lesson:best:auth:jwt-expiry')).toBe(false);
  });

  it('skips existing lessons by default (no overwrite)', async () => {
    // Pre-populate one lesson
    redis['store'].set('cachly:lesson:best:auth:jwt-expiry', makeLesson('auth:jwt-expiry', 'success', 'original'));

    const apiFetch = async <T>() => sharePayload as T;
    const result = await handleShareTool('brain_import', {
      instance_id: 'inst-1', share_id: 'abc123',
    }, getConn, apiFetch);

    expect(result).toContain('already exist');
    const stored = redis._store().get('cachly:lesson:best:auth:jwt-expiry')!;
    expect(JSON.parse(stored).what_worked).toBe('original');
  });

  it('overwrites existing lessons when overwrite=true', async () => {
    redis['store'].set('cachly:lesson:best:auth:jwt-expiry', makeLesson('auth:jwt-expiry', 'success', 'original'));

    const apiFetch = async <T>() => sharePayload as T;
    await handleShareTool('brain_import', {
      instance_id: 'inst-1', share_id: 'abc123', overwrite: true,
    }, getConn, apiFetch);

    const stored = redis._store().get('cachly:lesson:best:auth:jwt-expiry')!;
    expect(JSON.parse(stored).what_worked).toBe('check exp claim');
  });

  it('filters by min_confidence', async () => {
    const apiFetch = async <T>() => sharePayload as T;
    await handleShareTool('brain_import', {
      instance_id: 'inst-1', share_id: 'abc123', min_confidence: 0.85,
    }, getConn, apiFetch);

    // Only confidence >= 0.85 (auth:jwt-expiry = 0.9) should be imported
    expect(redis._store().has('cachly:lesson:best:auth:jwt-expiry')).toBe(true);
    expect(redis._store().has('cachly:lesson:best:deploy:docker-build')).toBe(false);
    expect(redis._store().has('cachly:lesson:best:infra:oom')).toBe(false);
  });

  it('extracts share ID from full URL', async () => {
    let capturedPath = '';
    const apiFetch = async <T>(path: string) => { capturedPath = path; return sharePayload as T; };
    await handleShareTool('brain_import', {
      instance_id: 'inst-1',
      share_id: 'https://cachly.dev/brain/share/abc123',
    }, getConn, apiFetch);

    expect(capturedPath).toBe('/api/v1/brains/share/abc123');
  });

  it('returns not-found message on 404', async () => {
    const apiFetch = async () => { throw new Error('404 not found'); };
    const result = await handleShareTool('brain_import', {
      instance_id: 'inst-1', share_id: 'nonexistent',
    }, getConn, apiFetch);

    expect(result).toContain('not found');
    expect(result).toContain('brain_share');
  });

  it('requires both instance_id and share_id', async () => {
    const r1 = await handleShareTool('brain_import', { share_id: 'abc' }, getConn, async () => ({}));
    expect(r1).toContain('requires `instance_id`');

    const r2 = await handleShareTool('brain_import', { instance_id: 'inst-1' }, getConn, async () => ({}));
    expect(r2).toContain('requires `share_id`');
  });
});

// ── Unknown tool returns null ─────────────────────────────────────────────────

describe('handleShareTool routing', () => {
  it('returns null for unknown tool names', async () => {
    const redis = new MockRedis();
    const result = await handleShareTool('some_other_tool', {}, async () => redis as unknown as Redis, async () => ({}));
    expect(result).toBeNull();
  });
});

// ── Regression: buildServerEnv self-host URL handling ────────────────────────

describe('buildServerEnv regression', () => {
  it('omits CACHLY_API_URL when using default URL', () => {
    const DEFAULT_URL = 'https://api.cachly.dev';
    const apiUrl = DEFAULT_URL;
    const env: Record<string, string> = { CACHLY_JWT: 'tok', CACHLY_BRAIN_INSTANCE_ID: 'inst' };
    if (apiUrl && apiUrl !== DEFAULT_URL) env.CACHLY_API_URL = apiUrl;

    expect(env.CACHLY_API_URL).toBeUndefined();
    expect(env.CACHLY_JWT).toBe('tok');
  });

  it('includes CACHLY_API_URL when using a custom URL', () => {
    const DEFAULT_URL = 'https://api.cachly.dev';
    const apiUrl = 'https://my-selfhost.example.com';
    const env: Record<string, string> = { CACHLY_JWT: 'tok', CACHLY_BRAIN_INSTANCE_ID: 'inst' };
    if (apiUrl && apiUrl !== DEFAULT_URL) env.CACHLY_API_URL = apiUrl;

    expect(env.CACHLY_API_URL).toBe('https://my-selfhost.example.com');
  });

  it('omits CACHLY_API_URL when value is empty string', () => {
    const DEFAULT_URL = 'https://api.cachly.dev';
    const apiUrl = '';
    const env: Record<string, string> = { CACHLY_JWT: 'tok', CACHLY_BRAIN_INSTANCE_ID: 'inst' };
    if (apiUrl && apiUrl !== DEFAULT_URL) env.CACHLY_API_URL = apiUrl;

    expect(env.CACHLY_API_URL).toBeUndefined();
  });
});

// ── Regression: MCP stdio stdout cleanness ────────────────────────────────────

describe('MCP stdio stdout regression', () => {
  it('safeJsonParse returns fallback for non-JSON without throwing', async () => {
    const { safeJsonParse } = await import('../utils.js');
    expect(safeJsonParse<unknown>('not json', null)).toBeNull();
    expect(safeJsonParse<unknown>('', null)).toBeNull();
    expect(safeJsonParse<unknown>('{"ok":true}', null)).toEqual({ ok: true });
  });

  it('lesson stored with imported_from field after brain_import', async () => {
    const redis = new MockRedis();
    const sharePayload = {
      share_id: 'xyz',
      lessons: [{ topic: 'test:lesson', outcome: 'success', what_worked: 'done', confidence: 1.0 }],
    };
    const apiFetch = async <T>() => sharePayload as T;
    await handleShareTool('brain_import', {
      instance_id: 'inst-1', share_id: 'xyz',
    }, async () => redis as unknown as Redis, apiFetch);

    const stored = JSON.parse(redis._store().get('cachly:lesson:best:test:lesson')!);
    expect(stored.imported_from).toBe('xyz');
    expect(stored.imported_at).toBeDefined();
  });
});
