# Cachly-Bench — recall quality, measured

Cachly's claim is structural: a memory that ranks by **lesson quality** (outcome,
confidence, proven-ness, human review) surfaces the lesson that actually helps
before a text-similar failed attempt. A flat-file memory — an LLM reading its own
`/memories` directory — has none of those signals. This benchmark proves the lift
on a fixed, labeled corpus and defends it in CI.

## Run it

```bash
npm run bench            # pretty head-to-head on the built-in fixture corpus
npm run bench:external   # third-party-labeled external corpus
npm run bench:gate       # CI gate: home + external, fails on regression
npm run bench:onboarding # cold vs seeded time-to-first-recall
```

## The three rankers compared

| Ranker     | What it models                                              |
|------------|------------------------------------------------------------|
| `flatfile` | Naive term-overlap, no IDF, no quality signal (≈ LLM reading memory files) |
| `baseline` | Raw BM25+ keyword ranking                                  |
| `cachly`   | BM25+ (top-25 candidate pool) → quality-aware rerank        |

All three score over the **same** candidate set, so the comparison isolates
ranking quality, not retrieval.

## Current results (2026-06-07)

### Home fixture corpus (17 lessons · 13 queries)

| metric       | flatfile | baseline | cachly | vs flat |
|--------------|----------|----------|--------|---------|
| Precision@1  | 76.9%    | 69.2%    | 92.3%  | +20.0%  |
| Recall@3     | 100.0%   | 96.2%    | 100.0% |  +0.0%  |
| MRR          | 87.2%    | 84.6%    | 96.2%  | +10.3%  |
| nDCG@5       | 89.9%    | 88.8%    | 97.6%  |  +8.7%  |

> **Diese Zahl war veraltet und stand hier wie ein aktueller Messwert.**
>
> Gemessen am 20.08.2026 mit `npm run bench` auf demselben Pruefstand:
> `vs BM25 baseline: MRR +0.0% · Precision@1 +0.0%`.
>
> Die alten Werte stammen aus einer Formel, die am 19.08.2026 abgeloest wurde,
> weil sie auf 498 ECHTEN Lektionen nur 15 % Precision@1 erreichte. Die
> Nachfolgerin erreicht dort 30 % — und auf diesem kleinen Pruefstand weniger.
> Der Pruefstand bewegt sich also entgegengesetzt zur Wirklichkeit; die
> Begruendung steht in `src/bench/gate.ts`.
>
> **17 Lektionen und 13 Fragen sind ein Beispielsatz, kein Bestand.** Wer eine
> Zahl aus dieser Datei zitiert, zitiert einen Beispielsatz.

### External labeled corpus

| metric       | cachly | gate floor |
|--------------|--------|-----------|
| Precision@1  | 80.4%  | 78.0%     |
| Recall@3     | 98.2%  | 96.0%     |
| MRR          | 89.0%  | 87.0%     |
| nDCG@5       | 91.8%  | 90.0%     |

## How the lift is produced

Three mechanisms, each load-bearing (see `src/search.ts`, `src/rerank.ts`):

1. **Document-side cross-lingual expansion is disabled.** Indexing a document
   with all ~28 multilingual synonyms of every common word (e.g. `error` →
   `エラー`, `错误`, `خطأ`, …) made BM25 count them as exact matches and inflated
   any document containing a common word ~28×, burying topic-specific lessons.
   **Queries still expand**, so a Japanese query still retrieves English lessons.

2. **Wider candidate pool (top-25).** The reranker can only rescue a relevant
   lesson it can see; BM25 vocabulary mismatch sometimes ranks the right lesson
   11–25. A 25-deep pool lets quality pull it back into the top 3–5.

3. **Score compression before quality.** A distractor whose `what_failed`
   contains the exact query phrase can score 5–6× higher than the correct
   success lesson in raw BM25 — too much for a ±40% quality multiplier to
   overcome. Compressing with `score^0.3` shrinks the ratio to ~1.5×, then
   `compressed * (0.4 + 0.6 * qualityBoost)` lets a proven success win.

## Token cost — measured (`npm run bench:cost`)

Recall quality is one half of the value; **token cost** is the other. This bench
measures the part that is exactly tokenizer-countable on the same corpus: how many
**context input tokens** a targeted recall sends per call versus the "paste
everything" approach (a flat-file / CLAUDE.md dump, or anything that re-sends the
whole knowledge base into the prompt each call).

### Current result (home corpus, 17 lessons · 13 queries)

| approach                              | context tokens / call |
|---------------------------------------|-----------------------|
| paste everything (flat-file / dump)   | 939                   |
| cachly targeted recall (top-3)        | ~57                   |
| **context-token reduction**           | **~94%**              |

Counted with `gpt-tokenizer` (cl100k_base). The reduction grows with the size of
your knowledge base — re-sending everything scales linearly, targeted recall does
not. This is **retrieval efficiency only**: it is an honest input-token number, not
a blanket "X% lower bill". Output tokens, multi-turn dynamics, and semantic-cache
hit rate are out of scope here (the cache's real per-instance hit rate and € saved
are reported live in the dashboard).

## CI regression gate

`src/bench/gate.ts` runs both corpora and asserts cachly's metrics stay at or
above committed floors (`FLOORS`). Update the floors **deliberately**, with a
bench run in the PR, when an intentional change moves them. A ranking change can
never again silently degrade recall.
