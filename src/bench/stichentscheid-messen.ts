/**
 * ══ Stichentscheid, Stufe A: lohnt der zweite Blick — und wie tief? ════════
 *
 * ── Die Rechnung, die diesen Messstand erzwingt (27.08.2026) ──────────────
 *
 * Auf dem eingefrorenen Pruefsatz: 98 von 100 richtigen Antworten liegen im
 * Topf, 70 in den Top 10, 59 werden gezeigt. Gewichte drehen kann hoechstens
 * Richtung 70 heben. Die 85-%-Zusage verlangt, dass etwas aus Rang <= 75 in
 * die Top 3 zieht — das kann nur ein zweiter Blick (Bauplan Abschnitt 5:
 * kleines Modell liest Kandidaten, nur bei Unsicherheit, nie im
 * Einblendungspfad).
 *
 * BEVOR ein Modell angerufen wird, klaert diese Stufe DREI Fragen ohne einen
 * einzigen Netzaufruf:
 *
 *   1. WANN ausloesen? Zwei Schalter-Familien aus den Vorarbeiten:
 *        V8 (Naturworkshop 2):  beste Punktzahl < Schwelle
 *        Bauplan Abschnitt 5:   Abstand Platz 1 zu Platz 2 < Schwelle
 *      Beide werden ueber Quantile abgetastet, damit jede Zeile einer
 *      Ausloesequote entspricht. Die 2,453 aus dem Workshop wird NICHT
 *      uebernommen: sie galt fuer die dortige Punkteskala, nicht fuer diese.
 *
 *   2. WIE TIEF muss der zweite Blick lesen? Fuer jede Tiefe T (5/10/25/alle)
 *      wird das ORAKEL gerechnet: wie viele ausgeloeste Faelle HAETTEN eine
 *      akzeptable Antwort in den ersten T — ein perfekter Waehler kann genau
 *      die retten, mehr nicht. Der Bauplan sagt Tiefe 5; ob 5 reicht, ist
 *      eine Messfrage, keine Planungsfrage.
 *
 *   3. WAS ist damit ueberhaupt erreichbar? Die Decke je Einstellung:
 *      nicht-ausgeloeste Faelle behalten ihr heutiges Ergebnis, ausgeloeste
 *      bekommen das Orakel. Liegt schon die DECKE unter dem Ziel, braucht
 *      kein Modell anzutreten.
 *
 * Das Orakel ist kein Modell. Es ist die Obergrenze; jedes echte Modell
 * liegt darunter. Diese Stufe kann den Stichentscheid also nur BEERDIGEN
 * oder BEPREISEN — beweisen kann ihn erst Stufe B mit echten Modellaufrufen.
 *
 * ── Messhygiene ───────────────────────────────────────────────────────────
 *
 * Punktzahl je Kandidat: importiert aus beleg-kaskade-messen.ts, das sie per
 * Eichprobe zifferngleich an gewichte-anpassen.bewerte bindet — keine dritte
 * Abschrift (Zwei-Systeme-Falle vom 20.08.2026). Gesiebt wird am
 * EINSTELLsatz; der eingefrorene Pruefsatz bleibt zu. Und der Auszug muss
 * aus der Pool-75-Welt stammen: der alte merkmale-einstell.jsonl traegt
 * 43er-Toepfe aus der Pool-25-Zeit und misst eine Suchmaschine, die es im
 * Produkt nicht gibt (der Messstand warnt, wenn die Toepfe zu klein sind).
 *
 * Aufruf:
 *   npx tsx src/bench/stichentscheid-messen.ts --merkmale <datei.jsonl>
 *   npx tsx src/bench/stichentscheid-messen.ts --selbstprobe
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { punktzahl } from './beleg-kaskade-messen.js';
// Die Poolgroesse wird IMPORTIERT, nicht abgeschrieben. Der Waechter
// stellschrauben-stehen-nur-hier.test.ts hat genau das hier gefangen: die 75
// stand als Zahl in der Fehlermeldung. Zwei Quellen laufen auseinander.
import { SINN_TOPF } from '../rangfolge-stellschrauben.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; art: string; relevant: string[]; topf: Kandidat[] };

/** Alles, was Schalter und Orakel brauchen — einmal je Frage vorgerechnet. */
type Vorgerechnet = {
  art: string;
  bestPunkt: number;
  abstand12: number;
  /** Platz der besten akzeptablen Antwort in der heutigen Rangfolge, 0 = fehlt. */
  platz: number;
};

const TIEFEN = [5, 10, 25, Infinity] as const;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const proz = (x: number) => `${(x * 100).toFixed(1)} %`;

