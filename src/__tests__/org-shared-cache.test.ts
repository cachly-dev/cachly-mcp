/**
 * Unit tests for Org-Shared-Cache feature.
 *
 * Covers:
 *   cache_org_stats   – counts keys in org:{org_id}:sem:* namespace
 *   cache_set         – with org_id writes to shared namespace
 *   cache_get         – with org_id falls back to org namespace on miss
 *
 * Run: npx vitest run src/__tests__/org-shared-cache.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleCacheTool } from '../handlers/cache.js';

// ── Minimal fake Redis ────────────────────────────────────────────────────────

class FakeRedis {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...rest: unknown[]): Promise<'OK'> {
    void rest;
    this.store.set(key, value);
    return 'OK';
  }

  // scanStream implementation expected by scanKeys in utils.ts
  scanStream(opts: { match: string; count?: number }): {
    on(event: 'data', cb: (batch: string[]) => void): void;
    on(event: 'end', cb: () => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
  } {
    const pattern = opts.match;
    // Convert Redis glob pattern to JS regex
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexStr}$`);
    const matching = [...this.store.keys()].filter((k) => regex.test(k));

    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {
      data: [],
      end: [],
      error: [],
    };

    // Emit asynchronously so callers can attach listeners first
    Promise.resolve().then(() => {
      if (matching.length > 0) {
        for (const cb of listeners['data'] ?? []) cb(matching);
      }
      for (const cb of listeners['end'] ?? []) (cb as () => void)();
    });

    return {
      on(event: string, cb: (...args: unknown[]) => void) {
        if (!listeners[event]) listeners[event] = [];
        listeners[event]!.push(cb);
      },
    };
  }

  _store() { return this.store; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const noopApiFetch = async <T>(_path: string, _opts?: RequestInit): Promise<T> => {
  throw new Error('apiFetch should not be called in these tests');
};

function makeGetConnection(redis: FakeRedis) {
  return async (_instanceId: string) => redis as unknown as import('ioredis').Redis;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cache_set with org_id', () => {
  let redis: FakeRedis;
  const getConnection = () => redis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('writes key to direct AND shared org namespace', async () => {
    const result = await handleCacheTool(
      'cache_set',
      { instance_id: 'inst-1', key: 'mykey', value: 'hello', org_id: 'acme' },
      makeGetConnection(redis),
      noopApiFetch,
    );
    expect(result).toContain('✅ Set `mykey`');
    expect(result).toContain('org:acme:sem');
    expect(redis._store().get('mykey')).toBe('hello');
    expect(redis._store().get('org:acme:sem:mykey')).toBe('hello');
  });

  it('writes key to direct namespace only when org_id is absent', async () => {
    await handleCacheTool(
      'cache_set',
      { instance_id: 'inst-1', key: 'mykey', value: 'hello' },
      makeGetConnection(redis),
      noopApiFetch,
    );
    expect(redis._store().get('mykey')).toBe('hello');
    expect(redis._store().has('org:acme:sem:mykey')).toBe(false);
  });
});

describe('cache_get with org_id fallback', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('returns direct key when it exists (no fallback needed)', async () => {
    redis._store().set('mykey', 'direct-value');
    redis._store().set('org:acme:sem:mykey', 'org-value');

    const result = await handleCacheTool(
      'cache_get',
      { instance_id: 'inst-1', key: 'mykey', org_id: 'acme' },
      makeGetConnection(redis),
      noopApiFetch,
    );
    expect(result).toContain('direct-value');
    expect(result).not.toContain('org:acme:sem');
  });

  it('falls back to org namespace on direct miss', async () => {
    redis._store().set('org:acme:sem:mykey', 'org-value');

    const result = await handleCacheTool(
      'cache_get',
      { instance_id: 'inst-1', key: 'mykey', org_id: 'acme' },
      makeGetConnection(redis),
      noopApiFetch,
    );
    expect(result).toContain('org-value');
    expect(result).toContain('org:acme:sem');
  });

  it('returns not found when both direct and org miss', async () => {
    const result = await handleCacheTool(
      'cache_get',
      { instance_id: 'inst-1', key: 'mykey', org_id: 'acme' },
      makeGetConnection(redis),
      noopApiFetch,
    );
    expect(result).toContain('not found');
  });
});

describe('cache_org_stats', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = new FakeRedis();
  });

  it('returns 0 entries when namespace is empty', async () => {
    const result = await handleCacheTool(
      'cache_org_stats',
      { instance_id: 'inst-1', org_id: 'acme' },
      makeGetConnection(redis),
      noopApiFetch,
    );
    expect(result).toContain('org `acme`');
    expect(result).toContain('Shared entries:  0');
    expect(result).toContain('org:acme:sem');
  });

  it('counts keys in the org namespace', async () => {
    redis._store().set('org:acme:sem:key1', 'v1');
    redis._store().set('org:acme:sem:key2', 'v2');
    redis._store().set('org:acme:sem:key3', 'v3');
    // key in different org should not be counted
    redis._store().set('org:other:sem:key1', 'v1');

    const result = await handleCacheTool(
      'cache_org_stats',
      { instance_id: 'inst-1', org_id: 'acme' },
      makeGetConnection(redis),
      noopApiFetch,
    );
    expect(result).toContain('Shared entries:  3');
    expect(result).toContain('org:acme:sem');
    expect(result).toContain('To enable sharing');
  });

  it('appends org-wide savings section when the API returns the savings payload', async () => {
    const savingsApiFetch = async <T>(path: string, _opts?: RequestInit): Promise<T> => {
      expect(path).toBe('/api/v1/orgs/acme/savings');
      return {
        org_id: 'acme',
        instance_count: 3,
        total_hits: 1234,
        hits_last_24h: 42,
        estimated_total_saved_usd: 2.468,
        estimated_monthly_saved_usd: 2.52,
        per_instance: [
          { instance_id: 'i-1', name: 'prod-brain', total_hits: 1000, estimated_total_saved_usd: 2.0 },
          { instance_id: 'i-2', name: 'staging', total_hits: 200, estimated_total_saved_usd: 0.4 },
          { instance_id: 'i-3', name: 'dev', total_hits: 34, estimated_total_saved_usd: 0.068 },
        ],
      } as T;
    };

    const result = await handleCacheTool(
      'cache_org_stats',
      { instance_id: 'inst-1', org_id: 'acme' },
      makeGetConnection(redis),
      savingsApiFetch,
    );
    expect(result).toContain('Org-wide');
    expect(result).toContain('Instances:        3');
    expect(result).toContain('1,234');
    expect(result).toContain('42');
    expect(result).toContain('$2.47');
    expect(result).toContain('$2.52');
    // Per-instance breakdown, sorted by savings
    expect(result).toContain('prod-brain: $2.00');
    expect(result).toContain('staging: $0.40');
    expect(result).toContain('dev: $0.07');
  });

  it('falls back to Redis-only output when the savings API throws', async () => {
    redis._store().set('org:acme:sem:key1', 'v1');

    const result = await handleCacheTool(
      'cache_org_stats',
      { instance_id: 'inst-1', org_id: 'acme' },
      makeGetConnection(redis),
      async <T>(): Promise<T> => { throw new Error('404 not found'); },
    );
    expect(result).toContain('Shared entries:  1');
    expect(result).toContain('org:acme:sem');
    expect(result).not.toContain('Org-wide');
  });
});
