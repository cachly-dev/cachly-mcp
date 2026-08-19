/**
 * Was kostet Bedeutungsabgleich an Wartezeit?
 *
 * ── Warum diese Messung vor dem Einbau kommt ────────────────────────────────
 *
 * Am 19.08.2026 gemessen: Bedeutungsabgleich hebt die Trefferquote von 21 auf
 * 40 Prozent. Das ist die halbe Antwort. Die andere Hälfte ist der Preis, und
 * den zahlt der Nutzer in Sekunden.
 *
 * Ein Recall läuft heute rein lokal gegen den Speicher. Bedeutungsabgleich
 * braucht für JEDE Frage einen Netzaufruf zum Einbettungsdienst — die Lektionen
 * kann man vorher ausrechnen, die Frage des Nutzers nicht.
 *
 * Wenn dieser Aufruf eine Sekunde dauert, ist die Frage nicht mehr "bauen wir
 * das ein", sondern "wo bauen wir es ein": in den Weg, den ein Mensch abwartet,
 * oder in den, der im Hintergrund läuft.
 *
 * Diese Datei misst drei Dinge:
 *   1. Wie lange dauert ein Recall heute (nur Wörter)?
 *   2. Wie lange dauert eine Einbettung der Frage?
 *   3. Wie lange dauert der Vergleich gegen alle Lektionsvektoren?
 *
 * Aufruf:
 *   CACHLY_JWT=... npx tsx src/bench/was-kostet-bedeutung.ts ./korpus.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { keywordSearch } from '../search.js';
import type { BenchLesson, BenchQuery } from './fixtures.js';

interface Korpus { lessons: BenchLesson[]; queries: BenchQuery[] }
const pfad = process.argv[2];
const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;
const cachePfad = pfad.replace(/\.json$/, '.einbettungen.json');
const API = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
const JWT = process.env.CACHLY_JWT ?? '';

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

const auswerten = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  const bei = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { mitte: bei(0.5), oben: bei(0.9), hoechst: s[s.length - 1] };
};
const zeile = (name: string, ms: number[]) => {
  const a = auswerten(ms);
  return `  ${name.padEnd(34)} ${String(Math.round(a.mitte)).padStart(6)} ${String(Math.round(a.oben)).padStart(7)} ${String(Math.round(a.hoechst)).padStart(8)}`;
};

// ── 1. Wortabgleich, wie er heute laeuft ────────────────────────────────────
const wortMs: number[] = [];
for (const q of korpus.queries.slice(0, 30)) {
  const t = performance.now();
  await keywordSearch(redis as never, ['cachly:lesson:best:*'], q.query, 25);
  wortMs.push(performance.now() - t);
}

// ── 2. Vergleich gegen alle Lektionsvektoren ────────────────────────────────
const vergleichMs: number[] = [];
if (existsSync(cachePfad)) {
  const roh = JSON.parse(readFileSync(cachePfad, 'utf8')) as { alle: Array<number[] | null> };
  const lekt = roh.alle.slice(0, korpus.lessons.length).filter(Boolean) as number[][];
  const frage = roh.alle[korpus.lessons.length] as number[] | null;
  if (frage && lekt.length) {
    for (let n = 0; n < 30; n++) {
      const t = performance.now();
      let bester = -2; let besterIdx = -1;
      for (let j = 0; j < lekt.length; j++) {
        const b = lekt[j];
        let p = 0; let qa = 0; let qb = 0;
        for (let i = 0; i < frage.length; i++) { p += frage[i] * b[i]; qa += frage[i] * frage[i]; qb += b[i] * b[i]; }
        const s = qa && qb ? p / Math.sqrt(qa * qb) : 0;
        if (s > bester) { bester = s; besterIdx = j; }
      }
      if (besterIdx < 0) throw new Error('kein Treffer');
      vergleichMs.push(performance.now() - t);
    }
    console.log(`  (Vergleich gegen ${lekt.length} Vektoren mit je ${frage.length} Zahlen)`);
  }
}

// ── 3. Einbettung der Frage — der Netzaufruf ────────────────────────────────
const netzMs: number[] = [];
if (JWT) {
  for (const q of korpus.queries.slice(0, 12)) {
    const t = performance.now();
    try {
      const r = await fetch(`${API}/api/v1/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` },
        body: JSON.stringify({ text: q.query }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) { await r.json(); netzMs.push(performance.now() - t); }
    } catch { /* zaehlt nicht als Messwert */ }
    // Unter dem Limit bleiben: 60 je Minute.
    await new Promise((f) => setTimeout(f, 1200));
  }
}

console.log('');
console.log('  Schritt                             Mitte   oberes    hoechster');
console.log('                                       (ms)   Zehntel      Wert');
console.log(zeile('Wortabgleich (heute, lokal)', wortMs));
if (vergleichMs.length) console.log(zeile('Vektorvergleich (lokal)', vergleichMs));
if (netzMs.length) console.log(zeile('Einbettung der Frage (Netz)', netzMs));

if (netzMs.length && wortMs.length) {
  const w = auswerten(wortMs).mitte;
  const n = auswerten(netzMs).mitte;
  const v = vergleichMs.length ? auswerten(vergleichMs).mitte : 0;
  console.log('');
  console.log(`  Heute:            ${Math.round(w)} ms`);
  console.log(`  Mit Bedeutung:    ${Math.round(n + v)} ms   (${(((n + v) / w)).toFixed(0)}-fach)`);
  console.log('');
  console.log('  Der Netzaufruf ist praktisch der ganze Preis. Der Vergleich selbst');
  console.log('  faellt nicht ins Gewicht — Vektoren vorher auszurechnen loest also');
  console.log('  nur die halbe Aufgabe: die Frage des Nutzers bleibt uebrig.');
}
