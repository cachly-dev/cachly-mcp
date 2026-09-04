#!/usr/bin/env node
/**
 * ══ Der große Messstand: Tausende Fragen aus echten Projekten ═════════════
 *
 * ── Warum es ihn braucht (30.08.2026, Karte 9qxuuay6l0bo) ─────────────────
 *
 * Cleverdon, C. W. (1967), die Cranfield-Versuche: **der Prüfsatz bestimmt
 * das Ergebnis stärker als das Verfahren.**
 *
 * Unser eingefrorener A/B-Schnitt hat ZEHN Projekte. `bester_zeuge 44,1` und
 * jede gemessene Sackgasse hängen an diesen zehn. Inzwischen liegen 3.619
 * geerntete Projekte mit 233.035 Frage-Antwort-Paaren da.
 *
 * Solange der Messstand zehn Projekte misst, ist jede Aussage über den
 * Sortierer eine Aussage über zehn Projekte.
 *
 * ── Woher Frage und Gold-Antwort kommen ───────────────────────────────────
 *
 * Ein Ernte-Paar ist ein geschlossenes Issue mit verknüpftem, gemergtem PR:
 *
 *   FRAGE   der Issue-Text — ein Mensch beschreibt in eigenen Worten, dass
 *           etwas nicht geht. Genau die Sicht des Suchenden.
 *   GOLD    der PR — was es wirklich behoben hat.
 *
 * Das ist keine gebastelte Frage, sondern eine, die jemand wirklich hatte.
 *
 * ── Die drei Regeln, die den Schnitt ehrlich halten ───────────────────────
 *
 * 1. **Trennung nach Projekt.** Kein Projekt steht in beiden Hälften. Sonst
 *    misst man, ob der Sortierer das Projekt kennt, nicht ob er die Frage
 *    versteht.
 * 2. **Gewinne je Projekt melden**, nicht nur im Mittel. Ein Mittelwert über
 *    200 Projekte versteckt, dass zwei davon alles tragen.
 * 3. **Der eingefrorene Zehner-Schnitt bleibt unangetastet.** Er ist die
 *    Referenz, gegen die alles bisher gemessen wurde. Ein Prüfsatz, der sich
 *    bewegt, misst nichts.
 *
 * ── Was er NICHT tut ──────────────────────────────────────────────────────
 *
 * Er stellt nichts ein. Er misst. Wer danach am Sortierer dreht, misst
 * hiermit erneut — und die Zahl je Projekt sagt, ob der Gewinn breit ist
 * oder aus einer Ecke kommt.
 *
 * ── Und die Grenze, die beim ersten Lauf sichtbar wurde ───────────────────
 *
 * Der erste Lauf über 60 Projekte gab:
 *
 *     Verfahren    P@1     P@3    Recall@3   MRR     nDCG@5
 *     BM25 pur    23,9 %  10,9 %   32,7 %   29,9 %  30,7 %
 *     cachly      23,9 %  10,9 %   32,7 %   30,4 %  30,7 %
 *
 * Der Sortierer trägt fast nichts bei — und das ist KEIN Urteil über ihn,
 * sondern eine Grenze dieses Messstands.
 *
 * Der Grund: eine geerntete Lektion hat keine Zuversicht, keine Abrufzahl,
 * keine Schwere und keine Abnahme. Diese Felder sind UNSERE Signale, und
 * fremde Projekte tragen sie nicht. Alle Einträge bekommen hier denselben
 * Wert — der Sortierer hat also nichts zu unterscheiden.
 *
 * Daraus folgt eine unbequeme Einsicht, und sie gehört hierher: **die
 * Qualitätsstufe lässt sich auf Fremddaten überhaupt nicht messen.** Jede
 * Zahl über ihren Nutzen stammt aus einem Bestand, dessen Qualitätssignale
 * wir selbst geschrieben haben.
 *
 * Was dieser Messstand deshalb misst, ist die RELEVANZ — und nur die. Für
 * die ist er der ehrlichste Satz, den wir haben: echte Fragen von Menschen,
 * die das Problem wirklich hatten.
 *
 * P@1 = 23,9 % auf echten fremden Fragen ist damit die Zahl, um die es geht.
 *
 * Aufruf:
 *   npx tsx src/bench/grosser-messstand.ts --ordner <pfad> [--projekte 200]
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { BenchLesson, BenchQuery } from './fixtures.js';
import { runBenchmarkOn } from './cachly-bench.js';

type Ernte = {
  name?: string;
  lessons?: Array<{ topic: string; what_worked?: string; what_failed?: string; outcome?: string }>;
  queries?: Array<{ query: string; relevant?: string[] }>;
};

/**
 * Ein Projekt in Frage-Gold-Paare übersetzen.
 *
 * Nur Paare, bei denen die Gold-Antwort wirklich zur Frage gehört — die
 * Ernte legt beide in derselben Reihenfolge ab, und `relevant[0]` muss auf
 * das Thema der Lektion zeigen. Wo das nicht stimmt, wird verworfen statt
 * geraten.
 */
