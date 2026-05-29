/**
 * Unit tests for handler helper functions and handler logic.
 *
 * Covers (no real network or Redis required):
 *   formatInstance       – status badge, memory formatting
 *   buildConnectionString – TLS, auth, port
 *   handleRoadmapTool   – add, list, update, next (full in-memory flow)
 *   handleInstanceTool  – list, create, get, connection string, delete
 *
 * Run: npx vitest run src/__tests__/handlers-unit.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { Instance } from '../handlers/brain.js';
import {
  formatInstance,
  buildConnectionString,
  handleInstanceTool,
} from '../handlers/instances.js';
import { handleRoadmapTool } from '../handlers/roadmap.js';

// ── Minimal MockRedis (hashes + lists) ───────────────────────────────────────

class MockRedis {
  private hashes = new Map<string, Map<string, string>>();

  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    this.hashes.get(key)!.set(field, value);
    return 1;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const h = this.hashes.get(key);
    if (!h || h.size === 0) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of h) out[k] = v;
    return out;
  }

  /** Expose internals for test assertions */
  _hashes() { return this.hashes; }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseInstance: Instance = {
  id: 'inst-abc123',
  name: 'my-cache',
  tier: 'free',
  status: 'running',
  region: 'eu-west',
  host: 'redis.cachly.dev',
  port: 6379,
  password: 'supersecret',
  tls_enabled: false,
  memory_mb: 256,
  encryption_at_rest: false,
  created_at: '2026-01-01T00:00:00Z',
};

// ── formatInstance ────────────────────────────────────────────────────────────

describe('formatInstance', () => {
  it('running instance shows 🟢 badge', () => {
    const result = formatInstance({ ...baseInstance, status: 'running' });
    expect(result).toContain('🟢');
  });

  it('provisioning instance shows 🟡 badge', () => {
    const result = formatInstance({ ...baseInstance, status: 'provisioning' });
    expect(result).toContain('🟡');
  });

  it('stopped/error instance shows 🔴 badge', () => {
    const result = formatInstance({ ...baseInstance, status: 'stopped' });
    expect(result).toContain('🔴');
    const error = formatInstance({ ...baseInstance, status: 'error' });
    expect(error).toContain('🔴');
  });

  it('includes instance name', () => {
    expect(formatInstance(baseInstance)).toContain('my-cache');
  });

  it('includes instance id in backticks', () => {
    expect(formatInstance(baseInstance)).toContain('inst-abc123');
  });

  it('includes tier', () => {
    expect(formatInstance(baseInstance)).toContain('free');
  });

  it('includes region', () => {
    expect(formatInstance(baseInstance)).toContain('eu-west');
  });

  it('displays memory < 1024 MB in MB', () => {
    const result = formatInstance({ ...baseInstance, memory_mb: 512 });
    expect(result).toContain('512MB');
  });

  it('displays memory >= 1024 MB in GB', () => {
    const result = formatInstance({ ...baseInstance, memory_mb: 1024 });
    expect(result).toContain('1GB');
  });

  it('displays 2048 MB as 2GB', () => {
    const result = formatInstance({ ...baseInstance, memory_mb: 2048 });
    expect(result).toContain('2GB');
  });

  it('displays 4096 MB as 4GB', () => {
    const result = formatInstance({ ...baseInstance, memory_mb: 4096 });
    expect(result).toContain('4GB');
  });
});

// ── buildConnectionString ─────────────────────────────────────────────────────

