# Cachly-Bench — the recall-quality proof

> The STRATEGY.md moat claim is: *Cachly's structured, quality-aware recall beats
> raw text matching (and a flat-file memory) at surfacing the lesson that actually
> helps.* A claim without a number is marketing. This is the number.

## Run it

```bash
npm run bench            # pretty report
npm run bench -- --json  # machine-readable
```

The benchmark is also a CI regression guard: `src/__tests__/rerank.test.ts`
asserts that quality reranking never regresses the headline metrics and that the
baseline is already strong (so the corpus isn't rigged).

## What it measures

Two rankers are compared over the **same** BM25 candidate set, so the comparison
isolates *ranking quality*, not retrieval:

| Ranker | What it does | Analogy |
|---|---|---|
| `baseline` | raw BM25+ keyword score (`src/search.ts`) | a text-only / flat-file memory |
| `cachly` | BM25+ then quality-aware rerank (`src/rerank.ts`) | structured, trust-aware recall |

Quality reranking boosts a lesson by its **outcome** (proven success > partial >
failed attempt), **confidence**, **proven-ness** (`recall_count`, log-saturated)
and **severity** — clamped so a strong text match is never fully buried, and a
weak one never catapulted on quality alone.

## The corpus is fair (not rigged)

The fixture corpus (`src/bench/fixtures.ts`) is deliberately and *fairly*
adversarial: for several queries a **symptom-dense failed attempt** competes with
the **solution-focused proven success**. This mirrors reality — failed attempts
repeat the symptom verbatim ("still stuck, still failing"), while the lesson that
fixed it is written in solution vocabulary. BM25 alone is fooled by the symptom
density; quality reranking corrects it.

The baseline still scores well (MRR ~85%, Precision@1 75%) — we are not making a
weak baseline look bad. We are improving an already-good one on the cases that
matter.

## Current results

```
  corpus: 15 lessons · queries: 12

  metric         baseline       cachly          lift
  Precision@1       75.0%  →     83.3%     +11.1%
  Precision@3       33.3%  →     33.3%      +0.0%
  Recall@3          95.8%  →     95.8%      +0.0%
  MRR               84.7%  →     90.3%      +6.6%
  nDCG@5            87.3%  →     91.7%      +5.0%
```

**Headline: Precision@1 +11.1%, MRR +6.6%, nDCG@5 +5.0%.**

Interpretation: when the agent asks a question, the *first* result is the proven
fix 11% more often, and the proven fix sits higher in the list overall. On the
hardest cases (a failed attempt out-ranking the success on text alone), reranking
flips the order to the lesson that actually solves the problem.

## Honest limitations (read this)

- **Small corpus.** 15 lessons, 12 queries. This proves the *mechanism* works and
  guards against regressions. It does **not** yet prove real-world magnitude. The
  next step (STRATEGY Phase 2) is a larger, externally-sourced corpus and a
  head-to-head against an actual flat-file memory baseline on real agent traces.
- **Ranking, not retrieval.** Both rankers see the same BM25 candidates, so this
  measures the quality layer only. Semantic retrieval (embeddings) is evaluated
  separately and is not in these numbers.
- **Labels are ours.** Gold relevance is author-assigned. A credible public
  benchmark needs third-party labels.

The point of this file is not to claim victory. It is to make the moat
*measurable* and *defended by CI*, so every future change to recall must move this
number in the right direction — or it doesn't ship.
