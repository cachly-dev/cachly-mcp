/**
 * tueren-verrechnung.ts — wie soll aus mehreren Tueren EINE Zahl werden?
 *
 * ── Der Anlass ──────────────────────────────────────────────────────────────
 *
 * `besteNaehe` nimmt das MAXIMUM ueber alle Tueren einer Lektion. Der Kommentar
 * dort begruendet das und nennt eine Messung vom 20.08.2026. Diese Messung ist
 * ueberholt, und zwar nicht ein bisschen:
 *
 *   Am 20.08. gab es nur Fehlertext-Tueren. 108 von 499 Lektionen hatten GAR
 *   KEINE. Am 21.08. hat die Vollimpfung jeder Lektion drei Fragen gegeben.
 *   Die Verteilung heute: 108 Lektionen mit 3 Tueren, 71 mit 4, 66 mit 5 und
 *   254 mit 6. Im Schnitt 4,93.
 *
 * Das Maximum belohnt damit systematisch die 254 Lektionen mit sechs Tueren —
 * wer mehr Lose hat, gewinnt oefter zufaellig. Das ist dieselbe Fehlerklasse
 * wie `spreizeImTopf`, das einem fehlenden Wert eine Null gibt: ein Merkmal
 * misst BESITZ statt PASSUNG.
 *
 * ── Die drei Verrechnungen ──────────────────────────────────────────────────
 *
 *   max     die naechste Tuer entscheidet. Belohnt viele Tueren.
 *   mittel  alle Tueren zaehlen. Verlangt, dass die Lektion als GANZE passt.
 *   marge   die eigene beste Tuer MINUS der besten Tuer aller anderen.
 *           Damit wird aus einem Pegel ein Abstand: nicht "wie nah bin ich",
 *           sondern "wie viel naeher als der beste Fremde". Das ist die
 *           kostenlose Fassung der Gegenfragen-Idee — eine Frage aus der Wolke
 *           einer anderen Lektion IST ein Gegenbeispiel fuer diese hier, und
 *           sie liegt bereits eingebettet vor.
 *
 * ── Warum jede Variante ZWEIMAL laeuft ─────────────────────────────────────
 *
 * Die Schwelle 0,5 wurde fuer das MAXIMUM abgetastet. Mittelwerte liegen
 * systematisch niedriger, Margen liegen um null. Dieselbe Schwelle auf alle
 * drei anzuwenden hiesse, eine eingestellte Variante gegen zwei uneingestellte
 * zu messen — und das Ergebnis waere vorhersagbar und wertlos. Deshalb laeuft
 * jede Variante ohne Schwelle, und das Maximum zusaetzlich mit 0,5, damit der
 * heutige Auslieferstand als Bezug sichtbar bleibt.
 *
 * Eine passende Schwelle je Variante zu SUCHEN waere der naechste Schritt —
 * aber nicht auf demselben Fragensatz, auf dem danach gemessen wird.
 *
 * Aufruf:
 *   npx tsx src/bench/tueren-verrechnung.ts [--korpus <k.json>] [--vektoren <v.json>]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke, kosinus } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, quote, type Frage } from './auswertung.js';

interface Korpus { lektionen: Array<{ topic: string }>; fragen: Frage[] }
interface Vektoren {
  volltext: Record<string, string>;
  name: Record<string, string>;
  eingaenge: Record<string, Record<string, string>>;
  fragen: Record<string, string>;
}

/** Produktionswerte — der Messstand muss die Auslieferung spiegeln. */
const POOL = 75;
const SCHWELLE = 0.5;
const GEWICHT = 0.2;

/** Kein Wert. spreizeImTopf macht daraus eine Null. */
const KEIN_WERT = -2;

/**
 * Die Decke ist "ueberhaupt im Topf", nicht "unter den ersten 75".
 *
 * Erster Wurf dieser Datei rechnete sie mit POOL. Das ist falsch: der Topf ist
 * die VEREINIGUNG zweier Listen zu je 75, kann also groesser als 75 werden —
 * und "Platz <= 75" ist dann eine Sortierzahl, keine Decke. Sie schwankte
 * daraufhin zwischen den Varianten, obwohl die Tueren nicht nominieren.
 *
 * Die Gegenprobe steht damit fest: bei richtiger Rechnung MUSS die Spalte in
 * allen Varianten gleich sein. Tut sie es nicht, stimmt die Lesart nicht.
 */
const DECKE = 99999;

