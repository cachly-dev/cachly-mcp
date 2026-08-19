/**
 * Was bringt welche Raumkorrektur — einzeln und zusammen.
 *
 * Eingestellt wird auf der einen Hälfte der Fragen, gemessen auf der anderen.
 * Ohne diese Trennung findet man mit genug Stellschrauben jede feste Liste.
 *
 * Aufruf:
 *   npx tsx src/bench/raum-durchmessen.ts ./korpus.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { baueRaum, bewerteImRaum, punktprodukt, normiere } from '../raumkorrektur.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const pfad = process.argv[2];
const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;
const cache = pfad.replace(/\.json$/, '.einbettungen.json');
if (!existsSync(cache)) { console.error(`fehlt: ${cache}`); process.exit(2); }
const roh = JSON.parse(readFileSync(cache, 'utf8')) as { alle: Array<number[] | null> };
const lektionen = roh.alle.slice(0, korpus.lessons.length);
const fragen = roh.alle.slice(korpus.lessons.length);

type Teil = 'alle' | 'gerade' | 'ungerade';
function bewerte(punkte: (frage: number[]) => number[], teil: Teil = 'alle') {
  const plaetze: number[] = [];
  korpus.queries.forEach((q, i) => {
    if (teil === 'gerade' && i % 2 !== 0) return;
    if (teil === 'ungerade' && i % 2 === 0) return;
    const fv = fragen[i];
    if (!fv) { plaetze.push(-1); return; }
    const p = punkte(fv);
    const rang = korpus.lessons.map((l, j) => ({ t: l.topic, p: p[j] })).sort((a, b) => b.p - a.p);
    plaetze.push(rang.findIndex((r) => r.t === q.relevant[0]));
  });
  const n = plaetze.length;
  const bis = (k: number) => plaetze.filter((x) => x >= 0 && x < k).length / n;
  return {
    n,
    p1: bis(1), p3: bis(3), p10: bis(10),
    mrr: plaetze.reduce((s, x) => s + (x >= 0 ? 1 / (x + 1) : 0), 0) / n,
  };
}

const zeile = (name: string, e: ReturnType<typeof bewerte>) =>
  `  ${name.padEnd(36)} ${(100 * e.p1).toFixed(0).padStart(4)}% ${(100 * e.p3).toFixed(0).padStart(6)}% `
  + `${(100 * e.p10).toFixed(0).padStart(6)}% ${(100 * e.mrr).toFixed(1).padStart(7)}%`;

// Ausgangspunkt: roher Kosinus.
const normLekt = lektionen.map((v) => (v ? normiere(v) : null));
const roherKosinus = (f: number[]) => {
  const fn = normiere(f);
  return normLekt.map((v) => (v ? punktprodukt(fn, v) : -2));
};

console.log('');
console.log(`  ${korpus.lessons.length} Lektionen · ${korpus.queries.length} Fragen`);
console.log('');
console.log('  Verfahren                             P@1    Top3   Top10     MRR');
console.log(zeile('roh (heute)', bewerte(roherKosinus)));

// Einzelwirkung jeder Korrektur.
for (const [name, opt] of [
  ['nur Schwerpunkt abziehen', { richtungen: 0, beta: 0 }],
  ['+ 1 Hauptrichtung', { richtungen: 1, beta: 0 }],
  ['+ 3 Hauptrichtungen', { richtungen: 3, beta: 0 }],
  ['+ 6 Hauptrichtungen', { richtungen: 6, beta: 0 }],
  ['nur Nabenabzug (beta 0,5)', { richtungen: 0, beta: 0.5 }],
] as Array<[string, { richtungen: number; beta: number }]>) {
  const raum = baueRaum(lektionen, opt);
  console.log(zeile(name, bewerte((f) => bewerteImRaum(raum, f))));
}

// ── Einstellen auf den geraden Fragen, messen auf den ungeraden ────────────
console.log('');
console.log('  ── Suche nach der besten Kombination (gerade Fragen) ──');
let bester: { name: string; opt: { richtungen: number; nachbarn: number; beta: number }; p1: number } | null = null;
for (const richtungen of [0, 1, 2, 3, 5, 8, 12]) {
  for (const beta of [0, 0.25, 0.5, 0.75, 1.0]) {
    for (const nachbarn of [5, 15]) {
      const raum = baueRaum(lektionen, { richtungen, nachbarn, beta });
      const e = bewerte((f) => bewerteImRaum(raum, f), 'gerade');
      const name = `${richtungen} Richtungen · beta ${beta} · ${nachbarn} Nachbarn`;
      if (!bester || e.p1 > bester.p1) bester = { name, opt: { richtungen, nachbarn, beta }, p1: e.p1 };
    }
  }
}
if (bester) {
  const raum = baueRaum(lektionen, bester.opt);
  console.log(zeile(bester.name, bewerte((f) => bewerteImRaum(raum, f), 'gerade')));
  console.log('');
  console.log('  ── Dieselben Einstellungen auf den UNGERADEN Fragen (nie gesehen) ──');
  console.log(zeile('mit Raumkorrektur', bewerte((f) => bewerteImRaum(raum, f), 'ungerade')));
  console.log(zeile('ohne (roher Kosinus)', bewerte(roherKosinus, 'ungerade')));
  console.log('');
  console.log('  ── Und auf allen 100, zum Einordnen ──');
  console.log(zeile('mit Raumkorrektur', bewerte((f) => bewerteImRaum(raum, f))));
}
