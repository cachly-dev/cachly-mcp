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
import { BENCH_LESSONS, BENCH_QUERIES, type BenchLesson } from './fixtures.js';

const LESSON_PREFIX = 'cachly:lesson:best:';

// ── Minimal in-memory Redis (only what keywordSearch needs) ────────────────────
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

// ── IR metrics ─────────────────────────────────────────────────────────────────
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
  baseline: BenchMetrics;
  cachly: BenchMetrics;
  /** Relative lift per metric, e.g. { mrr: 0.23 } = +23%. */
  lift: BenchMetrics;
  queryCount: number;
  corpusSize: number;
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

/** Run the benchmark over the fixture corpus. Pure-ish: no network, no real Redis. */
export async function runBenchmark(): Promise<BenchResult> {
  const redis = indexCorpus(BENCH_LESSONS);
  const baselineRows: BenchMetrics[] = [];
  const cachlyRows: BenchMetrics[] = [];

  for (const q of BENCH_QUERIES) {
    const relevant = new Set(q.relevant);

    // Same candidate set for both rankers — isolates the ranking contribution.
    const matches = await keywordSearch(redis as never, [`${LESSON_PREFIX}*`], q.query, 10);

    const baselineRanked = matches.map(matchTopic);
    const cachlyRanked = rerankByQuality(matches).map(matchTopic);

    baselineRows.push(scoreRanking(baselineRanked, relevant));
    cachlyRows.push(scoreRanking(cachlyRanked, relevant));
  }

  const baseline = aggregate(baselineRows);
  const cachly = aggregate(cachlyRows);
  const liftOf = (b: number, c: number) => (b === 0 ? (c > 0 ? 1 : 0) : (c - b) / b);
  const lift: BenchMetrics = {
    precisionAt1: liftOf(baseline.precisionAt1, cachly.precisionAt1),
    precisionAt3: liftOf(baseline.precisionAt3, cachly.precisionAt3),
    recallAt3: liftOf(baseline.recallAt3, cachly.recallAt3),
    mrr: liftOf(baseline.mrr, cachly.mrr),
    ndcgAt5: liftOf(baseline.ndcgAt5, cachly.ndcgAt5),
  };

  return { baseline, cachly, lift, queryCount: BENCH_QUERIES.length, corpusSize: BENCH_LESSONS.length };
}

// ── Reporting ──────────────────────────────────────────────────────────────────
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const signedPct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

export function formatReport(r: BenchResult): string {
  const row = (label: string, b: number, c: number, l: number) =>
    `  ${label.padEnd(14)} ${pct(b).padStart(8)}  →  ${pct(c).padStart(8)}   ${signedPct(l).padStart(8)}`;
  return [
    '',
    '🧠  Cachly-Bench — recall quality (BM25 baseline vs quality-aware rerank)',
    '────────────────────────────────────────────────────────────────────────',
    `  corpus: ${r.corpusSize} lessons · queries: ${r.queryCount}`,
    '',
    `  ${'metric'.padEnd(14)} ${'baseline'.padStart(8)}     ${'cachly'.padStart(8)}      ${'lift'.padStart(8)}`,
    row('Precision@1', r.baseline.precisionAt1, r.cachly.precisionAt1, r.lift.precisionAt1),
    row('Precision@3', r.baseline.precisionAt3, r.cachly.precisionAt3, r.lift.precisionAt3),
    row('Recall@3', r.baseline.recallAt3, r.cachly.recallAt3, r.lift.recallAt3),
    row('MRR', r.baseline.mrr, r.cachly.mrr, r.lift.mrr),
    row('nDCG@5', r.baseline.ndcgAt5, r.cachly.ndcgAt5, r.lift.ndcgAt5),
    '────────────────────────────────────────────────────────────────────────',
    `  Headline: MRR ${signedPct(r.lift.mrr)} · Precision@1 ${signedPct(r.lift.precisionAt1)}`,
    '',
  ].join('\n');
}

// ── CLI entry ───────────────────────────────────────────────────────────────────
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
