/**
 * Wie stark darf der Mittelwert ueber die Tueren mitsortieren?
 *
 * ── Warum es diese Datei gibt ───────────────────────────────────────────────
 *
 * Am 21.08.2026 hat der Naturworkshop einen Kandidaten hervorgebracht, den
 * niemand vorgeschlagen hatte. Der Vorschlag am Tisch lautete "Mittelwert
 * STATT Maximum" und starb noch am selben Tag an seiner eigenen Widerlegung
 * (55 und 62 Prozent Findequote@3 gegen die geforderten 65).
 *
 * Die Messung zeigte aber etwas anderes: Maximum und Mittelwert ziehen
 * ENTGEGENGESETZT. Das Maximum gewinnt auf @3, der Mittelwert auf Platz 1 —
 * gleichgerichtet auf zwei unabhaengigen Fragensaetzen. Sie messen
 * Verschiedenes: das Maximum die naechste Tuer, der Mittelwert die Passung der
 * ganzen Lektion. Nebeneinander waren sie 4 Punkte wert.
 *
 * Diese 4 Punkte sind mit UNGEPRUEFTEM Gewicht entstanden. Sein Vorgaenger,
 * EINGANG_SORTIER_GEWICHT, wurde abgetastet und mittig in sein Band gelegt —
 * genau deshalb hat er gehalten. Dasselbe bekommt der Mittelwert hier, bevor
 * er in den Recall-Pfad darf.
 *
 * ── Was FEST bleibt ─────────────────────────────────────────────────────────
 *
 * Der Maximum-Term steht auf den ausgelieferten Werten (Schwelle 0,5, Gewicht
 * 0,2) und wird nicht angefasst. Eine Aenderung je Lauf, sonst misst man zwei
 * Dinge auf einmal und weiss am Ende von keinem, was er getan hat.
 *
 * ── Die Spalten "besser" und "schlechter" ───────────────────────────────────
 *
 * Sie sind der eigentliche Grund, warum diese Datei mehr ausgibt als eine
 * Prozentzahl. Bei 100 Fragen sind 4 Punkte genau 4 Fragen. Ob dahinter "4
 * gewonnen, 0 verloren" steht oder "22 gewonnen, 18 verloren", ist derselbe
 * Zahlenunterschied und ein voellig anderer Befund — im zweiten Fall wackelt
 * das Ergebnis nur, im ersten bewegt es sich.
 *
 * Der README des Naturworkshops nennt genau diese Luecke: keine der acht
 * Rollen fragt, ob ein Effekt vom Rauschen zu trennen ist.
 *
 * Aufruf:
 *   npx tsx src/bench/mittel-gewicht-abtasten.ts [--korpus <k.json>] [--vektoren <v.json>]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { baueBestand } from './echter-korpus.js';
import { Vektorbestand, NAME_VEKTOR_PRAEFIX, entpacke, kosinus } from '../bedeutung.js';
import { Eingangsbestand } from '../eingaenge.js';
import { Seltenheitsbestand } from '../seltenheitsbestand.js';
import { messe, quote, type Frage } from './auswertung.js';
import { SINN_TOPF } from '../rangfolge-stellschrauben.js';

interface Korpus { lektionen: Array<{ topic: string }>; fragen: Frage[] }
interface Vektoren {
  volltext: Record<string, string>;
  name: Record<string, string>;
  eingaenge: Record<string, Record<string, string>>;
  fragen: Record<string, string>;
}

/** Produktionswerte — der Messstand muss die Auslieferung spiegeln. */
const POOL = SINN_TOPF;
const SCHWELLE = 0.5;
const MAX_GEWICHT = 0.2;

/** Kein Wert. spreizeImTopf macht daraus eine Null. */
const KEIN_WERT = -2;

/** "Ueberhaupt im Topf", nicht "unter den ersten 75" — siehe tueren-verrechnung.ts. */
const DECKE = 99999;

