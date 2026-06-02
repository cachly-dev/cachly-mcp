/**
 * brain_plan — generative planning on top of the CKG.
 *
 * Verifies the handler turns relevant lessons into an ordered action plan:
 * failure modes to avoid, proven steps (dependency-aware), pre-flight checklist.
 * Uses an in-memory Redis stub (only get + scanStream are exercised).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleSyndicateTool } from '../handlers/syndicate.js';

class MiniRedis {
  store = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }
  scanStream(opts: { match: string }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = opts.match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => { emitter.emit('data', matches); emitter.emit('end'); });
    return emitter;
  }
}

function seed(redis: MiniRedis, lesson: Record<string, unknown> & { topic: string }) {
  redis.store.set(`cachly:lesson:best:${lesson.topic}`, JSON.stringify({
    outcome: 'success', what_worked: '', ts: new Date().toISOString(),
    verified_at: new Date().toISOString(), confidence: 1.0, recall_count: 3, ...lesson,
  }));
}

const getConn = (redis: MiniRedis) => () => Promise.resolve(redis as never);
const apiFetch = async <T>() => ({} as T);

describe('brain_plan', () => {
  let redis: MiniRedis;
  beforeEach(() => { redis = new MiniRedis(); });

  it('requires a task', async () => {
    await expect(
      handleSyndicateTool('brain_plan', { instance_id: 'i', task: '  ' }, getConn(redis), apiFetch),
    ).rejects.toThrow(/task is required/);
  });

  it('returns a graceful message when the brain has no relevant lessons', async () => {
    const out = await handleSyndicateTool(
      'brain_plan',
      { instance_id: 'i', task: 'migrate postgres 14 to 16' },
      getConn(redis), apiFetch,
    );
    expect(out).toContain('No grounded plan yet');
  });

  it('assembles failure modes, ordered steps, and a checklist from relevant lessons', async () => {
    seed(redis, {
      topic: 'postgres:migration-lock-timeout', outcome: 'failure', severity: 'critical',
      what_failed: 'postgres migration held an ACCESS EXCLUSIVE lock and timed out',
      tags: ['postgres', 'migration'],
    });
    seed(redis, {
      topic: 'postgres:online-migration', outcome: 'success', severity: 'major',
      what_worked: 'run postgres migration with lock_timeout and CONCURRENTLY',
      commands: ['SET lock_timeout = "5s"', 'CREATE INDEX CONCURRENTLY ...'],
      file_paths: ['db/migrate/0042_add_index.sql'],
      tags: ['postgres', 'migration'],
    });
    seed(redis, {
      topic: 'postgres:rollback-plan', outcome: 'success', severity: 'major',
      what_worked: 'keep a postgres rollback migration ready',
      depends_on: ['postgres:online-migration'],
      tags: ['postgres'],
    });

    const out = await handleSyndicateTool(
      'brain_plan',
      { instance_id: 'i', task: 'postgres migration to 16' },
      getConn(redis), apiFetch,
    ) as string;

    expect(out).toContain('Brain Plan');
    expect(out).toContain('Likely failure modes');
    expect(out).toContain('postgres:migration-lock-timeout');
    expect(out).toContain('Recommended steps');
    expect(out).toContain('Pre-flight checklist');
    // The dependency (online-migration) must be listed before the lesson that
    // depends on it (rollback-plan).
    const idxDep = out.indexOf('postgres:online-migration');
    const idxNeedsDep = out.indexOf('postgres:rollback-plan');
    expect(idxDep).toBeGreaterThan(-1);
    expect(idxNeedsDep).toBeGreaterThan(-1);
    expect(idxDep).toBeLessThan(idxNeedsDep);
  });
});
