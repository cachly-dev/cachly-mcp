/**
 * Zeigt fuer jede Frage, WELCHE ihrer Woerter in der richtigen Antwort
 * ankommen — und welche nicht.
 *
 * ── Warum das noetig ist ─────────────────────────────────────────────────────
 *
 * Der Bench sagt "2 von 20". Das ist ein Ergebnis, keine Diagnose. Zum Bauen
 * braucht es die Frage darunter: scheitert es an der Wortform (Abhaengigkeiten
 * gegen Abhaengigkeit), an der Sprache (Zwischenspeicher gegen cache) oder
 * daran, dass die Antwort das Wort schlicht nicht enthaelt?
 *
 * Jede dieser drei Ursachen braucht eine andere Abhilfe. Ohne die Aufteilung
 * baut man auf Verdacht.
 *
 * Aufruf:
 *   npx tsx src/bench/wo-bricht-die-frage.ts ./korpus.json
 */

import { readFileSync } from 'node:fs';
import { tokenize } from '../search.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }

const korpus = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Korpus;
const nachThema = new Map(korpus.lessons.map((l) => [l.topic, l]));

let ohneJedeBruecke = 0;
const fehlendeWoerter = new Map<string, number>();

for (const q of korpus.queries) {
  const ziel = nachThema.get(q.relevant[0]);
  if (!ziel) continue;

  // Die Frage wird erweitert (Synonyme), der Datensatz nicht — genau wie im
  // echten Suchlauf. Sonst misst man einen Weg, den es nicht gibt.
  const frageWoerter = [...new Set(tokenize(q.query))];
  const zielText = `cachly:lesson:best:${ziel.topic} ${JSON.stringify(ziel)}`;
  const zielWoerter = new Set(tokenize(zielText, { crossLingualExpand: false }));

  const treffer = frageWoerter.filter((w) => zielWoerter.has(w));
  const daneben = frageWoerter.filter((w) => !zielWoerter.has(w));
  for (const w of daneben) fehlendeWoerter.set(w, (fehlendeWoerter.get(w) ?? 0) + 1);
  if (treffer.length === 0) ohneJedeBruecke++;

  console.log('');
  console.log(`${treffer.length}/${frageWoerter.length} Woerter kommen an  —  ${q.query.slice(0, 58)}`);
  console.log(`   trifft:  ${treffer.join(' ') || '(NICHTS)'}`);
  console.log(`   daneben: ${daneben.slice(0, 12).join(' ')}`);
}

console.log('');
console.log(`Fragen ohne EIN einziges gemeinsames Wort mit der richtigen Antwort: ${ohneJedeBruecke}/${korpus.queries.length}`);
console.log('');
console.log('Haeufigste Woerter ohne Anschluss (Kandidaten fuer Wortform oder Synonym):');
const top = [...fehlendeWoerter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
console.log('  ' + top.map(([w, n]) => `${w}(${n})`).join(' '));
