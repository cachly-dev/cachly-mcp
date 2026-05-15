/**
 * E2E: Authenticated API endpoints
 *
 * Requires: E2E_JWT, E2E_INSTANCE_ID
 * Run: npx vitest run src/__tests__/e2e/api-auth.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { cfg, requireAuth, apiGet, apiPost } from './config.js';

beforeAll(() => requireAuth());

describe('Auth guard', () => {
  it('GET /api/v1/instances without token returns 401', async () => {
    const { status } = await apiGet('/api/v1/instances', '');
    expect(status).toBe(401);
  });

  it('GET /api/v1/instances with invalid token returns 401', async () => {
    const { status } = await apiGet('/api/v1/instances', 'not-a-real-token');
    expect(status).toBe(401);
  });

  it('GET /api/v1/instances with valid token returns 200', async () => {
    const { status } = await apiGet('/api/v1/instances');
    expect(status).toBe(200);
  });
});

describe('Instances API', () => {
  // API returns { data: Instance[], count: number }
  it('returns object with data array', async () => {
    const { body } = await apiGet('/api/v1/instances');
    const b = body as { data?: unknown[]; count?: number };
    expect(Array.isArray(b.data)).toBe(true);
    expect(typeof b.count).toBe('number');
  });

  it('each instance has required fields', async () => {
    const { body } = await apiGet('/api/v1/instances');
    const instances = ((body as { data?: Record<string, unknown>[] }).data) ?? [];
    if (instances.length === 0) return; // fresh account — skip
    for (const inst of instances) {
      expect(typeof inst.id).toBe('string');
      expect(typeof inst.name).toBe('string');
      expect(typeof inst.status).toBe('string');
      expect(typeof inst.tier).toBe('string');
    }
  });

  it('test instance is present and running', async () => {
    const { body } = await apiGet('/api/v1/instances');
    const instances = ((body as { data?: Record<string, unknown>[] }).data) ?? [];
    const found = instances.find((i) => i.id === cfg.instanceId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('running');
  });
});

describe('Single instance GET', () => {
  it('returns 200 for test instance', async () => {
    const { status } = await apiGet(`/api/v1/instances/${cfg.instanceId}`);
    expect(status).toBe(200);
  });

  it('returns 404 for non-existent instance', async () => {
    const { status } = await apiGet('/api/v1/instances/00000000-0000-0000-0000-000000000000');
    expect([403, 404]).toContain(status);
  });

  it('instance body has id, status running, tier, name', async () => {
    const { body } = await apiGet(`/api/v1/instances/${cfg.instanceId}`);
    const inst = body as Record<string, unknown>;
    expect(inst.id).toBe(cfg.instanceId);
    expect(inst.status).toBe('running');
    expect(typeof inst.tier).toBe('string');
    expect(typeof inst.name).toBe('string');
  });
});

describe('Connection endpoint', () => {
  it('returns 200 with connection details for running instance', async () => {
    const { status, body } = await apiGet(`/api/v1/instances/${cfg.instanceId}/connection`);
    expect(status).toBe(200);
    const conn = body as Record<string, unknown>;
    expect(typeof conn.host).toBe('string');
    expect(typeof conn.port).toBe('number');
    expect(typeof conn.password).toBe('string');
    expect((conn.host as string).length).toBeGreaterThan(3);
  });

  it('connection host is not localhost (prod/dev has real host)', async () => {
    const { body } = await apiGet(`/api/v1/instances/${cfg.instanceId}/connection`);
    const conn = body as Record<string, unknown>;
    expect(String(conn.host)).not.toBe('localhost');
    expect(String(conn.host)).not.toBe('127.0.0.1');
  });

  it('port is within valid Redis range', async () => {
    const { body } = await apiGet(`/api/v1/instances/${cfg.instanceId}/connection`);
    const conn = body as Record<string, unknown>;
    expect(Number(conn.port)).toBeGreaterThan(1023);
    expect(Number(conn.port)).toBeLessThan(65536);
  });
});

describe('API keys', () => {
  // API returns { keys: APIKey[], count: number }
  it('GET /api/v1/api-keys returns 200 with keys array', async () => {
    const { status, body } = await apiGet('/api/v1/api-keys');
    expect(status).toBe(200);
    const b = body as { keys?: unknown[]; count?: number };
    expect(Array.isArray(b.keys)).toBe(true);
  });

  it('api-keys have id and instance_id fields', async () => {
    const { body } = await apiGet('/api/v1/api-keys');
    const keys = ((body as { keys?: Record<string, unknown>[] }).keys) ?? [];
    if (keys.length === 0) return;
    for (const k of keys) {
      expect(typeof k.id).toBe('string');
      expect(typeof k.instance_id).toBe('string');
    }
  });
});

describe('Brain Stats endpoint', () => {
  it('GET /api/v1/instances/:id/brain-stats returns 200', async () => {
    const { status } = await apiGet(`/api/v1/instances/${cfg.instanceId}/brain-stats`);
    expect(status).toBe(200);
  });

  it('brain-stats body has brain_level and brain_level_name', async () => {
    const { body } = await apiGet(`/api/v1/instances/${cfg.instanceId}/brain-stats`);
    const stats = body as Record<string, unknown>;
    expect(typeof stats.brain_level).toBe('number');
    expect(stats.brain_level).toBeGreaterThanOrEqual(1);
    expect(typeof stats.brain_level_name).toBe('string');
    expect(['Apprentice', 'Explorer', 'Expert', 'Architect', 'Oracle']).toContain(stats.brain_level_name);
  });

  it('brain-stats has hours_saved and brain_recall_count', async () => {
    const { body } = await apiGet(`/api/v1/instances/${cfg.instanceId}/brain-stats`);
    const stats = body as Record<string, unknown>;
    expect(typeof stats.hours_saved).toBe('number');
    expect(stats.hours_saved).toBeGreaterThanOrEqual(0);
    expect(typeof stats.brain_recall_count).toBe('number');
    expect(stats.brain_recall_count).toBeGreaterThanOrEqual(0);
  });

  it('brain-stats has standard search telemetry fields', async () => {
    const { body } = await apiGet(`/api/v1/instances/${cfg.instanceId}/brain-stats`);
    const stats = body as Record<string, unknown>;
    expect(typeof stats.total_searches).toBe('number');
    expect(typeof stats.avg_latency_ms).toBe('number');
    expect(Array.isArray(stats.top_queries)).toBe(true);
  });
});

describe('Provisioning status messages', () => {
  it('non-existent instance connection returns 4xx, never 500', async () => {
    const { status } = await apiGet('/api/v1/instances/00000000-0000-0000-0000-000000000001/connection');
    expect([400, 403, 404, 422]).toContain(status);
  });
});

describe('Auto-provision endpoint', () => {
  it('POST /api/v1/instances/auto returns 200 or 201', async () => {
    const { status } = await apiPost('/api/v1/instances/auto', {});
    expect([200, 201]).toContain(status);
  });

  it('returns existing running instance without creating a new one', async () => {
    const { body } = await apiPost('/api/v1/instances/auto', {});
    const b = body as { instance?: { id: string; status: string }; created?: boolean };
    if (b.instance) {
      // Existing instance returned
      expect(typeof b.instance.id).toBe('string');
      expect(b.created).toBe(false);
    }
  });
});
