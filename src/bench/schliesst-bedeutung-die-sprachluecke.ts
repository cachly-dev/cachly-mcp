/**
 * Schliesst Bedeutungsabgleich die Luecke zwischen Deutsch und Englisch?
 *
 * ── Warum die Frage zaehlt ──────────────────────────────────────────────────
 *
 * ── ACHTUNG: die Luecke ist NICHT stabil ───────────────────────────────────
 *
 * Am 19.08.2026 wurde zuerst an 20 Beduerfnispaaren gemessen: Median-Platz 44
 * auf Deutsch, 4 auf Englisch. Elffach. Diese Zahl wurde weitergegeben.
 *
 * An 40 Paaren — dieselben 20 plus 20 weitere — dreht sie sich um:
 *
 *   Wortabgleich, 40 Paare:  Deutsch Median 11, Englisch Median 18
 *
 * Beide Messungen sind richtig. Sie messen verschiedene Fragen. Eine
 * Sprachluecke IST damit nicht belegt, und wer die 11-fach-Zahl weitergibt,
 * gibt ein Ergebnis von 20 Fragen als Eigenschaft der Sprache aus.
 *
 * Was bleibt: bei 20 Fragen bewegt ein einziger Ausreisser den Median um
 * Dutzende Plaetze. Diese Datei existiert, damit die naechste Person das sieht,
 * bevor sie eine Zahl zitiert.
 *
 * Die Vermutung dahinter war trotzdem plausibel: die unterscheidenden Woerter
 * (`No space left on device`, `ON CONFLICT`, `fail2ban`) stehen auf Englisch in
 * den Lektionen, weil Werkzeuge Englisch sprechen. Plausibel ist kein Beleg.
 *
 * Ein mehrsprachiges Einbettungsmodell braucht diese Bruecke nicht: es bildet
 * Text auf Punkte ab, und "Zwischenspeicher" und "cache" landen am selben Ort,
 * ohne dass jemand das Paar aufschreibt. Ob das in der Praxis stimmt, sagt
 * diese Messung.
 *
 * ── Wie gemessen wird ───────────────────────────────────────────────────────
 *
 * Aus dem grossen Fragensatz werden die PAARE gezogen: zwei Fragen, die
 * dieselbe Lektion erwarten, eine deutsch, eine englisch. Nur so misst der
 * Vergleich die Sprache und sonst nichts — verschiedene Lektionen waeren
 * verschieden schwer.
 *
 * Aufruf (braucht die Einbettungen neben dem Korpus):
 *   npx tsx src/bench/schliesst-bedeutung-die-sprachluecke.ts ./korpus.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { keywordSearch } from '../search.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const pfad = process.argv[2];
const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;
const cachePfad = pfad.replace(/\.json$/, '.einbettungen.json');
if (!existsSync(cachePfad)) {
  console.error(`Einbettungen fehlen: ${cachePfad}`);
  process.exit(2);
}
const roh = JSON.parse(readFileSync(cachePfad, 'utf8')) as { alle: Array<number[] | null> };
const lektionsVektoren = roh.alle.slice(0, korpus.lessons.length);
const frageVektoren = roh.alle.slice(korpus.lessons.length);

/** Deutsch oder Englisch — an Funktionswoertern, die es in der anderen nicht gibt. */
function istDeutsch(s: string): boolean {
  const t = ` ${s.toLowerCase()} `;
  const deutsch = [' der ', ' die ', ' das ', ' und ', ' nicht ', ' obwohl ', ' ich ', ' ein ', ' eine ', ' mit ', ' nach ', ' wenn ', ' aber ', ' auf ', ' im ', ' beim ', ' welcher ', ' dass '];
  const englisch = [' the ', ' and ', ' not ', ' although ', ' but ', ' with ', ' when ', ' does ', ' is ', ' are ', ' a ', ' every ', ' which '];
  return deutsch.filter((w) => t.includes(w)).length > englisch.filter((w) => t.includes(w)).length;
}

// Paare bilden: gleiche erwartete Lektion, verschiedene Sprache.
const nachZiel = new Map<string, { de?: BenchQuery & { i: number }; en?: BenchQuery & { i: number } }>();
korpus.queries.forEach((q, i) => {
  const ziel = q.relevant[0];
  const e = nachZiel.get(ziel) ?? {};
  if (istDeutsch(q.query)) e.de ??= { ...q, i }; else e.en ??= { ...q, i };
  nachZiel.set(ziel, e);
});
const paare = [...nachZiel.values()].filter((p) => p.de && p.en) as Array<{ de: BenchQuery & { i: number }; en: BenchQuery & { i: number } }>;

