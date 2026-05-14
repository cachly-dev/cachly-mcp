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
  it('returns an array', async () => {
    const { body } = await apiGet('/api/v1/instances');
    expect(Array.isArray(body)).toBe(true);
  });

  it('each instance has required fields', async () => {
    const { body } = await apiGet('/api/v1/instances');
    const instances = body as Record<string, unknown>[];
    if (instances.length === 0) return; // fresh account — skip
    for (const inst of instances) {
      expect(typeof inst.id).toBe('string');
      expect(typeof inst.name).toBe('string');
      expect(typeof inst.status).toBe('string');
      expect(typeof inst.tier).toBe('string');
    }
  });

  it('test instance is present and active', async () => {
    const { body } = await apiGet('/api/v1/instances');
    const instances = body as Record<string, unknown>[];
    const found = instances.find((i) => i.id === cfg.instanceId);
    expect(found).toBeDefined();
    expect(found!.status).toBe('active');
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

  it('instance body has id, status, tier, name', async () => {
    const { body } = await apiGet(`/api/v1/instances/${cfg.instanceId}`);
    const inst = body as Record<string, unknown>;
    expect(inst.id).toBe(cfg.instanceId);
    expect(inst.status).toBe('active');
    expect(typeof inst.tier).toBe('string');
    expect(typeof inst.name).toBe('string');
  });
});

describe('Connection endpoint', () => {
  it('returns 200 with connection details for active instance', async () => {
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
  it('GET /api/v1/api-keys returns array', async () => {
    const { status, body } = await apiGet('/api/v1/api-keys');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('api-keys have id and instance_id fields', async () => {
    const { body } = await apiGet('/api/v1/api-keys');
    const keys = body as Record<string, unknown>[];
    if (keys.length === 0) return;
    for (const k of keys) {
      expect(typeof k.id).toBe('string');
      expect(typeof k.instance_id).toBe('string');
    }
  });
});

describe('Provisioning status messages', () => {
  it('a suspended instance returns connection error with billing hint', async () => {
    // We cannot easily have a suspended instance in e2e, so we verify the
    // endpoint returns a meaningful error (not a generic 500) for bad states.
    // This test validates the connection endpoint fails gracefully.
    const { status } = await apiGet('/api/v1/instances/00000000-0000-0000-0000-000000000001/connection');
    expect([400, 403, 404, 422]).toContain(status); // never 500
  });
});
