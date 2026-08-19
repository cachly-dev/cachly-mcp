/**
 * Den Kandidatentopf besser sortieren.
 *
 * ── Wo das Problem liegt ────────────────────────────────────────────────────
 *
 * Gemessen am 19.08.2026 an 499 Lektionen mit 100 Fragen:
 *
 *   Vorauswahl "Wörter ODER Bedeutung, je 25"   Decke 84 %
 *   Ergebnis der heutigen Mischung (RRF)        40 % auf Platz 1
 *
 * Vierundvierzig Punkte liegen also nicht in der Suche, sondern im Sortieren.
 * Die richtige Antwort ist meistens schon da — sie steht nur nicht vorn.
 *
 * ── Warum RRF hier Geld liegen lässt ────────────────────────────────────────
 *
 * Reciprocal Rank Fusion benutzt ausschließlich die PLATZIERUNG. Das ist seine
 * Stärke beim Mischen unvergleichbarer Verfahren — und hier seine Schwäche:
 * ob eine Lektion mit 0,61 oder mit 0,43 auf Platz 1 der Bedeutungsliste steht,
 * ist für RRF dasselbe. Der Abstand, also die eigentliche Aussage, wird
 * weggeworfen.
 *
 * ── Die Idee: innerhalb des Topfes normieren ────────────────────────────────
 *
 * Über den ganzen Bestand sind die Kosinuswerte in ein schmales Band gepresst
 * (0,42 bis 0,61 gemessen), weil alle Vektoren eine gemeinsame Grundrichtung
 * teilen. Innerhalb von fünfzig Kandidaten ist das anders: dort spreizt eine
 * Normierung auf 0 bis 1 genau die Unterschiede auf, um die es geht.
 *
 * Diese Datei probiert Gewichtungen durch und sagt, welche gewinnt — statt
 * eine zu wählen und sie plausibel zu begründen.
 *
 * Aufruf:
 *   npx tsx src/bench/topf-sortieren.ts ./korpus.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { keywordSearch } from '../search.js';
import { kosinus, mischeRangfolgen } from '../bedeutung.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const pfad = process.argv[2];
const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;
const aPfad = pfad.replace(/\.json$/, '.einbettungen.json');
if (!existsSync(aPfad)) { console.error(`fehlt: ${aPfad}`); process.exit(2); }
const a = JSON.parse(readFileSync(aPfad, 'utf8')) as { alle: Array<number[] | null> };
const sichtA = a.alle.slice(0, korpus.lessons.length);
const fragen = a.alle.slice(korpus.lessons.length);
const nachThema = new Map(korpus.lessons.map((l, j) => [l.topic, { l, j }]));

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

/** Wörter der Frage, klein geschrieben, ohne Kurzwörter. */
const woerter = (s: string) =>
  new Set(s.toLowerCase().split(/[^a-zäöüß0-9]+/).filter((w) => w.length > 3));

interface Kandidat {
  topic: string;
  naehe: number;      // Kosinus, oder -2 wenn kein Vektor
  wortPunkte: number; // BM25, oder 0
  wortPlatz: number;  // Platz in der Wortliste, oder 999
  sinnPlatz: number;
  themaTreffer: number; // Anteil der Fragewörter, die im Thema vorkommen
  guete: number;        // Qualitätsmerkmale der Lektion
  inBeiden: number;     // 1, wenn Wörter UND Bedeutung sie vorschlagen
}

/** Auf 0 bis 1 spreizen — INNERHALB des Topfes, nicht über den Bestand. */
function spreize(werte: number[]): number[] {
  const gueltig = werte.filter((x) => Number.isFinite(x) && x > -2);
  if (gueltig.length === 0) return werte.map(() => 0);
  const min = Math.min(...gueltig); const max = Math.max(...gueltig);
  if (max === min) return werte.map(() => 0.5);
  return werte.map((x) => (x > -2 ? (x - min) / (max - min) : 0));
}

const POOL = 25;
const kandidatenJeFrage: Kandidat[][] = [];
const ziele: string[] = [];

