#!/usr/bin/env node
/**
 * ══ Der Messstand je Projekt — mit Einstell- und Prüfhälfte ═══════════════
 *
 * ── Warum diese Datei die Voraussetzung für „Top 1" ist (30.08.2026) ──────
 *
 * Der Weg zum Spitzenplatz führt über eine Schleife: einstellen → messen →
 * behalten oder verwerfen. Diese Schleife braucht zwei Dinge, die der erste
 * große Messstand (`grosser-messstand.ts`) noch nicht hatte:
 *
 *   1. **Die Zahl JE PROJEKT.** Ein Mittelwert über 60 Projekte versteckt,
 *      ob zwei davon alles tragen. Wer auf den Mittelwert einstellt, baut
 *      einen Sortierer für die zwei größten Issue-Tracker der Welt.
 *
 *   2. **Eine Einstell- und eine Prüfhälfte, getrennt nach PROJEKT.**
 *      Wer auf denselben Fragen einstellt und misst, misst sein
 *      Kurzzeitgedächtnis. Die Trennung nach Projekt (nicht nach Frage!)
 *      verhindert auch das Weichere: dass der Sortierer die Eigenheiten
 *      eines Projekts lernt und das für Können hält.
 *
 * Die Zuordnung zur Hälfte ist ein STABILER Hash über den Projektnamen —
 * kein Zufall, kein Datum. Derselbe Aufruf liefert in einem Jahr dieselbe
 * Teilung, sonst wäre jede Vergleichsmessung wertlos.
 *
 * ── Die Regel für alle künftigen Einstellläufe ────────────────────────────
 *
 * Eingestellt wird NUR auf der Einstellhälfte. Die Prüfhälfte wird erst
 * angefasst, wenn eine Änderung feststeht — und dann GENAU EINMAL je
 * Änderung. Eine Prüfhälfte, die man täglich befragt, ist eine zweite
 * Einstellhälfte mit besserem Namen.
 *
 * Aufruf:
 *   npx tsx src/bench/messstand-je-projekt.ts --ordner <pfad> [--je-projekt 20]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchLesson, BenchQuery } from './fixtures.js';
import { indexCorpus, LESSON_PREFIX, matchTopic } from './cachly-bench.js';
import { rerankByQuality } from '../rerank.js';
import { keywordSearch } from '../search.js';
import { paareAus, projektAus } from './grosser-messstand.js';

/**
 * Stabiler Hash → Hälfte. FNV-1a über den Projektnamen, unterstes Bit.
 *
 * Bewusst KEIN Math.random und KEIN Datum: dieselbe Eingabe muss in einem
 * Jahr dieselbe Hälfte ergeben, sonst ist keine Messung mit einer früheren
 * vergleichbar.
 */
export function haelfteFuer(projekt: string): 'einstellen' | 'pruefen' {
  let h = 0x811c9dc5;
  for (let i = 0; i < projekt.length; i++) {
    h ^= projekt.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h & 1) === 0 ? 'einstellen' : 'pruefen';
}

export type ProjektErgebnis = {
  projekt: string;
  haelfte: 'einstellen' | 'pruefen';
  fragen: number;
  /** Wie oft stand die Gold-Antwort auf Platz 1 / in den Top 3. */
  p1: number;
  p3: number;
};

