/**
 * ⚠ DIESER MESSSTAND MISST FALSCH HERUM. Er heisst seit dem 20.08.2026
 * `npm run bench:spielzeug` und nicht mehr `npm run bench`.
 *
 * Belegt an diesem Tag: mit 17 Lektionen und 13 Fragen sortiert er die beiden
 * Rangfolge-Formeln GENAU VERKEHRT HERUM ein — 92,3 gegen 69,2 Prozent fuer die
 * Fassung, die auf 498 echten Lektionen 15 statt 30 Prozent erreichte.
 *
 * Er bleibt hier, weil seine gegnerischen Beispielpaare (zwei fast gleiche
 * CSRF-Lektionen, von denen nur eine stimmt) etwas pruefen, was im grossen
 * Korpus untergeht. Als Beleg fuer Rangfolge-Qualitaet taugt er NICHT.
 *
 * Der Messstand, der zaehlt: src/bench/echter-korpus.ts — 499 echte Lektionen,
 * 100 von Hand geschriebene Fragen, mit Untergrenzen.
 */
/**
 * Cachly-Bench — the moat proof.
 *
 * Measures recall quality on a fixed, labeled corpus and compares two rankers
 * over the *same* BM25 candidate set, so the comparison isolates ranking quality:
 *
 *   baseline  — raw BM25+ keyword ranking (what a text-only / flat-file memory does)
 *   cachly    — BM25+ followed by quality-aware reranking (rerank.ts)
 *
 * It reports standard IR metrics (Precision@k, Recall@k, MRR, nDCG@k) and the
 * relative lift. The corpus (fixtures.ts) is fair: gold answers are the lessons
 * that actually solve each problem, while text-similar failed attempts act as
 * distractors — exactly where ranking by quality should pull ahead.
 *
 * Run:  npm run bench        (pretty report)
 *       npm run bench -- --json   (machine-readable)
 */

import { EventEmitter } from 'node:events';
import { keywordSearch, type KeywordMatch } from '../search.js';
import { rerankByQuality } from '../rerank.js';
import { BENCH_LESSONS, BENCH_QUERIES, type BenchLesson, type BenchQuery } from './fixtures.js';

const LESSON_PREFIX = 'cachly:lesson:best:';

// ── Minimal in-memory Redis (only what keywordSearch needs) ──────────────────
class MiniRedis {
  private store = new Map<string, string>();

  set(key: string, value: string): void { this.store.set(key, value); }
  async get(key: string): Promise<string | null> { return this.store.get(key) ?? null; }

  scanStream(opts: { match: string; count?: number }): EventEmitter {
    const emitter = new EventEmitter();
    const pattern = '^' + opts.match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    const regex = new RegExp(pattern);
    const matches = [...this.store.keys()].filter(k => regex.test(k));
    setImmediate(() => { emitter.emit('data', matches); emitter.emit('end'); });
    return emitter;
  }

  pipeline() {
    const cmds: string[] = [];
    const store = this.store;
    return {
      get(key: string) { cmds.push(key); return this; },
      async exec(): Promise<Array<[null, string | null]>> {
        return cmds.map(k => [null, store.get(k) ?? null] as [null, string | null]);
      },
    };
  }
}

function indexCorpus(lessons: BenchLesson[]): MiniRedis {
  const redis = new MiniRedis();
  for (const l of lessons) {
    redis.set(`${LESSON_PREFIX}${l.topic}`, JSON.stringify(l));
  }
  return redis;
}

// ── IR metrics ──────────────────────────────────────────────────────────────────
function precisionAtK(ranked: string[], relevant: Set<string>, k: number): number {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  const hits = top.filter(t => relevant.has(t)).length;
  return hits / Math.min(k, top.length);
}

function recallAtK(ranked: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = ranked.slice(0, k);
  const hits = top.filter(t => relevant.has(t)).length;
  return hits / relevant.size;
}

function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.size); i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

export interface BenchMetrics {
  precisionAt1: number;
  precisionAt3: number;
  recallAt3: number;
  mrr: number;
  ndcgAt5: number;
}

