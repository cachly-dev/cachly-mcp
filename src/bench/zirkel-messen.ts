/**
 * ══ Zirkel-Messung: steht die Antwort schon in der Frage? ══════════════════
 *
 * ── Warum das die erste Frage an JEDEN Fragensatz ist ─────────────────────
 *
 * Ein Fragensatz, dessen Fragen aus den Lektionstexten abgeschrieben sind,
 * misst nicht die Suche. Er misst, wie gut die Suche einen Text wiederfindet,
 * aus dem die Frage stammt — und das ist immer sehr gut. Die Zahlen sehen
 * dann hervorragend aus, und niemand merkt, dass die Aufgabe eine andere war.
 *
 * Genau diese Fehlerklasse hat uns am 20.08.2026 schon einmal getroffen: der
 * Messstand sortierte anders als der ausgelieferte Pfad, die Fehlertext-
 * Eingaenge brachten dort +6 Punkte und im Produkt +1. Die Zahl war richtig —
 * sie beschrieb nur eine Aufgabe, die es nicht gab.
 *
 * `.agent/FRAGEN-POOL-BAUPLAN.md` VERBIETET das Abschreiben ausdruecklich.
 * Ein Verbot ist keine Messung. Dieses Werkzeug misst es.
 *
 * ── Was gemessen wird ────────────────────────────────────────────────────
 *
 * Je Frage: welcher Anteil ihrer Inhaltswoerter steht auch im Text ihrer
 * Gold-Lektion? Ueber Wortstaemme, damit "Zeitgrenze" und "Zeitgrenzen"
 * zusammenfallen.
 *
 *   0,00 bis 0,25   unabhaengig formuliert — so soll es sein
 *   0,25 bis 0,50   normale Ueberschneidung im Fachwortschatz
 *   0,50 bis 0,75   verdaechtig
 *   ueber 0,75      mit hoher Wahrscheinlichkeit abgeschrieben
 *
 * ── Die Gegenprobe, ohne die die Zahl nichts wert ist ────────────────────
 *
 * Dieselbe Rechnung gegen eine ZUFAELLIGE andere Lektion. Liegt die
 * Ueberlappung dort aehnlich hoch, misst dieses Werkzeug nur den gemeinsamen
 * Fachwortschatz und nicht das Abschreiben. Erst der ABSTAND zwischen beiden
 * Zahlen ist die Aussage.
 *
 * Aufruf:
 *   npx tsx src/bench/zirkel-messen.ts \
 *     --korpus "$HOME/.cachly/bench-korpus/korpus-gross.json" \
 *     --fragen "$HOME/.cachly/bench-korpus/einstellsatz-3000.json"
 */

import { readFileSync } from 'node:fs';
import { inhaltsWoerter, grobStamm } from '../rangfolge.js';

type Lektion = {
  topic: string;
  what_worked?: string;
  what_failed?: string;
  context?: string;
};

