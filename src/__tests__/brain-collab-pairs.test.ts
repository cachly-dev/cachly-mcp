/**
 * brain_collab_pairs — Person↔Person Collaboration Graph (W5).
 *
 * Verifies: empty brain message, pair detection from collaborates edges,
 * bus-factor alert for solo contributors, and min_weight filtering.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleBrainTool } from '../handlers/brain.js';

class MiniRedis {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  async smembers(key: string): Promise<string[]> { return [...(this.sets.get(key) ?? [])]; }

  scanStream(opts: { match: string }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = opts.match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => { emitter.emit('data', matches); emitter.emit('end'); });
    return emitter;
  }

  addPerson(id: string, handle: string, domain: string, count: number) {
    this.store.set(`cachly:ckg:node:${id}`, JSON.stringify({
      id, handle, domain, type: 'person', count, last_active: new Date().toISOString(),
    }));
  }

  addCollabEdge(from: string, to: string, trials: number) {
    const edgeKey = `cachly:ckg:edge:${from}:collaborates:${to}`;
    this.store.set(edgeKey, JSON.stringify({
      from, to, edgeType: 'collaborates',
      successes: trials, trials, confidence: (trials + 1) / (trials + 2),
      last_updated: new Date().toISOString(),
    }));
    if (!this.sets.has(`cachly:ckg:idx:from:${from}`)) this.sets.set(`cachly:ckg:idx:from:${from}`, new Set());
    this.sets.get(`cachly:ckg:idx:from:${from}`)!.add(edgeKey);
  }
}

const getConn = (redis: MiniRedis) => () => Promise.resolve(redis as never);
const apiFetch = async <T>() => ({} as T);

describe('brain_collab_pairs', () => {
  let redis: MiniRedis;
  beforeEach(() => { redis = new MiniRedis(); });

  it('returns guidance message when no contributors found', async () => {
    const out = await handleBrainTool('brain_collab_pairs', { instance_id: 'i' }, getConn(redis), apiFetch) as string;
    expect(out).toContain('No contributors found yet');
    expect(out).toContain('learn_from_attempts');
  });

  it('shows collaboration pair with routing suggestion', async () => {
    redis.addPerson('person:alice', 'alice', 'auth', 5);
    redis.addPerson('person:bob', 'bob', 'payments', 3);
    redis.addCollabEdge('person:alice', 'person:bob', 4);

    const out = await handleBrainTool('brain_collab_pairs', { instance_id: 'i' }, getConn(redis), apiFetch) as string;
    expect(out).toContain('@alice');
    expect(out).toContain('@bob');
    expect(out).toContain('Frag');
    expect(out).toContain('4 collaboration event');
  });

  it('flags solo contributor in bus-factor section', async () => {
    redis.addPerson('person:alice', 'alice', 'auth', 5);
    redis.addPerson('person:dave', 'dave', 'monitoring', 2);
    // alice↔bob pair (bob is not a person node → dave is truly solo)
    // dave has no collaborates edges

    const out = await handleBrainTool('brain_collab_pairs', { instance_id: 'i' }, getConn(redis), apiFetch) as string;
    expect(out).toContain('Bus Factor');
    expect(out).toContain('@dave');
  });

  it('respects min_weight filter', async () => {
    redis.addPerson('person:alice', 'alice', 'auth', 5);
    redis.addPerson('person:bob', 'bob', 'auth', 3);
    redis.addCollabEdge('person:alice', 'person:bob', 1); // low weight

    const out = await handleBrainTool(
      'brain_collab_pairs', { instance_id: 'i', min_weight: 5 }, getConn(redis), apiFetch,
    ) as string;
    // pair is below min_weight → no pair shown
    expect(out).not.toContain('collaboration event');
  });
});
