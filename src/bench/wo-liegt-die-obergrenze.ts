/**
 * Wie gut KÖNNTE es überhaupt werden?
 *
 * ── Warum diese Frage vor der nächsten Idee kommt ───────────────────────────
 *
 * Der Bedeutungsabgleich liefert 40 Prozent auf Platz 1 und 68 Prozent unter
 * den ersten zehn. Die richtige Antwort steht im Mittel auf Platz 2.
 *
 * Daraus folgt etwas Unbequemes: wer die Rangfolge unter den ersten zehn
 * perfekt sortieren könnte, käme auf 68 Prozent — nicht mehr. Alles darüber
 * hinaus braucht nicht bessere Sortierung, sondern bessere VORAUSWAHL.
 *
 * Diese Datei misst die Obergrenze für jede Kombination, die uns zur Verfügung
 * steht: wie oft ist die richtige Lektion überhaupt in der Vorauswahl, egal auf
 * welchem Platz. Diese Zahl ist die Decke. Kein Nachsortierer kommt darüber.
 *
 * Ohne sie diskutiert man über Zielwerte, die niemand erreichen kann — und
 * baut Nachsortierer für ein Problem, das eine Etage tiefer liegt.
 *
 * Aufruf:
 *   npx tsx src/bench/wo-liegt-die-obergrenze.ts ./korpus.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { keywordSearch } from '../search.js';
import { kosinus } from '../bedeutung.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const pfad = process.argv[2];
const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;

const aPfad = pfad.replace(/\.json$/, '.einbettungen.json');
const bPfad = pfad.replace(/\.json$/, '.sicht-b.json');
if (!existsSync(aPfad)) { console.error(`fehlt: ${aPfad}`); process.exit(2); }
const a = JSON.parse(readFileSync(aPfad, 'utf8')) as { alle: Array<number[] | null> };
const sichtA = a.alle.slice(0, korpus.lessons.length);
const fragen = a.alle.slice(korpus.lessons.length);
const sichtB: Array<number[] | null> = existsSync(bPfad)
  ? (JSON.parse(readFileSync(bPfad, 'utf8')) as { alle: Array<number[] | string | null> })
    .alle.map((v) => (Array.isArray(v) ? v : null))
  : korpus.lessons.map(() => null);

class MiniRedis {
  store = new Map<string, string>();
  set(k: string, v: string) { this.store.set(k, v); }
  async get(k: string) { return this.store.get(k) ?? null; }
  scanStream(o: { match: string }) {
    const e = new EventEmitter();
    const p = o.match.replace('*', '');
    const m = [...this.store.keys()].filter((k) => k.startsWith(p));
    setImmediate(() => { e.emit('data', m); e.emit('end'); });
    return e;
  }
  pipeline() {
    const c: string[] = []; const s = this.store;
    return { get(k: string) { c.push(k); return this; },
             async exec() { return c.map((k) => [null, s.get(k) ?? null]); } };
  }
}
const redis = new MiniRedis();
for (const l of korpus.lessons) redis.set('cachly:lesson:best:' + l.topic, JSON.stringify(l));

const naechste = (f: number[], sicht: Array<number[] | null>, n: number) =>
  korpus.lessons
    .map((l, j) => ({ t: l.topic, s: sicht[j] ? kosinus(f, sicht[j]!) : -2 }))
    .sort((x, y) => y.s - x.s).slice(0, n).map((x) => x.t);

const treffer: Record<string, number> = {};
const zaehle = (name: string, drin: boolean) => { treffer[name] = (treffer[name] ?? 0) + (drin ? 1 : 0); };

for (const [i, q] of korpus.queries.entries()) {
  const ziel = q.relevant[0];
  const fv = fragen[i];

  const wort10 = (await keywordSearch(redis as never, ['cachly:lesson:best:*'], q.query, 10) as Array<{ key: string }>)
    .map((h) => h.key.replace('cachly:lesson:best:', ''));
  const wort25 = (await keywordSearch(redis as never, ['cachly:lesson:best:*'], q.query, 25) as Array<{ key: string }>)
    .map((h) => h.key.replace('cachly:lesson:best:', ''));

  const sinn10 = fv ? naechste(fv, sichtA, 10) : [];
  const sinn25 = fv ? naechste(fv, sichtA, 25) : [];
  const symp10 = fv ? naechste(fv, sichtB, 10) : [];

  zaehle('nur Woerter, erste 10', wort10.includes(ziel));
  zaehle('nur Bedeutung, erste 10', sinn10.includes(ziel));
  zaehle('nur Bedeutung, erste 25', sinn25.includes(ziel));
  zaehle('Woerter ODER Bedeutung, je 10', wort10.includes(ziel) || sinn10.includes(ziel));
  zaehle('Woerter ODER Bedeutung, je 25', wort25.includes(ziel) || sinn25.includes(ziel));
  zaehle('alle drei Sichten, je 10', wort10.includes(ziel) || sinn10.includes(ziel) || symp10.includes(ziel));
}

const n = korpus.queries.length;
console.log('');
console.log(`  ${korpus.lessons.length} Lektionen · ${n} Fragen`);
console.log('');
console.log('  Vorauswahl                        Decke');
for (const [name, t] of Object.entries(treffer)) {
  console.log(`  ${name.padEnd(32)} ${String(t).padStart(3)}/${n} = ${(100 * t / n).toFixed(0).padStart(3)} %`);
}
console.log('');
console.log('  "Decke" heisst: so oft ist die richtige Lektion ueberhaupt in der');
console.log('  Vorauswahl. Ein noch so guter Nachsortierer kommt nicht darueber.');
console.log('  Liegt das Ziel ueber der Decke, ist Nachsortieren die falsche Baustelle.');