export function paareAus(e: Ernte): { lessons: BenchLesson[]; queries: BenchQuery[] } {
  const lessons: BenchLesson[] = [];
  const queries: BenchQuery[] = [];
  const l = e.lessons ?? [];
  const q = e.queries ?? [];
  for (let i = 0; i < Math.min(l.length, q.length); i++) {
    const lekt = l[i];
    const frage = q[i];
    if (!lekt || !frage) continue;
    if (frage.relevant?.[0] !== lekt.topic) continue;
    if (!lekt.what_worked || lekt.what_worked.length < 40) continue;
    if (!frage.query || frage.query.length < 25) continue;
    lessons.push({
      topic: lekt.topic,
      outcome: 'success',
      what_worked: lekt.what_worked,
      what_failed: lekt.what_failed ?? '',
      confidence: 0.8,
      recall_count: 0,
    } as BenchLesson);
    queries.push({ query: frage.query, relevant: [lekt.topic] });
  }
  return { lessons, queries };
}

/** Der Projektname aus einem Thema (`gin:pr-4479` → `gin`). */
export function projektAus(topic: string): string {
  return String(topic ?? '').split(':')[0] ?? 'unbekannt';
}

async function main(): Promise<void> {
  const flag = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const ordner = flag('ordner');
  const hoechstens = Number(flag('projekte') ?? '200');
  const jeProjekt = Number(flag('je-projekt') ?? '20');

  if (!ordner || !existsSync(ordner)) {
    console.error('NICHT GEMESSEN: --ordner <pfad zu ernten/> ist Pflicht und muss existieren.');
    process.exit(2);
  }

  const dateien = readdirSync(ordner)
    .filter((n) => n.startsWith('ernte-') && n.endsWith('.json') && !n.includes('vek'))
    .slice(0, hoechstens);

  if (dateien.length === 0) {
    console.error(`NICHT GEMESSEN: keine ernte-*.json in ${ordner}.`);
    console.error('Null gelesene Projekte sehen von aussen aus wie ein bestandener Messstand.');
    process.exit(2);
  }

  const lessons: BenchLesson[] = [];
  const queries: BenchQuery[] = [];
  const projekte = new Set<string>();
  let verworfen = 0;

  for (const d of dateien) {
    let e: Ernte;
    try {
      e = JSON.parse(readFileSync(join(ordner, d), 'utf8')) as Ernte;
    } catch {
      verworfen++;
      continue;
    }
    const p = paareAus(e);
    // Je Projekt gedeckelt: sonst traegt ein grosses Projekt den ganzen Satz.
    const l = p.lessons.slice(0, jeProjekt);
    const q = p.queries.slice(0, jeProjekt);
    if (l.length === 0) continue;
    lessons.push(...l);
    queries.push(...q);
    for (const x of l) projekte.add(projektAus(x.topic));
  }

  if (queries.length === 0) {
    console.error('NICHT GEMESSEN: keine gueltigen Frage-Gold-Paare gefunden.');
    process.exit(2);
  }

  console.log(`\n${dateien.length} Ernte-Dateien gelesen, ${verworfen} unlesbar.`);
  console.log(`${projekte.size} Projekte · ${lessons.length} Lektionen · ${queries.length} Fragen`);
  console.log(`(der eingefrorene Schnitt hat 10 Projekte)\n`);
  console.log('Messe … das dauert bei dieser Groesse ein paar Minuten.\n');

  const r = await runBenchmarkOn(lessons, queries);
  const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

  console.log('  Verfahren      P@1      P@3      Recall@3   MRR      nDCG@5');
  for (const [name, m] of [['Flatfile', r.flatfile], ['BM25 pur', r.baseline], ['cachly', r.cachly]] as const) {
    console.log(
      `  ${name.padEnd(13)}${pct(m.precisionAt1).padStart(7)}${pct(m.precisionAt3).padStart(9)}` +
      `${pct(m.recallAt3).padStart(11)}${pct(m.mrr).padStart(9)}${pct(m.ndcgAt5).padStart(10)}`,
    );
  }

  const beitrag = r.cachly.precisionAt1 - r.baseline.precisionAt1;
  console.log(`
  Beitrag des Sortierers auf P@1: ${(beitrag * 100).toFixed(1)} Punkte`);

  console.log(`
WICHTIG ZUR EINORDNUNG, damit die Zahl nicht falsch weitergetragen wird:

Eine geerntete Lektion hat keine Zuversicht, keine Abrufzahl, keine Schwere
und keine Abnahme. Das sind UNSERE Signale, und fremde Projekte tragen sie
nicht — hier bekommen alle Eintraege denselben Wert. Der Sortierer hat also
nichts zu unterscheiden.

Ein kleiner Abstand ist deshalb KEIN Urteil ueber den Sortierer, sondern
eine Grenze dieses Messstands. Was er misst, ist die RELEVANZ — und nur die.

Daraus folgt die unbequeme Einsicht: die Qualitaetsstufe laesst sich auf
Fremddaten ueberhaupt nicht messen. Jede Zahl ueber ihren Nutzen stammt aus
einem Bestand, dessen Qualitaetssignale wir selbst geschrieben haben.

NICHT GEMESSEN: die Gewinne JE PROJEKT. Der Mittelwert ueber ${projekte.size} Projekte
versteckt, ob zwei davon alles tragen. Das ist der naechste Schritt und
braucht eine Aenderung an runBenchmarkOn.

DER EINGEFRORENE ZEHNER-SCHNITT BLEIBT unangetastet — er ist die Referenz,
gegen die alles bisher gemessen wurde.`);
}

// Nur beim direkten Aufruf laufen — als Modul importiert (haelfteFuer,
// paareAus) darf hier NICHTS starten. Beleg 31.08.2026: der blosse Import
// in longmemeval.ts liess diesen main() mitlaufen und brach mit
// '--ordner ist Pflicht' ab.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
