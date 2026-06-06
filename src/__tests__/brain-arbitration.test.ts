/**
 * brain_conflicts + brain_resolve_conflict — multi-agent arbitration (Move 4).
 *
 * Verifies the arbitration inbox lists unresolved belief conflicts and live
 * agents, and that resolution decays the losing CKG edges, archives the losing
 * lesson, and marks the conflict resolved.
 *
 * Uses an in-memory Redis stub (get, set, mget, smembers, scanStream).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleSyndicateTool } from '../handlers/syndicate.js';
import { ckgSlug } from '../ckg.js';

class MiniRedis {
  store = new Map<string, string>();
  sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map(k => this.store.get(k) ?? null);
  }
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  sadd(key: string, member: string) {
    const s = this.sets.get(key) ?? new Set<string>();
    s.add(member);
    this.sets.set(key, s);
  }
  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = opts.match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => { emitter.emit('data', matches); emitter.emit('end'); });
    return emitter;
  }
}

function makeConn(redis: MiniRedis) {
  return (async (_id: string) => redis) as unknown as Parameters<typeof handleSyndicateTool>[2];
}
const noopFetch = (async () => ({})) as unknown as Parameters<typeof handleSyndicateTool>[3];

const INSTANCE = 'test-instance';

function seedConflict(redis: MiniRedis, topic: string, opts: Partial<{ reported_by: string; resolved: boolean; fix_confidence: number; fix_trials: number }> = {}) {
  const conceptId = ckgSlug(topic);
  redis.store.set(`cachly:ckg:conflict:${conceptId}`, JSON.stringify({
    topic, concept_id: conceptId,
    detected_at: new Date().toISOString(),
    fix_confidence: opts.fix_confidence ?? 0.85,
    fix_trials: opts.fix_trials ?? 4,
    failure_outcome: 'failure',
    reported_by: opts.reported_by ?? 'agent-bob',
    resolved: opts.resolved ?? false,
  }));
}

function seedAgent(redis: MiniRedis, author: string, topic = 'api:auth') {
  redis.store.set(`cachly:agents:active:${author}`, JSON.stringify({
    author, last_topic: topic, last_outcome: 'success', ts: new Date().toISOString(),
  }));
}

function seedFixEdge(redis: MiniRedis, topic: string, confidence = 0.85) {
  const conceptId = ckgSlug(topic);
  const edgeKey = `cachly:ckg:edge:${conceptId}:fixes:target`;
  redis.store.set(edgeKey, JSON.stringify({ from: conceptId, to: 'target', edgeType: 'fixes', confidence, trials: 4 }));
  redis.sadd(`cachly:ckg:idx:from:${conceptId}`, edgeKey);
}

function seedLesson(redis: MiniRedis, topic: string, outcome: string, state = 'active') {
  redis.store.set(`cachly:lesson:best:${topic}`, JSON.stringify({
    topic, outcome, what_worked: 'x', ts: new Date().toISOString(),
    recall_count: 2, state, audit_trail: [],
  }));
}

async function callTool(redis: MiniRedis, name: string, args: Record<string, unknown>) {
  return handleSyndicateTool(name, { instance_id: INSTANCE, ...args }, makeConn(redis), noopFetch);
}

describe('brain_conflicts', () => {
  let redis: MiniRedis;
  beforeEach(() => { redis = new MiniRedis(); });

  it('reports consensus when there are no conflicts', async () => {
    const result = await callTool(redis, 'brain_conflicts', {});
    expect(result).toContain('No unresolved belief conflicts');
  });

  it('lists an unresolved conflict with its reporter', async () => {
    seedConflict(redis, 'fix:jwks-rotation', { reported_by: 'agent-alice' });
    const result = await callTool(redis, 'brain_conflicts', {});
    expect(result).toContain('Unresolved belief conflicts');
    expect(result).toContain('fix:jwks-rotation');
    expect(result).toContain('agent-alice');
  });

  it('excludes already-resolved conflicts', async () => {
    seedConflict(redis, 'fix:resolved-topic', { resolved: true });
    const result = await callTool(redis, 'brain_conflicts', {});
    expect(result).toContain('No unresolved belief conflicts');
  });

  it('lists active agents within the window', async () => {
    seedAgent(redis, 'agent-bob', 'deploy:k8s');
    seedAgent(redis, 'agent-carol', 'api:cors');
    const result = await callTool(redis, 'brain_conflicts', {});
    expect(result).toContain('Active agents');
    expect(result).toContain('agent-bob');
    expect(result).toContain('agent-carol');
  });
});

describe('brain_resolve_conflict', () => {
  let redis: MiniRedis;
  beforeEach(() => { redis = new MiniRedis(); });

  it('rejects an invalid winner', async () => {
    await expect(callTool(redis, 'brain_resolve_conflict', { topic: 'fix:x', winner: 'maybe' }))
      .rejects.toThrow(/winner must be/);
  });

  it('requires a topic', async () => {
    await expect(callTool(redis, 'brain_resolve_conflict', { topic: '', winner: 'success' }))
      .rejects.toThrow(/topic is required/);
  });

  it('returns a friendly message when no conflict exists', async () => {
    const result = await callTool(redis, 'brain_resolve_conflict', { topic: 'fix:nonexistent', winner: 'success' });
    expect(result).toContain('No active conflict found');
  });

  it('winner=failure decays the fixes edge to 0.1 and archives the success lesson', async () => {
    seedConflict(redis, 'fix:jwks-rotation');
    seedFixEdge(redis, 'fix:jwks-rotation', 0.85);
    seedLesson(redis, 'fix:jwks-rotation', 'success');

    const result = await callTool(redis, 'brain_resolve_conflict', { topic: 'fix:jwks-rotation', winner: 'failure' });
    expect(result).toContain('Conflict resolved');
    expect(result).toContain('fix retired');

    // Edge decayed
    const conceptId = ckgSlug('fix:jwks-rotation');
    const edgeRaw = redis.store.get(`cachly:ckg:edge:${conceptId}:fixes:target`);
    expect(JSON.parse(edgeRaw!).confidence).toBe(0.1);

    // Losing success lesson archived
    const lessonRaw = redis.store.get('cachly:lesson:best:fix:jwks-rotation');
    const lesson = JSON.parse(lessonRaw!);
    expect(lesson.state).toBe('archived');
    expect(lesson.audit_trail.at(-1).action).toBe('conflict_loser_archived');
  });

  it('winner=success does not decay edges and reactivates a provisional lesson', async () => {
    seedConflict(redis, 'fix:retry-logic');
    seedFixEdge(redis, 'fix:retry-logic', 0.85);
    seedLesson(redis, 'fix:retry-logic', 'success', 'provisional');

    const result = await callTool(redis, 'brain_resolve_conflict', { topic: 'fix:retry-logic', winner: 'success' });
    expect(result).toContain('reaffirmed');

    // Edge NOT decayed
    const conceptId = ckgSlug('fix:retry-logic');
    const edgeRaw = redis.store.get(`cachly:ckg:edge:${conceptId}:fixes:target`);
    expect(JSON.parse(edgeRaw!).confidence).toBe(0.85);

    // Provisional success lesson reactivated
    const lesson = JSON.parse(redis.store.get('cachly:lesson:best:fix:retry-logic')!);
    expect(lesson.state).toBe('active');
  });

  it('marks the conflict resolved so brain_conflicts no longer lists it', async () => {
    seedConflict(redis, 'fix:double-write');
    seedLesson(redis, 'fix:double-write', 'success');

    await callTool(redis, 'brain_resolve_conflict', { topic: 'fix:double-write', winner: 'success', resolved_by: 'heinrich' });

    const conceptId = ckgSlug('fix:double-write');
    const marker = JSON.parse(redis.store.get(`cachly:ckg:conflict:${conceptId}`)!);
    expect(marker.resolved).toBe(true);
    expect(marker.winner).toBe('success');
    expect(marker.resolved_by).toBe('heinrich');

    // brain_conflicts now reports consensus
    const list = await callTool(redis, 'brain_conflicts', {});
    expect(list).toContain('No unresolved belief conflicts');
  });
});
