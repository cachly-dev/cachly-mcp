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
    const hi = qualityMultiplier({ outcome: 'success', confidence: 1, recall_count: 100000, severity: 'critical', review_level: 'senior', reviewed_by: 'x', endorsements: 99 });
    const lo = qualityMultiplier({ outcome: 'failure', confidence: 0, recall_count: 0, severity: 'minor' });
    expect(hi).toBeLessThanOrEqual(2.5);
    expect(lo).toBeGreaterThanOrEqual(0.5);
  });

  it('boosts a human-reviewed lesson above an unreviewed equal', () => {
    const base = { outcome: 'success', confidence: 0.8, recall_count: 3 } as const;
    const unreviewed = qualityMultiplier({ ...base });
    const peer = qualityMultiplier({ ...base, reviewed_by: 'alice', review_level: 'peer', endorsements: 1 });
    const senior = qualityMultiplier({ ...base, reviewed_by: 'bob', review_level: 'senior', endorsements: 1 });
    expect(peer).toBeGreaterThan(unreviewed);
    expect(senior).toBeGreaterThan(peer);
  });

  it('rewards additional distinct endorsements but saturates', () => {
    const base = { outcome: 'success', confidence: 0.8, recall_count: 3, reviewed_by: 'a', review_level: 'peer' } as const;
    const one = qualityMultiplier({ ...base, endorsements: 1 });
    const three = qualityMultiplier({ ...base, endorsements: 3 });
    const fifty = qualityMultiplier({ ...base, endorsements: 50 });
    expect(three).toBeGreaterThan(one);
    expect(fifty).toBeGreaterThan(three);
    expect(fifty - three).toBeLessThan(three - one + 0.1);
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

  // ── Was dieser Pruefstand belegen KANN, und was nicht ────────────────────
  //
  // Bis zum 19.08.2026 stand hier "the proof": die Nachsortierung muss auf
  // diesen 17 Lektionen besser sein als rohes BM25. Sie war es — mit 92,3
  // gegen 69,2 Prozent.
  //
  // Der Vorsprung kam daher, dass die Relevanz vorher mit `score^0.3`
  // gestaucht wurde. Auf 498 echten Lektionen halbierte genau das die
  // richtigen ersten Plaetze (15 statt 30 Prozent). Der "Beweis" hier war der
  // Schaden dort.
  //
  // Ein Pruefstand mit 17 Lektionen kann einen Rangfolge-Vorsprung nicht
  // belegen: bei 16 Mitbewerbern ist der richtige Treffer meist eindeutig, und
  // 5 der 13 Fragen teilen mehr als die Haelfte ihrer langen Woerter woertlich
  // mit der erwarteten Antwort.
  //
  // Deshalb prueft dieser Fall jetzt das, was hier wirklich zusagbar ist: die
  // Nachsortierung darf nicht SCHADEN. Der Vorsprung wird gegen den echten
  // Bestand gemessen — src/bench/korpus-aus-brain.ts baut den Korpus dafuer.
  it('schadet nicht gegenueber rohem BM25', async () => {
    const r = await runBenchmark();
    expect(r.cachly.precisionAt1).toBeGreaterThanOrEqual(r.baseline.precisionAt1 - 1e-9);
    expect(r.cachly.mrr).toBeGreaterThanOrEqual(r.baseline.mrr - 1e-9);
  });

  it('baseline is already strong (corpus is not rigged to make rerank look good)', async () => {
    const r = await runBenchmark();
    // A fair benchmark: BM25 alone already gets most queries right.
    expect(r.baseline.mrr).toBeGreaterThan(0.7);
  });

  // Auch hier stand eine Zusage, die dieser Pruefstand nicht traegt: cachly
  // schlaegt eine Textdatei-Ablage. Auf 17 Lektionen tut es das seit dem
  // 19.08.2026 NICHT mehr — dort liegt die Textdatei bei 76,9 Prozent, cachly
  // bei 69,2.
  //
  // Auf 498 echten Lektionen mit denselben 20 Fragen sieht es umgekehrt aus:
  //
  //            Textdatei   cachly
  //   P@1          0 %       30 %
  //   MRR        6,4 %     31,2 %
  //
  // Die Textdatei gewinnt, wenn es fast nichts zu verwechseln gibt, und
  // verliert vollstaendig, sobald es das gibt. Genau das ist die Aussage, die
  // wir treffen wollen — und sie ist auf diesem Pruefstand nicht messbar.
  it('die Textdatei-Ablage ist kein Strohmann', async () => {
    const r = await runBenchmark();
    // Der Vergleich bleibt ehrlich: die Textdatei-Nachbildung ist stark, nicht
    // absichtlich schlecht. Faellt dieser Wert, ist der Vergleich manipuliert.
    expect(r.flatfile.mrr).toBeGreaterThan(0.5);
  });
});
