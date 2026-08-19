/**
 * Hilft es, den Schwerpunkt aus den Vektoren zu nehmen?
 *
 * ── Der Befund, der zu dieser Frage führte ───────────────────────────────────
 *
 * Am 19.08.2026 an 499 Lektionen gemessen: wenn der Bedeutungsabgleich
 * danebenliegt, liegt er KNAPP daneben. Beispiele aus dem Lauf:
 *
 *   richtige Lektion 0,535 — falsche auf Platz 1: 0,562
 *   richtige Lektion 0,556 — falsche auf Platz 1: 0,584
 *
 * Alle Ähnlichkeiten liegen zwischen 0,42 und 0,61. Bei einem Kosinus, der von
 * -1 bis 1 reicht, ist das ein sehr schmales Band.
 *
 * Der Grund ist bekannt und hat nichts mit dem Wissen zu tun: Einbettungen
 * eines Modells teilen eine gemeinsame Grundrichtung. Jeder Text zeigt zu einem
 * großen Teil dorthin, und dieser Teil ist in JEDEM Vergleich gleich. Er
 * verschiebt alle Werte nach oben und drückt die Unterschiede zusammen — also
 * genau das, worauf es beim Sortieren ankommt.
 *
 * Die Abhilfe ist eine Subtraktion: den Mittelwert aller Lektionsvektoren
 * einmal ausrechnen und von jedem Vektor abziehen. Was übrig bleibt, ist das,
 * worin sich die Texte UNTERSCHEIDEN.
 *
 * Diese Datei misst, ob das hier wirklich hilft — statt es zu glauben, weil es
 * in Aufsätzen steht.
 *
 * Aufruf:
 *   npx tsx src/bench/vektoren-zentrieren.ts ./korpus.json
 */

import { readFileSync, existsSync } from 'node:fs';
import type { BenchLesson, BenchQuery } from './fixtures.js';
import { kosinus } from '../bedeutung.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const pfad = process.argv[2];
const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;
const cache = pfad.replace(/\.json$/, '.einbettungen.json');
if (!existsSync(cache)) { console.error(`Einbettungen fehlen: ${cache}`); process.exit(2); }

const roh = JSON.parse(readFileSync(cache, 'utf8')) as { alle: Array<number[] | null> };
const lektionen = roh.alle.slice(0, korpus.lessons.length);
const fragen = roh.alle.slice(korpus.lessons.length);

const daL = lektionen.filter(Boolean) as number[][];
if (daL.length === 0) { console.error('keine Lektionsvektoren'); process.exit(3); }
const dim = daL[0].length;

/** Der Schwerpunkt aller Lektionsvektoren — die gemeinsame Grundrichtung. */
function schwerpunkt(vs: number[][]): number[] {
  const m = new Array<number>(dim).fill(0);
  for (const v of vs) for (let i = 0; i < dim; i++) m[i] += v[i];
  for (let i = 0; i < dim; i++) m[i] /= vs.length;
  return m;
}
const mitte = schwerpunkt(daL);

const abzueglich = (v: number[] | null, m: number[]): number[] | null =>
  v ? v.map((x, i) => x - m[i]) : null;

/**
 * Wie groß ist der gemeinsame Anteil? Ein Wert nahe 1 heißt: fast jeder
 * Vektor zeigt in dieselbe Richtung, und der Rest ist Feinabstimmung.
 */
const laenge = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
const anteil = daL.reduce((s, v) => s + Math.abs(kosinus(v, mitte)), 0) / daL.length;

function bewerte(lek: Array<number[] | null>, fra: Array<number[] | null>) {
  const plaetze: number[] = [];
  const abstaende: number[] = [];
  for (const [i, q] of korpus.queries.entries()) {
    const fv = fra[i];
    if (!fv) { plaetze.push(-1); continue; }
    const rang = korpus.lessons
      .map((l, j) => ({ t: l.topic, s: lek[j] ? kosinus(fv, lek[j]!) : -2 }))
      .sort((a, b) => b.s - a.s);
    plaetze.push(rang.findIndex((r) => r.t === q.relevant[0]));
    // Abstand zwischen Platz 1 und Platz 10 — je groesser, desto klarer die
    // Entscheidung. Ein schmales Band heisst: die Rangfolge ist Zufall.
    if (rang.length > 10) abstaende.push(rang[0].s - rang[10].s);
  }
  const n = plaetze.length;
  const bis = (k: number) => plaetze.filter((p) => p >= 0 && p < k).length;
  const mrr = plaetze.reduce((s, p) => s + (p >= 0 ? 1 / (p + 1) : 0), 0) / n;
  const gef = plaetze.filter((p) => p >= 0).map((p) => p).sort((a, b) => a - b);
  return {
    p1: bis(1), p3: bis(3), p10: bis(10), mrr,
    median: gef.length ? gef[Math.floor(gef.length / 2)] + 1 : -1,
    spanne: abstaende.reduce((s, x) => s + x, 0) / Math.max(1, abstaende.length),
  };
}

const zeile = (name: string, e: ReturnType<typeof bewerte>) =>
  `  ${name.padEnd(26)} ${String(e.p1).padStart(4)} ${String(e.p3).padStart(6)} ${String(e.p10).padStart(6)} `
  + `${(100 * e.mrr).toFixed(1).padStart(7)}% ${String(e.median).padStart(7)} ${e.spanne.toFixed(3).padStart(8)}`;

console.log('');
console.log(`  ${daL.length} Lektionsvektoren, ${dim} Zahlen je Vektor`);
console.log(`  Gemeinsamer Anteil: ${(100 * anteil).toFixed(1)} % — so stark zeigt ein durchschnittlicher`);
console.log(`  Vektor bereits in die Richtung des Schwerpunkts, bevor irgendetwas verglichen wird.`);
console.log(`  Laenge des Schwerpunkts: ${laenge(mitte).toFixed(2)}`);
console.log('');
console.log('  Verfahren                  P@1   Top3  Top10     MRR  Median   Spanne');
console.log(zeile('roh (heute)', bewerte(lektionen, fragen)));

const lZ = lektionen.map((v) => abzueglich(v, mitte));
const fZ = fragen.map((v) => abzueglich(v, mitte));
console.log(zeile('ohne Schwerpunkt', bewerte(lZ, fZ)));

// Variante: auch den Schwerpunkt der FRAGEN abziehen. Fragen und Lektionen
// sind verschiedene Textsorten und haben je einen eigenen Schwerpunkt.
const daF = fragen.filter(Boolean) as number[][];
if (daF.length > 5) {
  const mitteF = schwerpunkt(daF);
  const fZ2 = fragen.map((v) => abzueglich(v, mitteF));
  console.log(zeile('je eigener Schwerpunkt', bewerte(lZ, fZ2)));
}

console.log('');
console.log('  Spanne = mittlerer Abstand zwischen Platz 1 und Platz 11.');
console.log('  Je groesser, desto klarer die Entscheidung — ein schmales Band');
console.log('  heisst, dass die Rangfolge von Nachkommastellen abhaengt.');