for (const [i, q] of korpus.queries.entries()) {
  const fv = fragen[i];
  const wortListe = (await keywordSearch(redis as never, ['cachly:lesson:best:*'], q.query, POOL) as Array<{ key: string; score: number }>)
    .map((h) => ({ topic: h.key.replace('cachly:lesson:best:', ''), score: h.score }));
  const sinnListe = fv
    ? korpus.lessons.map((l, j) => ({ topic: l.topic, s: sichtA[j] ? kosinus(fv, sichtA[j]!) : -2 }))
      .sort((x, y) => y.s - x.s).slice(0, POOL)
    : [];

  const wortPlatz = new Map(wortListe.map((x, k) => [x.topic, k]));
  const wortPunkte = new Map(wortListe.map((x) => [x.topic, x.score]));
  const sinnPlatz = new Map(sinnListe.map((x, k) => [x.topic, k]));
  const naehe = new Map(sinnListe.map((x) => [x.topic, x.s]));

  const fw = woerter(q.query);
  const topf = new Set([...wortPlatz.keys(), ...sinnPlatz.keys()]);
  const kand: Kandidat[] = [];
  for (const topic of topf) {
    const eintrag = nachThema.get(topic);
    if (!eintrag) continue;
    const l = eintrag.l as unknown as Record<string, unknown>;
    const themaW = woerter(topic.replace(/[:_-]/g, ' '));
    const gemeinsam = [...fw].filter((w) => themaW.has(w)).length;
    kand.push({
      topic,
      naehe: naehe.get(topic) ?? (fv && sichtA[eintrag.j] ? kosinus(fv, sichtA[eintrag.j]!) : -2),
      wortPunkte: wortPunkte.get(topic) ?? 0,
      wortPlatz: wortPlatz.get(topic) ?? 999,
      sinnPlatz: sinnPlatz.get(topic) ?? 999,
      themaTreffer: fw.size ? gemeinsam / fw.size : 0,
      guete:
        (typeof l.confidence === 'number' ? Math.min(1, l.confidence) : 0.5) * 0.5
        + (l.outcome === 'success' ? 0.3 : 0)
        + (l.severity === 'critical' ? 0.2 : l.severity === 'major' ? 0.1 : 0),
      // Einigkeit ist ein eigenes Signal: was BEIDE Verfahren vorschlagen, ist
      // meist richtig. Genau das faengt RRF ein, und genau das fehlt einer
      // reinen Punktsumme.
      inBeiden: wortPlatz.has(topic) && sinnPlatz.has(topic) ? 1 : 0,
    });
  }
  kandidatenJeFrage.push(kand);
  ziele.push(q.relevant[0]);
}

/**
 * Bewertet auf einer TEILMENGE der Fragen.
 *
 * Gewichte auf denselben Fragen einzustellen, an denen man sie danach misst,
 * ist Selbstbetrug: mit genug Stellschrauben trifft man jede feste Liste. Der
 * Satz wird deshalb halbiert — eingestellt wird auf der einen Haelfte, gemessen
 * auf der anderen, die dabei nie gesehen wurde.
 */
function bewerte(punkte: (k: Kandidat[], idx: number) => number[], teil: 'alle' | 'gerade' | 'ungerade' = 'alle') {
  const plaetze: number[] = [];
  kandidatenJeFrage.forEach((kand, i) => {
    if (teil === 'gerade' && i % 2 !== 0) return;
    if (teil === 'ungerade' && i % 2 === 0) return;
    const p = punkte(kand, i);
    const rang = kand.map((k, j) => ({ t: k.topic, p: p[j] })).sort((x, y) => y.p - x.p);
    plaetze.push(rang.findIndex((r) => r.t === ziele[i]));
  });
  const n = plaetze.length;
  const bis = (k: number) => plaetze.filter((x) => x >= 0 && x < k).length;
  return {
    p1: bis(1), p3: bis(3), p5: bis(5),
    mrr: plaetze.reduce((s, x) => s + (x >= 0 ? 1 / (x + 1) : 0), 0) / n,
  };
}