type Frage = {
  query: string;
  relevant?: string[];
  art?: string;
  guete?: string;
  sprache?: string;
  form?: string;
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function lies<T>(pfad: string): T {
  return JSON.parse(readFileSync(pfad, 'utf8')) as T;
}

/** Wortstaemme eines Textes — dieselbe Zerlegung wie in der Rangfolge. */
function staemme(text: string): Set<string> {
  return new Set([...inhaltsWoerter(text)].map(grobStamm));
}

/** Anteil der Fragewoerter, die auch im Lektionstext vorkommen. */
export function ueberlappung(frage: Set<string>, lektion: Set<string>): number {
  if (frage.size === 0) return 0;
  let treffer = 0;
  for (const w of frage) if (lektion.has(w)) treffer++;
  return treffer / frage.size;
}

/** Ein Band fuer die Verteilung. */
export function band(x: number): string {
  if (x < 0.25) return '0,00–0,25  unabhaengig';
  if (x < 0.5) return '0,25–0,50  normal';
  if (x < 0.75) return '0,50–0,75  verdaechtig';
  return '0,75–1,00  ABGESCHRIEBEN';
}

function mittel(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main(): Promise<void> {
  const korpusPfad = flag('korpus');
  const fragenPfad = flag('fragen');
  if (!korpusPfad || !fragenPfad) {
    console.error('NICHT GEMESSEN: --korpus und --fragen sind Pflicht.');
    process.exit(2);
  }

  const korpus = lies<{ lessons?: Lektion[]; lektionen?: Lektion[] }>(korpusPfad);
  const lektionen = korpus.lessons ?? korpus.lektionen ?? [];
  const fragenDatei = lies<{ queries?: Frage[]; fragen?: Frage[] }>(fragenPfad);
  const fragen = fragenDatei.queries ?? fragenDatei.fragen ?? [];

  if (lektionen.length === 0 || fragen.length === 0) {
    console.error(`NICHT GEMESSEN: ${lektionen.length} Lektionen, ${fragen.length} Fragen.`);
    process.exit(3);
  }

  // Text je Lektion einmal zerlegen — 499 mal statt 3000 mal.
  const textVon = new Map<string, Set<string>>();
  for (const l of lektionen) {
    const ganz = [l.topic, l.what_worked ?? '', l.what_failed ?? '', l.context ?? ''].join(' ');
    textVon.set(l.topic, staemme(ganz));
  }
  const alleThemen = [...textVon.keys()];

  const echt: number[] = [];
  const zufall: number[] = [];
  const nachGuete = new Map<string, number[]>();
  const nachSprache = new Map<string, number[]>();
  const verdaechtig: Array<{ q: string; t: string; x: number }> = [];
  let ohneGold = 0;

  // Fester Zufall: derselbe Lauf muss dieselbe Zahl liefern.
  let saat = 42;
  const wuerfel = (): number => {
    saat = (saat * 1103515245 + 12345) % 2147483648;
    return saat / 2147483648;
  };

  for (const f of fragen) {
    const gold = (f.relevant ?? [])[0];
    const goldText = gold ? textVon.get(gold) : undefined;
    if (!goldText) { ohneGold++; continue; }

    const fw = staemme(f.query);
    const x = ueberlappung(fw, goldText);
    echt.push(x);
    if (x >= 0.75) verdaechtig.push({ q: f.query, t: gold, x });

    const g = f.guete ?? '—';
    if (!nachGuete.has(g)) nachGuete.set(g, []);
    nachGuete.get(g)!.push(x);
    const s = f.sprache ?? '—';
    if (!nachSprache.has(s)) nachSprache.set(s, []);
    nachSprache.get(s)!.push(x);

    // Gegenprobe: dieselbe Frage gegen eine zufaellige FREMDE Lektion.
    let fremd = alleThemen[Math.floor(wuerfel() * alleThemen.length)];
    if (fremd === gold) fremd = alleThemen[(alleThemen.indexOf(gold) + 1) % alleThemen.length];
    zufall.push(ueberlappung(fw, textVon.get(fremd)!));
  }

  const proz = (x: number) => `${(x * 100).toFixed(1)} %`;

  console.log('');
  console.log('🔎  Zirkel-Messung — steht die Antwort schon in der Frage?');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  Lektionen ${lektionen.length} · Fragen ${fragen.length}`
    + (ohneGold ? ` · ${ohneGold} ohne auffindbare Gold-Lektion uebersprungen` : ''));
  console.log('');
  console.log('  Wortueberlappung Frage → ihre Gold-Lektion');
  console.log(`    Mittel  ${proz(mittel(echt))}     Median  ${proz(median(echt))}`);
  console.log('');
  console.log('  GEGENPROBE: dieselbe Frage → eine ZUFAELLIGE andere Lektion');
  console.log(`    Mittel  ${proz(mittel(zufall))}     Median  ${proz(median(zufall))}`);
  console.log('');
  const abstand = mittel(echt) - mittel(zufall);
  console.log(`  Abstand ${proz(abstand)} — nur DIESE Zahl ist die Aussage.`);
  console.log('    Ein kleiner Abstand heisst: die Ueberlappung ist gemeinsamer');
  console.log('    Fachwortschatz, kein Abschreiben.');
  console.log('');

  const verteilung = new Map<string, number>();
  for (const x of echt) verteilung.set(band(x), (verteilung.get(band(x)) ?? 0) + 1);
  console.log('  Verteilung');
  for (const b of ['0,00–0,25  unabhaengig', '0,25–0,50  normal',
    '0,50–0,75  verdaechtig', '0,75–1,00  ABGESCHRIEBEN']) {
    const n = verteilung.get(b) ?? 0;
    console.log(`    ${b.padEnd(28)} ${String(n).padStart(5)}  ${proz(n / echt.length)}`);
  }
  console.log('');

  console.log('  Nach Guete');
  for (const [g, xs] of [...nachGuete].sort()) {
    console.log(`    ${g.padEnd(16)} ${proz(mittel(xs))}  (${xs.length} Fragen)`);
  }
  console.log('');
  console.log('  Nach Sprache');
  for (const [s, xs] of [...nachSprache].sort()) {
    console.log(`    ${s.padEnd(16)} ${proz(mittel(xs))}  (${xs.length} Fragen)`);
  }

  if (verdaechtig.length > 0) {
    console.log('');
    console.log(`  ⚠️  ${verdaechtig.length} Fragen ueber 75 % — die ersten fuenf:`);
    for (const v of verdaechtig.slice(0, 5)) {
      console.log(`    ${proz(v.x)}  ${v.q.slice(0, 70)}`);
      console.log(`            → ${v.t}`);
    }
  }

  console.log('──────────────────────────────────────────────────────────────────────');
  // Ein Satz mit mehr als 5 Prozent abgeschriebenen Fragen taugt nicht zum
  // Einstellen. Die Zahl ist gesetzt, nicht gemessen — sie darf sich aendern,
  // aber dann sichtbar.
  const anteilAbgeschrieben = verdaechtig.length / echt.length;
  if (anteilAbgeschrieben > 0.05) {
    console.log(`  ❌ ${proz(anteilAbgeschrieben)} der Fragen sind vermutlich abgeschrieben.`);
    console.log('     Dieser Satz misst die Suche nicht. Nicht zum Einstellen benutzen.');
    process.exit(1);
  }
  console.log(`  ✅ ${proz(anteilAbgeschrieben)} verdaechtig — unter der Grenze von 5,0 %.`);
}

main().catch((e) => {
  console.error('NICHT GEMESSEN:', e instanceof Error ? e.message : String(e));
  process.exit(4);
});
