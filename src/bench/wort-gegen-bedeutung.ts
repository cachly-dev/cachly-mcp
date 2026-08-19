/**
 * Wortabgleich gegen Bedeutungsabgleich — und beides zusammen.
 *
 * ── Warum diese Messung ─────────────────────────────────────────────────────
 *
 * Am 19.08.2026 wurde die Suche gegen 499 echte Lektionen mit 100 Fragen
 * gemessen. Nach drei Reparaturen steht sie bei 24 Prozent auf Platz 1. Danach
 * brachten zwei weitere Eingriffe (Synonymgewicht, Feldauswahl) je ein bis zwei
 * Fragen — der Wortabgleich ist ausgereizt.
 *
 * Der Grund liegt in der Aufgabe: eine Frage beschreibt ein SYMPTOM, die
 * Lektion beschreibt eine URSACHE. "Der Deploy haengt beim Bauen" und "No space
 * left on device" teilen kein Wort und meinen dasselbe. Kein Woerterbuch der
 * Welt schliesst diese Luecke, weil sie nicht sprachlich ist.
 *
 * Einbettungen tun genau das: sie bilden Text auf Punkte ab, deren Naehe
 * Bedeutung ist. Und bge-m3 ist mehrsprachig — "Zwischenspeicher" und "cache"
 * landen am selben Ort, ohne dass jemand das Paar aufschreibt.
 *
 * Diese Messung beantwortet drei Fragen mit Zahlen statt mit Zuversicht:
 *   1. Ist Bedeutungsabgleich hier besser als Wortabgleich?
 *   2. Ist die Mischung besser als beide einzeln?
 *   3. Schliesst er die Luecke zwischen Deutsch und Englisch?
 *
 * Aufruf:
 *   CACHLY_JWT=... npx tsx src/bench/wort-gegen-bedeutung.ts ./korpus.json
 *
 * Einbettungen werden neben dem Korpus zwischengespeichert; ein zweiter Lauf
 * kostet nichts.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { keywordSearch } from '../search.js';
import { kosinus, mischeRangfolgen } from '../bedeutung.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }

const korpusPfad = process.argv[2];
const korpus = JSON.parse(readFileSync(korpusPfad, 'utf8')) as Korpus;
const cachePfad = korpusPfad.replace(/\.json$/, '.einbettungen.json');

const API = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
const JWT = process.env.CACHLY_JWT ?? '';
if (!JWT) { console.error('CACHLY_JWT fehlt.'); process.exit(2); }

// ── Einbettungen holen ──────────────────────────────────────────────────────

// Warum eine Einbettung fehlte. OHNE das ist ein Fehlschlag nicht von einem
// Ergebnis zu unterscheiden — und genau diese Verwechslung soll dieser Bench
// aufdecken, nicht selbst begehen.
const gruende = new Map<string, number>();
const merke = (g: string) => gruende.set(g, (gruende.get(g) ?? 0) + 1);

async function einbette(text: string): Promise<number[] | null> {
  let letzter = 'unbekannt';
  for (let versuch = 0; versuch < 4; versuch++) {
    try {
      const r = await fetch(`${API}/api/v1/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` },
        body: JSON.stringify({ text: text.slice(0, 2000) }),
        signal: AbortSignal.timeout(120000),
      });
      if (!r.ok) {
        letzter = `HTTP ${r.status}`;
        // Zu viele Anfragen: warten, nicht sofort wieder zuschlagen.
        if (r.status === 429 || r.status >= 500) {
          await new Promise((f) => setTimeout(f, 1500 * (versuch + 1)));
          continue;
        }
        break; // 4xx sonst: erneut versuchen bringt nichts
      }
      const j = await r.json() as { embedding?: number[]; data?: Array<{ embedding: number[] }> };
      const v = j.embedding ?? j.data?.[0]?.embedding;
      if (v?.length) return v;
      letzter = 'Antwort ohne Vektor';
    } catch (e) {
      letzter = e instanceof Error ? e.name : 'Ausnahme';
      await new Promise((f) => setTimeout(f, 800 * (versuch + 1)));
    }
  }
  merke(letzter);
  return null;
}

/** Holt viele Einbettungen mit begrenzter Gleichzeitigkeit. */
async function alleEinbetten(texte: string[], gleichzeitig = Number(process.env.MESS_PARALLEL ?? '2')): Promise<Array<number[] | null>> {
  const aus: Array<number[] | null> = new Array(texte.length).fill(null);
  let naechster = 0;
  const arbeiter = Array.from({ length: gleichzeitig }, async () => {
    for (;;) {
      const i = naechster++;
      if (i >= texte.length) return;
      aus[i] = await einbette(texte[i]);
      if ((i + 1) % 50 === 0) process.stderr.write(`  ${i + 1}/${texte.length}\n`);
    }
  });
  await Promise.all(arbeiter);
  return aus;
}

