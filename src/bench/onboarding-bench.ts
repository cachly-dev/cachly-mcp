/**
 * Onboarding-Bench — measuring time-to-first-recall.
 *
 * Time-to-first-recall is the onboarding metric that decides whether a new user
 * ever reaches the "aha". We measure it as a **cold-start hit rate**: when a brand
 * new user asks their first realistic question, does the Brain return a relevant
 * hit — or nothing?
 *
 * Two scenarios over the *same* realistic cold-start queries, using the *real*
 * keyword search engine (search.ts), so the result reflects production retrieval:
 *
 *   cold    — empty Brain (fresh repo, no git-derived lessons). This is what every
 *             user saw before v0.10.80. First query returns nothing → the user must
 *             first do work, learn a lesson, and only then can recall it. Time-to-
 *             first-recall therefore spans at least one full work cycle (often a
 *             whole session: many minutes to hours).
 *   seeded  — Brain pre-seeded with the curated starter corpus (brain_seed_starter,
 *             which auto-runs on first session when git history is empty). The first
 *             query hits immediately → time-to-first-recall collapses to seconds.
 *
 * The queries are phrased the way a frustrated developer actually types them — NOT
 * using the lesson's topic slug — so a hit means real lexical retrieval worked, not
 * a trivial exact-match.
 *
 * Run:  npm run bench:onboarding
 *       npm run bench:onboarding -- --json
 */

import { EventEmitter } from 'node:events';
import { keywordSearch, type KeywordMatch } from '../search.js';
import { STARTER_CORPUS } from '../starter-corpus.js';

const LESSON_PREFIX = 'cachly:lesson:best:';

// ── Cold-start queries — realistic, differently-worded from the topic slug ──────
// Each maps to the starter topic that should answer it. These are the questions a
// brand-new user is most likely to ask in their first session.
export interface ColdStartQuery {
  query: string;
  relevant: string[];
}

export const COLD_START_QUERIES: ColdStartQuery[] = [
  { query: 'my docker build is really slow and reinstalls all dependencies every time', relevant: ['docker:layer-cache'] },
  { query: 'i ran git push force and overwrote my teammates commits', relevant: ['git:force-push-safety'] },
  { query: 'tests pass on my machine but randomly fail in the CI pipeline', relevant: ['ci:flaky-tests-timing'] },
  { query: 'getting exports is not defined error after adding an npm module', relevant: ['node:esm-cjs-interop'] },
  { query: 'a valid auth token keeps getting rejected as expired', relevant: ['jwt:clock-skew'] },
  { query: 'my database schema migration hangs forever during deploy', relevant: ['postgres:migration-lock'] },
  { query: 'redis is dropping cached keys and writes start failing', relevant: ['redis:eviction-policy'] },
  { query: 'kubernetes pod keeps getting killed and restarting out of memory', relevant: ['k8s:oom-limits'] },
  { query: 'the browser blocks my api call with a cross origin error', relevant: ['cors:preflight'] },
  { query: 'an environment variable from my dotenv file is ignored inside the container', relevant: ['env:dotenv-precedence'] },
  { query: 'a promise rejection silently vanishes with no error logged anywhere', relevant: ['async:unhandled-rejection'] },
  { query: 'my list endpoint is slow and the db shows tons of tiny repeated queries', relevant: ['sql:n-plus-one'] },
  { query: 'retrying a failed post request created duplicate database records', relevant: ['http:retry-idempotency'] },
  { query: 'database load spikes exactly when a hot cache entry expires', relevant: ['cache:stampede'] },
  { query: 'we found a bearer token written into our application logs', relevant: ['security:no-secrets-in-logs'] },
  { query: 'production went down because a tls certificate silently expired', relevant: ['tls:cert-expiry'] },
];

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

function seededRedis(): MiniRedis {
  const redis = new MiniRedis();
  const now = new Date().toISOString();
  for (const l of STARTER_CORPUS) {
    redis.set(`${LESSON_PREFIX}${l.topic}`, JSON.stringify({
      topic: l.topic, outcome: l.outcome, what_worked: l.what_worked,
      what_failed: l.what_failed, ctx: l.ctx, tags: l.tags,
      confidence: l.confidence, source: 'starter', ts: now, verified_at: now, version: 3,
    }));
  }
  return redis;
}

