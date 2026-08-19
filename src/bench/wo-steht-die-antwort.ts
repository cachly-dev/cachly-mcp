/**
 * Steht die Antwort auf die Frage IM Text — nur an einer Stelle, die untergeht?
 *
 * ── Die Vermutung ───────────────────────────────────────────────────────────
 *
 * Eine Frage ist 60 Zeichen lang, eine Lektion im Mittel 1376. Ein einziger
 * Vektor über 1376 Zeichen ist ein Durchschnitt: die eine Stelle, die zur Frage
 * passt, wird von allem anderen weggemittelt.
 *
 * Wenn das stimmt, muss gelten: der SATZ mit der besten Übereinstimmung liegt
 * deutlich über der Übereinstimmung des ganzen Textes — und zwar besonders bei
 * den Fragen, die heute danebengehen.
 *
 * Wenn das NICHT stimmt, ist Zerteilen die falsche Baustelle, und man spart
 * sich fünfzig Minuten Einbettungen für nichts.
 *
 * Gemessen wird lexikalisch (Wortüberlappung), nicht mit Vektoren — es geht um
 * die Frage "ist die Information überhaupt lokal konzentriert", und die
 * beantwortet ein Wortvergleich genauso gut und sofort.
 *
 * Aufruf:
 *   npx tsx src/bench/wo-steht-die-antwort.ts ./korpus.json
 */

import { readFileSync } from 'node:fs';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const korpus = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Korpus;
const nachThema = new Map(korpus.lessons.map((l) => [l.topic, l]));

const woerter = (s: string): Set<string> =>
  new Set(
    s.toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

/** Text einer Lektion, so wie ein Mensch ihn liest. */
const text = (l: BenchLesson): string =>
  [l.topic, l.what_worked, (l as { what_failed?: string }).what_failed].filter(Boolean).join('\n');

/** In Stücke schneiden — an Satzzeichen, mit Mindestlänge. */
function stuecke(s: string, ziel = 320): string[] {
  const teile = s.split(/(?<=[.!?\n])\s+/);
  const aus: string[] = [];
  let puffer = '';
  for (const t of teile) {
    puffer = puffer ? `${puffer} ${t}` : t;
    if (puffer.length >= ziel) { aus.push(puffer); puffer = ''; }
  }
  if (puffer.trim().length > 20) aus.push(puffer);
  return aus.length ? aus : [s];
}

/** Anteil der Fragewörter, die im Stück vorkommen. */
function deckung(fragewoerter: Set<string>, stueck: string): number {
  if (fragewoerter.size === 0) return 0;
  const sw = woerter(stueck);
  let treffer = 0;
  for (const w of fragewoerter) if (sw.has(w)) treffer++;
  return treffer / fragewoerter.size;
}

let ganzSumme = 0;
let bestesStueckSumme = 0;
let anzahl = 0;
const verhaeltnisse: number[] = [];
const wo: number[] = [];

for (const q of korpus.queries) {
  const l = nachThema.get(q.relevant[0]);
  if (!l) continue;
  const t = text(l);
  const fw = woerter(q.query);
  const ganz = deckung(fw, t);
  const teile = stuecke(t);
  const werte = teile.map((s) => deckung(fw, s));
  const bestes = Math.max(...werte, 0);

  ganzSumme += ganz;
  bestesStueckSumme += bestes;
  anzahl++;
  if (ganz > 0) verhaeltnisse.push(bestes / ganz);
  // An welcher Stelle des Textes steht das beste Stück?
  const idx = werte.indexOf(bestes);
  if (teile.length > 1) wo.push(idx / (teile.length - 1));
}

const mittel = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

console.log('');
console.log(`  ${anzahl} Fragen mit gefundener Ziellektion`);
console.log('');
console.log(`  Deckung über den GANZEN Text:      ${(100 * ganzSumme / anzahl).toFixed(1)} %`);
console.log(`  Deckung im BESTEN Stück (~320 Z.): ${(100 * bestesStueckSumme / anzahl).toFixed(1)} %`);
console.log(`  Verhältnis (Median):               ${median(verhaeltnisse).toFixed(2)}-fach`);
console.log('');
console.log(`  Lage des besten Stücks im Text (0 = Anfang, 1 = Ende):`);
console.log(`    Mittelwert ${mittel(wo).toFixed(2)} · Median ${median(wo).toFixed(2)}`);
console.log(`    im ersten Drittel: ${wo.filter((x) => x < 0.34).length} von ${wo.length}`);
console.log('');
console.log('  Lesart: ist das Verhältnis deutlich über 1, steckt die Antwort an');
console.log('  EINER Stelle und geht im Durchschnitt des ganzen Textes unter.');
console.log('  Dann lohnt Zerteilen. Liegt es bei 1, ist die Information über den');
console.log('  ganzen Text verteilt und Zerteilen bringt nichts.');