/** Median über eine Zahlenreihe — kopiert, sortiert nicht in Ordnung. */
export function median(zahlen: readonly number[]): number {
  if (zahlen.length === 0) return 0;
  const s = [...zahlen].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

async function main(): Promise<void> {
  const flag = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const ordner = flag('ordner');
  const jeProjekt = Number(flag('je-projekt') ?? '20');

  if (!ordner || !existsSync(ordner)) {
    console.error('NICHT GEMESSEN: --ordner <pfad zu ernten/> ist Pflicht.');
    process.exit(2);
  }

  const dateien = readdirSync(ordner)
    .filter((n) => n.startsWith('ernte-') && n.endsWith('.json') && !n.includes('vek'));
  if (dateien.length === 0) {
    console.error(`NICHT GEMESSEN: keine ernte-*.json in ${ordner}.`);
    process.exit(2);
  }

  // ── Paare einsammeln, je Projekt gedeckelt ────────────────────────────
  const lessons: BenchLesson[] = [];
  const queries: Array<BenchQuery & { projekt: string }> = [];
  for (const d of dateien) {
    let e;
    try { e = JSON.parse(readFileSync(join(ordner, d), 'utf8')); } catch { continue; }
    const p = paareAus(e);
    const l = p.lessons.slice(0, jeProjekt);
    const q = p.queries.slice(0, jeProjekt);
    if (l.length === 0) continue;
    lessons.push(...l);
    for (const x of q) queries.push({ ...x, projekt: projektAus(x.relevant[0]) });
  }
  if (queries.length === 0) {
    console.error('NICHT GEMESSEN: keine gueltigen Frage-Gold-Paare.');
    process.exit(2);
  }

  // ── EIN gemeinsamer Index. Die Haelften trennen die FRAGEN, nicht den ──
  // Bestand: ein echter Kunde hat auch alles im Speicher, gesucht wird
  // trotzdem nur, was er gerade braucht.
  const redis = indexCorpus(lessons);

  const jeProjektErgebnis = new Map<string, ProjektErgebnis>();
  for (const q of queries) {
    const roh = await keywordSearch(redis as never, [`${LESSON_PREFIX}*`], q.query, 25);
    const topics = rerankByQuality(roh).map(matchTopic);
    const rang = topics.indexOf(q.relevant[0]) + 1; // 0 = nicht gefunden
    const e = jeProjektErgebnis.get(q.projekt) ?? {
      projekt: q.projekt, haelfte: haelfteFuer(q.projekt), fragen: 0, p1: 0, p3: 0,
    };
    e.fragen++;
    if (rang === 1) e.p1++;
    if (rang >= 1 && rang <= 3) e.p3++;
    jeProjektErgebnis.set(q.projekt, e);
  }

  const alle = [...jeProjektErgebnis.values()];
  const pct = (x: number) => `${(100 * x).toFixed(1)} %`;

  for (const h of ['einstellen', 'pruefen'] as const) {
    const teil = alle.filter((e) => e.haelfte === h);
    const fragen = teil.reduce((s, e) => s + e.fragen, 0);
    const p1 = teil.reduce((s, e) => s + e.p1, 0);
    const p3 = teil.reduce((s, e) => s + e.p3, 0);
    const quoten = teil.map((e) => e.p1 / e.fragen);
    const null1 = teil.filter((e) => e.p1 === 0).length;

    console.log(`\n══ Haelfte "${h}" — ${teil.length} Projekte, ${fragen} Fragen ══`);
    console.log(`  P@1 gesamt      ${pct(p1 / fragen)}`);
    console.log(`  P@3 gesamt      ${pct(p3 / fragen)}`);
    console.log(`  P@1 je Projekt  Median ${pct(median(quoten))}`);
    console.log(`  Projekte mit P@1 = 0:  ${null1} von ${teil.length}`);
  }

  // Die Verteilung, die der Mittelwert versteckt.
  const einst = alle.filter((e) => e.haelfte === 'einstellen')
    .sort((a, b) => b.p1 / b.fragen - a.p1 / a.fragen);
  console.log(`\n── Einstellhaelfte, beste und schlechteste fuenf ──`);
  for (const e of [...einst.slice(0, 5), ...einst.slice(-5)]) {
    console.log(`  ${pct(e.p1 / e.fragen).padStart(8)}  ${e.projekt} (${e.fragen} Fragen)`);
  }

  console.log(`
DIE REGEL fuer alle Einstellaeufe ab jetzt: eingestellt wird NUR auf der
Einstellhaelfte. Die Pruefhaelfte wird erst angefasst, wenn eine Aenderung
feststeht — und dann genau EINMAL je Aenderung. Eine Pruefhaelfte, die man
taeglich befragt, ist eine zweite Einstellhaelfte mit besserem Namen.

Die Teilung ist ein stabiler Hash ueber den Projektnamen. Derselbe Aufruf
liefert in einem Jahr dieselbe Teilung.`);
}

main().catch((e) => {
  console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
