#!/usr/bin/env node
/**
 * ══ Woraus besteht Platz 1? ═══════════════════════════════════════════════
 *
 * ── Woher die Frage kommt (30.08.2026, Karte herwg1j3je29) ────────────────
 *
 * Die Irrtumsquote (Commit 0f7b1902) zeigte zwei Dinge:
 *
 *   1. Zwanzig absichtlich falsche, gut findbare Lektionen landen in 2 von 2
 *      Fällen auf Platz eins.
 *   2. Schon OHNE sie stand dort ein FEHLVERSUCH statt des Fixes.
 *
 * Punkt 2 ist der überraschende. Der Sortierer bestraft `outcome: failure`
 * bereits mit 0,55 — und trotzdem gewinnt der Fehlversuch.
 *
 * Die naheliegende Erklärung wäre „die Gewichte sind falsch". Bevor jemand
 * daran dreht, wird ZERLEGT: wie viel von Platz 1 kommt aus der
 * Wortübereinstimmung, wie viel aus der Qualität?
 *
 * Im Kopf von `rerank.ts` steht die Lehre einer früheren Messreihe: „Wer
 * zwei Dinge gleichzeitig verstellt, weiß hinterher nicht, welches gewirkt
 * hat." Dieses Werkzeug verstellt nichts — es liest ab.
 *
 * Aufruf:  npx tsx src/bench/rangfolge-zerlegen.ts
 */

import { BENCH_LESSONS } from './fixtures.js';
import { FALSCHE_LEKTIONEN, IRRTUMS_FRAGEN } from './irrtumsquote.js';
import { indexCorpus, LESSON_PREFIX } from './cachly-bench.js';
import { rerankByQuality } from '../rerank.js';
import { keywordSearch } from '../search.js';

/** Das Qualitätsgewicht aus rerank.ts. Hier gespiegelt, nicht neu gesetzt. */
const GEWICHT = 0.6;

/**
 * Wie viel Rohvorsprung kann die Qualität überhaupt ausgleichen?
 *
 * Der Sortierer rechnet `roh * (1 - g + g * boost)`. Der schlechteste Boost
 * (ein Fehlversuch, ~0,5) und der beste (~1,8) spannen den Bereich auf. Ist
 * der Rohvorsprung größer als dieses Verhältnis, entscheidet allein die
 * Wortübereinstimmung — und jede Änderung an den Gewichten wäre folgenlos.
 */
export function qualitaetsSpanne(gewicht: number, boostMin: number, boostMax: number) {
  const min = 1 - gewicht + gewicht * boostMin;
  const max = 1 - gewicht + gewicht * boostMax;
  return { min, max, verhaeltnis: max / min };
}

async function main(): Promise<void> {
  const alle = [...BENCH_LESSONS, ...FALSCHE_LEKTIONEN];
  const falsch = new Set(FALSCHE_LEKTIONEN.map((l) => l.topic));
  const redis = indexCorpus(alle);
  const s = qualitaetsSpanne(GEWICHT, 0.5, 1.8);

  console.log(`\nQualitaets-Gewicht ${GEWICHT}. Die Qualitaet bewegt den Endwert zwischen`);
  console.log(`${s.min.toFixed(2)} und ${s.max.toFixed(2)} — sie gleicht hoechstens einen Rohvorsprung`);
  console.log(`von ${s.verhaeltnis.toFixed(2)}x aus.\n`);

  for (const q of IRRTUMS_FRAGEN) {
    const roh = await keywordSearch(redis as never, [`${LESSON_PREFIX}*`], q.query, 25);
    const sortiert = rerankByQuality(roh);

    console.log(`── "${q.query}"`);
    console.log(`   gold: ${q.relevant.join(', ')}\n`);

    const plaetze = sortiert.slice(0, 4).map((m) => ({
      topic: m.key.replace(LESSON_PREFIX, ''),
      roh: m.score,
      boost: m.qualityBoost,
      end: m.finalScore,
    }));

    for (const [i, p] of plaetze.entries()) {
      const marke = falsch.has(p.topic) ? '✗' : q.relevant.includes(p.topic) ? '★' : ' ';
      console.log(
        `   ${marke} ${i + 1}. ${p.topic.padEnd(38)}` +
        `roh ${p.roh.toFixed(2).padStart(6)}  boost ${p.boost.toFixed(2)}  =  ${p.end.toFixed(2)}`,
      );
    }

    // Der eigentliche Befund: wo steht die RICHTIGE Lektion roh?
    const gold = sortiert.find((m) => q.relevant.includes(m.key.replace(LESSON_PREFIX, '')));
    const spitze = sortiert[0];
    if (gold && spitze && gold.score > 0) {
      const abstand = spitze.score / gold.score;
      console.log(`\n   Die richtige Lektion hat roh ${gold.score.toFixed(2)}, die Spitze ${spitze.score.toFixed(2)}`);
      console.log(`   Rohabstand: ${abstand.toFixed(2)}x — Qualitaetsspanne: ${s.verhaeltnis.toFixed(2)}x`);
      console.log(`   ${abstand > s.verhaeltnis
        ? 'GROESSER. Keine Einstellung der Gewichte holt das auf.'
        : 'kleiner. Die Gewichte koennten es drehen.'}`);
    }
    console.log('');
  }

  console.log(`Bevor jemand an outcome, confidence oder recall_count dreht: diese
Zerlegung sagt, OB sie ueberhaupt zum Zug kommen.

Der Verdacht, den sie pruefbar macht: die richtige Lektion beschreibt die
LOESUNG, die Frage beschreibt das SYMPTOM. Wortuebereinstimmung belohnt, wer
das Problem wiederholt — und das tut ein Fehlversuch von Natur aus.

Das waere derselbe Befund wie bei LoCoMo, wo zwei Drittel der blinden Fragen
in die Klasse "anders formuliert" fielen.`);
}

main().catch((e) => {
  console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
