/**
 * Trennt zwei Ursachen, die im Gesamtergebnis nicht zu unterscheiden sind.
 *
 * Der Bench auf 498 Lektionen liefert 2 Treffer von 20. Dafuer gibt es zwei
 * voellig verschiedene Erklaerungen:
 *
 *   A) MENGE. Die richtige Lektion wird von hunderten Ablenkern verdraengt.
 *      Dann waere es ein Rangfolge-Problem und wuerde bei kleinem Bestand
 *      verschwinden.
 *
 *   B) WORTSCHATZ. Die Frage und die Antwort teilen keine Woerter. Dann bleibt
 *      es auch bei 50 Lektionen falsch, denn die richtige Lektion gewinnt nicht
 *      einmal gegen 30 zufaellige.
 *
 * ERGEBNIS vom 19.08.2026 (20 Fragen, Bestand von 20 auf 498):
 *   20 Lektionen  6/20 auf Platz 1   9/20 unter den ersten 3
 *   50            3/20               5/20
 *  200            2/20               2/20
 *  498            2/20               2/20
 *
 * Damit ist die Frage beantwortet: schon OHNE jeden Ablenker scheitern 14 von
 * 20 Fragen. Das ist Ursache B, Wortschatz. Die Menge kostet weitere 4.
 *
 * Der Unterschied entscheidet, was zu tun ist: bessere Rangfolge oder bessere
 * Abbildung von Frage auf Antwort. Deshalb dieselbe Frageliste gegen wachsende
 * Bestaende.
 *
 * Die Ablenker werden mit festem Startwert gezogen, damit der Lauf wiederholbar
 * ist — ein Zufall, den man nicht nachstellen kann, ist keine Messung.
 */

import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { keywordSearch } from '../search.js';

const K = JSON.parse(readFileSync(process.argv[2], 'utf8'));

class MiniRedis {
  store = new Map<string, string>();
  set(k: string, v: string) { this.store.set(k, v); }
  async get(k: string) { return this.store.get(k) ?? null; }
  scanStream(o: { match: string }) {
    const e = new EventEmitter();
    const praefix = o.match.replace('*', '');
    const m = [...this.store.keys()].filter((k) => k.startsWith(praefix));
    setImmediate(() => { e.emit('data', m); e.emit('end'); });
    return e;
  }
  pipeline() {
    const c: string[] = [];
    const s = this.store;
    return {
      get(k: string) { c.push(k); return this; },
      async exec() { return c.map((k) => [null, s.get(k) ?? null]); },
    };
  }
}

/** Wiederholbarer Zufall (mulberry32) — gleicher Startwert, gleiche Auswahl. */
function wuerfel(saat: number) {
  return () => {
    saat |= 0; saat = (saat + 0x6d2b79f5) | 0;
    let t = Math.imul(saat ^ (saat >>> 15), 1 | saat);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gold = new Set<string>(K.queries.flatMap((q: { relevant: string[] }) => q.relevant));
const goldLektionen = K.lessons.filter((l: { topic: string }) => gold.has(l.topic));
const rest = K.lessons.filter((l: { topic: string }) => !gold.has(l.topic));

async function messe(lektionen: Array<{ topic: string }>) {
  const r = new MiniRedis();
  for (const l of lektionen) r.set('cachly:lesson:best:' + l.topic, JSON.stringify(l));
  let p1 = 0; let p3 = 0;
  for (const q of K.queries) {
    const hits: Array<{ key: string }> = await keywordSearch(r as never, ['cachly:lesson:best:*'], q.query, 5);
    const pos = hits.map((h) => h.key.replace('cachly:lesson:best:', '')).indexOf(q.relevant[0]);
    if (pos === 0) p1++;
    if (pos >= 0 && pos < 3) p3++;
  }
  return { p1, p3 };
}

const stufen = [0, 10, 30, 80, 180, 380, rest.length];
console.log('Frageliste unveraendert (' + K.queries.length + ' Fragen), Bestand waechst:');
console.log('');
console.log('  Lektionen   Platz 1      unter den ersten 3');
for (const n of stufen) {
  const w = wuerfel(42);
  const gemischt = [...rest].sort(() => w() - 0.5).slice(0, n);
  const bestand = [...goldLektionen, ...gemischt];
  const { p1, p3 } = await messe(bestand);
  const pct = (x: number) => (100 * x / K.queries.length).toFixed(0).padStart(3) + ' %';
  console.log('  ' + String(bestand.length).padStart(9) + '   '
    + String(p1).padStart(2) + '/' + K.queries.length + ' = ' + pct(p1) + '     '
    + String(p3).padStart(2) + '/' + K.queries.length + ' = ' + pct(p3));
}