// Der Text einer Lektion, so wie ihn ein Mensch lesen wuerde — nicht das JSON.
const lektionsText = (l: BenchLesson) =>
  [l.topic, l.what_worked, (l as { what_failed?: string }).what_failed].filter(Boolean).join('\n');

let cache: { lektionen: Array<number[] | null>; fragen: Array<number[] | null> };
if (existsSync(cachePfad)) {
  cache = JSON.parse(readFileSync(cachePfad, 'utf8'));
  console.error('Einbettungen aus dem Zwischenspeicher.');
} else {
  console.error(`Einbette ${korpus.lessons.length} Lektionen ...`);
  const lektionen = await alleEinbetten(korpus.lessons.map(lektionsText));
  console.error(`Einbette ${korpus.queries.length} Fragen ...`);
  const fragen = await alleEinbetten(korpus.queries.map((q) => q.query));
  cache = { lektionen, fragen };
  writeFileSync(cachePfad, JSON.stringify(cache));
}

const fehlend = cache.lektionen.filter((e) => !e).length;
if (fehlend > 0) {
  console.error(`ACHTUNG: ${fehlend} von ${cache.lektionen.length} Lektionen ohne Einbettung.`);
  console.error('Gruende: ' + [...gruende.entries()].map(([g, n]) => `${g} (${n}x)`).join(', '));
  console.error('Solange das so ist, ist die Zeile "Bedeutung" KEIN Befund ueber bge-m3,');
  console.error('sondern einer ueber diese Messung. Erst beheben, dann lesen.');
}

// ── Die drei Rangfolgen ─────────────────────────────────────────────────────



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

// kosinus() und mische() kommen aus dem AUSGELIEFERTEN Modul, nicht aus einer
// Kopie hier. Eine zweite Fassung derselben Rechnung neben dem Bench waere die
// Fehlerklasse, die diese ganze Sitzung untersucht: gemessen wuerde dann etwas
// anderes als das, was Nutzer bekommen.

interface Ergebnis { p1: number; p3: number; p10: number; mrr: number; median: number }
function bewerte(plaetze: number[]): Ergebnis {
  const n = plaetze.length;
  const bis = (k: number) => plaetze.filter((p) => p >= 0 && p < k).length / n;
  const gefunden = plaetze.filter((p) => p >= 0).sort((x, y) => x - y);
  return {
    p1: bis(1), p3: bis(3), p10: bis(10),
    mrr: plaetze.reduce((s, p) => s + (p >= 0 ? 1 / (p + 1) : 0), 0) / n,
    median: gefunden.length ? gefunden[Math.floor(gefunden.length / 2)] + 1 : -1,
  };
}

const wortPlaetze: number[] = [];
const sinnPlaetze: number[] = [];
const mischPlaetze: Record<string, number[]> = { '0.0': [], '0.1': [], '0.2': [], '0.3': [], '0.4': [] };

for (const [i, q] of korpus.queries.entries()) {
  const wortRang = (await keywordSearch(redis as never, ['cachly:lesson:best:*'], q.query, 100) as Array<{ key: string }>)
    .map((h) => h.key.replace('cachly:lesson:best:', ''));

  const qv = cache.fragen[i];
  const sinnRang = qv
    ? korpus.lessons
      .map((l, j) => ({ t: l.topic, s: cache.lektionen[j] ? kosinus(qv, cache.lektionen[j]!) : -2 }))
      .sort((a, b) => b.s - a.s).slice(0, 100).map((x) => x.t)
    : [];

  const ziel = q.relevant[0];
  wortPlaetze.push(wortRang.indexOf(ziel));
  sinnPlaetze.push(sinnRang.indexOf(ziel));
  for (const g of Object.keys(mischPlaetze)) {
    mischPlaetze[g].push(mischeRangfolgen(wortRang, sinnRang, Number(g)).indexOf(ziel));
  }
}

const zeile = (name: string, e: Ergebnis) =>
  `  ${name.padEnd(22)} ${(100 * e.p1).toFixed(0).padStart(4)}% ${(100 * e.p3).toFixed(0).padStart(5)}% `
  + `${(100 * e.p10).toFixed(0).padStart(5)}% ${(100 * e.mrr).toFixed(1).padStart(6)}% ${String(e.median).padStart(7)}`;

console.log('');
console.log(`  ${korpus.lessons.length} Lektionen · ${korpus.queries.length} Fragen`);
console.log('');
console.log('  Verfahren               Platz1   Top3   Top10    MRR  Median');
console.log(zeile('Woerter (heute)', bewerte(wortPlaetze)));
console.log(zeile('Bedeutung (bge-m3)', bewerte(sinnPlaetze)));
for (const g of Object.keys(mischPlaetze)) {
  console.log(zeile(`gemischt ${g} Woerter`, bewerte(mischPlaetze[g])));
}