export interface BenchResult {
  /** Flat-file memory simulation: naive term-overlap, no IDF, no quality signal. */
  flatfile: BenchMetrics;
  baseline: BenchMetrics;
  cachly: BenchMetrics;
  /** Relative lift of cachly vs the BM25 baseline. */
  lift: BenchMetrics;
  /** Relative lift of cachly vs a flat-file memory (the head-to-head that matters). */
  liftVsFlatfile: BenchMetrics;
  queryCount: number;
  corpusSize: number;
}

/**
 * Simulates how a flat-file memory (e.g. an LLM reading a `/memories` directory)
 * actually surfaces knowledge: it has NO ranking engine. Practical retrieval is
 * naive lexical overlap — count how many distinct query terms appear in the file's
 * text — with NO inverse-document-frequency, NO length normalization, and crucially
 * NO quality signal (a proven fix and a failed attempt are just text). Ties break by
 * recency, mimicking "most recently edited note first". This is a fair, and honestly
 * weaker, stand-in for "Claude reads its own memory files".
 */
function flatFileRank(lessons: BenchLesson[], query: string): string[] {
  const qTerms = new Set(
    query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3),
  );
  const scored = lessons.map(l => {
    const blob = [l.topic, l.what_worked, l.what_failed ?? '', l.context ?? '', (l.tags ?? []).join(' ')]
      .join(' ').toLowerCase();
    let overlap = 0;
    for (const t of qTerms) if (blob.includes(t)) overlap++;
    const recency = l.ts ? new Date(l.ts).getTime() : 0;
    return { topic: l.topic, overlap, recency };
  });
  return scored
    .filter(s => s.overlap > 0)
    .sort((a, b) => (b.overlap - a.overlap) || (b.recency - a.recency))
    .map(s => s.topic);
}

const matchTopic = (m: KeywordMatch): string => m.key.replace(LESSON_PREFIX, '');

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function aggregate(rows: BenchMetrics[]): BenchMetrics {
  return {
    precisionAt1: mean(rows.map(r => r.precisionAt1)),
    precisionAt3: mean(rows.map(r => r.precisionAt3)),
    recallAt3: mean(rows.map(r => r.recallAt3)),
    mrr: mean(rows.map(r => r.mrr)),
    ndcgAt5: mean(rows.map(r => r.ndcgAt5)),
  };
}

function scoreRanking(ranked: string[], relevant: Set<string>): BenchMetrics {
  return {
    precisionAt1: precisionAtK(ranked, relevant, 1),
    precisionAt3: precisionAtK(ranked, relevant, 3),
    recallAt3: recallAtK(ranked, relevant, 3),
    mrr: reciprocalRank(ranked, relevant),
    ndcgAt5: ndcgAtK(ranked, relevant, 5),
  };
}

/**
 * Run the three-ranker benchmark over any labeled corpus + query set. Pure-ish:
 * no network, no real Redis. Shared by the built-in fixture bench and the external
 * labeled-corpus bench (external-corpus.ts) so both prove lift the same way.
 */
