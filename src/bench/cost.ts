/**
 * Cachly-Bench — token-cost, measured (honest first version).
 *
 * This does NOT claim a blanket "X% lower AI bill". It measures one thing that is
 * exactly measurable with a real tokenizer on the same fixed corpus the quality
 * bench uses: how many *context tokens* a targeted recall sends per query versus
 * the "paste everything" memory approach (a flat-file / CLAUDE.md dump, or any
 * setup that re-sends the whole knowledge base into the prompt each call).
 *
 * Why this is the honest number:
 *   - Without retrieval, to make N lessons available you re-send all N every call.
 *   - cachly retrieves only the few relevant lessons per query.
 *   - The difference in *input tokens* is real, deterministic, and tokenizer-counted.
 *
 * What it deliberately does NOT measure (needs live LLM runs — separate task):
 *   - output tokens, multi-turn dynamics, or a total monthly-bill percentage.
 *   - semantic-cache hit rate on a production query stream (varies by workload;
 *     cachly reports the real per-instance hit rate + € saved in the dashboard).
 *
 * Run:  npm run bench:cost
 */

import { encode } from 'gpt-tokenizer';
import { BENCH_LESSONS, BENCH_QUERIES, type BenchLesson } from './fixtures.js';

// ── Assumptions (printed so the number is auditable) ────────────────────────────
// Input-token price per 1M tokens. Defaults span a cheap small model and a
// frontier model so the € range is honest rather than cherry-picked.
const PRICE_PER_1M_CHEAP_USD = 0.15; // ~gpt-4o-mini / haiku class input
const PRICE_PER_1M_FRONTIER_USD = 3.0; // ~frontier class input
const TOP_K = 3; // cachly surfaces the few relevant lessons, not the whole base

/** Serialize a lesson exactly as it would occupy space in a prompt context. */
function serializeLesson(l: BenchLesson): string {
  const parts = [`## ${l.topic}`, l.what_worked];
  if (l.context) parts.push(`context: ${l.context}`);
  if (l.what_failed) parts.push(`avoid: ${l.what_failed}`);
  return parts.join('\n');
}

function tokens(text: string): number {
  return encode(text).length;
}

function fmtUSD(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function main(): void {
  const lessons = BENCH_LESSONS;
  const queries = BENCH_QUERIES;

  // "Paste everything": the entire knowledge base re-sent as context each call.
  const pasteEverythingTokens = lessons.reduce(
    (sum, l) => sum + tokens(serializeLesson(l)),
    0,
  );

  // Targeted recall: only the gold-relevant lessons for each query, capped at TOP_K.
  // Using the labeled relevant set isolates token cost from ranking quality
  // (which the recall-quality bench already measures separately).
  const byTopic = new Map(lessons.map((l) => [l.topic, l]));
  let recallTokenSum = 0;
  let counted = 0;
  for (const q of queries) {
    const picked = q.relevant
      .map((t) => byTopic.get(t))
      .filter((l): l is BenchLesson => Boolean(l))
      .slice(0, TOP_K);
    if (picked.length === 0) continue;
    recallTokenSum += picked.reduce((s, l) => s + tokens(serializeLesson(l)), 0);
    counted++;
  }
  const avgRecallTokens = counted > 0 ? recallTokenSum / counted : 0;
  const reductionPct =
    pasteEverythingTokens > 0
      ? (1 - avgRecallTokens / pasteEverythingTokens) * 100
      : 0;

  // Per-call € for context input, both pricing tiers.
  const cheapPaste = (pasteEverythingTokens / 1_000_000) * PRICE_PER_1M_CHEAP_USD;
  const cheapRecall = (avgRecallTokens / 1_000_000) * PRICE_PER_1M_CHEAP_USD;
  const frontierPaste =
    (pasteEverythingTokens / 1_000_000) * PRICE_PER_1M_FRONTIER_USD;
  const frontierRecall =
    (avgRecallTokens / 1_000_000) * PRICE_PER_1M_FRONTIER_USD;

  const out: string[] = [];
  out.push('Cachly-Bench — token cost (context input per call)');
  out.push('═'.repeat(54));
  out.push(`Corpus: ${lessons.length} lessons · ${queries.length} queries`);
  out.push(`Tokenizer: gpt-tokenizer (cl100k_base) · top-k recall: ${TOP_K}`);
  out.push('');
  out.push(`Paste-everything context : ${pasteEverythingTokens} tokens / call`);
  out.push(`Targeted recall (avg)    : ${avgRecallTokens.toFixed(0)} tokens / call`);
  out.push(`Context-token reduction  : ${reductionPct.toFixed(1)}%`);
  out.push('');
  out.push('€/call for context input (illustrative pricing):');
  out.push(
    `  cheap model   ${fmtUSD(cheapPaste)} → ${fmtUSD(cheapRecall)} per call`,
  );
  out.push(
    `  frontier model ${fmtUSD(frontierPaste)} → ${fmtUSD(frontierRecall)} per call`,
  );
  out.push('');
  out.push(
    'Reads as: targeted recall sends ' +
      `${reductionPct.toFixed(0)}% fewer context tokens than re-sending the whole`,
  );
  out.push(
    'knowledge base each call. This is retrieval efficiency only — not a total',
  );
  out.push('bill %. Output tokens and cache-hit rate are out of scope here.');
  console.log(out.join('\n'));
}

main();
