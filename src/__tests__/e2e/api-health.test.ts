/**
 * E2E: API health & public endpoints
 *
 * These tests require NO credentials — they hit publicly accessible endpoints.
 * Run: E2E_API_URL=https://api.dev.cachly.dev npx vitest run src/__tests__/e2e/api-health.test.ts
 */

import { describe, it, expect } from 'vitest';
import { cfg } from './config.js';

describe('API health (no auth required)', () => {
  it('GET /health returns 200', async () => {
    const res = await fetch(`${cfg.apiUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('GET /health body contains status ok', async () => {
    const res = await fetch(`${cfg.apiUrl}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status ?? body.ok ?? body.alive).toBeTruthy();
  });

  it('unknown route returns 404, not 500', async () => {
    const res = await fetch(`${cfg.apiUrl}/api/v1/does-not-exist-xyz`);
    expect(res.status).toBe(404);
  });
});

describe('Device flow init (no auth required)', () => {
  it('GET /api/v1/auth/device/code returns device_code and user_code', async () => {
    const res = await fetch(`${cfg.apiUrl}/api/v1/auth/device/code`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.device_code).toBe('string');
    expect(typeof body.user_code).toBe('string');
    expect(typeof body.verification_uri).toBe('string');
    expect(body.verification_uri).toContain('cachly.dev');
  });

  it('device_code is at least 20 chars (not truncated)', async () => {
    const res = await fetch(`${cfg.apiUrl}/api/v1/auth/device/code`);
    const body = await res.json() as Record<string, unknown>;
    expect((body.device_code as string).length).toBeGreaterThanOrEqual(20);
  });

  it('expires_in is a positive number', async () => {
    const res = await fetch(`${cfg.apiUrl}/api/v1/auth/device/code`);
    const body = await res.json() as Record<string, unknown>;
    expect(Number(body.expires_in)).toBeGreaterThan(0);
  });
});

describe('Badge endpoint (public, no auth)', () => {
  it('returns 400 or 404 for an invalid instance id', async () => {
    const res = await fetch(`${cfg.apiUrl}/api/v1/badge/not-a-real-uuid`);
    expect([400, 404]).toContain(res.status);
  });

  it('returns badge JSON for a valid instance id', async () => {
    if (!cfg.instanceId) return; // skip if not configured
    const res = await fetch(`${cfg.apiUrl}/api/v1/badge/${cfg.instanceId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.schemaVersion).toBe('number');
    expect(typeof body.label).toBe('string');
    expect(typeof body.message).toBe('string');
  });

  it('badge message contains lesson count (numeric string)', async () => {
    if (!cfg.instanceId) return;
    const res = await fetch(`${cfg.apiUrl}/api/v1/badge/${cfg.instanceId}`);
    const body = await res.json() as Record<string, unknown>;
    expect((body.message as string)).toMatch(/\d+/);
  });
});

describe('Telemetry endpoint (public)', () => {
  it('POST /api/v1/telemetry/mcp accepts anonymous event', async () => {
    const res = await fetch(`${cfg.apiUrl}/api/v1/telemetry/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'e2e_test_ping', version: '0.0.0', editor: 'test', source: 'e2e' }),
    });
    expect([200, 202, 204]).toContain(res.status);
  });

  it('POST /api/v1/telemetry/mcp accepts jwt-attributed event', async () => {
    if (!cfg.jwt) return;
    const res = await fetch(`${cfg.apiUrl}/api/v1/telemetry/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'e2e_test_ping_authed',
        version: '0.0.0',
        editor: 'test',
        source: 'e2e',
        jwt: cfg.jwt,
        instance_id: cfg.instanceId,
      }),
    });
    expect([200, 202, 204]).toContain(res.status);
  });
});