export function vorrechnen(z: Zeile): Vorgerechnet {
  const punkte = punktzahl(z.topf);
  const rang = z.topf
    .map((k, i) => ({ t: k.t, p: punkte[i] }))
    .sort((a, b) => b.p - a.p);
  const gold = new Set(z.relevant);
  let platz = 0;
  for (let i = 0; i < rang.length; i++) if (gold.has(rang[i].t)) { platz = i + 1; break; }
  return {
    art: z.art || 'ohne',
    bestPunkt: rang[0]?.p ?? -Infinity,
    abstand12: (rang[0]?.p ?? 0) - (rang[1]?.p ?? 0),
    platz,
  };
}

/** p-Quantil einer Kopie (die Eingabe bleibt unsortiert). */
function quantil(werte: number[], p: number): number {
  const s = [...werte].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
}

type DeckenZeile = {
  ausloesequote: number;
  schwelle: number;
  /** @3 heute unter den Ausgeloesten — was der Schalter an Schaden einfaengt. */
  heuteAusgeloest: number;
  /** Decke je Tiefe: gesamt-@3, wenn ein perfekter Waehler die Ausgeloesten ordnet. */
  decke: number[];
};

export function deckenrechnung(
  faelle: Vorgerechnet[],
  ausgeloest: (f: Vorgerechnet) => boolean,
): Omit<DeckenZeile, 'schwelle' | 'ausloesequote'> & { ausgeloestAnzahl: number } {
  let trifftHeuteRuhig = 0;
  let trifftHeuteAusgeloest = 0;
  let ausgeloestAnzahl = 0;
  const rettbar = TIEFEN.map(() => 0);
  for (const f of faelle) {
    if (!ausgeloest(f)) {
      if (f.platz >= 1 && f.platz <= 3) trifftHeuteRuhig++;
      continue;
    }
    ausgeloestAnzahl++;
    if (f.platz >= 1 && f.platz <= 3) trifftHeuteAusgeloest++;
    TIEFEN.forEach((t, i) => {
      if (f.platz >= 1 && f.platz <= t) rettbar[i]++;
    });
  }
  const n = faelle.length;
  return {
    ausgeloestAnzahl,
    heuteAusgeloest: ausgeloestAnzahl ? trifftHeuteAusgeloest / ausgeloestAnzahl : 0,
    decke: rettbar.map((r) => (trifftHeuteRuhig + r) / n),
  };
}

function selbstprobe(): void {
  const proben: Array<[string, boolean]> = [];
  const p = (was: string, ok: boolean): void => { proben.push([was, ok]); };

  // Vier konstruierte Faelle mit von Hand bekannten Plaetzen.
  const faelle: Vorgerechnet[] = [
    { art: 'a', bestPunkt: 3.0, abstand12: 1.0, platz: 1 },  // sicher, richtig
    { art: 'a', bestPunkt: 1.0, abstand12: 0.1, platz: 7 },  // unsicher, in Top 10
    { art: 'b', bestPunkt: 0.9, abstand12: 0.05, platz: 30 }, // unsicher, tief im Topf
    { art: 'b', bestPunkt: 0.8, abstand12: 0.02, platz: 0 },  // unsicher, gar nicht da
  ];
  const d = deckenrechnung(faelle, (f) => f.bestPunkt < 2);
  p('drei von vier loesen aus', d.ausgeloestAnzahl === 3);
  p('heute trifft unter den Ausgeloesten keiner', d.heuteAusgeloest === 0);
  // Tiefe 5 rettet nichts (Plaetze 7, 30, 0) -> Decke = 1/4 (der ruhige Treffer).
  p('Tiefe 5 rettet nichts', d.decke[0] === 1 / 4);
  // Tiefe 10 rettet Platz 7 -> 2/4. Tiefe 25 ebenso. "alle" rettet auch Platz 30 -> 3/4.
  p('Tiefe 10 rettet Platz 7', d.decke[1] === 2 / 4);
  p('Tiefe 25 rettet Platz 30 NICHT', d.decke[2] === 2 / 4);
  p('volle Tiefe rettet Platz 30, aber nie den fehlenden', d.decke[3] === 3 / 4);

  p('Quantil 0 ist das Minimum', quantil([3, 1, 2], 0) === 1);
  p('Quantil-Eingabe bleibt unsortiert', (() => { const w = [3, 1, 2]; quantil(w, 0.5); return w[0] === 3; })());

  let rot = 0;
  for (const [was, ok] of proben) {
    console.log(`${ok ? 'ok  ' : 'ROT '} ${was}`);
    if (!ok) rot++;
  }
  console.log(rot === 0 ? 'Selbstprobe bestanden.' : `Selbstprobe ROT: ${rot} von ${proben.length}.`);
  process.exit(rot === 0 ? 0 : 1);
}

