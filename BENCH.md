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

Quality reranking boosts a lesson by five orthogonal signals:
1. **Outcome** (proven success > partial > failed attempt)
2. **Confidence** (0..1 → maps to a 0.7..1.3 nudge)
3. **Proven-ness** (`recall_count`, log-saturated, caps at +30%)
4. **Severity** (critical issue > minor, mild tiebreaker)
5. **Governance** (`review_level` × distinct `endorsements` — a senior-reviewed
   lesson outranks an unreviewed one even when the text is nearly identical)

All five factors are multiplied and clamped to `[0.5, 2.5]` so a strong text match
is never fully buried, and a weak one never catapulted on quality alone.

## The corpus is fair (not rigged)

The fixture corpus (`src/bench/fixtures.ts`) is deliberately and *fairly*
adversarial in two dimensions:

**Failure-distractor pairs:** for several queries a **symptom-dense failed attempt**
competes with the **solution-focused proven success**. Failed attempts repeat the
symptom verbatim ("still stuck, still failing"); the lesson that fixed it is written
in solution vocabulary. BM25 alone is fooled by the symptom density; quality
reranking corrects it.

**Governance pairs:** two success lessons with near-identical vocabulary, but only
one has a senior reviewer endorsement. BM25 cannot distinguish them; the governance
signal breaks the tie in favour of the reviewed, canonical lesson.

The baseline still scores well (MRR ~82%, Precision@1 ~69%) — we are not making a
weak baseline look bad. We are improving an already-good one on the cases that matter.

## Current results

```
  corpus: 17 lessons · queries: 13

  metric         baseline       cachly          lift
  Precision@1       69.2%  →     84.6%     +22.2%
  Precision@3       33.3%  →     33.3%      +0.0%
  Recall@3          96.2%  →     96.2%      +0.0%
  MRR               82.1%  →     91.0%     +10.9%
  nDCG@5            85.5%  →     92.4%      +8.1%
```

**Headline: Precision@1 +22.2%, MRR +10.9%, nDCG@5 +8.1%.**

Interpretation: when the agent asks a question, the *first* result is the proven
fix 22% more often. On the hardest cases — a symptom-dense failed attempt beating
the success on raw text, or two near-identical success lessons where only one was
reviewed — reranking consistently surfaces the lesson that actually solves the problem.

## Honest limitations (read this)

- **Small corpus.** 17 lessons, 13 queries. This proves the *mechanism* works for
  each quality signal and guards against regressions. It does **not** yet prove
  real-world magnitude. The next step is a larger, externally-sourced corpus and a
  head-to-head against an actual flat-file memory baseline on real agent traces.
- **Ranking, not retrieval.** Both rankers see the same BM25 candidates, so this
  measures the quality layer only. CKG-traversal and semantic retrieval are
  evaluated separately via integration tests and are not in these numbers.
- **Labels are ours.** Gold relevance is author-assigned. A credible public
  benchmark needs third-party labels.

The point of this file is not to claim victory. It is to make the moat
*measurable* and *defended by CI*, so every future change to recall must move this
number in the right direction — or it doesn't ship.
