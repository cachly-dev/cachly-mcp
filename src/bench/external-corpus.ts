/**
 * External labeled-corpus benchmark.
 *
 * The built-in fixture bench (fixtures.ts) proves lift on a corpus *we* wrote.
 * The honest next step is to prove the same lift on a corpus authored by a third
 * party. This module loads a labeled corpus from a portable JSON file and runs the
 * exact same three-ranker comparison (flat-file vs BM25 baseline vs cachly).
 *
 * Portable format (BEIR-ish, but with the optional quality metadata our reranker
 * uses — a generic IR corpus without it will simply show cachly ≈ BM25, which is
 * itself an honest, documented result):
 *
 *   {
 *     "name": "my-team-incidents-2025",
 *     "lessons": [
 *       { "topic": "deploy:oom", "outcome": "success", "what_worked": "...",
 *         "confidence": 0.9, "recall_count": 4, "severity": "critical",
 *         "review_level": "senior", "reviewed_by": "alice", "endorsements": 2,
 *         "ts": "2025-01-02T00:00:00.000Z" },
 *       ...
 *     ],
 *     "queries": [
 *       { "query": "pod keeps restarting out of memory", "relevant": ["deploy:oom"] },
 *       ...
 *     ]
 *   }
 *
 * Run:  npm run bench:external                       (uses the bundled sample)
 *       npm run bench:external -- ./path/corpus.json (your own labeled corpus)
 *       npm run bench:external -- ./corpus.json --json
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runBenchmarkOn, formatReport, type BenchResult } from './cachly-bench.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

export interface ExternalCorpus {
  name?: string;
  lessons: BenchLesson[];
  queries: BenchQuery[];
}

/** Parse + validate a portable corpus object. Throws a clear error on bad shape. */
export function parseExternalCorpus(raw: unknown): ExternalCorpus {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Corpus must be a JSON object with `lessons` and `queries`.');
  }
  const obj = raw as Record<string, unknown>;
  const lessons = obj.lessons;
  const queries = obj.queries;
  if (!Array.isArray(lessons) || lessons.length === 0) {
    throw new Error('Corpus.lessons must be a non-empty array.');
  }
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error('Corpus.queries must be a non-empty array.');
  }

  const topics = new Set<string>();
  for (const [i, l] of lessons.entries()) {
    const lesson = l as Record<string, unknown>;
    if (typeof lesson.topic !== 'string' || !lesson.topic.trim()) {
      throw new Error(`lessons[${i}].topic must be a non-empty string.`);
    }
    if (typeof lesson.what_worked !== 'string') {
      throw new Error(`lessons[${i}].what_worked must be a string.`);
    }
    if (topics.has(lesson.topic)) {
      throw new Error(`Duplicate lesson topic "${lesson.topic}" — topics must be unique.`);
    }
    topics.add(lesson.topic);
  }

  for (const [i, q] of queries.entries()) {
    const query = q as Record<string, unknown>;
    if (typeof query.query !== 'string' || !query.query.trim()) {
      throw new Error(`queries[${i}].query must be a non-empty string.`);
    }
    if (!Array.isArray(query.relevant) || query.relevant.length === 0) {
      throw new Error(`queries[${i}].relevant must be a non-empty array of topics.`);
    }
    for (const rel of query.relevant as unknown[]) {
      if (typeof rel !== 'string' || !topics.has(rel)) {
        throw new Error(`queries[${i}] references unknown relevant topic "${String(rel)}".`);
      }
    }
  }

  return {
    name: typeof obj.name === 'string' ? obj.name : undefined,
    lessons: lessons as BenchLesson[],
    queries: queries as BenchQuery[],
  };
}

/** Load + validate a corpus from a JSON file path. */
export async function loadExternalCorpus(path: string): Promise<ExternalCorpus> {
  const text = await readFile(path, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Corpus file is not valid JSON: ${(e as Error).message}`);
  }
  return parseExternalCorpus(raw);
}

/** Run the three-ranker benchmark on an external corpus. */
export async function runExternalBenchmark(corpus: ExternalCorpus): Promise<BenchResult> {
  return runBenchmarkOn(corpus.lessons, corpus.queries);
}

// ── CLI entry ───────────────────────────────────────────────────────────────────
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
      || process.argv[1]?.endsWith('external-corpus.ts')
      || process.argv[1]?.endsWith('external-corpus.js');
  } catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2).filter(a => a !== '--json');
  const asJson = process.argv.includes('--json');
  const here = dirname(fileURLToPath(import.meta.url));
  // Default to the bundled sample so `npm run bench:external` works out of the box.
  const corpusPath = args[0]
    ? resolve(process.cwd(), args[0])
    : resolve(here, 'external', 'sample-corpus.json');

  loadExternalCorpus(corpusPath)
    .then(async (corpus) => {
      const result = await runExternalBenchmark(corpus);
      if (asJson) {
        console.log(JSON.stringify({ corpus: corpus.name ?? corpusPath, ...result }, null, 2));
      } else {
        console.log(`\n📦  External corpus: ${corpus.name ?? corpusPath}`);
        console.log(formatReport(result));
      }
    })
    .catch((e: Error) => {
      console.error(`\n❌ External bench failed: ${e.message}\n`);
      process.exit(1);
    });
}