if (paare.length < 5) {
  console.error(`Nur ${paare.length} Paare gefunden — zu wenig fuer eine Aussage.`);
  process.exit(3);
}

// ── Die zwei Verfahren ──────────────────────────────────────────────────────

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

const kosinus = (a: number[], b: number[]) => {
  let p = 0; let qa = 0; let qb = 0;
  for (let i = 0; i < a.length; i++) { p += a[i] * b[i]; qa += a[i] * a[i]; qb += b[i] * b[i]; }
  return qa && qb ? p / Math.sqrt(qa * qb) : 0;
};

async function wortPlatz(q: BenchQuery): Promise<number> {
  // Der VOLLE Rang, nicht die ersten 200.
  //
  // Mit einem Deckel liefert indexOf fuer alles dahinter -1, und wer -1 beim
  // Median wegfiltert, rechnet die schlechtesten Faelle heraus. Am 19.08.2026
  // sah Deutsch dadurch BESSER aus als Englisch — das Gegenteil der Wahrheit.
  // Ein Messfehler derselben Bauart, die diese ganze Sitzung untersucht.
  const r = await keywordSearch(redis as never, ['cachly:lesson:best:*'], q.query, korpus.lessons.length) as Array<{ key: string }>;
  return r.map((h) => h.key.replace('cachly:lesson:best:', '')).indexOf(q.relevant[0]);
}
function sinnPlatz(i: number, ziel: string): number {
  const v = frageVektoren[i];
  if (!v) return -1;
  return korpus.lessons
    .map((l, j) => ({ t: l.topic, s: lektionsVektoren[j] ? kosinus(v, lektionsVektoren[j]!) : -2 }))
    .sort((a, b) => b.s - a.s).map((x) => x.t).indexOf(ziel);
}

const erg = { wort: { de: [] as number[], en: [] as number[] }, sinn: { de: [] as number[], en: [] as number[] } };
for (const p of paare) {
  erg.wort.de.push(await wortPlatz(p.de));
  erg.wort.en.push(await wortPlatz(p.en));
  erg.sinn.de.push(sinnPlatz(p.de.i, p.de.relevant[0]));
  erg.sinn.en.push(sinnPlatz(p.en.i, p.en.relevant[0]));
}

/**
 * Median ueber ALLE Fragen — ein Fehlschlag zaehlt als schlechtester Platz,
 * nicht als fehlender Wert. Wer nicht Gefundenes weglaesst, belohnt das
 * Verfahren, das oefter gar nichts findet.
 */
const median = (a: number[]) => {
  const g = a.map((x) => (x >= 0 ? x : korpus.lessons.length)).sort((x, y) => x - y);
  return g.length ? g[Math.floor(g.length / 2)] + 1 : -1;
};
const treffer = (a: number[]) => a.filter((x) => x === 0).length;
const top3 = (a: number[]) => a.filter((x) => x >= 0 && x < 3).length;

const n = paare.length;
console.log('');
console.log(`  ${n} Fragenpaare — dieselbe erwartete Lektion, einmal deutsch, einmal englisch`);
console.log('');
console.log('  Verfahren     Sprache   Platz 1   Top 3   Median');
for (const [name, d] of [['Woerter', erg.wort], ['Bedeutung', erg.sinn]] as const) {
  for (const sp of ['de', 'en'] as const) {
    const a = d[sp];
    console.log(`  ${name.padEnd(13)} ${sp === 'de' ? 'deutsch ' : 'englisch'}  ${String(treffer(a)).padStart(4)}/${n}  ${String(top3(a)).padStart(4)}/${n}  ${String(median(a)).padStart(6)}`);
  }
}
console.log('');
const lueckeWort = median(erg.wort.de) / Math.max(1, median(erg.wort.en));
const lueckeSinn = median(erg.sinn.de) / Math.max(1, median(erg.sinn.en));
console.log(`  Sprachluecke (Median deutsch / Median englisch):`);
console.log(`    mit Wortabgleich:      ${lueckeWort.toFixed(1)}x`);
console.log(`    mit Bedeutungsabgleich: ${lueckeSinn.toFixed(1)}x`);
