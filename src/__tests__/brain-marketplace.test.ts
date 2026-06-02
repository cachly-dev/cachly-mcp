/**
 * brain_marketplace + brain_install — Domain Brains marketplace (W10).
 *
 * Verifies the catalog browse, the install write path (idempotent +
 * non-destructive), dry-run, and the "never override your own lessons" guard.
 * Uses an in-memory Redis stub (get/set/rpush/ltrim/expire) and a fake apiFetch.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleSyndicateTool } from '../handlers/syndicate.js';

class MiniRedis {
  store = new Map<string, string>();
  lists = new Map<string, string[]>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async set(key: string, val: string): Promise<'OK'> { this.store.set(key, val); return 'OK'; }
  async rpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.push(val); this.lists.set(key, l); return l.length;
  }
  async ltrim(): Promise<'OK'> { return 'OK'; }
  async expire(): Promise<number> { return 1; }
}

const getConn = (redis: MiniRedis) => () => Promise.resolve(redis as never);

// apiFetch fake routed by path.
function makeApiFetch(routes: Record<string, unknown>) {
  return async <T>(path: string): Promise<T> => {
    const base = path.split('?')[0];
    if (base in routes) return routes[base] as T;
    throw new Error(`unexpected path: ${path}`);
  };
}

const catalog = {
  brains: [
    {
      slug: 'k8s', name: 'Kubernetes Incident Brain', icon: '☸️',
      description: 'pod crashes', category: 'k8s',
      lesson_count: 2, total_confirms: 9, curated: true, last_updated: '2026-05-30T00:00:00Z',
    },
  ],
  count: 1,
};

const k8sPack = {
  slug: 'k8s', name: 'Kubernetes Incident Brain', curated: true, count: 2,
  lessons: [
    {
      topic: 'k8s:oom-kill', outcome: 'success', what_worked: 'raise memory limit + probe',
      what_failed: '', severity: 'major', tags: '["k8s","memory"]', confirm_count: 5,
    },
    {
      topic: 'k8s:rollout-stall', outcome: 'success', what_worked: 'fix readiness probe',
      what_failed: '', severity: 'minor', tags: '["k8s"]', confirm_count: 4,
    },
  ],
};

describe('brain_marketplace', () => {
  it('lists available domain brains with install hints', async () => {
    const apiFetch = makeApiFetch({ '/api/v1/syndication/brains': catalog });
    const out = await handleSyndicateTool('brain_marketplace', {}, getConn(new MiniRedis()), apiFetch) as string;
    expect(out).toContain('Kubernetes Incident Brain');
    expect(out).toContain('brain_install(slug="k8s")');
    expect(out).toContain('⭐ curated');
  });

  it('handles an empty marketplace gracefully', async () => {
    const apiFetch = makeApiFetch({ '/api/v1/syndication/brains': { brains: [], count: 0 } });
    const out = await handleSyndicateTool('brain_marketplace', {}, getConn(new MiniRedis()), apiFetch) as string;
    expect(out).toContain('No domain brains are available yet');
  });
});

describe('brain_install', () => {
  let redis: MiniRedis;
  beforeEach(() => { redis = new MiniRedis(); });

  it('requires a slug', async () => {
    const apiFetch = makeApiFetch({});
    await expect(
      handleSyndicateTool('brain_install', { instance_id: 'i', slug: '  ' }, getConn(redis), apiFetch),
    ).rejects.toThrow(/slug is required/);
  });

  it('installs lessons into the local brain', async () => {
    const apiFetch = makeApiFetch({ '/api/v1/syndication/brains/k8s': k8sPack });
    const out = await handleSyndicateTool('brain_install', { instance_id: 'i', slug: 'k8s' }, getConn(redis), apiFetch) as string;
    expect(out).toContain('Installed: Kubernetes Incident Brain');
    expect(out).toContain('merged into your Brain');

    const stored = redis.store.get('cachly:lesson:best:k8s:oom-kill');
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.source).toBe('marketplace:k8s');
    expect(parsed.tags).toEqual(['k8s', 'memory']);
    expect(parsed.recall_count).toBe(0);
  });

  it('dry_run previews without writing', async () => {
    const apiFetch = makeApiFetch({ '/api/v1/syndication/brains/k8s': k8sPack });
    const out = await handleSyndicateTool('brain_install', { instance_id: 'i', slug: 'k8s', dry_run: true }, getConn(redis), apiFetch) as string;
    expect(out).toContain('DRY RUN');
    expect(redis.store.has('cachly:lesson:best:k8s:oom-kill')).toBe(false);
  });

  it('never overrides the user\'s own lesson on the same topic', async () => {
    // Pre-seed a real user lesson (no marketplace source).
    redis.store.set('cachly:lesson:best:k8s:oom-kill', JSON.stringify({
      topic: 'k8s:oom-kill', outcome: 'success', what_worked: 'MY fix', source: undefined, version: 3,
    }));
    const apiFetch = makeApiFetch({ '/api/v1/syndication/brains/k8s': k8sPack });
    const out = await handleSyndicateTool('brain_install', { instance_id: 'i', slug: 'k8s' }, getConn(redis), apiFetch) as string;

    // The user's lesson is preserved; only the second (new) lesson installs.
    const kept = JSON.parse(redis.store.get('cachly:lesson:best:k8s:oom-kill')!);
    expect(kept.what_worked).toBe('MY fix');
    expect(out).toContain('1 skipped');
  });
});
