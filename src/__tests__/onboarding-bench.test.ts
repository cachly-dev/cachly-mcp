/**
 * CI guard for the onboarding benchmark (time-to-first-recall).
 *
 * Defends the headline result: a starter-seeded Brain answers a new user's very
 * first realistic query, while an empty Brain answers nothing. If the starter
 * corpus, the cold-start queries, or the search engine regress such that the
 * first-query hit rate drops, CI fails here.
 *
 * Run: npx vitest run src/__tests__/onboarding-bench.test.ts
 */

import { describe, it, expect } from 'vitest';
import { runOnboardingBenchmark, runFirstContactSimulation, COLD_START_QUERIES } from '../bench/onboarding-bench.js';
import { STARTER_CORPUS } from '../starter-corpus.js';
import { buildFirstContactReport, suggestRecallQueries } from '../first-contact.js';

describe('onboarding benchmark — time-to-first-recall', () => {
  it('an empty Brain answers nothing on the first query (cold start)', async () => {
    const r = await runOnboardingBenchmark();
    expect(r.cold.answeredRate).toBe(0);
    expect(r.cold.hitAt1).toBe(0);
    expect(r.cold.hitAt3).toBe(0);
  });

  it('a starter-seeded Brain answers the first query with high precision', async () => {
    const r = await runOnboardingBenchmark();
    // Headline guardrails — generous margins so legitimate corpus tweaks don't break CI,
    // but a real regression (search broken, corpus mismatched) is caught.
    expect(r.seeded.answeredRate).toBe(1);          // every query returns something
    expect(r.seeded.hitAt3).toBeGreaterThanOrEqual(0.9);
    expect(r.seeded.hitAt1).toBeGreaterThanOrEqual(0.7);
    expect(r.seeded.mrr).toBeGreaterThanOrEqual(0.8);
  });

  it('seeding produces a large, positive lift on every metric', async () => {
    const r = await runOnboardingBenchmark();
    expect(r.seeded.hitAt1).toBeGreaterThan(r.cold.hitAt1);
    expect(r.seeded.hitAt3).toBeGreaterThan(r.cold.hitAt3);
    expect(r.seeded.mrr).toBeGreaterThan(r.cold.mrr);
    expect(r.seeded.answeredRate).toBeGreaterThan(r.cold.answeredRate);
  });

  it('every cold-start query maps to a real starter topic', () => {
    const topics = new Set(STARTER_CORPUS.map(l => l.topic));
    for (const q of COLD_START_QUERIES) {
      expect(q.relevant.length).toBeGreaterThan(0);
      for (const rel of q.relevant) {
        expect(topics.has(rel)).toBe(true);
      }
    }
  });

  it('there is at least one cold-start query per starter lesson topic', () => {
    // Ensures the bench exercises the whole corpus, not just a flattering subset.
    const queried = new Set(COLD_START_QUERIES.flatMap(q => q.relevant));
    const topics = STARTER_CORPUS.map(l => l.topic);
    const uncovered = topics.filter(t => !queried.has(t));
    expect(uncovered).toEqual([]);
  });
});

describe('first-contact response — brain_from_git onboarding UX (P1-5)', () => {
  it('seeding response carries summary, proof-of-value, suggested queries, and duration', async () => {
    const fc = await runFirstContactSimulation();

    // (a) seeded summary — counts by category
    expect(fc.report).toContain('brain_from_git');
    expect(fc.report).toContain('Ingested: **16** lessons');
    expect(fc.report).toContain('What your Brain just learned (by category):');

    // (b) proof of value — a real search hit against a just-seeded topic
    expect(fc.proofHit).toBe(true);
    expect(fc.report).toContain('Proof — your first recall already works.');
    expect(fc.report).toContain('→ Top hit:');

    // (c) 2-3 copy-pasteable next queries
    expect(fc.suggestedQueries.length).toBeGreaterThanOrEqual(2);
    expect(fc.suggestedQueries.length).toBeLessThanOrEqual(3);
    expect(fc.report).toContain('Try these next (copy-paste):');
    for (const q of fc.suggestedQueries) {
      expect(q).toMatch(/^smart_recall\(instance_id="demo-instance", query=".+"\)$/);
      expect(fc.report).toContain(q);
    }

    // duration is measured and reported in the response text
    expect(fc.report).toMatch(/Seeding took \d+(\.\d+)?(ms|s)/);

    // The roadmap target: time-to-first-recall < 5 minutes. The in-memory
    // simulation must be orders of magnitude below that.
    expect(fc.timeToFirstRecallMs).toBeLessThan(5 * 60 * 1000);
  });

  it('empty repo degrades gracefully — guidance instead of empty stats', () => {
    const report = buildFirstContactReport({
      repoDir: '/tmp/fresh-repo', revRange: 'HEAD',
      processed: 0, ingested: 0, skipped: 0, durationMs: 42,
      isIncremental: false, instanceId: 'i-1', categories: [], suggestedQueries: [],
      emptyReason: 'No commits found in `/tmp/fresh-repo` on branch `HEAD`.',
    });
    expect(report).toContain('Nothing to learn from this git history yet');
    expect(report).toContain('brain_seed_starter(instance_id="i-1")');
    expect(report).toContain('smart_recall(instance_id="i-1"');
    expect(report).not.toContain('What your Brain just learned');
    expect(report).not.toContain('undefined');
  });

  it('small repo gets explicit growth guidance', () => {
    const report = buildFirstContactReport({
      repoDir: '/tmp/tiny-repo', revRange: 'HEAD',
      processed: 2, ingested: 2, skipped: 0, durationMs: 1500,
      isIncremental: false, instanceId: 'i-2',
      categories: [['fix', 1], ['chore', 1]],
      severities: [['minor', 2]],
      suggestedQueries: suggestRecallQueries(['fix:auth-token', 'chore:deps'], 'i-2'),
    });
    expect(report).toContain('Small git history — only 2 lessons');
    expect(report).toContain('brain_seed_starter(instance_id="i-2")');
    expect(report).toContain('Seeding took 1.5s');
  });

  it('suggestRecallQueries dedupes domains and caps at 3', () => {
    const qs = suggestRecallQueries(
      ['fix:auth-token', 'feat:auth-token', 'fix:slow-build', 'perf:cache-miss', 'fix:another-thing'],
      'i-3',
    );
    expect(qs).toHaveLength(3);
    expect(qs[0]).toBe('smart_recall(instance_id="i-3", query="auth token")');
    expect(new Set(qs).size).toBe(3);
  });
});
