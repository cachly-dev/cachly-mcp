/**
 * Bench regression gate (CI).
 *
 * Runs the recall-quality benchmark on both the home fixture corpus and the
 * external labeled corpus, then asserts cachly's metrics stay at or above
 * committed floors. Fails the build (exit 1) on regression so a ranking change
 * can never silently degrade recall again.
 *
 * Floors are set just below the current measured values with a small tolerance,
 * so noise doesn't flake CI but a real regression trips it. Update FLOORS
 * deliberately (with a bench run in the PR) when an intentional change moves them.
 *
 * Run: npm run bench:gate
 */
import { runBenchmarkOn, type BenchMetrics } from './cachly-bench.js';
import { BENCH_LESSONS, BENCH_QUERIES } from './fixtures.js';
import { loadExternalCorpus } from './external-corpus.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// ACHTUNG — diese Werte sind am 19.08.2026 ABSICHTLICH GESUNKEN.
//
// Wer sie steigen sieht und "zurueckstellt", macht die Suche wieder schlechter.
// Deshalb steht hier, was gemessen wurde, und nicht nur, was gilt.
//
// Vorher:  home.precisionAt1 = 0.90 · mrr = 0.94
// Jetzt:   home.precisionAt1 = 0.67 · mrr = 0.83
//
// Die alten Werte kamen aus einer Formel, die die Relevanz stauchte
// (score^0.3) und Qualitaetsmerkmale mit 60 Prozent gewichtete. Auf diesem
// Pruefstand — 17 Lektionen, 13 Fragen — war das ein Gewinn.
//
// Auf 498 ECHTEN Lektionen mit 20 in Alltagssprache gestellten Fragen war
// dieselbe Formel der Verlust:
//
//   Stauchung        echter Bestand P@1     Pruefstand P@1
//   ^0.3 / 0.6 (alt)        15 %                92,3 %
//   ^1.0 / 0.6  (neu)       30 %                69,2 %
//
// Der gesamte Vorteil auf dem Pruefstand WAR der Schaden auf echten Daten.
// Dazu kam der Frischebonus mit Bereich [0.5, 1.5]: er allein kostete auf dem
// echten Bestand 4 von 20 richtigen ersten Plaetzen (Median-Platz 101 statt
// 37). Auch das war auf 17 Lektionen unsichtbar — nicht schwer zu finden,
// UNSICHTBAR: bei 16 Mitbewerbern gewinnt ein seltenes Wort auch gegen den
// Faktor 3.
//
// ── Was dieses Gate NICHT kann ──────────────────────────────────────────────
//
// Es kann diese Fehlerklasse nicht finden. Beide Fehler treten erst ab einigen
// hundert Datensaetzen auf, und beide Korpora hier sind klein. Das Gate bleibt
// ein Rueckschritt-Waechter fuer bekannte Zahlen — kein Beleg fuer Qualitaet.
//
// Was die Klasse faengt, steht in src/rangfolge-braucht-relevanz.test.ts:
// Waechter fuer die zwei konkreten Mechanismen (Frische darf Relevanz nicht
// ueberstimmen, Relevanz darf nicht gestaucht werden). Und der ehrliche Weg
// bleibt: gegen den eigenen echten Bestand messen, siehe
// src/bench/korpus-aus-brain.ts.
// ─────────────────────────────────────────────────────────────────────────────
const FLOORS: Record<string, Partial<BenchMetrics>> = {
  home: { precisionAt1: 0.67, recallAt3: 0.96, mrr: 0.83, ndcgAt5: 0.87 },
  // external.recallAt3 von 0,93 auf 0,92: der Wortabgleich loest unscharfe
  // Treffer seit dem 19.08.2026 EINMAL je Frage gegen den Gesamtwortschatz auf
  // statt je Dokument (788 ms -> 262 ms). Der Preis ist gemessen: auf dem
  // externen Beispielkorpus 0,1 Prozentpunkte, auf 499 echten Lektionen im
  // gemischten Betrieb nichts (40 gegen 41 auf Platz 1, bei drei Vierteln
  // weniger Wartezeit).
  external: { precisionAt1: 0.71, recallAt3: 0.92, mrr: 0.82, ndcgAt5: 0.85 },
};

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ext = await loadExternalCorpus(resolve(here, 'external', 'sample-corpus.json'));

  const corpora: Array<{ name: keyof typeof FLOORS; result: BenchMetrics }> = [
    { name: 'home', result: (await runBenchmarkOn(BENCH_LESSONS, BENCH_QUERIES)).cachly },
    { name: 'external', result: (await runBenchmarkOn(ext.lessons, ext.queries)).cachly },
  ];

  const failures: string[] = [];
  for (const { name, result } of corpora) {
    const floor = FLOORS[name];
    for (const [metric, min] of Object.entries(floor) as Array<[keyof BenchMetrics, number]>) {
      const got = result[metric];
      const ok = got >= min;
      console.log(`  ${ok ? '✓' : '✗'} ${name}.${metric}: ${pct(got)} (floor ${pct(min)})`);
      if (!ok) failures.push(`${name}.${metric}: ${pct(got)} < floor ${pct(min)}`);
    }
  }

  if (failures.length) {
    console.error(`\n❌ Bench regression — ${failures.length} metric(s) below floor:`);
    for (const f of failures) console.error(`   ${f}`);
    console.error('\nIf this change is intentional, update FLOORS in src/bench/gate.ts with a bench run.\n');
    process.exit(1);
  }
  console.log('\n✅ Bench gate passed — no recall-quality regression.\n');

  // Was dieses Tor NICHT bewacht — und warum das hier steht.
  //
  // Bis zum 21.08.2026 war dies das EINZIGE Bench-Tor in der CI. Wer den
  // gruenen Haken sah, durfte annehmen, die Rangfolge sei abgesichert. Sie war
  // es nicht: hier laufen 17 handgeschriebene Fixtures plus ein kleiner
  // externer Beispielkorpus. Beide sind gut fuer das, wofuer sie gebaut sind —
  // die Formel-Mechanik festhalten —, und beide sagen NICHTS ueber die Zahl,
  // die wir nach aussen nennen.
  //
  // Ein Tor, das mehr zu bewachen scheint als es tut, ist schlimmer als
  // keines. Deshalb sagt es das jetzt selbst, bei jedem Lauf.
  console.log('   Bewacht: die Formel-Mechanik auf 17 Fixtures + externem Beispielkorpus.');
  console.log('   NICHT bewacht: die Rangfolge am echten Bestand — das tut `npm run bench`');
  console.log('   (499 Lektionen, eigene Untergrenzen, laeuft seit 21.08.2026 daneben in der CI).\n');
}

main().catch((e: Error) => { console.error(`\n❌ Bench gate error: ${e.message}\n`); process.exit(1); });