async function main(): Promise<void> {
  if (process.argv.includes('--selbstprobe')) selbstprobe();

  const pfad = flag('merkmale');
  if (!pfad) {
    console.error('NICHT GEMESSEN: --merkmale <datei.jsonl> ist Pflicht.');
    process.exit(2);
  }

  const zeilen: Zeile[] = [];
  const leser = createInterface({ input: createReadStream(resolve(pfad)), crlfDelay: Infinity });
  for await (const z of leser) {
    if (z.trim()) zeilen.push(JSON.parse(z) as Zeile);
  }
  if (zeilen.length < 100) {
    console.error(`NICHT GEMESSEN: nur ${zeilen.length} Zeilen.`);
    process.exit(3);
  }

  // Pool-25-Wache: kleine Toepfe = alte Welt = andere Suchmaschine.
  const mittlererTopf = zeilen.reduce((s, z) => s + z.topf.length, 0) / zeilen.length;
  // Untergrenze aus der Stellschraube abgeleitet, nicht geraten: weniger als
  // vier Fuenftel der Produkt-Poolgroesse heisst, der Auszug stammt aus einer
  // anderen Welt.
  if (mittlererTopf < SINN_TOPF * 0.8) {
    console.error(`NICHT GEMESSEN: mittlere Topfgroesse ${mittlererTopf.toFixed(0)} — das ist die`);
    console.error(`Pool-25-Welt. Das Produkt sucht mit SINN_TOPF=${SINN_TOPF}; den Auszug neu erzeugen`);
    console.error('(findequote-messen.ts laeuft seit 24.08. mit der Produkt-Vorgabe).');
    process.exit(4);
  }

  const faelle = zeilen.map(vorrechnen);
  const n = faelle.length;
  const heute3 = faelle.filter((f) => f.platz >= 1 && f.platz <= 3).length / n;
  const inTopf = faelle.filter((f) => f.platz >= 1).length / n;

  console.log('');
  console.log('⚖️  Stichentscheid, Stufe A — Schalter und Decke, ohne Modell');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${n} Fragen · mittlere Topfgroesse ${mittlererTopf.toFixed(0)} · Merkmale aus ${pfad}`);
  console.log(`  heute: @3 ${proz(heute3)} · im Topf ueberhaupt ${proz(inTopf)}  <- die absolute Obergrenze`);

  for (const [name, wert] of [
    ['V8: beste Punktzahl unter Schwelle', (f: Vorgerechnet) => f.bestPunkt],
    ['Bauplan: Abstand Platz 1-2 unter Schwelle', (f: Vorgerechnet) => f.abstand12],
  ] as const) {
    console.log('');
    console.log(`  ── Schalter "${name}" ──`);
    console.log('  loest aus   Schwelle    @3 heute (ausgel.)   Decke T5    T10     T25     alle');
    const werte = faelle.map(wert);
    for (const q of [0.15, 0.25, 0.35, 0.45, 0.55]) {
      const s = quantil(werte, q);
      const d = deckenrechnung(faelle, (f) => wert(f) < s);
      console.log(
        `    ${proz(d.ausgeloestAnzahl / n).padStart(6)}   ${s.toFixed(3).padStart(8)}        ${proz(d.heuteAusgeloest).padStart(6)}        `
        + d.decke.map((x) => proz(x).padStart(6)).join('  '),
      );
    }
  }

  // Nach Frageart, fuer den staerksten Hebel: wo sitzen die ausgeloesten Verluste?
  console.log('');
  console.log('  Nach Frageart (Anteil der Fragen, die heute NICHT in den Top 3 treffen):');
  const arten = new Map<string, { n: number; verloren: number }>();
  for (const f of faelle) {
    const e = arten.get(f.art) ?? { n: 0, verloren: 0 };
    e.n++;
    if (!(f.platz >= 1 && f.platz <= 3)) e.verloren++;
    arten.set(f.art, e);
  }
  for (const [art, e] of [...arten.entries()].sort()) {
    console.log(`    ${art.padEnd(14)} ${proz(e.verloren / e.n).padStart(7)} verloren  (${e.n} Fragen)`);
  }

  console.log('');
  console.log('  Lesart: die Decke ist ein ORAKEL — ein perfekter Waehler. Jedes echte');
  console.log('  Modell liegt darunter. Liegt schon die Decke unterm Ziel, ist Stufe B');
  console.log('  tot, bevor sie einen Cent gekostet hat.');
}

const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('stichentscheid-messen.ts');
if (direktGestartet) {
  main().catch((e: unknown) => {
    console.error('NICHT GEMESSEN:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
