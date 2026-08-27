/**
 * ══ Tragen Zeichen-n-Gramme ueberhaupt Signal? (Unterscheidbarkeits-Probe) ══
 *
 * ── Warum diese Probe VOR dem Bauen kommt ─────────────────────────────────
 *
 * Am 27.08.2026 sind zwei modellfreie Umsortier-Ideen gestorben, beide nach
 * dem Bauen: die Beleg-Kaskade (+-0) und das V8-Quorum (-0,8). Die Lehre war
 * eindeutig — beide ordneten DIESELBEN Zahlen anders. Neue Punkte koennen nur
 * aus NEUER Information kommen.
 *
 * Zeichen-n-Gramme waeren solche neue Information: sie finden Aehnlichkeit
 * zwischen `Rechnungsnummer` und `Rechnung` ohne Woerterbuch und ohne
 * Sprachannahme. Bevor das aber irgendwo eingebaut wird, muss die Frage
 * beantwortet sein, an der `besterZeuge` am 26.08. gescheitert ist:
 *
 *     TRENNT das Mass ueberhaupt richtige von falschen Kandidaten?
 *
 * Damals lagen die Verteilungen mit Antwort (0,564-0,823) und ohne Antwort
 * (0,266-0,823) so weit uebereinander, dass kein Schwellenwert half. Diese
 * Probe stellt dieselbe Frage fuer n-Gramme, und zwar in DREI Stufen:
 *
 *   1. Trennt das Mass allein? (Verteilungen richtig gegen falsch)
 *   2. Trennt es dort, wo der WORTABGLEICH versagt? Das ist die eigentliche
 *      Frage — ein Mass, das nur dort stark ist, wo die Woerter schon passen,
 *      bringt nichts Neues.
 *   3. Wie viele Faelle betrifft das ueberhaupt?
 *
 * ── Der wichtige Vorbehalt aus dem eigenen Haus ───────────────────────────
 *
 * `rangfolge.ts` haelt fest, dass Stammbildung GEMESSEN schadet: Kuerzen auf
 * 6 oder 8 Zeichen kostete am 19.08.2026 drei Punkte, weil es seltene
 * Fachwoerter verwischt (`container` und `contains` werden ein Wort).
 *
 * n-Gramme sind eine Verwandte davon — aber nicht dasselbe: sie ERSETZEN den
 * Wortabgleich nicht, sie kaemen daneben. Der exakte Treffer auf `fail2ban`
 * behaelt sein volles Gewicht. Ob das reicht, sagt Stufe 2.
 *
 * Aufruf:
 *   npx tsx src/bench/ngramme-trennschaerfe.ts --korpus <korpus-gross.json>
 *   npx tsx src/bench/ngramme-trennschaerfe.ts --selbstprobe
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inhaltsWoerter } from '../rangfolge.js';
import type { BenchLesson } from './fixtures.js';

interface Frage { query: string; relevant: string[]; art?: string }
interface Korpus { lessons: BenchLesson[]; queries: Frage[] }

/** Laenge der Zeichenketten. 3 ist die uebliche Wahl fuer kurze Texte. */
const N = 3;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Die n-Gramme eines Textes.
 *
 * Umlaute werden ausgeschrieben und alles ausser Buchstaben und Ziffern wird
 * zu einem Leerzeichen — dieselbe Vorbehandlung wie in `inhaltsWoerter`,
 * damit die beiden Masse dieselbe Welt sehen. Wortgrenzen bleiben erhalten
 * (das Leerzeichen ist Teil der Kette), sonst entstehen n-Gramme ueber
 * Wortgrenzen hinweg, die nichts bedeuten.
 */
export function ngramme(text: string, n = N): Set<string> {
  const sauber = text
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const raus = new Set<string>();
  for (const wort of sauber.split(' ')) {
    if (!wort) continue;
    // Kurze Woerter liefern sich selbst — sonst gingen sie ganz verloren.
    if (wort.length <= n) { raus.add(wort); continue; }
    for (let i = 0; i + n <= wort.length; i++) raus.add(wort.slice(i, i + n));
  }
  return raus;
}

/**
 * Deckung: welcher Anteil der Frage-n-Gramme steht im Text?
 *
 * Bewusst asymmetrisch (nicht Jaccard): der Text ist viel laenger als die
 * Frage, und ein Jaccard-Mass wuerde vor allem die Laenge messen. Gefragt ist,
 * wie viel von der FRAGE der Text abdeckt.
 */
export function ngrammDeckung(frage: string, text: string, n = N): number {
  const f = ngramme(frage, n);
  if (f.size === 0) return 0;
  const t = ngramme(text, n);
  let treffer = 0;
  for (const g of f) if (t.has(g)) treffer++;
  return treffer / f.size;
}

/** Wortdeckung mit denselben Regeln wie der Sortierer — der Vergleichsmassstab. */
export function wortDeckung(frage: string, text: string): number {
  const f = inhaltsWoerter(frage);
  if (f.size === 0) return 0;
  const t = inhaltsWoerter(text);
  let treffer = 0;
  for (const w of f) if (t.has(w)) treffer++;
  return treffer / f.size;
}

function spanne(werte: number[]): string {
  if (werte.length === 0) return '(keine)';
  const s = [...werte].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `${q(0.05).toFixed(3)}–${q(0.95).toFixed(3)} (Median ${q(0.5).toFixed(3)})`;
}

