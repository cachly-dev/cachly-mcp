/**
 * Tests for session_start_summary — focused top-N briefing for large brains.
 *
 * Covers:
 *   - Empty brain returns a graceful message
 *   - Brain with ≤ top_n lessons returns all of them
 *   - Brain with more lessons than top_n returns exactly top_n
 *   - Focus matching boosts relevant lessons to the top
 *
 * Run: npx vitest run src/__tests__/session-start-summary.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';

// ── Minimal in-memory Redis mock ──────────────────────────────────────────────

class MockRedis {
  private store = new Map<string, string>();
  private sets  = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ..._opts: unknown[]): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map(k => this.store.get(k) ?? null);
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
    this.sets.set(key, s);
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const k of keys) { if (this.store.delete(k)) count++; }
    return count;
  }

  async incr(key: string): Promise<number> {
    const next = parseInt(this.store.get(key) ?? '0', 10) + 1;
    this.store.set(key, String(next));
    return next;
  }

  async expire(_key: string, _ttl: number): Promise<number> { return 1; }

  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = opts.match.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(`^${pattern}$`);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => {
      emitter.emit('data', matches);
      emitter.emit('end');
    });
    return emitter;
  }

  _store() { return this.store; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const INSTANCE = 'test-summary-instance';
const NO_FETCH = (async () => { throw new Error('no fetch'); }) as unknown as Parameters<typeof handleBrainTool>[3];

function makeGetConn(redis: MockRedis) {
  return (async (_id: string) => redis as unknown as Redis);
}

interface LessonInput {
  topic: string;
  outcome?: 'success' | 'failure' | 'partial';
  what_worked?: string;
  severity?: 'critical' | 'major' | 'minor';
  recall_count?: number;
  tags?: string[];
  ts?: string;
}

async function seedLesson(redis: MockRedis, lesson: LessonInput): Promise<void> {
  const obj = {
    topic: lesson.topic,
    outcome: lesson.outcome ?? 'success',
    what_worked: lesson.what_worked ?? `Fix for ${lesson.topic}`,
    severity: lesson.severity ?? 'minor',
    recall_count: lesson.recall_count ?? 0,
    tags: lesson.tags ?? [],
    ts: lesson.ts ?? new Date().toISOString(),
    verified_at: new Date().toISOString(),
    confidence: 1.0,
  };
  await redis.set(`cachly:lesson:best:${lesson.topic}`, JSON.stringify(obj));
}

async function callSummary(
  redis: MockRedis,
  args: { focus: string; top_n?: number; author?: string },
): Promise<string> {
  const result = await handleBrainTool(
    'session_start_summary',
    { instance_id: INSTANCE, ...args },
    makeGetConn(redis),
    NO_FETCH,
  );
  return String(result);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('session_start_summary', () => {
  let redis: MockRedis;

  beforeEach(() => {
    redis = new MockRedis();
  });

  // ── 1. Empty brain ──────────────────────────────────────────────────────────
  it('returns graceful message when brain is empty', async () => {
    const result = await callSummary(redis, { focus: 'deploy infra' });
    expect(result).toContain('no lessons yet');
    expect(result).toContain('learn_from_attempts');
  });

  // ── 2. Brain with ≤ top_n lessons returns all ───────────────────────────────
  it('returns all lessons when count is at or below top_n', async () => {
    await seedLesson(redis, { topic: 'api:auth', what_worked: 'Use Bearer token in header' });
    await seedLesson(redis, { topic: 'db:migration', what_worked: 'Run migrations before deploy' });
    await seedLesson(redis, { topic: 'docker:cache', what_worked: 'Order COPY steps by change frequency' });

    const result = await callSummary(redis, { focus: 'deploy', top_n: 10 });

    // All 3 lessons should appear
    expect(result).toContain('api:auth');
    expect(result).toContain('db:migration');
    expect(result).toContain('docker:cache');
    // Footer should say "all N lessons" not "top N of M"
    expect(result).toMatch(/[Aa]ll 3 lessons/);
  });

  // ── 3. Brain with more lessons than top_n returns exactly top_n ─────────────
  it('returns exactly top_n lessons when brain has more', async () => {
    // Seed 20 lessons with no focus-match
    for (let i = 1; i <= 20; i++) {
      await seedLesson(redis, { topic: `unrelated:topic-${i}`, what_worked: `Fix number ${i}` });
    }

    const result = await callSummary(redis, { focus: 'deploy infra', top_n: 10 });

    // Header must say "top 10 of 20"
    expect(result).toContain('top 10 of 20');
    // Footer hint
    expect(result).toContain('session_start');

    // Count lesson lines — each contains a backtick-wrapped topic
    const lessonLines = result.split('\n').filter(l => /`[^`]+:[^`]+-\d+`/.test(l));
    expect(lessonLines).toHaveLength(10);
  });

  // ── 4. Focus matching boosts relevant lessons to top ────────────────────────
  it('boosts focus-matching lessons to the top', async () => {
    // Seed 15 generic lessons with no overlap to "deploy"
    for (let i = 1; i <= 15; i++) {
      await seedLesson(redis, {
        topic: `network:routing-${i}`,
        what_worked: `Routing fix ${i}`,
        recall_count: 0,
      });
    }
    // Seed 2 lessons that match focus "deploy"
    await seedLesson(redis, {
      topic: 'deploy:k8s',
      what_worked: 'Always check rollout status before switching Caddy',
      severity: 'critical',
      recall_count: 12,
    });
    await seedLesson(redis, {
      topic: 'deploy:migration',
      what_worked: 'Run DB migrations before flipping traffic',
      severity: 'major',
      recall_count: 5,
    });

    const result = await callSummary(redis, { focus: 'deploy', top_n: 5 });

    // Both deploy lessons must appear in top 5
    expect(result).toContain('deploy:k8s');
    expect(result).toContain('deploy:migration');

    // The deploy:k8s line should appear before a generic routing line
    const deployPos = result.indexOf('deploy:k8s');
    const routingPos = result.indexOf('network:routing-1');
    // routingPos may be -1 (not in top 5) — that's fine
    if (routingPos !== -1) {
      expect(deployPos).toBeLessThan(routingPos);
    }

    // Header shows we're slicing top 5 of 17
    expect(result).toContain('top 5 of 17');
  });

  // ── 5. top_n is clamped to max 25 ───────────────────────────────────────────
  it('clamps top_n to 25 even when higher value is passed', async () => {
    for (let i = 1; i <= 30; i++) {
      await seedLesson(redis, { topic: `topic:item-${i}`, what_worked: `Fix ${i}` });
    }

    const result = await callSummary(redis, { focus: 'topic', top_n: 100 });

    // Should show at most 25
    const lessonLines = result.split('\n').filter(l => /`topic:item-\d+`/.test(l));
    expect(lessonLines.length).toBeLessThanOrEqual(25);
    expect(result).toContain('top 25 of 30');
  });
});