/**
 * Das abzutastende Band.
 *
 * Es beginnt bei 0 (= der heutige Auslieferstand, die Kontrolle) und reicht
 * bis 0,6. Weiter oben braucht es nicht zu gehen: schon der Maximum-Term
 * brach bei 0,5 auf der Findequote ein, weil ein zu schweres Merkmal Treffer
 * von Platz 2 und 3 wegdraengt, um einen auf Platz 1 zu heben.
 */
const GEWICHTE = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6];

/** Platz 0 heisst "gar nicht gefunden" — beim Vergleichen das schlechteste Los. */
const rang = (p: number): number => (p > 0 ? p : Number.POSITIVE_INFINITY);

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

  // Die Tueren einmal entpacken, sonst je Frage neu.
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

  // Je Frage einmal alle Kosinusse rechnen, beide Verrechnungen daraus ziehen.
  const zwischen = new Map<string, { max: Map<string, number>; mittel: Map<string, number> }>();
  const rechne = (fv: number[], schluessel: string): void => {
    if (zwischen.has(schluessel)) return;
    const max = new Map<string, number>();
    const mittel = new Map<string, number>();
    for (const [topic, vs] of tueren) {
      let m = -2; let summe = 0;
      for (const x of vs) { const k = kosinus(fv, x); if (k > m) m = k; summe += k; }
      max.set(topic, m);
      mittel.set(topic, summe / vs.length);
    }
    zwischen.set(schluessel, { max, mittel });
  };
  const schluesselVon = (fv: number[]): string => `${fv[0]}|${fv[1]}|${fv[2]}`;

  /** Der ausgelieferte Maximum-Term. Fest. */
  const maxTerm = {
    werte: (fv: number[], topic: string): number => {
      const s = schluesselVon(fv);
      rechne(fv, s);
      const n = zwischen.get(s)!.max.get(topic) ?? KEIN_WERT;
      return n >= SCHWELLE ? n : KEIN_WERT;
    },
    gewicht: MAX_GEWICHT,
  };

  /**
   * Der Mittelwert-Term — OHNE Schwelle.
   *
   * Die 0,5 wurde fuer das Maximum abgetastet. Ein Mittelwert liegt
   * naturgemaess darunter; dieselbe Schwelle daraufzusetzen wuerde fast alles
   * auf "kein Wert" druecken und das Merkmal still abschalten. Bei
   * vollstaendiger Impfung traegt ohnehin jede Lektion Tueren, es gibt also
   * keine Gruppe, die durch das Fehlen benachteiligt wuerde.
   */
  /**
   * Womit eine Lektion OHNE Tueren in die Rechnung geht.
   *
   *   null    KEIN_WERT (-2). spreizeImTopf macht daraus eine 0 — und das ist
   *           der schlechteste Platz im gespreizten Band, nicht "kein Wert".
   *           Die Lektion ohne Tuer wird also bestraft, obwohl ueber sie gar
   *           nichts bekannt ist.
   *   median  Der Mittelwert der Lektion wird durch den MITTLEREN Wert aller
   *           Lektionen mit Tueren ersetzt. Sie landet damit mittig statt ganz
   *           unten: unbekannt heisst weder gut noch schlecht.
   *
   * Der Unterschied ist der ganze Zweck dieser Option. Faellt das Merkmal bei
   * 78 Prozent Abdeckung durch, gibt es zwei moegliche Gruende — das Merkmal
   * taugt nicht, oder die Behandlung des Fehlenden taugt nicht. Ohne diese
   * Trennung raet man.
   */
  const fehlendModus = (arg('--fehlend', 'null') ?? 'null') as 'null' | 'median';

  const mittelwertDerGueltigen = new Map<string, number>();
  const neutralerWert = (s: string): number => {
    const da = mittelwertDerGueltigen.get(s);
    if (da !== undefined) return da;
    const alle = [...zwischen.get(s)!.mittel.values()].sort((a, b) => a - b);
    const m = alle.length ? alle[Math.floor(alle.length / 2)] : KEIN_WERT;
    mittelwertDerGueltigen.set(s, m);
    return m;
  };

  const mittelTerm = (gewicht: number): { werte: (fv: number[], topic: string) => number; gewicht: number } => ({
    werte: (fv: number[], topic: string): number => {
      const s = schluesselVon(fv);
      rechne(fv, s);
      const w = zwischen.get(s)!.mittel.get(topic);
      if (w !== undefined) return w;
      return fehlendModus === 'median' ? neutralerWert(s) : KEIN_WERT;
    },
    gewicht,
  });

  const mitVektor = korpus.fragen.filter((q) => fvVon(q));
  let gesamt = 0;
  for (const vs of tueren.values()) gesamt += vs.length;
  const abdeckung = (tueren.size / Math.max(korpus.lektionen.length, 1)) * 100;

  console.log('');
  console.log(`Mittelwert-Gewicht abtasten · ${korpus.lektionen.length} Lektionen · ${mitVektor.length} Fragen`);
  console.log(`Tueren ${gesamt} auf ${tueren.size} Lektionen · Abdeckung ${abdeckung.toFixed(1)} %`);
  console.log(`FEST: Maximum mit Schwelle ${SCHWELLE} und Gewicht ${MAX_GEWICHT} (Auslieferstand)`);
  console.log(`Lektion ohne Tuer zaehlt als: ${fehlendModus === "median" ? "MITTIG (neutral)" : "kein Wert -> 0, also schlechtester Platz"}`);
  console.log('─'.repeat(88));
  console.log(`  ${'Mittel-Gewicht'.padEnd(16)}${'Platz 1'.padStart(9)}${'@3'.padStart(9)}${'Top 10'.padStart(9)}${'im Topf'.padStart(9)}${'besser'.padStart(9)}${'schlechter'.padStart(11)}`);

  const p = (x: number): string => `${(x * 100).toFixed(1)} %`.padStart(9);
  let grundlinie: number[] = [];

  for (const g of GEWICHTE) {
    const istKontrolle = g === 0;
    const merkmale = istKontrolle ? [maxTerm] : [maxTerm, mittelTerm(g)];
    const m = await messe(redis, mitVektor, fvVon, bestaende, { pool: POOL, zusatzMerkmal: merkmale });

    let vgl = `${'—'.padStart(9)}${'—'.padStart(11)}`;
    if (istKontrolle) {
      grundlinie = m.plaetze;
    } else {
      let besser = 0; let schlechter = 0;
      for (const [i, platz] of m.plaetze.entries()) {
        const a = rang(grundlinie[i]); const b = rang(platz);
        if (b < a) besser++; else if (b > a) schlechter++;
      }
      vgl = `${String(besser).padStart(9)}${String(schlechter).padStart(11)}`;
    }

    const name = istKontrolle ? '0 (Kontrolle)' : String(g).replace('.', ',');
    console.log(`  ${name.padEnd(16)}${p(quote(m.plaetze, 1))}${p(quote(m.plaetze, 3))}${p(quote(m.plaetze, 10))}${p(quote(m.plaetze, DECKE))}${vgl}`);
  }

  console.log('─'.repeat(88));
  console.log('  "besser"/"schlechter" zaehlen FRAGEN gegen die Kontrolle, nicht Prozentpunkte.');
  console.log('  4 Punkte aus "4 besser, 0 schlechter" sind eine Bewegung. Dieselben 4 Punkte aus');
  console.log('  "22 besser, 18 schlechter" sind ein Wackeln — gleiche Zahl, anderer Befund.');
  console.log('');
  console.log('  Die Spalte "im Topf" MUSS ueber alle Zeilen gleich sein: die Tueren nominieren');
  console.log('  nicht, sie sortieren nur. Schwankt sie, stimmt die Messung nicht.');
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