/** Anteil der falschen Werte, die ueber dem Median der richtigen liegen. */
function ueberlappung(richtig: number[], falsch: number[]): number {
  if (richtig.length === 0 || falsch.length === 0) return 1;
  const s = [...richtig].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  return falsch.filter((x) => x >= median).length / falsch.length;
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  p('n-Gramme eines kurzen Wortes sind das Wort', ngramme('abc').has('abc'));
  p('n-Gramme zerlegen ein langes Wort', ngramme('rechnung').has('rec') && ngramme('rechnung').has('ung'));
  p('keine n-Gramme ueber Wortgrenzen', !ngramme('ab cd').has('bc'));

  // Der Kernfall: Kompositum gegen Grundwort.
  const mitN = ngrammDeckung('rechnung', 'die rechnungsnummer fehlt');
  const mitWort = wortDeckung('rechnung', 'die rechnungsnummer fehlt');
  p('n-Gramme finden das Kompositum', mitN > 0.7);
  p('der Wortabgleich findet es NICHT', mitWort === 0);

  // Und die Gegenrichtung: unverwandte Woerter duerfen nicht hoch liegen.
  const fremd = ngrammDeckung('rechnung', 'der server startet neu');
  p('unverwandter Text liegt niedrig', fremd < 0.3);

  p('Umlaute werden gleichgezogen', ngrammDeckung('loesung', 'lösung gefunden') === 1);

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

function main(): void {
  if (process.argv.includes('--selbstprobe')) selbstprobe();

  const pfad = resolve(flag('korpus') ?? '');
  if (!existsSync(pfad)) {
    console.error(`NICHT GEMESSEN: --korpus <datei.json> fehlt (${pfad}).`);
    process.exit(2);
  }
  const korpus = JSON.parse(readFileSync(pfad, 'utf8')) as Korpus;
  const textVon = new Map<string, string>();
  for (const l of korpus.lessons) {
    const t = l as unknown as Record<string, string>;
    textVon.set(l.topic, [l.topic, t.what_worked ?? '', t.what_failed ?? ''].join(' '));
  }

  // Fuer jede Frage: der Wert zur RICHTIGEN Antwort und zu drei zufaelligen
  // falschen. Zufall fest verdrahtet ueber den Index, damit der Lauf
  // wiederholbar ist.
  const themen = [...textVon.keys()];
  const nRichtig: number[] = []; const nFalsch: number[] = [];
  const wRichtig: number[] = []; const wFalsch: number[] = [];
  // Stufe 2: nur die Faelle, in denen der Wortabgleich NICHTS findet.
  const nRichtigBlind: number[] = []; const nFalschBlind: number[] = [];
  let blindeFragen = 0;

  for (const [i, q] of korpus.queries.entries()) {
    const ziel = q.relevant?.[0];
    const zielText = ziel ? textVon.get(ziel) : undefined;
    if (!zielText) continue;

    const nR = ngrammDeckung(q.query, zielText);
    const wR = wortDeckung(q.query, zielText);
    nRichtig.push(nR); wRichtig.push(wR);
    if (wR === 0) { blindeFragen++; nRichtigBlind.push(nR); }

    for (let k = 1; k <= 3; k++) {
      const j = (i * 7 + k * 137) % themen.length;
      const t = themen[j];
      if (t === ziel) continue;
      const text = textVon.get(t) ?? '';
      const nF = ngrammDeckung(q.query, text);
      const wF = wortDeckung(q.query, text);
      nFalsch.push(nF); wFalsch.push(wF);
      if (wR === 0) nFalschBlind.push(nF);
    }
  }

  console.log('');
  console.log('⚖️  Zeichen-n-Gramme: trennen sie ueberhaupt?');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${korpus.queries.length} Fragen · ${korpus.lessons.length} Lektionen · n=${N}`);
  console.log('');
  console.log('  ── Stufe 1: das Mass allein ──');
  console.log(`    n-Gramme  richtig  ${spanne(nRichtig)}`);
  console.log(`    n-Gramme  falsch   ${spanne(nFalsch)}`);
  console.log(`    ueber dem Median der richtigen liegen ${(ueberlappung(nRichtig, nFalsch) * 100).toFixed(1)} % der falschen`);
  console.log('');
  console.log(`    Wortabgleich richtig  ${spanne(wRichtig)}`);
  console.log(`    Wortabgleich falsch   ${spanne(wFalsch)}`);
  console.log(`    ueber dem Median der richtigen liegen ${(ueberlappung(wRichtig, wFalsch) * 100).toFixed(1)} % der falschen`);
  console.log('');
  console.log('  ── Stufe 2: dort, wo der Wortabgleich BLIND ist ──');
  console.log(`    ${blindeFragen} von ${nRichtig.length} Fragen teilen KEIN Wort mit ihrer Antwort`);
  if (blindeFragen > 0) {
    console.log(`    n-Gramme  richtig  ${spanne(nRichtigBlind)}`);
    console.log(`    n-Gramme  falsch   ${spanne(nFalschBlind)}`);
    console.log(`    ueber dem Median liegen ${(ueberlappung(nRichtigBlind, nFalschBlind) * 100).toFixed(1)} % der falschen`);
  }
  console.log('');
  console.log('  Lesart: je hoeher der Ueberlappungswert, desto weniger trennt das Mass.');
  console.log('  Zum Vergleich: besterZeuge lag am 26.08. bei einer Ueberlappung, die');
  console.log('  keinen Schwellenwert zuliess — und wurde deshalb NICHT gebaut.');
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('ngramme-trennschaerfe.ts');
if (direktGestartet) {
  try {
    main();
  } catch (e) {
    console.error('NICHT GEMESSEN:', e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