describe('buildConnectionString', () => {
  it('returns error message when host is absent', () => {
    const result = buildConnectionString({ ...baseInstance, host: undefined });
    expect(result).toContain('❌');
    expect(result.toLowerCase()).toContain('not ready');
  });

  it('uses redis:// for non-TLS', () => {
    const result = buildConnectionString({ ...baseInstance, tls_enabled: false });
    expect(result).toMatch(/^redis:\/\//);
  });

  it('uses rediss:// for TLS', () => {
    const result = buildConnectionString({ ...baseInstance, tls_enabled: true });
    expect(result).toMatch(/^rediss:\/\//);
  });

  it('includes password in auth section', () => {
    const result = buildConnectionString({ ...baseInstance, password: 'mypass' });
    expect(result).toContain(':mypass@');
  });

  it('no auth section when password is absent', () => {
    const result = buildConnectionString({ ...baseInstance, password: undefined });
    expect(result).not.toContain('@');
  });

  it('includes host in connection string', () => {
    const result = buildConnectionString(baseInstance);
    expect(result).toContain('redis.cachly.dev');
  });

  it('includes default port 6379', () => {
    const result = buildConnectionString(baseInstance);
    expect(result).toContain(':6379');
  });

  it('includes custom port', () => {
    const result = buildConnectionString({ ...baseInstance, port: 12345 });
    expect(result).toContain(':12345');
  });

  it('TLS + auth builds correct rediss:// URL', () => {
    const result = buildConnectionString({
      ...baseInstance,
      tls_enabled: true,
      password: 'pass123',
      host: 'secure.cachly.dev',
      port: 6380,
    });
    expect(result).toBe('rediss://:pass123@secure.cachly.dev:6380');
  });

  it('non-TLS no-auth builds correct redis:// URL', () => {
    const result = buildConnectionString({
      ...baseInstance,
      tls_enabled: false,
      password: undefined,
      host: 'open.cachly.dev',
      port: 6379,
    });
    expect(result).toBe('redis://open.cachly.dev:6379');
  });
});

// ── handleRoadmapTool ─────────────────────────────────────────────────────────

describe('handleRoadmapTool', () => {
  let redis: MockRedis;
  let getConnection: ReturnType<typeof vi.fn>;
  const apiFetch = vi.fn();
  const INSTANCE = 'inst-test';

  beforeEach(() => {
    redis = new MockRedis();
    getConnection = vi.fn().mockResolvedValue(redis as unknown as Redis);
  });

  // ── roadmap_add ──────────────────────────────────────────────────────────────

  describe('roadmap_add', () => {
    it('creates a roadmap item and returns formatted output', async () => {
      const result = await handleRoadmapTool(
        'roadmap_add',
        { instance_id: INSTANCE, title: 'Fix login bug', priority: 'high' },
        getConnection,
        apiFetch,
      );
      expect(result).toContain('📋 **Roadmap item added**');
      expect(result).toContain('Fix login bug');
      expect(result).toContain('high');
      expect(result).toContain('planned');
    });

    it('returns an ID prefixed with rm_', async () => {
      const result = await handleRoadmapTool(
        'roadmap_add',
        { instance_id: INSTANCE, title: 'Migrate DB', priority: 'critical' },
        getConnection,
        apiFetch,
      );
      expect(result).toMatch(/`rm_[a-z0-9_]+`/);
    });

    it('stores item in Redis under cachly:roadmap:{instance_id}', async () => {
      await handleRoadmapTool(
        'roadmap_add',
        { instance_id: INSTANCE, title: 'Add tests', priority: 'medium' },
        getConnection,
        apiFetch,
      );
      const stored = redis._hashes().get(`cachly:roadmap:${INSTANCE}`);
      expect(stored).toBeDefined();
      expect(stored!.size).toBe(1);
      const item = JSON.parse([...stored!.values()][0]);
      expect(item.title).toBe('Add tests');
      expect(item.status).toBe('planned');
      expect(item.priority).toBe('medium');
    });

    it('includes milestone in output when provided', async () => {
      const result = await handleRoadmapTool(
        'roadmap_add',
        { instance_id: INSTANCE, title: 'Release v2', priority: 'high', milestone: 'Q2-2026' },
        getConnection,
        apiFetch,
      );
      expect(result).toContain('Q2-2026');
    });

    it('includes tags in output when provided', async () => {
      const result = await handleRoadmapTool(
        'roadmap_add',
        { instance_id: INSTANCE, title: 'Cache warmup', priority: 'low', tags: ['perf', 'infra'] },
        getConnection,
        apiFetch,
      );
      expect(result).toContain('perf');
      expect(result).toContain('infra');
    });

    it('contains roadmap_update hint with the new item ID', async () => {
      const result = await handleRoadmapTool(
        'roadmap_add',
        { instance_id: INSTANCE, title: 'Deploy feature', priority: 'medium' },
        getConnection,
        apiFetch,
      );
      // Hint should reference the new item ID for marking in-progress
      expect(result).toContain('roadmap_update');
      expect(result).toContain('in-progress');
    });
  });

  // ── roadmap_list ─────────────────────────────────────────────────────────────

  describe('roadmap_list', () => {
    it('returns empty message when no items', async () => {
      const result = await handleRoadmapTool(
        'roadmap_list',
        { instance_id: INSTANCE },
        getConnection,
        apiFetch,
      );
      expect(result).toContain('empty');
      expect(result).toContain('roadmap_add');
    });

    it('shows added item in list', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Write tests', priority: 'high' }, getConnection, apiFetch);
      const result = await handleRoadmapTool('roadmap_list', { instance_id: INSTANCE }, getConnection, apiFetch);
      expect(result).toContain('Write tests');
    });

    it('shows item count', async () => {
      for (let i = 0; i < 3; i++) {
        await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: `Task ${i}`, priority: 'low' }, getConnection, apiFetch);
      }
      const result = await handleRoadmapTool('roadmap_list', { instance_id: INSTANCE }, getConnection, apiFetch);
      expect(result).toContain('3 item');
    });

    it('sorts critical items before low items', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Low priority', priority: 'low' }, getConnection, apiFetch);
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Critical fix', priority: 'critical' }, getConnection, apiFetch);
      const result = await handleRoadmapTool('roadmap_list', { instance_id: INSTANCE }, getConnection, apiFetch);
      const critIdx = result!.indexOf('Critical fix');
      const lowIdx  = result!.indexOf('Low priority');
      expect(critIdx).toBeLessThan(lowIdx);
    });

    it('filters by tag', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Frontend task', priority: 'medium', tags: ['frontend'] }, getConnection, apiFetch);
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Backend task',  priority: 'medium', tags: ['backend']  }, getConnection, apiFetch);
      const result = await handleRoadmapTool('roadmap_list', { instance_id: INSTANCE, tag: 'frontend' }, getConnection, apiFetch);
      expect(result).toContain('Frontend task');
      expect(result).not.toContain('Backend task');
    });

    it('filters by milestone', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'MVP feature', priority: 'high', milestone: 'mvp' }, getConnection, apiFetch);
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Post-launch',  priority: 'low',  milestone: 'v2' }, getConnection, apiFetch);
      const result = await handleRoadmapTool('roadmap_list', { instance_id: INSTANCE, milestone: 'mvp' }, getConnection, apiFetch);
      expect(result).toContain('MVP feature');
      expect(result).not.toContain('Post-launch');
    });

    it('status=done shows only done items', async () => {
      // Add and complete one item
      const addResult = await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Finished task', priority: 'low' }, getConnection, apiFetch);
      const idMatch = addResult!.match(/`(rm_[a-z0-9_]+)`/);
      const id = idMatch![1];
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, status: 'done' }, getConnection, apiFetch);

      const result = await handleRoadmapTool('roadmap_list', { instance_id: INSTANCE, status: 'done' }, getConnection, apiFetch);
      expect(result).toContain('Finished task');
    });

    it('status=open hides done items', async () => {
      const addResult = await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Done item', priority: 'low' }, getConnection, apiFetch);
      const id = addResult!.match(/`(rm_[a-z0-9_]+)`/)![1];
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, status: 'done' }, getConnection, apiFetch);

      const result = await handleRoadmapTool('roadmap_list', { instance_id: INSTANCE, status: 'open' }, getConnection, apiFetch);
      // No open items after marking done
      expect(result).toContain('No roadmap items');
    });
  });

  // ── roadmap_update ────────────────────────────────────────────────────────────

  describe('roadmap_update', () => {
    async function addItem(title: string, priority = 'medium'): Promise<string> {
      const result = await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title, priority }, getConnection, apiFetch);
      return result!.match(/`(rm_[a-z0-9_]+)`/)![1];
    }

    it('updates status and returns confirmation', async () => {
      const id = await addItem('Deploy feature');
      const result = await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, status: 'in-progress' }, getConnection, apiFetch);
      expect(result).toContain('⚡');
      expect(result).toContain('Deploy feature');
      expect(result).toContain('in-progress');
    });

    it('persists status change in Redis', async () => {
      const id = await addItem('Fix cache');
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, status: 'done' }, getConnection, apiFetch);
      const stored = await redis.hget(`cachly:roadmap:${INSTANCE}`, id);
      const item = JSON.parse(stored!);
      expect(item.status).toBe('done');
    });

    it('appends notes with timestamp prefix', async () => {
      const id = await addItem('Refactor');
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, notes: 'Started refactor' }, getConnection, apiFetch);
      const stored = JSON.parse((await redis.hget(`cachly:roadmap:${INSTANCE}`, id))!);
      expect(stored.notes).toContain('Started refactor');
      expect(stored.notes).toMatch(/^\[20\d\d-/);  // Date prefix like [2026-...
    });

    it('appends multiple notes, keeping history', async () => {
      const id = await addItem('Long task');
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, notes: 'First update' }, getConnection, apiFetch);
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, notes: 'Second update' }, getConnection, apiFetch);
      const stored = JSON.parse((await redis.hget(`cachly:roadmap:${INSTANCE}`, id))!);
      expect(stored.notes).toContain('First update');
      expect(stored.notes).toContain('Second update');
    });

    it('returns error message for missing item ID', async () => {
      const result = await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id: 'rm_nonexistent', status: 'done' }, getConnection, apiFetch);
      expect(result).toContain('not found');
      expect(result).toContain('roadmap_list');
    });

    it('updates title', async () => {
      const id = await addItem('Old title');
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, title: 'New title' }, getConnection, apiFetch);
      const stored = JSON.parse((await redis.hget(`cachly:roadmap:${INSTANCE}`, id))!);
      expect(stored.title).toBe('New title');
    });

    it('updates priority', async () => {
      const id = await addItem('Task', 'low');
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, priority: 'critical' }, getConnection, apiFetch);
      const stored = JSON.parse((await redis.hget(`cachly:roadmap:${INSTANCE}`, id))!);
      expect(stored.priority).toBe('critical');
    });
  });

  // ── roadmap_next ─────────────────────────────────────────────────────────────

  describe('roadmap_next', () => {
    it('returns empty roadmap message when no items exist', async () => {
      const result = await handleRoadmapTool('roadmap_next', { instance_id: INSTANCE }, getConnection, apiFetch);
      expect(result).toContain('empty');
      expect(result).toContain('roadmap_add');
    });

    it('returns all-done message when all items are completed', async () => {
      // Add an item then mark it done
      const addResult = await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Finished', priority: 'low' }, getConnection, apiFetch);
      const id = addResult!.match(/`(rm_[a-z0-9_]+)`/)![1];
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id, status: 'done' }, getConnection, apiFetch);

      const result = await handleRoadmapTool('roadmap_next', { instance_id: INSTANCE }, getConnection, apiFetch);
      // All open items exhausted → 🎉 message
      expect(result).toContain('No open roadmap items');
    });

    it('returns the single item when only one exists', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Only task', priority: 'medium' }, getConnection, apiFetch);
      const result = await handleRoadmapTool('roadmap_next', { instance_id: INSTANCE }, getConnection, apiFetch);
      expect(result).toContain('Only task');
    });

    it('returns critical item over low item', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Low task',      priority: 'low'      }, getConnection, apiFetch);
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Critical task', priority: 'critical' }, getConnection, apiFetch);
      const result = await handleRoadmapTool('roadmap_next', { instance_id: INSTANCE }, getConnection, apiFetch);
      expect(result).toContain('Critical task');
    });

    it('returns in-progress item over higher-priority planned item', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Critical planned', priority: 'critical' }, getConnection, apiFetch);
      const lowResult = await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Low in-progress', priority: 'low' }, getConnection, apiFetch);
      const lowId = lowResult!.match(/`(rm_[a-z0-9_]+)`/)![1];
      await handleRoadmapTool('roadmap_update', { instance_id: INSTANCE, id: lowId, status: 'in-progress' }, getConnection, apiFetch);

      const result = await handleRoadmapTool('roadmap_next', { instance_id: INSTANCE }, getConnection, apiFetch);
      expect(result).toContain('Low in-progress');
      expect(result).toContain('⚡');
    });

    it('shows remaining count', async () => {
      for (let i = 0; i < 5; i++) {
        await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: `Task ${i}`, priority: 'medium' }, getConnection, apiFetch);
      }
      const result = await handleRoadmapTool('roadmap_next', { instance_id: INSTANCE }, getConnection, apiFetch);
      expect(result).toContain('+4 more');
    });

    it('filters by tag', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Backend', priority: 'high',   tags: ['backend']  }, getConnection, apiFetch);
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'Frontend', priority: 'critical', tags: ['frontend'] }, getConnection, apiFetch);
      // Even though Frontend has higher priority, filtering by backend should return Backend
      const result = await handleRoadmapTool('roadmap_next', { instance_id: INSTANCE, tag: 'backend' }, getConnection, apiFetch);
      expect(result).toContain('Backend');
      expect(result).not.toContain('Frontend');
    });

    it('contains a roadmap_update call-to-action hint', async () => {
      await handleRoadmapTool('roadmap_add', { instance_id: INSTANCE, title: 'My task', priority: 'medium' }, getConnection, apiFetch);
      const result = await handleRoadmapTool('roadmap_next', { instance_id: INSTANCE }, getConnection, apiFetch);
      expect(result).toContain('roadmap_update');
    });
  });
});

