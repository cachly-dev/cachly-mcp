#!/usr/bin/env node
/**
 * ══ Ändert das Symptom im Text den Rohabstand? ════════════════════════════
 *
 * ── Die Kette, die hierher führt (30.08.2026, Karte zarko0q3w2xt) ─────────
 *
 * 1. Irrtumsquote@1 = 100 % — und schon ohne die falschen Lektionen stand
 *    auf Platz eins ein Fehlversuch (Commit 0f7b1902).
 * 2. Die Zerlegung zeigte, warum: die richtige Lektion liegt roh 2,32x bzw.
 *    7,27x zurück, und die Qualität gleicht höchstens 2,11x aus (PR #531).
 * 3. Der Grund: **die Frage nennt das SYMPTOM, die Lektion die LÖSUNG.**
 *    Wortübereinstimmung belohnt, wer das Problem wiederholt — und das tut
 *    ein Fehlversuch von Natur aus.
 *
 * ── Was diese Probe misst ─────────────────────────────────────────────────
 *
 * Genau eine Frage, und nur diese: **wenn die richtige Lektion das Symptom
 * in den Worten des Suchenden mitträgt — schließt sich der Rohabstand?**
 *
 * Der Mechanismus dafür existiert längst und wird nicht benutzt:
 *
 *   - `context` steht im Schema von `learn_from_attempts`, beschrieben als
 *     „Additional context, error messages, root cause (optional)".
 *   - Der Index liest den ROHEN Inhalt, `context` ist also mit drin.
 *   - **Null von 499 echten Lektionen tragen das Feld.**
 *
 * Und die Beschreibung fragt nach dem Falschen: „error messages, root cause"
 * ist die Sicht dessen, der es schon gelöst hat. Gesucht wird in den Worten
 * dessen, der noch mittendrin steckt.
 *
 * ── Was sie NICHT beweist ─────────────────────────────────────────────────
 *
 * Dass es auf echten Daten wirkt. Sie ändert EINE Lektion im Prüfsatz und
 * liest den Abstand ab. Das ist der billigste Aufschluss, nicht das
 * Ergebnis — und er sagt vor allem, ob sich der Aufwand lohnt.
 *
 * Und sie misst die Länge mit: wer das Symptom in jede Lektion schreibt,
 * bläht den Text auf, und dann gewinnt wieder, wer am meisten schreibt.
 *
 * Aufruf:  npx tsx src/bench/symptom-probe.ts
 */

import { BENCH_LESSONS, type BenchLesson } from './fixtures.js';
import { FALSCHE_LEKTIONEN, IRRTUMS_FRAGEN } from './irrtumsquote.js';
import { indexCorpus, LESSON_PREFIX } from './cachly-bench.js';
import { rerankByQuality } from '../rerank.js';
import { keywordSearch } from '../search.js';

/**
 * Das Symptom in den Worten des Suchenden — nicht in denen des Lösers.
 *
 * Wörtlich aus der jeweiligen Frage genommen. Das ist Absicht: die Probe
 * soll die OBERGRENZE zeigen. Was ein Mensch beim Schreiben tatsächlich
 * trifft, ist weniger — aber wenn schon die Obergrenze nichts bringt, lohnt
 * der Weg gar nicht.
 */
const SYMPTOME: Record<string, string> = {
  'deploy:k8s:rollout-stuck':
    'Symptom: kubernetes deploy stuck, the rollout was not finishing.',
  'db:postgres:connection-pool-exhausted':
    'Symptom: postgres reported too many connections under load.',
};

function mitSymptom(l: BenchLesson): BenchLesson {
  const s = SYMPTOME[l.topic];
  if (!s) return l;
  return { ...l, context: `${l.context ?? ''} ${s}`.trim() };
}

/** Zeichen im indizierten Inhalt — die Laengenkosten der Aenderung. */
function laenge(l: BenchLesson): number {
  return JSON.stringify(l).length;
}

async function platzUndRoh(lektionen: BenchLesson[], frage: string, gold: string) {
  const redis = indexCorpus(lektionen);
  const roh = await keywordSearch(redis as never, [`${LESSON_PREFIX}*`], frage, 25);
  const sortiert = rerankByQuality(roh);
  const topics = sortiert.map((m) => m.key.replace(LESSON_PREFIX, ''));
  const eigen = sortiert.find((m) => m.key.replace(LESSON_PREFIX, '') === gold);
  return {
    platz: topics.indexOf(gold) + 1, // 0 = nicht gefunden
    roh: eigen?.score ?? 0,
    spitzeRoh: sortiert[0]?.score ?? 0,
    spitze: topics[0] ?? '(nichts)',
  };
}

async function main(): Promise<void> {
  const ohne = [...BENCH_LESSONS, ...FALSCHE_LEKTIONEN];
  const mit = [...BENCH_LESSONS.map(mitSymptom), ...FALSCHE_LEKTIONEN];

  const zusatz = BENCH_LESSONS.reduce((s, l) => s + (laenge(mitSymptom(l)) - laenge(l)), 0);
  console.log(`\nZwei Lektionen tragen jetzt das Symptom. Laengenkosten: +${zusatz} Zeichen`);
  console.log(`ueber ${BENCH_LESSONS.length} Lektionen.\n`);

  for (const q of IRRTUMS_FRAGEN) {
    const gold = q.relevant[0];
    const a = await platzUndRoh(ohne, q.query, gold);
    const b = await platzUndRoh(mit, q.query, gold);

    const abstandA = a.roh > 0 ? a.spitzeRoh / a.roh : Infinity;
    const abstandB = b.roh > 0 ? b.spitzeRoh / b.roh : Infinity;

    console.log(`── "${q.query}"`);
    console.log(`   gold: ${gold}\n`);
    console.log(`   ohne Symptom   Platz ${a.platz || '—'}   roh ${a.roh.toFixed(2).padStart(6)}   Abstand zur Spitze ${abstandA.toFixed(2)}x`);
    console.log(`   mit  Symptom   Platz ${b.platz || '—'}   roh ${b.roh.toFixed(2).padStart(6)}   Abstand zur Spitze ${abstandB.toFixed(2)}x`);
    const besser = b.platz > 0 && (a.platz === 0 || b.platz < a.platz);
    const gleich = b.platz === a.platz;
    console.log(`   ${besser ? '→ BESSER' : gleich ? '→ unveraendert' : '→ SCHLECHTER'}`);
    console.log(`   Spitze bleibt: ${b.spitze}\n`);
  }

  console.log(`Die Symptome sind WOERTLICH aus der Frage genommen. Das ist die
OBERGRENZE dessen, was der Weg leisten kann — ein Mensch trifft beim
Schreiben weniger. Bringt schon die Obergrenze nichts, lohnt der Weg nicht.

NICHT GEMESSEN: die Wirkung auf echten Daten. Null von 499 Lektionen tragen
heute ein context-Feld, es gibt also nichts zu messen, bevor es geschrieben
wird.`);
}

main().catch((e) => {
  console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