const matchTopic = (m: KeywordMatch): string => m.key.replace(LESSON_PREFIX, '');
function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }

export interface OnboardingMetrics {
  /** Fraction of first-queries whose top result is relevant. */
  hitAt1: number;
  /** Fraction of first-queries with a relevant result in the top 3. */
  hitAt3: number;
  /** Mean reciprocal rank of the first relevant result. */
  mrr: number;
  /** Fraction of queries that returned ANY result at all. */
  answeredRate: number;
}

export interface OnboardingResult {
  cold: OnboardingMetrics;
  seeded: OnboardingMetrics;
  queryCount: number;
  corpusSize: number;
}

async function rankFor(redis: MiniRedis, query: string): Promise<string[]> {
  const matches = await keywordSearch(redis as unknown as never, [`${LESSON_PREFIX}*`], query, 5);
  return matches.map(matchTopic);
}

async function scoreScenario(redis: MiniRedis): Promise<OnboardingMetrics> {
  const hit1: number[] = [], hit3: number[] = [], rr: number[] = [], answered: number[] = [];
  for (const q of COLD_START_QUERIES) {
    const ranked = await rankFor(redis, q.query);
    const relevant = new Set(q.relevant);
    answered.push(ranked.length > 0 ? 1 : 0);
    hit1.push(ranked.length > 0 && relevant.has(ranked[0]) ? 1 : 0);
    hit3.push(ranked.slice(0, 3).some(t => relevant.has(t)) ? 1 : 0);
    let r = 0;
    for (let i = 0; i < ranked.length; i++) { if (relevant.has(ranked[i])) { r = 1 / (i + 1); break; } }
    rr.push(r);
  }
  return { hitAt1: mean(hit1), hitAt3: mean(hit3), mrr: mean(rr), answeredRate: mean(answered) };
}

/** Run the cold-vs-seeded onboarding benchmark. */
export async function runOnboardingBenchmark(): Promise<OnboardingResult> {
  const cold = await scoreScenario(new MiniRedis());       // empty brain
  const seeded = await scoreScenario(seededRedis());        // starter-seeded brain
  return { cold, seeded, queryCount: COLD_START_QUERIES.length, corpusSize: STARTER_CORPUS.length };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatOnboardingReport(r: OnboardingResult): string {
  const row = (label: string, c: number, s: number) =>
    `| ${label.padEnd(22)} | ${pct(c).padStart(7)} | ${pct(s).padStart(7)} |`;
  return [
    ``,
    `⏱️  Onboarding-Bench — time-to-first-recall (cold-start hit rate)`,
    `   ${r.queryCount} realistic first-session queries · ${r.corpusSize}-lesson starter corpus · real search engine`,
    ``,
    `| Metric                 |    cold |  seeded |`,
    `|------------------------|---------|---------|`,
    row('First-query hit@1', r.cold.hitAt1, r.seeded.hitAt1),
    row('Hit@3', r.cold.hitAt3, r.seeded.hitAt3),
    row('MRR', r.cold.mrr, r.seeded.mrr),
    row('Answered (any result)', r.cold.answeredRate, r.seeded.answeredRate),
    ``,
    `Interpretation:`,
    `  • cold   = empty Brain (no git lessons). First query returns ${pct(r.cold.hitAt1)} hits →`,
    `             the user must do work + learn before any recall is possible. Time-to-first-`,
    `             recall spans a full work cycle (minutes → hours).`,
    `  • seeded = starter corpus auto-seeded on first session. First query hits ${pct(r.seeded.hitAt1)} →`,
    `             time-to-first-recall collapses to seconds.`,
    ``,
  ].join('\n');
}

// ── CLI entry ───────────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || process.argv[1]?.endsWith('onboarding-bench.ts')
      || process.argv[1]?.endsWith('onboarding-bench.js');
  } catch { return false; }
})();

if (isMain) {
  const asJson = process.argv.includes('--json');
  runOnboardingBenchmark()
    .then((result) => {
      if (asJson) console.log(JSON.stringify(result, null, 2));
      else console.log(formatOnboardingReport(result));
    })
    .catch((e: Error) => {
      console.error(`\n❌ Onboarding bench failed: ${e.message}\n`);
      process.exit(1);
    });
}
