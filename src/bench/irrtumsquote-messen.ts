#!/usr/bin/env node
/**
 * ══ Bevorzugt der Sortierer das Richtige oder das gut Indizierte? ═════════
 *
 * Die Belastungsprobe zu `irrtumsquote.ts`: der eingefrorene Prüfsatz wird
 * um zwanzig absichtlich FALSCHE, aber gut findbare Lektionen erweitert.
 * Gemessen wird nur eine Zahl — wie oft steht eine davon auf Platz 1?
 *
 * Der eingefrorene Satz bleibt unangetastet. Die falschen kommen als
 * eigener Satz dazu, und beide Zahlen stehen getrennt.
 *
 * Aufruf:  npx tsx src/bench/irrtumsquote-messen.ts
 */

import { BENCH_LESSONS, type BenchLesson } from './fixtures.js';
import { FALSCHE_LEKTIONEN, IRRTUMS_FRAGEN, irrtumsquote } from './irrtumsquote.js';
import { indexCorpus, LESSON_PREFIX, matchTopic } from './cachly-bench.js';
import { rerankByQuality } from '../rerank.js';
import { keywordSearch } from '../search.js';

async function main(): Promise<void> {
  const mitFalschen: BenchLesson[] = [...BENCH_LESSONS, ...FALSCHE_LEKTIONEN];
  const falscheTopics = new Set(FALSCHE_LEKTIONEN.map((l) => l.topic));

  const redisRein = indexCorpus(BENCH_LESSONS);
  const redisMit = indexCorpus(mitFalschen);

  const ranglistenRein: string[][] = [];
  const ranglistenMit: string[][] = [];

  for (const q of IRRTUMS_FRAGEN) {
    const rein = rerankByQuality(
      await keywordSearch(redisRein as never, [`${LESSON_PREFIX}*`], q.query, 25),
    ).map(matchTopic);
    const mit = rerankByQuality(
      await keywordSearch(redisMit as never, [`${LESSON_PREFIX}*`], q.query, 25),
    ).map(matchTopic);
    ranglistenRein.push(rein);
    ranglistenMit.push(mit);
  }

  const quote = irrtumsquote(ranglistenMit, falscheTopics);

  console.log(`\nPruefsatz: ${BENCH_LESSONS.length} echte + ${FALSCHE_LEKTIONEN.length} absichtlich falsche.`);
  console.log(`Fragen:    ${IRRTUMS_FRAGEN.length}\n`);
  console.log(`  Irrtumsquote@1   ${quote.treffer} von ${quote.gesamt} = ${(quote.quote * 100).toFixed(1)} %`);
  console.log(`  (wie oft steht eine BEKANNT FALSCHE Lektion auf Platz 1)\n`);

  for (const [i, q] of IRRTUMS_FRAGEN.entries()) {
    const eins = ranglistenMit[i][0] ?? '(nichts)';
    const vorher = ranglistenRein[i][0] ?? '(nichts)';
    const marke = falscheTopics.has(eins) ? '✗ FALSCH' : '✓';
    console.log(`  ${marke}  "${q.query}"`);
    console.log(`        ohne falsche:  ${vorher}`);
    console.log(`        mit falschen:  ${eins}`);
  }

  console.log(`
Diese Zahl steht GETRENNT von P@1, Recall@3, MRR und nDCG. Wer sie
verrechnet, loescht genau die Auskunft, fuer die es sie gibt: die vier
messen Findbarkeit, diese eine misst, ob das Gefundene stimmt.

NICHT GEMESSEN: die Alltagsquote. Das hier ist eine Belastungsprobe in einer
Welt, in der jemand absichtlich gut indizierten Unsinn abgelegt hat. Eine
hohe Zahl verurteilt den Sortierer nicht — sie sagt, wie weit er sich auf
Zuversicht und Abrufzahl verlaesst.`);
}

main().catch((e) => {
  console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