const zeile = (name: string, e: ReturnType<typeof bewerte>) =>
  `  ${name.padEnd(38)} ${String(e.p1).padStart(4)} ${String(e.p3).padStart(6)} ${String(e.p5).padStart(5)} ${(100 * e.mrr).toFixed(1).padStart(7)}%`;

console.log('');
console.log(`  ${korpus.lessons.length} Lektionen · ${korpus.queries.length} Fragen · Topf aus je ${POOL}`);
console.log('');
console.log('  Sortierung                              P@1   Top3  Top5     MRR');

// Heute: RRF über die Plätze.
console.log(zeile('heute (RRF ueber Plaetze, 0,1)', bewerte((kand) => {
  const wort = [...kand].sort((a2, b2) => a2.wortPlatz - b2.wortPlatz).map((k) => k.topic);
  const sinn = [...kand].sort((a2, b2) => a2.sinnPlatz - b2.sinnPlatz).map((k) => k.topic);
  const reihen = mischeRangfolgen(wort, sinn, 0.1);
  const platz = new Map(reihen.map((t, i) => [t, i]));
  return kand.map((k) => -(platz.get(k.topic) ?? 999));
})));

// Nur die gespreizte Naehe.
console.log(zeile('nur Naehe, im Topf gespreizt', bewerte((kand) => spreize(kand.map((k) => k.naehe)))));

// ── Einstellen auf der einen Haelfte, messen auf der anderen ────────────────
interface Gewichte { gN: number; gW: number; gT: number; gQ: number; gB: number }
const punkteFn = (g: Gewichte) => (kand: Kandidat[]) => {
  const n = spreize(kand.map((k) => k.naehe));
  const w = spreize(kand.map((k) => k.wortPunkte));
  return kand.map((k, j) => g.gN * n[j] + g.gW * w[j] + g.gT * k.themaTreffer + g.gQ * k.guete + g.gB * k.inBeiden);
};

const alle: Array<{ g: Gewichte; e: ReturnType<typeof bewerte> }> = [];
for (const gW of [0, 0.15, 0.3, 0.5])
  for (const gT of [0, 0.2, 0.4, 0.6, 0.9])
    for (const gQ of [0, 0.1, 0.25])
      for (const gB of [0, 0.15, 0.3, 0.5]) {
        const g = { gN: 1, gW, gT, gQ, gB };
        alle.push({ g, e: bewerte(punkteFn(g), 'gerade') });
      }
alle.sort((x, y) => (y.e.p1 - x.e.p1) || (y.e.mrr - x.e.mrr));
const sieger = alle[0];

const nenn = (g: Gewichte) => `Naehe 1 · Wort ${g.gW} · Thema ${g.gT} · Guete ${g.gQ} · Einigkeit ${g.gB}`;

console.log('');
console.log('  ── Eingestellt auf den GERADEN Fragen (50 Stueck) ──');
console.log(zeile(nenn(sieger.g), sieger.e));
console.log('');
console.log('  ── Gemessen auf den UNGERADEN Fragen (nie gesehen) ──');
console.log(zeile('mit denselben Gewichten', bewerte(punkteFn(sieger.g), 'ungerade')));
console.log(zeile('zum Vergleich: heutiges RRF', bewerte((kand) => {
  const wort = [...kand].sort((a2, b2) => a2.wortPlatz - b2.wortPlatz).map((k) => k.topic);
  const sinn = [...kand].sort((a2, b2) => a2.sinnPlatz - b2.sinnPlatz).map((k) => k.topic);
  const reihen = mischeRangfolgen(wort, sinn, 0.1);
  const platz = new Map(reihen.map((t, i) => [t, i]));
  return kand.map((k) => -(platz.get(k.topic) ?? 999));
}, 'ungerade')));
console.log('');
console.log('  ── Und auf ALLEN 100, zum Einordnen ──');
console.log(zeile('gewaehlte Gewichte', bewerte(punkteFn(sieger.g))));
