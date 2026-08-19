/**
 * Nicht "ist sie unter den ersten 3", sondern: auf welchem Platz von 498?
 *
 * Der Unterschied entscheidet, was zu tun ist. Landet die richtige Antwort auf
 * Platz 5, ist die Rangfolge fast richtig und ein Feinschliff genuegt. Landet
 * sie auf Platz 300, hilft kein Feinschliff — dann findet die Suche sie
 * ueberhaupt nicht, und jede Arbeit an Gewichten waere vergeudet.
 *
 * Am 19.08.2026 wurde dreimal hintereinander eine Verbesserung gebaut, die
 * nichts bewegte. Diese Messung sagt, warum: sie zeigt nicht das Ergebnis,
 * sondern den Abstand dazu.
 */

import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { keywordSearch } from '../search.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const korpus = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Korpus;

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

const r = new MiniRedis();
for (const l of korpus.lessons) r.set('cachly:lesson:best:' + l.topic, JSON.stringify(l));

const plaetze: number[] = [];
for (const q of korpus.queries) {
  // Voller Rang: so viele Treffer holen, wie es Lektionen gibt.
  const hits: Array<{ key: string }> = await keywordSearch(
    r as never, ['cachly:lesson:best:*'], q.query, korpus.lessons.length,
  );
  const namen = hits.map((h) => h.key.replace('cachly:lesson:best:', ''));
  const platz = namen.indexOf(q.relevant[0]);
  plaetze.push(platz);
  const anzeige = platz < 0 ? `GAR NICHT (${hits.length} Treffer insgesamt)` : `Platz ${platz + 1}`;
  console.log(`${anzeige.padEnd(28)} ${q.query.slice(0, 56)}`);
}

const gefunden = plaetze.filter((p) => p >= 0);
const stufe = (n: number) => plaetze.filter((p) => p >= 0 && p < n).length;
console.log('');
console.log(`ueberhaupt gefunden: ${gefunden.length}/${plaetze.length}`);
console.log(`  auf Platz 1:       ${stufe(1)}`);
console.log(`  unter den ersten 3:${stufe(3)}`);
console.log(`  unter den ersten 10: ${stufe(10)}`);
console.log(`  unter den ersten 25: ${stufe(25)}`);
console.log(`  unter den ersten 50: ${stufe(50)}`);
if (gefunden.length) {
  const sortiert = [...gefunden].sort((a, b) => a - b);
  console.log(`  Mittelwert (Median) der Plaetze: ${sortiert[Math.floor(sortiert.length / 2)] + 1}`);
}
