/**
 * E2E: Provisioning flow
 *
 * Tests the full instance lifecycle:
 *   create → poll until active (or timeout) → connect → delete
 *
 * ⚠️  This test creates a real instance and WILL be billed if not deleted.
 *     It always cleans up in afterAll, even on failure.
 *
 * Skipped if E2E_SKIP_SLOW=true.
 *
 * Requires: E2E_JWT
 * Run: npx vitest run src/__tests__/e2e/provisioning.test.ts --reporter=verbose
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cfg, requireAuth, apiGet, apiPost } from './config.js';

beforeAll(() => {
  requireAuth();
  if (cfg.skipSlow) {
    console.log('Skipping provisioning tests (E2E_SKIP_SLOW=true)');
  }
});

let createdInstanceId: string | null = null;

afterAll(async () => {
  if (!createdInstanceId) return;
  try {
    const res = await fetch(`${cfg.apiUrl}/api/v1/instances/${createdInstanceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cfg.jwt}` },
    });
    console.log(`Cleanup: deleted instance ${createdInstanceId} → ${res.status}`);
  } catch (e) {
    console.warn(`Cleanup failed for ${createdInstanceId}:`, e);
  }
});

describe('Instance provisioning lifecycle', () => {
  it.skipIf(cfg.skipSlow)('POST /api/v1/instances creates a new free instance', async () => {
    const { status, body } = await apiPost('/api/v1/instances', {
      name: `e2e-test-${Date.now()}`,
      tier: 'free',
    });
    expect([200, 201]).toContain(status);
    const inst = body as Record<string, unknown>;
    expect(typeof inst.id).toBe('string');
    expect(inst.status).toMatch(/^(provisioning|active)$/);
    createdInstanceId = inst.id as string;
  });

  it.skipIf(cfg.skipSlow)('instance status transitions from provisioning → active within 5 min', async () => {
    if (!createdInstanceId) return;

    const maxWaitMs = 5 * 60 * 1000; // 5 minutes
    const pollMs    = 10_000;         // poll every 10 seconds
    const start     = Date.now();
    let status      = 'provisioning';

    while (Date.now() - start < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const { body } = await apiGet(`/api/v1/instances/${createdInstanceId}`);
      status = (body as Record<string, unknown>).status as string;
      console.log(`  [${Math.round((Date.now() - start) / 1000)}s] status: ${status}`);
      if (status === 'active') break;
      if (status === 'failed')  break;
    }

    expect(status).toBe('active');
  }, 6 * 60 * 1000); // vitest timeout: 6 min

  it.skipIf(cfg.skipSlow)('active instance returns valid connection details', async () => {
    if (!createdInstanceId) return;
    const { status, body } = await apiGet(`/api/v1/instances/${createdInstanceId}/connection`);
    expect(status).toBe(200);
    const conn = body as Record<string, unknown>;
    expect(typeof conn.host).toBe('string');
    expect(Number(conn.port)).toBeGreaterThan(0);
    expect(typeof conn.password).toBe('string');
  });

  it.skipIf(cfg.skipSlow)('can PING the provisioned Redis', async () => {
    if (!createdInstanceId) return;
    const { body } = await apiGet(`/api/v1/instances/${createdInstanceId}/connection`);
    const conn = body as Record<string, unknown>;

    const { Redis: RedisClass } = await import('ioredis');
    const r = new RedisClass({
      host: conn.host as string,
      port: Number(conn.port),
      password: conn.password as string,
      tls: cfg.redisTls ? {} : undefined,
      connectTimeout: 8000,
      lazyConnect: true,
    });
    try {
      await r.connect();
      expect(await r.ping()).toBe('PONG');
    } finally {
      await r.quit();
    }
  });
});

describe('Provisioning status — failed instance handling', () => {
  it('failed status returns meaningful error (not 500) from connection endpoint', async () => {
    // We use a known-bad UUID to simulate a missing/failed instance
    const { status } = await apiGet('/api/v1/instances/00000000-0000-0000-0000-000000000000/connection');
    // Should be a client error (4xx), never a server error (5xx)
    expect(status).toBeGreaterThanOrEqual(400);
    expect(status).toBeLessThan(500);
  });
});

describe('Auto-provision via /instances/auto', () => {
  it.skipIf(cfg.skipSlow)('POST /api/v1/instances/auto returns instance id', async () => {
    const { status, body } = await apiPost('/api/v1/instances/auto', {});
    // 200 = existing instance returned
    // 201 = new instance created
    // 409 = already has an instance (also fine)
    expect([200, 201, 409]).toContain(status);
    if (status !== 409) {
      expect(typeof (body as Record<string, unknown>).id).toBe('string');
    }
  });
});
