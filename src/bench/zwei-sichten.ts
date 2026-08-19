/**
 * Hilft eine ZWEITE Sicht je Lektion?
 *
 * ── Die These ────────────────────────────────────────────────────────────────
 *
 * Eine Frage beschreibt ein SYMPTOM: "Der Deploy hängt beim Bauen."
 * Eine Lektion beschreibt eine LÖSUNG: "Runner-Dienst neu starten."
 *
 * Heute wird beides in EINEN Vektor gepackt (Thema + what_worked +
 * what_failed). Der landet dann irgendwo zwischen Symptom und Lösung — also
 * bei keinem von beiden richtig.
 *
 * Sicht B nimmt nur die Symptomseite: Thema, what_failed, Schlagworte,
 * Dateipfade, Zusammenhang. Beim Suchen zählt das MAXIMUM über beide Sichten:
 * eine Lektion passt, wenn IRGENDEINE ihrer Sichten passt.
 *
 * ── Warum das Maximum und nicht der Durchschnitt ────────────────────────────
 *
 * Der Durchschnitt bestraft Lektionen, die eine sehr passende und eine
 * unpassende Sicht haben — und das ist der Normalfall. Wer nach dem Symptom
 * fragt, soll die Lektion finden, deren Symptomseite passt, auch wenn ihre
 * Lösungsseite von etwas ganz anderem handelt.
 *
 * Aufruf:
 *   npx tsx src/bench/zwei-sichten.ts ./korpus.json
 */

import { readFileSync, existsSync } from 'node:fs';
import type { BenchLesson, BenchQuery } from './fixtures.js';
import { kosinus } from '../bedeutung.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const pfad = process.argv[2];
const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;

const aPfad = pfad.replace(/\.json$/, '.einbettungen.json');
const bPfad = pfad.replace(/\.json$/, '.sicht-b.json');
for (const p of [aPfad, bPfad]) {
  if (!existsSync(p)) { console.error(`fehlt: ${p}`); process.exit(2); }
}

const a = JSON.parse(readFileSync(aPfad, 'utf8')) as { alle: Array<number[] | null> };
const b = JSON.parse(readFileSync(bPfad, 'utf8')) as { alle: Array<number[] | string | null> };

const sichtA = a.alle.slice(0, korpus.lessons.length);
const fragen = a.alle.slice(korpus.lessons.length);
// 'leer' bedeutet: diese Lektion hat keinen Symptomtext. Das ist kein
// Fehlschlag, sondern eine Eigenschaft — und muss vom Fehlschlag unterscheidbar
// bleiben, sonst sieht "kein Text" aus wie "Dienst kaputt".
const sichtB = b.alle.map((v) => (Array.isArray(v) ? v : null));
const ohneSymptom = b.alle.filter((v) => v === 'leer').length;
const fehlgeschlagen = b.alle.filter((v) => v === null).length;

function bewerte(naehe: (frage: number[], j: number) => number) {
  const plaetze: number[] = [];
  for (const [i, q] of korpus.queries.entries()) {
    const fv = fragen[i];
    if (!fv) { plaetze.push(-1); continue; }
    const rang = korpus.lessons
      .map((l, j) => ({ t: l.topic, s: naehe(fv, j) }))
      .sort((x, y) => y.s - x.s);
    plaetze.push(rang.findIndex((r) => r.t === q.relevant[0]));
  }
  const n = plaetze.length;
  const bis = (k: number) => plaetze.filter((p) => p >= 0 && p < k).length;
  const gef = plaetze.filter((p) => p >= 0).sort((x, y) => x - y);
  return {
    p1: bis(1), p3: bis(3), p10: bis(10),
    mrr: plaetze.reduce((s, p) => s + (p >= 0 ? 1 / (p + 1) : 0), 0) / n,
    median: gef.length ? gef[Math.floor(gef.length / 2)] + 1 : -1,
  };
}

const nurA = (f: number[], j: number) => (sichtA[j] ? kosinus(f, sichtA[j]!) : -2);
const nurB = (f: number[], j: number) => (sichtB[j] ? kosinus(f, sichtB[j]!) : -2);
const maximum = (f: number[], j: number) => Math.max(nurA(f, j), nurB(f, j));
const mittel = (f: number[], j: number) => {
  const x = nurA(f, j); const y = nurB(f, j);
  if (x < -1) return y; if (y < -1) return x;
  return (x + y) / 2;
};

const zeile = (name: string, e: ReturnType<typeof bewerte>) =>
  `  ${name.padEnd(30)} ${String(e.p1).padStart(4)} ${String(e.p3).padStart(6)} ${String(e.p10).padStart(6)} `
  + `${(100 * e.mrr).toFixed(1).padStart(7)}% ${String(e.median).padStart(7)}`;

console.log('');
console.log(`  ${korpus.lessons.length} Lektionen · ${korpus.queries.length} Fragen`);
console.log(`  Sicht B: ${sichtB.filter(Boolean).length} Vektoren · ${ohneSymptom} Lektionen ohne Symptomtext · ${fehlgeschlagen} Fehlschlaege`);
console.log('');
console.log('  Verfahren                       P@1   Top3  Top10     MRR  Median');
console.log(zeile('Sicht A (Loesung, heute)', bewerte(nurA)));
console.log(zeile('Sicht B (Symptom)', bewerte(nurB)));
console.log(zeile('beide, Maximum', bewerte(maximum)));
console.log(zeile('beide, Mittelwert', bewerte(mittel)));

if (fehlgeschlagen > 0) {
  console.log('');
  console.log(`  ACHTUNG: ${fehlgeschlagen} Lektionen fehlt Sicht B wegen eines Fehlschlags.`);
  console.log('  Die Zeilen mit Sicht B sind damit zu niedrig, nicht zu hoch.');
}