// ── handleInstanceTool ────────────────────────────────────────────────────────

describe('handleInstanceTool', () => {
  const noop = vi.fn();
  const getConnection = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list_instances — empty list returns helpful message', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ data: [] });
    const result = await handleInstanceTool('list_instances', {}, getConnection, apiFetch);
    expect(result).toContain('no cache instances');
    expect(result).toContain('create_instance');
  });

  it('list_instances — returns formatted instance list', async () => {
    const instances: Instance[] = [
      { ...baseInstance, id: 'inst-1', name: 'prod-cache', status: 'running' },
      { ...baseInstance, id: 'inst-2', name: 'dev-cache',  status: 'provisioning' },
    ];
    const apiFetch = vi.fn().mockResolvedValue({ data: instances });
    const result = await handleInstanceTool('list_instances', {}, getConnection, apiFetch);
    expect(result).toContain('2 instance');
    expect(result).toContain('prod-cache');
    expect(result).toContain('dev-cache');
    expect(result).toContain('🟢');
    expect(result).toContain('🟡');
  });

  it('create_instance (free tier) — returns success without checkout URL', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      instance_id: 'inst-new123',
      status: 'provisioning',
    });
    const result = await handleInstanceTool(
      'create_instance',
      { name: 'my-new-cache', tier: 'free' },
      getConnection,
      apiFetch,
    );
    expect(result).toContain('✅');
    expect(result).toContain('inst-new123');
    expect(result).toContain('provisioning');
    expect(result).not.toContain('checkout');
    expect(result).toContain('get_connection_string');
  });

  it('create_instance (paid tier) — returns checkout URL', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      instance_id: 'inst-paid-456',
      checkout_url: 'https://checkout.stripe.com/pay/cs_test_abc',
      status: 'pending_payment',
    });
    const result = await handleInstanceTool(
      'create_instance',
      { name: 'pro-cache', tier: 'starter' },
      getConnection,
      apiFetch,
    );
    expect(result).toContain('✅');
    expect(result).toContain('inst-paid-456');
    expect(result).toContain('💳');
    expect(result).toContain('https://checkout.stripe.com');
  });

  it('get_instance — calls correct API endpoint and returns formatted result', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ ...baseInstance, status: 'running' });
    const result = await handleInstanceTool(
      'get_instance',
      { instance_id: 'inst-abc123' },
      getConnection,
      apiFetch,
    );
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/instances/inst-abc123');
    expect(result).toContain('my-cache');
    expect(result).toContain('🟢');
  });

  it('get_connection_string — running instance returns redis:// URL block', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      ...baseInstance,
      status: 'running',
      tls_enabled: false,
      password: 'abc',
      host: 'redis.cachly.dev',
      port: 6379,
    });
    const result = await handleInstanceTool(
      'get_connection_string',
      { instance_id: 'inst-abc123' },
      getConnection,
      apiFetch,
    );
    expect(result).toContain('redis://:abc@redis.cachly.dev:6379');
    expect(result).toContain('REDIS_URL');
    expect(result).toContain('redis-cli');
  });

  it('get_connection_string — non-running instance returns not-ready message', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ ...baseInstance, status: 'provisioning', host: undefined });
    const result = await handleInstanceTool(
      'get_connection_string',
      { instance_id: 'inst-abc123' },
      getConnection,
      apiFetch,
    );
    expect(result).toContain('not running');
    expect(result).toContain('provisioning');
  });

  it('delete_instance without confirm — returns cancelled message without calling API', async () => {
    const apiFetch = vi.fn();
    const result = await handleInstanceTool(
      'delete_instance',
      { instance_id: 'inst-abc123', confirm: false },
      getConnection,
      apiFetch,
    );
    expect(result).toContain('cancelled');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('delete_instance with confirm=true — calls DELETE and returns success', async () => {
    const apiFetch = vi.fn().mockResolvedValue({});
    const result = await handleInstanceTool(
      'delete_instance',
      { instance_id: 'inst-abc123', confirm: true },
      getConnection,
      apiFetch,
    );
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/instances/inst-abc123', { method: 'DELETE' });
    expect(result).toContain('✅');
    expect(result).toContain('inst-abc123');
  });

  it('list_orgs — empty org list returns hint to create org', async () => {
    const apiFetch = vi.fn().mockResolvedValue({ orgs: [] });
    const result = await handleInstanceTool('list_orgs', {}, getConnection, apiFetch);
    expect(result).toContain('No organizations');
    expect(result).toContain('create_org');
  });

  it('list_orgs — returns formatted org list', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      orgs: [
        { id: 'org-1', name: 'ACME Inc.', slug: 'acme', plan: 'team', max_members: 10, member_count: 3 },
      ],
    });
    const result = await handleInstanceTool('list_orgs', {}, getConnection, apiFetch);
    expect(result).toContain('ACME Inc.');
    expect(result).toContain('team');
    expect(result).toContain('3/10');
  });

  it('create_org — returns created org details', async () => {
    const apiFetch = vi.fn().mockResolvedValue({
      id: 'org-new',
      name: 'My Team',
      slug: 'my-team',
      plan: 'free',
    });
    const result = await handleInstanceTool(
      'create_org',
      { name: 'My Team' },
      getConnection,
      apiFetch,
    );
    expect(result).toContain('✅');
    expect(result).toContain('My Team');
    expect(result).toContain('invite_member');
  });

  it('invite_member — returns confirmation with email', async () => {
    const apiFetch = vi.fn().mockResolvedValue({});
    const result = await handleInstanceTool(
      'invite_member',
      { org_id: 'org-1', email: 'dev@example.com', role: 'member' },
      getConnection,
      apiFetch,
    );
    expect(result).toContain('✅');
    expect(result).toContain('dev@example.com');
    expect(result).toContain('member');
  });

  it('unknown tool name — returns null', async () => {
    const result = await handleInstanceTool('nonexistent_tool', {}, getConnection, noop);
    expect(result).toBeNull();
  });
});
