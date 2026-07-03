/**
 * Tests for the external labeled-corpus benchmark harness.
 * Validates the portable-format parser and that cachly's reranker does not
 * regress against the BM25 baseline on an independently-shaped corpus.
 */

import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parseExternalCorpus, loadExternalCorpus, runExternalBenchmark,
} from '../bench/external-corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(here, '..', 'bench', 'external', 'sample-corpus.json');

const minimalCorpus = {
  name: 'unit',
  lessons: [
    { topic: 'a:win', outcome: 'success', what_worked: 'did the thing that fixed it', confidence: 0.9, recall_count: 3 },
    { topic: 'a:fail', outcome: 'failure', what_worked: '', what_failed: 'the thing did not fix it', confidence: 0.2 },
  ],
  queries: [
    { query: 'the thing that fixed it', relevant: ['a:win'] },
  ],
};

describe('parseExternalCorpus', () => {
  it('accepts a well-formed corpus', () => {
    const c = parseExternalCorpus(minimalCorpus);
    expect(c.lessons).toHaveLength(2);
    expect(c.queries).toHaveLength(1);
    expect(c.name).toBe('unit');
  });

  it('rejects a non-object', () => {
    expect(() => parseExternalCorpus(null)).toThrow(/JSON object/);
    expect(() => parseExternalCorpus(42)).toThrow(/JSON object/);
  });

  it('rejects empty lessons', () => {
    expect(() => parseExternalCorpus({ lessons: [], queries: [{ query: 'x', relevant: ['a'] }] }))
      .toThrow(/non-empty array/);
  });

  it('rejects empty queries', () => {
    expect(() => parseExternalCorpus({ lessons: minimalCorpus.lessons, queries: [] }))
      .toThrow(/non-empty array/);
  });

  it('rejects a lesson without a topic', () => {
    expect(() => parseExternalCorpus({
      lessons: [{ what_worked: 'x' }],
      queries: [{ query: 'q', relevant: ['a'] }],
    })).toThrow(/topic must be/);
  });

  it('rejects duplicate topics', () => {
    expect(() => parseExternalCorpus({
      lessons: [
        { topic: 'dup', what_worked: 'a' },
        { topic: 'dup', what_worked: 'b' },
      ],
      queries: [{ query: 'q', relevant: ['dup'] }],
    })).toThrow(/Duplicate lesson topic/);
  });

  it('rejects a query referencing an unknown relevant topic', () => {
    expect(() => parseExternalCorpus({
      lessons: [{ topic: 'a', what_worked: 'x' }],
      queries: [{ query: 'q', relevant: ['does-not-exist'] }],
    })).toThrow(/unknown relevant topic/);
  });

  it('rejects a query with empty relevant set', () => {
    expect(() => parseExternalCorpus({
      lessons: [{ topic: 'a', what_worked: 'x' }],
      queries: [{ query: 'q', relevant: [] }],
    })).toThrow(/non-empty array of topics/);
  });
});

describe('loadExternalCorpus', () => {
  it('throws a clear error on invalid JSON', async () => {
    // Point at this very test file — definitely not valid JSON.
    const thisFile = fileURLToPath(import.meta.url);
    await expect(loadExternalCorpus(thisFile)).rejects.toThrow(/not valid JSON/);
  });

  it('loads the bundled sample corpus', async () => {
    const corpus = await loadExternalCorpus(samplePath);
    expect(corpus.lessons.length).toBeGreaterThanOrEqual(8);
    expect(corpus.queries.length).toBeGreaterThanOrEqual(5);
  });
});

describe('runExternalBenchmark', () => {
  it('cachly does not regress vs BM25 baseline on the sample corpus', async () => {
    const corpus = await loadExternalCorpus(samplePath);
    const r = await runExternalBenchmark(corpus);
    // cachly should be >= baseline on the headline metrics (quality rerank never hurts here).
    expect(r.cachly.precisionAt1).toBeGreaterThanOrEqual(r.baseline.precisionAt1);
    expect(r.cachly.mrr).toBeGreaterThanOrEqual(r.baseline.mrr);
    // And it should beat the flat-file memory on Precision@1 (the decisive metric).
    expect(r.cachly.precisionAt1).toBeGreaterThan(r.flatfile.precisionAt1);
    expect(r.corpusSize).toBe(corpus.lessons.length);
    expect(r.queryCount).toBe(corpus.queries.length);
    // 30s timeout: this benchmark is compute-heavy and shares the self-hosted
    // runner with ~20 concurrent CI jobs, so the default 5s vitest limit tips
    // over under CPU contention (observed 5015ms) and flaked the deploy gate.
  }, 30_000);

  it('the sample JSON is parseable and self-consistent', async () => {
    const raw = JSON.parse(await readFile(samplePath, 'utf-8'));
    const c = parseExternalCorpus(raw);
    // Every relevant topic exists as a lesson.
    const topics = new Set(c.lessons.map(l => l.topic));
    for (const q of c.queries) {
      for (const rel of q.relevant) expect(topics.has(rel)).toBe(true);
    }
  });
});
