/**
 * Bench regression gate (CI).
 *
 * Runs the recall-quality benchmark on both the home fixture corpus and the
 * external labeled corpus, then asserts cachly's metrics stay at or above
 * committed floors. Fails the build (exit 1) on regression so a ranking change
 * can never silently degrade recall again.
 *
 * Floors are set just below the current measured values with a small tolerance,
 * so noise doesn't flake CI but a real regression trips it. Update FLOORS
 * deliberately (with a bench run in the PR) when an intentional change moves them.
 *
 * Run: npm run bench:gate
 */
import { runBenchmarkOn, type BenchMetrics } from './cachly-bench.js';
import { BENCH_LESSONS, BENCH_QUERIES } from './fixtures.js';
import { loadExternalCorpus } from './external-corpus.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Committed floors — cachly metrics must not drop below these.
// Measured 2026-06-07 after: wider candidate pool (topK=25 for cachly), doc-side
// cross-lingual expansion disabled (prevents symmetric inflation bug), score^0.3
// compression + 0.4+0.6*boost reranker formula. Tolerance ~1.5pp.
const FLOORS: Record<string, Partial<BenchMetrics>> = {
  home: { precisionAt1: 0.90, recallAt3: 0.99, mrr: 0.94, ndcgAt5: 0.96 },
  external: { precisionAt1: 0.78, recallAt3: 0.96, mrr: 0.87, ndcgAt5: 0.90 },
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = await loadExternalCorpus(resolve(here, 'external', 'sample-corpus.json'));

  const corpora: Array<{ name: keyof typeof FLOORS; result: BenchMetrics }> = [
    { name: 'home', result: (await runBenchmarkOn(BENCH_LESSONS, BENCH_QUERIES)).cachly },
    { name: 'external', result: (await runBenchmarkOn(ext.lessons, ext.queries)).cachly },
  ];

  const failures: string[] = [];
  for (const { name, result } of corpora) {
    const floor = FLOORS[name];
    for (const [metric, min] of Object.entries(floor) as Array<[keyof BenchMetrics, number]>) {
      const got = result[metric];
      const ok = got >= min;
      console.log(`  ${ok ? '✓' : '✗'} ${name}.${metric}: ${pct(got)} (floor ${pct(min)})`);
      if (!ok) failures.push(`${name}.${metric}: ${pct(got)} < floor ${pct(min)}`);
    }
  }

  if (failures.length) {
    console.error(`\n❌ Bench regression — ${failures.length} metric(s) below floor:`);
    for (const f of failures) console.error(`   ${f}`);
    console.error('\nIf this change is intentional, update FLOORS in src/bench/gate.ts with a bench run.\n');
    process.exit(1);
  }
  console.log('\n✅ Bench gate passed — no recall-quality regression.\n');
}

main().catch((e: Error) => { console.error(`\n❌ Bench gate error: ${e.message}\n`); process.exit(1); });
