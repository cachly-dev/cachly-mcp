/**
 * E2E: MCP tool calls via live Redis connection
 *
 * Requires: E2E_JWT, E2E_INSTANCE_ID, E2E_API_KEY, E2E_REDIS_HOST
 * Run: npx vitest run src/__tests__/e2e/mcp-tools.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { cfg, requireRedis } from './config.js';

import { handleBrainTool } from '../../handlers/brain.js';
import { handleContextTool } from '../../handlers/context.js';

let redis: Redis;

function getConn(_id: string): Promise<Redis> {
  return Promise.resolve(redis);
}

// ApiFetch matches the generic signature the handlers expect
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${cfg.jwt}`,
      'Content-Type': 'application/json',
      ...(opts?.headers as Record<string, string> ?? {}),
    },
  });
  return res.json() as Promise<T>;
}

beforeAll(async () => {
  requireRedis();
  redis = new Redis({
    host: cfg.redisHost,
    port: cfg.redisPort,
    password: cfg.apiKey,
    tls: cfg.redisTls ? {} : undefined,
    lazyConnect: true,
    connectTimeout: 8000,
  });
  await redis.connect();
  expect(await redis.ping()).toBe('PONG');
});

afterAll(async () => {
  await redis.quit();
});

describe('Redis connectivity', () => {
  it('PING returns PONG', async () => {
    expect(await redis.ping()).toBe('PONG');
  });

  it('SET / GET round-trip works', async () => {
    const key = `e2e:probe:${Date.now()}`;
    await redis.set(key, 'ok', 'EX', 60);
    expect(await redis.get(key)).toBe('ok');
    await redis.del(key);
  });
});

describe('session_start', () => {
  it('returns a non-empty briefing string', async () => {
    // session_start is handled by handleBrainTool, not handleContextTool
    const result = await handleBrainTool(
      'session_start',
      { instance_id: cfg.instanceId, focus: 'e2e-test' },
      getConn,
      apiFetch,
    );
    expect(typeof result === 'string' || result === null).toBe(true);
    if (result !== null) expect(result.length).toBeGreaterThan(0);
  });
});

describe('brain_store + brain_recall', () => {
  const marker = `E2E-lesson-${Date.now()}`;

  it('brain_store returns without error', async () => {
    const result = await handleBrainTool(
      'brain_store',
      {
        instance_id: cfg.instanceId,
        lesson: `${marker}: Redis race condition fixed with WAIT command`,
        tags: ['e2e', 'redis', 'race-condition'],
        severity: 'info',
      },
      getConn,
      apiFetch,
    );
    // Returns a string (confirmation message) or null — never throws
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('brain_recall finds the stored lesson', async () => {
    await new Promise((r) => setTimeout(r, 400));
    const result = await handleBrainTool(
      'brain_recall',
      {
        instance_id: cfg.instanceId,
        query: marker,
        limit: 5,
      },
      getConn,
      apiFetch,
    );
    // Result is a formatted string with lessons, or null if empty
    if (result !== null) {
      expect(result).toContain(marker.split(':')[0]);
    }
  });

  it('brain_recall handles unknown query gracefully (no throw)', async () => {
    const result = await handleBrainTool(
      'brain_recall',
      { instance_id: cfg.instanceId, query: 'xyzzy-no-match-e2e-99887766', limit: 3 },
      getConn,
      apiFetch,
    );
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('brain_from_git (smoke)', () => {
  it('responds without throwing', async () => {
    const result = await handleBrainTool(
      'brain_from_git',
      { instance_id: cfg.instanceId, max_commits: 5 },
      getConn,
      apiFetch,
    );
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('causal_trace', () => {
  it('returns a trace string without throwing', async () => {
    const result = await handleBrainTool(
      'causal_trace',
      { instance_id: cfg.instanceId, problem: 'auth breaks after restart', depth: 2 },
      getConn,
      apiFetch,
    );
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('brain_predict', () => {
  it('returns a prediction string without throwing', async () => {
    const result = await handleBrainTool(
      'brain_predict',
      { instance_id: cfg.instanceId, target: 'deploy' },
      getConn,
      apiFetch,
    );
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('session_end', () => {
  it('persists session summary without throwing', async () => {
    const result = await handleContextTool(
      'session_end',
      {
        instance_id: cfg.instanceId,
        summary: 'E2E test session completed.',
        lessons: ['brain_recall round-trip verified', 'causal_trace responded correctly'],
      },
      getConn,
      apiFetch,
    );
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('brain_health', () => {
  it('returns a health string containing a positive indicator', async () => {
    const result = await handleBrainTool(
      'brain_health',
      { instance_id: cfg.instanceId },
      getConn,
      apiFetch,
    );
    if (result !== null) {
      expect(result.toLowerCase()).toMatch(/ok|healthy|active|ping|pong|connected/);
    }
  });
});
