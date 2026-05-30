/**
 * Unit tests for the Brain Viz 3D graph export (brain_graph).
 *
 * Covers (no real network or Redis required):
 *   - node export with kind detection (concept/person/file/service) + groups
 *   - edge export read from stored CKGEdge value (robust to ':' in ids)
 *   - dangling-edge pruning when an endpoint is filtered out
 *   - domain filter, min_confidence filter, max_nodes cap + truncation flag
 *   - summary vs json format
 *   - empty brain → valid empty graph
 *   - schema marker stability (frontend contract)
 *
 * Run: npx vitest run src/__tests__/viz.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleVizTool } from '../handlers/viz.js';
import type { Redis } from 'ioredis';

// ── In-memory Redis mock (only get + scanStream are exercised by viz) ─────────

class MockRedis {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  scanStream(opts: { match: string; count?: number }): EventEmitter & { destroy?: () => void } {
    const emitter: EventEmitter & { destroy?: () => void } = new EventEmitter();
    let destroyed = false;
    emitter.destroy = () => { destroyed = true; emitter.emit('close'); };
    const pattern = opts.match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => {
      if (destroyed) return;
      emitter.emit('data', matches);
      if (!destroyed) emitter.emit('end');
    });
    return emitter;
  }
}

function makeRedis(): { redis: MockRedis; getConnection: (id: string) => Promise<Redis> } {
  const redis = new MockRedis();
  const getConnection = async () => redis as unknown as Redis;
  return { redis, getConnection };
}

const apiFetch = (async () => null) as unknown as <T>(p: string, o?: RequestInit) => Promise<T>;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function node(redis: MockRedis, id: string, extra: Record<string, unknown> = {}) {
  redis.store.set(`cachly:ckg:node:${id}`, JSON.stringify({ id, domain: id.split(':').pop()?.split('-')[0] ?? '', count: 1, ts: new Date().toISOString(), ...extra }));
}

function edge(redis: MockRedis, from: string, edgeType: string, to: string, confidence = 0.8, trials = 3) {
  redis.store.set(`cachly:ckg:edge:${from}:${edgeType}:${to}`, JSON.stringify({ from, to, edgeType, successes: Math.round(confidence * trials), trials, confidence, last_updated: new Date().toISOString() }));
}

type GNode = { id: string; name: string; type: string; group: number; val: number; count: number; domain: string };
type GLink = { source: string; target: string; type: string; value: number; trials: number };
function parseGraph(out: string): { schema: string; nodes: GNode[]; links: GLink[]; meta: Record<string, unknown> } {
  const m = out.match(/```json\n([\s\S]*?)\n```/);
  expect(m).toBeTruthy();
  return JSON.parse(m![1]);
}

async function run(getConnection: (id: string) => Promise<Redis>, args: Record<string, unknown> = {}) {
  return (await handleVizTool('brain_graph', { instance_id: 'inst-1', ...args }, getConnection, apiFetch)) as string;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('brain_graph — viz export', () => {
  let redis: MockRedis;
  let getConnection: (id: string) => Promise<Redis>;

  beforeEach(() => {
    const m = makeRedis();
    redis = m.redis;
    getConnection = m.getConnection;
  });

  it('returns null for non-viz tools', async () => {
    expect(await handleVizTool('something_else', {}, getConnection, apiFetch)).toBeNull();
  });

  it('exports an empty but valid graph for a fresh brain', async () => {
    const g = parseGraph(await run(getConnection));
    expect(g.schema).toBe('cachly.brain_graph/v1');
    expect(g.nodes).toEqual([]);
    expect(g.links).toEqual([]);
    expect(g.meta.node_count).toBe(0);
  });

  it('detects node kinds and assigns stable color groups', async () => {
    node(redis, 'docker:layer-cache');     // concept
    node(redis, 'person:alice', { handle: 'alice' });
    node(redis, 'file:src/auth.ts', { path: 'src/auth.ts' });
    node(redis, 'service:auth-api', { name: 'auth-api' });

    const g = parseGraph(await run(getConnection));
    const byId = Object.fromEntries(g.nodes.map(n => [n.id, n]));
    expect(byId['docker:layer-cache'].type).toBe('concept');
    expect(byId['docker:layer-cache'].group).toBe(1);
    expect(byId['person:alice'].type).toBe('person');
    expect(byId['person:alice'].group).toBe(2);
    expect(byId['person:alice'].name).toBe('alice');
    expect(byId['file:src/auth.ts'].type).toBe('file');
    expect(byId['file:src/auth.ts'].name).toBe('auth.ts'); // basename label
    expect(byId['service:auth-api'].type).toBe('service');
    expect(byId['service:auth-api'].group).toBe(4);
    expect(g.meta.node_types).toEqual({ concept: 1, person: 1, file: 1, service: 1 });
  });

  it('exports edges from the stored value (ids containing ":" are safe)', async () => {
    node(redis, 'docker:layer-cache');
    node(redis, 'ci:flaky-tests');
    edge(redis, 'docker:layer-cache', 'co-occurs', 'ci:flaky-tests', 0.75, 4);

    const g = parseGraph(await run(getConnection));
    expect(g.links).toHaveLength(1);
    expect(g.links[0]).toMatchObject({
      source: 'docker:layer-cache',
      target: 'ci:flaky-tests',
      type: 'co-occurs',
      value: 0.75,
      trials: 4,
    });
  });

  it('prunes dangling edges whose endpoint was filtered out', async () => {
    node(redis, 'auth:jwt-skew', { domain: 'auth' });
    node(redis, 'docker:layer-cache', { domain: 'docker' });
    edge(redis, 'auth:jwt-skew', 'causes', 'docker:layer-cache', 0.9);

    // domain filter keeps only the auth node → the edge is now dangling
    const g = parseGraph(await run(getConnection, { domain: 'auth' }));
    expect(g.nodes.map(n => n.id)).toEqual(['auth:jwt-skew']);
    expect(g.links).toHaveLength(0);
  });

  it('drops edges below min_confidence', async () => {
    node(redis, 'a:one'); node(redis, 'b:two');
    edge(redis, 'a:one', 'fixes', 'b:two', 0.3);
    edge(redis, 'b:two', 'fixes', 'a:one', 0.95);

    const g = parseGraph(await run(getConnection, { min_confidence: 0.5 }));
    expect(g.links).toHaveLength(1);
    expect(g.links[0].value).toBe(0.95);
  });

  it('scales node val with reference count', async () => {
    node(redis, 'big:concept', { count: 100 });
    node(redis, 'small:concept', { count: 1 });
    const g = parseGraph(await run(getConnection));
    const big = g.nodes.find(n => n.id === 'big:concept');
    const small = g.nodes.find(n => n.id === 'small:concept');
    expect(big.val).toBeGreaterThan(small.val);
  });

  it('caps nodes at max_nodes and flags truncation', async () => {
    for (let i = 0; i < 10; i++) node(redis, `c:${i}`);
    const g = parseGraph(await run(getConnection, { max_nodes: 5 }));
    expect(g.nodes.length).toBeLessThanOrEqual(5);
    expect(g.meta.truncated).toBe(true);
  });

  it('summary format is human-readable and omits the json block', async () => {
    node(redis, 'docker:layer-cache');
    node(redis, 'person:bob', { handle: 'bob' });
    const out = await run(getConnection, { format: 'summary' });
    expect(out).toContain('Brain Graph');
    expect(out).toContain('nodes');
    expect(out).not.toContain('```json');
  });

  it('keeps the schema marker stable for the frontend contract', async () => {
    node(redis, 'x:y');
    const g = parseGraph(await run(getConnection));
    expect(g.schema).toBe('cachly.brain_graph/v1');
    // node shape contract the 3D frontend depends on
    expect(g.nodes[0]).toHaveProperty('id');
    expect(g.nodes[0]).toHaveProperty('name');
    expect(g.nodes[0]).toHaveProperty('val');
    expect(g.nodes[0]).toHaveProperty('group');
  });
});