export async function runBenchmarkOn(lessons: BenchLesson[], queries: BenchQuery[]): Promise<BenchResult> {
  const redis = indexCorpus(lessons);
  const flatfileRows: BenchMetrics[] = [];
  const baselineRows: BenchMetrics[] = [];
  const cachlyRows: BenchMetrics[] = [];

  for (const q of queries) {
    const relevant = new Set(q.relevant);

    // Baseline: BM25 top-10 only (no reranking), mirrors what a plain keyword search gives.
    const baselineMatches = await keywordSearch(redis as never, [`${LESSON_PREFIX}*`], q.query, 10);
    const baselineRanked = baselineMatches.map(matchTopic);

    // Cachly: wider candidate pool (top-25) → quality reranker selects the best 3–5.
    // Wider pool lets the reranker rescue relevant items that BM25 pushed to ranks 11–25.
    const cachlyMatches = await keywordSearch(redis as never, [`${LESSON_PREFIX}*`], q.query, 25);
    const cachlyRanked = rerankByQuality(cachlyMatches).map(matchTopic);

    // Flat-file memory sees the whole corpus but has no ranking engine.
    const flatfileRanked = flatFileRank(lessons, q.query);

    flatfileRows.push(scoreRanking(flatfileRanked, relevant));
    baselineRows.push(scoreRanking(baselineRanked, relevant));
    cachlyRows.push(scoreRanking(cachlyRanked, relevant));
  }

  const flatfile = aggregate(flatfileRows);
  const baseline = aggregate(baselineRows);
  const cachly = aggregate(cachlyRows);
  const liftOf = (b: number, c: number) => (b === 0 ? (c > 0 ? 1 : 0) : (c - b) / b);
  const liftBetween = (from: BenchMetrics): BenchMetrics => ({
    precisionAt1: liftOf(from.precisionAt1, cachly.precisionAt1),
    precisionAt3: liftOf(from.precisionAt3, cachly.precisionAt3),
    recallAt3: liftOf(from.recallAt3, cachly.recallAt3),
    mrr: liftOf(from.mrr, cachly.mrr),
    ndcgAt5: liftOf(from.ndcgAt5, cachly.ndcgAt5),
  });

  return {
    flatfile, baseline, cachly,
    lift: liftBetween(baseline),
    liftVsFlatfile: liftBetween(flatfile),
    queryCount: queries.length,
    corpusSize: lessons.length,
  };
}

/** Run the benchmark over the built-in fixture corpus. */
export async function runBenchmark(): Promise<BenchResult> {
  return runBenchmarkOn(BENCH_LESSONS, BENCH_QUERIES);
}

// ── Reporting ───────────────────────────────────────────────────────────────────────────
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signedPct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

export function formatReport(r: BenchResult): string {
  const row = (label: string, f: number, b: number, c: number, lf: number) =>
    `  ${label.padEnd(12)} ${pct(f).padStart(8)} ${pct(b).padStart(8)} ${pct(c).padStart(8)}   ${signedPct(lf).padStart(8)}`;
  return [
    '',
    '🧠  Cachly-Bench — recall quality head-to-head',
    '──────────────────────────────────────────────────────────────────────────',
    `  corpus: ${r.corpusSize} lessons · queries: ${r.queryCount}`,
    '  flat-file = naive term-overlap, no quality signal (≈ LLM reading memory files)',
    '  baseline  = raw BM25+ keyword ranking',
    '  cachly    = BM25+ followed by quality-aware reranking',
    '',
    `  ${'metric'.padEnd(12)} ${'flatfile'.padStart(8)} ${'baseline'.padStart(8)} ${'cachly'.padStart(8)}   ${'vs flat'.padStart(8)}`,
    row('Precision@1', r.flatfile.precisionAt1, r.baseline.precisionAt1, r.cachly.precisionAt1, r.liftVsFlatfile.precisionAt1),
    row('Precision@3', r.flatfile.precisionAt3, r.baseline.precisionAt3, r.cachly.precisionAt3, r.liftVsFlatfile.precisionAt3),
    row('Recall@3', r.flatfile.recallAt3, r.baseline.recallAt3, r.cachly.recallAt3, r.liftVsFlatfile.recallAt3),
    row('MRR', r.flatfile.mrr, r.baseline.mrr, r.cachly.mrr, r.liftVsFlatfile.mrr),
    row('nDCG@5', r.flatfile.ndcgAt5, r.baseline.ndcgAt5, r.cachly.ndcgAt5, r.liftVsFlatfile.ndcgAt5),
    '──────────────────────────────────────────────────────────────────────────',
    `  vs BM25 baseline : MRR ${signedPct(r.lift.mrr)} · Precision@1 ${signedPct(r.lift.precisionAt1)}`,
    `  vs flat-file mem : MRR ${signedPct(r.liftVsFlatfile.mrr)} · Precision@1 ${signedPct(r.liftVsFlatfile.precisionAt1)}`,
    '',
  ].join('\n');
}

// ── CLI entry ───────────────────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || process.argv[1]?.endsWith('cachly-bench.ts')
      || process.argv[1]?.endsWith('cachly-bench.js');
  } catch { return false; }
})();

if (isMain) {
  runBenchmark().then(result => {
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(formatReport(result));
    }
  }).catch(err => {
    process.stderr.write(`bench failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
