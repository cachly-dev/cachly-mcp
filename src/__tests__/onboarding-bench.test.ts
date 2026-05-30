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
import { runOnboardingBenchmark, COLD_START_QUERIES } from '../bench/onboarding-bench.js';
import { STARTER_CORPUS } from '../starter-corpus.js';

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
