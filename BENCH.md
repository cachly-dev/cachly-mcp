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
| `flatfile` | naive term-overlap, no IDF/quality, recency tiebreak | an LLM reading `/memories` files |
| `baseline` | raw BM25+ keyword score (`src/search.ts`) | a decent text search engine |
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

Three rankers, same corpus:

- **flat-file** — naive term-overlap, no IDF, no length normalization, **no quality
  signal**, ties broken by recency. This is an honest (in fact *charitable*) stand-in
  for "an LLM reading its own `/memories` files": it has no ranking engine.
- **baseline** — raw BM25+ keyword ranking.
- **cachly** — BM25+ followed by quality-aware reranking (`rerank.ts`).

```
  corpus: 17 lessons · queries: 13

  metric       flatfile baseline   cachly    vs flat
  Precision@1     76.9%    69.2%    84.6%     +10.0%
  Precision@3     37.2%    33.3%    33.3%     -10.3%
  Recall@3       100.0%    96.2%    96.2%      -3.8%
  MRR             87.2%    82.1%    91.0%      +4.4%
  nDCG@5          89.9%    85.5%    92.4%      +2.8%

  vs BM25 baseline : MRR +10.9% · Precision@1 +22.2%
  vs flat-file mem : MRR  +4.4% · Precision@1 +10.0%
```

**Headline: Precision@1 +22.2% vs BM25, +10.0% vs a flat-file memory.**

Interpretation — read the metrics that matter for an *agent*: it acts on the **top**
result, so **Precision@1** and **MRR** are decisive. There, cachly wins against both
baselines: it puts the single proven fix first most often. On the hardest cases — a
symptom-dense failed attempt that beats the success on raw text, or two near-identical
success lessons where only one was reviewed — quality reranking surfaces the lesson
that actually solves the problem.

**Why is flat-file's Precision@3 / Recall@3 higher?** Honesty matters: the flat-file
ranker scores the *entire* 17-lesson corpus, while cachly and BM25 rank the capped
BM25 candidate set. On a tiny corpus, "return more" mechanically inflates recall-at-k
without making the *top* answer better. We deliberately did **not** rig this away — and
we **steelman** the flat-file with a recency tiebreak it wouldn't normally have. Even
so, cachly wins the metrics an agent actually depends on.

## Honest limitations (read this)

- **Small corpus.** 17 lessons, 13 queries. This proves the *mechanism* works for
  each quality signal and guards against regressions. It does **not** yet prove
  real-world magnitude. The flat-file head-to-head is now built in (a naive,
  quality-blind ranker), but the next step is a larger, externally-sourced corpus
  and the same head-to-head on **real agent traces** with third-party labels.
- **Ranking, not retrieval.** Both rankers see the same BM25 candidates, so this
  measures the quality layer only. CKG-traversal and semantic retrieval are
  evaluated separately via integration tests and are not in these numbers.
- **Labels are ours.** Gold relevance is author-assigned. A credible public
  benchmark needs third-party labels.

The point of this file is not to claim victory. It is to make the moat
*measurable* and *defended by CI*, so every future change to recall must move this
number in the right direction — or it doesn't ship.

## External labeled corpus (`npm run bench:external`)

To address the "labels are ours" limitation, the same three-ranker harness now runs
against a **portable, externally-supplied corpus** — a single JSON file with
`lessons` (with optional quality metadata) and labeled `queries`. Drop in any
third-party-labeled set and reproduce the lift claim on data you control:

```bash
npm run bench:external                            # bundled sample corpus
npm run bench:external -- ./your-corpus.json      # your own labeled set
npm run bench:external -- ./your-corpus.json --json
```

Two bundled corpora now ship, both independently shaped from the fixture bench:

| Corpus | Lessons | Queries | P@1 vs flat | MRR vs flat |
|---|---|---|---|---|
| `sample-corpus.json` (general infra) | 10 | 8 | +20.0% | +7.7% |
| `agent-traces-corpus.json` (agent sessions) | 22 | 15 | **+66.7%** | **+9.5%** |

The agent-traces corpus is modelled after patterns observed in real AI-agent debugging
sessions: TypeScript/ESM resolution, Docker layer caching, DB migration locks, GitHub
Actions pnpm caching, Redis eviction policy, Node.js event-emitter leaks, JWT
clock-skew, and Vitest fake-timer issues. Each category contains an adversarial
**symptom-dense failure distractor** competing with the solution-focused proven
success — the hardest realistic recall case for any ranker.

```bash
npm run bench:external -- src/bench/external/agent-traces-corpus.json
```

The loader validates structure (unique topics, every `relevant` topic exists) and is
covered by `external-bench.test.ts`.

> Note: a generic IR corpus with **no** quality metadata will show cachly ≈ BM25 —
> the quality rerank can only help when the corpus carries outcome / proven-ness /
> review signals. That is itself an honest, documented result: cachly's lift comes
> specifically from engineering-lesson corpora where those signals exist.

---

## Onboarding-Bench — time-to-first-recall (`npm run bench:onboarding`)

The recall-lift benches above answer "given knowledge, do we rank it better?". This
bench answers a different, equally decisive question: **how fast does a brand-new
user reach their first useful recall?**

We model time-to-first-recall as a **cold-start hit rate**. A new user asks their
first realistic question — phrased the way a frustrated developer types it, *not*
using the lesson's topic slug. Two scenarios run over the same 16 queries through the
**real keyword search engine**:

- **cold** — empty Brain (fresh repo, no git-derived lessons). What every user saw
  before v0.10.80.
- **seeded** — Brain pre-seeded with the curated 16-lesson starter corpus
  (`brain_seed_starter`, which auto-runs on first session when git history is empty).

```bash
npm run bench:onboarding            # pretty report
npm run bench:onboarding -- --json  # machine-readable
```

### Result

| Metric | cold (empty) | seeded (starter) |
|---|---|---|
| First-query hit@1 | 0.0% | **87.5%** |
| Hit@3 | 0.0% | **100.0%** |
| MRR | 0.0% | **93.8%** |
| Answered (any result) | 0.0% | **100.0%** |

**Interpretation.** With an empty Brain the first query returns nothing — the user
must do work, learn a lesson, and only *then* can recall it, so time-to-first-recall
spans at least one full work cycle (minutes → hours). With the starter corpus seeded
on first session, the first query hits immediately → time-to-first-recall collapses
to seconds. CI-defended in `onboarding-bench.test.ts` (cold must answer 0%, seeded
must keep hit@3 ≥ 90%, hit@1 ≥ 70%, MRR ≥ 80%).

> This is a retrieval proxy, not a wall-clock measurement of live users. The real
> server-side wall-clock distribution (born_at → first_recall_at across actual
> instances) is tracked per-Brain in `brain_metrics` and is the subject of the
> external analytics dashboard (see `PLAN-DASHBOARD.md`).