async function main(): Promise<void> {
  const arg = (n: string, s?: string): string | undefined => {
    const i = process.argv.indexOf(n);
    return i > -1 ? process.argv[i + 1] : s;
  };
  const hier = dirname(fileURLToPath(import.meta.url));
  const kDatei = arg('--korpus', join(hier, 'korpus', 'korpus.json'))!;
  const vDatei = arg('--vektoren', join(hier, 'korpus', 'korpus-vektoren.json'))!;

  const korpus = JSON.parse(readFileSync(kDatei, 'utf8')) as Korpus;
  const v = JSON.parse(readFileSync(vDatei, 'utf8')) as Vektoren;

  const redis = baueBestand(korpus as never, v as never);
  const vektorbestand = new Vektorbestand();
  const namensbestand = new Vektorbestand(60_000, NAME_VEKTOR_PRAEFIX);
  const eingangsbestand = new Eingangsbestand();
  const seltenheitsbestand = new Seltenheitsbestand();
  await vektorbestand.aktualisiere(redis as never);
  await namensbestand.aktualisiere(redis as never);
  await eingangsbestand.aktualisiere(redis as never);
  await seltenheitsbestand.aktualisiere(redis as never);
  const bestaende = { vektorbestand, namensbestand, eingangsbestand, seltenheitsbestand };

  // Die Tueren einmal entpacken — 2462 Vektoren, sonst je Frage neu.
  const tueren = new Map<string, number[][]>();
  for (const [topic, t] of Object.entries(v.eingaenge ?? {})) {
    const vs: number[][] = [];
    for (const gepackt of Object.values(t)) {
      const x = entpacke(gepackt);
      if (x?.length) vs.push(x);
    }
    if (vs.length) tueren.set(topic, vs);
  }

  const fvVon = (q: Frage): number[] | null => {
    const g = v.fragen[q.query];
    return g ? entpacke(g) : null;
  };

  // Je Frage einmal ALLE Lektionen bewerten — daraus leiten sich alle drei
  // Varianten ab, ohne die Kosinusse dreimal zu rechnen.
  const zwischen = new Map<string, { max: Map<string, number>; mittel: Map<string, number>; besterFremder: number }>();
  const rechne = (fv: number[], schluessel: string): void => {
    if (zwischen.has(schluessel)) return;
    const max = new Map<string, number>();
    const mittel = new Map<string, number>();
    let bester = -2;
    for (const [topic, vs] of tueren) {
      let m = -2; let summe = 0;
      for (const x of vs) { const k = kosinus(fv, x); if (k > m) m = k; summe += k; }
      max.set(topic, m);
      mittel.set(topic, summe / vs.length);
      if (m > bester) bester = m;
    }
    zwischen.set(schluessel, { max, mittel, besterFremder: bester });
  };

  /**
   * Die Marge braucht den besten FREMDEN Wert. Ist die Lektion selbst die
   * beste, waere die Marge gegen sich selbst null — deshalb der zweitbeste.
   */
  const zweitBester = (max: Map<string, number>, ausser: string): number => {
    let a = -2; let b = -2;
    for (const [t, x] of max) {
      if (t === ausser) continue;
      if (x > a) { b = a; a = x; } else if (x > b) b = x;
    }
    return a;
  };

  const varianten: Array<{ name: string; hinweis: string; werte: (fv: number[], topic: string, s: string) => number }> = [
    {
      name: 'ohne Tueren',
      hinweis: 'Kontrolle — das Merkmal ganz aus',
      werte: () => KEIN_WERT,
    },
    {
      name: 'max + Schwelle 0,5',
      hinweis: 'der heutige Auslieferstand',
      werte: (fv, topic, s) => {
        rechne(fv, s);
        const n = zwischen.get(s)!.max.get(topic) ?? KEIN_WERT;
        return n >= SCHWELLE ? n : KEIN_WERT;
      },
    },
    {
      name: 'max ohne Schwelle',
      hinweis: 'zeigt, was die Schwelle allein beitraegt',
      werte: (fv, topic, s) => {
        rechne(fv, s);
        return zwischen.get(s)!.max.get(topic) ?? KEIN_WERT;
      },
    },
    {
      name: 'Mittelwert',
      hinweis: 'die Lektion muss als GANZE passen',
      werte: (fv, topic, s) => {
        rechne(fv, s);
        return zwischen.get(s)!.mittel.get(topic) ?? KEIN_WERT;
      },
    },
    {
      name: 'Marge gegen den Besten',
      hinweis: 'eigene beste Tuer minus beste fremde — Abstand statt Pegel',
      werte: (fv, topic, s) => {
        rechne(fv, s);
        const z = zwischen.get(s)!;
        const eigen = z.max.get(topic);
        if (eigen === undefined) return KEIN_WERT;
        const fremd = eigen >= z.besterFremder ? zweitBester(z.max, topic) : z.besterFremder;
        return eigen - fremd;
      },
    },
  ];

  /**
   * Die Kombination — der einzige Kandidat, den die MESSUNG erzeugt hat.
   *
   * Maximum und Mittelwert ziehen entgegengesetzt: das eine gewinnt @3, das
   * andere Platz 1, auf beiden Fragensaetzen gleichgerichtet. Solange nur ein
   * Zusatzmerkmal ging, musste man sich entscheiden. Jetzt nicht mehr.
   *
   * BEWUSST OHNE EIGENES GEWICHT: der Mittelwert bekommt dieselbe 0,2 wie das
   * Maximum. Ein auf dem Pruefsatz gesuchtes Gewicht waere eine Messung, die
   * sich selbst bestaetigt — genau der Fehler, fuer den am 20.08. eine
   * oeffentliche Korrektur noetig war. Gewinnt die Kombination UNEINGESTELLT,
   * ist das ein Befund; verliert sie, ist ein besseres Gewicht die naechste
   * Frage und braucht einen eigenen Satz.
   */
  const kombiniert = [
    {
      gewicht: GEWICHT,
      werte: (fv: number[], topic: string): number => {
        const s = `${fv[0]}|${fv[1]}|${fv[2]}`;
        rechne(fv, s);
        const n = zwischen.get(s)!.max.get(topic) ?? KEIN_WERT;
        return n >= SCHWELLE ? n : KEIN_WERT;
      },
    },
    {
      gewicht: GEWICHT,
      werte: (fv: number[], topic: string): number => {
        const s = `${fv[0]}|${fv[1]}|${fv[2]}`;
        rechne(fv, s);
        return zwischen.get(s)!.mittel.get(topic) ?? KEIN_WERT;
      },
    },
  ];

  const mitVektor = korpus.fragen.filter((q) => fvVon(q));
  console.log('');
  console.log(`Tueren-Verrechnung · ${korpus.lektionen.length} Lektionen · ${mitVektor.length} Fragen · ${tueren.size} Lektionen mit Tueren`);
  let gesamt = 0;
  for (const vs of tueren.values()) gesamt += vs.length;
  console.log(`Tueren gesamt ${gesamt} · im Schnitt ${(gesamt / Math.max(tueren.size, 1)).toFixed(2)} je Lektion`);
  console.log('──────────────────────────────────────────────────────────────────────────────');
  console.log(`  ${'Verrechnung'.padEnd(24)}${'Platz 1'.padStart(9)}${'@3'.padStart(9)}${'Top 10'.padStart(9)}${'im Topf'.padStart(9)}`);

  const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(9);
  const zeile = async (name: string, merkmal: Parameters<typeof messe>[4]['zusatzMerkmal']): Promise<void> => {
    const m = await messe(redis, mitVektor, fvVon, bestaende, { pool: POOL, zusatzMerkmal: merkmal });
    console.log(`  ${name.padEnd(24)}${p(quote(m.plaetze, 1))}${p(quote(m.plaetze, 3))}${p(quote(m.plaetze, 10))}${p(quote(m.plaetze, DECKE))}`);
  };
  for (const va of varianten) {
    await zeile(va.name, {
      werte: (fv, topic) => va.werte(fv, topic, `${fv[0]}|${fv[1]}|${fv[2]}`),
      gewicht: GEWICHT,
    });
  }
  await zeile('max+Schwelle UND Mittel', kombiniert);
  console.log('──────────────────────────────────────────────────────────────────────────────');
  for (const va of varianten) console.log(`  ${va.name.padEnd(24)}${va.hinweis}`);
  console.log('');
  console.log('  Die Schwelle 0,5 wurde fuer das MAXIMUM abgetastet. Sie auf Mittelwert oder');
  console.log('  Marge anzuwenden waere ein Vergleich zwischen eingestellt und uneingestellt,');
  console.log('  deshalb laufen die beiden ohne. Eine eigene Schwelle je Variante gehoert');
  console.log('  gesucht — aber nicht auf dem Satz, auf dem danach gemessen wird.');
}

main().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
