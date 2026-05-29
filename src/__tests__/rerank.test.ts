/**
 * Tests for quality-aware reranking and the Cachly-Bench regression guard.
 */
import { describe, it, expect } from 'vitest';
import { qualityMultiplier, extractLessonQuality, rerankByQuality, type LessonQuality } from '../rerank.js';
import type { KeywordMatch } from '../search.js';
import { runBenchmark } from '../bench/cachly-bench.js';

const lessonMatch = (topic: string, score: number, lesson: Partial<LessonQuality> & Record<string, unknown>): KeywordMatch => ({
  key: `cachly:lesson:best:${topic}`,
  content: JSON.stringify(lesson),
  score,
  matchedWords: ['x'],
});

describe('qualityMultiplier', () => {
  it('returns neutral 1.0 for documents with no quality signal', () => {
    expect(qualityMultiplier(null)).toBe(1.0);
    expect(qualityMultiplier({})).toBe(1.0);
  });

  it('ranks a proven success above a fresh failure', () => {
    const success = qualityMultiplier({ outcome: 'success', confidence: 0.95, recall_count: 12 });
    const failure = qualityMultiplier({ outcome: 'failure', confidence: 0.3, recall_count: 0 });
    expect(success).toBeGreaterThan(failure);
  });

  it('rewards proven-ness (recall_count) but saturates', () => {
    const never = qualityMultiplier({ outcome: 'success', confidence: 0.8, recall_count: 0 });
    const some = qualityMultiplier({ outcome: 'success', confidence: 0.8, recall_count: 5 });
    const many = qualityMultiplier({ outcome: 'success', confidence: 0.8, recall_count: 500 });
    expect(some).toBeGreaterThan(never);
    expect(many).toBeGreaterThan(some);
    expect(many - some).toBeLessThan(some - never + 0.2); // diminishing returns
  });

  it('clamps within [0.5, 2.5]', () => {
    const hi = qualityMultiplier({ outcome: 'success', confidence: 1, recall_count: 100000, severity: 'critical' });
    const lo = qualityMultiplier({ outcome: 'failure', confidence: 0, recall_count: 0, severity: 'minor' });
    expect(hi).toBeLessThanOrEqual(2.5);
    expect(lo).toBeGreaterThanOrEqual(0.5);
  });
});

describe('extractLessonQuality', () => {
  it('parses lesson JSON for lesson keys', () => {
    const q = extractLessonQuality({ key: 'cachly:lesson:best:foo', content: '{"outcome":"success"}' });
    expect(q?.outcome).toBe('success');
  });
  it('returns null for non-lesson keys (e.g. context)', () => {
    expect(extractLessonQuality({ key: 'cachly:ctx:custom:foo', content: 'plain text' })).toBeNull();
  });
  it('returns null for corrupt lesson JSON', () => {
    expect(extractLessonQuality({ key: 'cachly:lesson:best:foo', content: '{not json' })).toBeNull();
  });
});

describe('rerankByQuality', () => {
  it('promotes a proven success over a higher-BM25 failure distractor', () => {
    const matches: KeywordMatch[] = [
      lessonMatch('symptom-failure', 10, { outcome: 'failure', confidence: 0.2, recall_count: 0 }),
      lessonMatch('proven-success', 8, { outcome: 'success', confidence: 0.95, recall_count: 12 }),
    ];
    const ranked = rerankByQuality(matches);
    expect(ranked[0].key).toBe('cachly:lesson:best:proven-success');
  });

  it('keeps a strong text match competitive (does not bury it on quality alone)', () => {
    const matches: KeywordMatch[] = [
      lessonMatch('weak-but-perfect', 1, { outcome: 'success', confidence: 1, recall_count: 100 }),
      lessonMatch('strong-text', 100, { outcome: 'partial', confidence: 0.6, recall_count: 0 }),
    ];
    const ranked = rerankByQuality(matches);
    expect(ranked[0].key).toBe('cachly:lesson:best:strong-text');
  });

  it('is stable and returns every input', () => {
    const matches: KeywordMatch[] = [
      lessonMatch('a', 5, { outcome: 'success' }),
      lessonMatch('b', 5, { outcome: 'success' }),
    ];
    const ranked = rerankByQuality(matches);
    expect(ranked).toHaveLength(2);
  });

  it('handles empty input', () => {
    expect(rerankByQuality([])).toEqual([]);
  });
});

describe('Cachly-Bench regression guard', () => {
  it('quality rerank never regresses headline metrics vs baseline', async () => {
    const r = await runBenchmark();
    // Cachly must be >= baseline on the headline metrics (the moat must not hurt).
    expect(r.cachly.mrr).toBeGreaterThanOrEqual(r.baseline.mrr - 1e-9);
    expect(r.cachly.precisionAt1).toBeGreaterThanOrEqual(r.baseline.precisionAt1 - 1e-9);
    expect(r.cachly.ndcgAt5).toBeGreaterThanOrEqual(r.baseline.ndcgAt5 - 1e-9);
  });

  it('demonstrates a positive lift on Precision@1 and MRR (the proof)', async () => {
    const r = await runBenchmark();
    expect(r.lift.precisionAt1).toBeGreaterThan(0);
    expect(r.lift.mrr).toBeGreaterThan(0);
  });

  it('baseline is already strong (corpus is not rigged to make rerank look good)', async () => {
    const r = await runBenchmark();
    // A fair benchmark: BM25 alone already gets most queries right.
    expect(r.baseline.mrr).toBeGreaterThan(0.7);
  });
});
