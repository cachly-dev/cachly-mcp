#!/usr/bin/env node
/**
 * ══ Der dritte Ausgang der Suche: Wann lohnt Ablehnen? ════════════════════
 *
 * ── Woher die Frage kommt (30.08.2026, Karte 0c5ln9soc5xm) ────────────────
 *
 * Fellegi und Sunter (1969): drei Ausgänge, nicht zwei — und der mittlere
 * ist ein Ergebnis, kein Fehler. Thomas Hansens Prüfer lebt vom selben
 * Prinzip: er LEHNT AB, statt Schwaches zurückzugeben (20 % Ablehnungsquote,
 * +10 Punkte auf seinen Evals).
 *
 * Unsere Suche antwortet heute IMMER. Die Irrtumsquote von 100 % unter
 * Belastung hat genau diese Wurzel: das System kennt kein „nichts
 * qualifiziert sich".
 *
 * ── Was hier gemessen wird ────────────────────────────────────────────────
 *
 * Die Risiko-Deckungs-Kurve auf der EINSTELLHÄLFTE (merkmale-fremd-A.jsonl,
 * 1999 echte Fragen): für jede Ablehnschwelle —
 *
 *   DECKUNG   welcher Anteil der Fragen wird noch beantwortet?
 *   PRÄZISION wie oft stimmt Platz 1 unter den BEANTWORTETEN?
 *   GERETTET  wie viele falsche Antworten werden abgelehnt?
 *   VERLOREN  wie viele richtige werden mit abgelehnt?
 *
 * Ein Ablehnen lohnt nur, wenn es überwiegend Falsche trifft. Lehnt es
 * gleich viele Richtige ab, ist es Feigheit, keine Ehrlichkeit.
 *
 * ── Warum offline aus den Merkmals-Auszügen ───────────────────────────────
 *
 * Die Auszüge tragen die fünf Merkmale je Kandidat, und `bewerteTopf` mit
 * den Auslieferungs-GEWICHTEN rechnet daraus dieselben Punkte wie das
 * Produkt. Ein voller Suchlauf kostet Minuten; diese Rechnung Sekunden —
 * und sie misst dieselbe Pipeline, keine nachgebaute.
 *
 * ── Die Regel dahinter ────────────────────────────────────────────────────
 *
 * Gemessen wird NUR auf Hälfte A. Die Schwelle, die hier gewählt wird, ist
 * eine Kandidatin — bestätigt wird sie auf Hälfte B, genau einmal.
 *
 * Aufruf:  npx tsx src/bench/dritter-ausgang-messen.ts [--datei <jsonl>]
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { bewerteTopf, GEWICHTE } from '../rangfolge.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; relevant: string[]; topf: Kandidat[] };

export type FrageErgebnis = {
  /** Punktabstand zwischen Platz 1 und Platz 2 — das Vertrauenssignal. */
  abstand: number;
  /** Punkte von Platz 1. */
  spitze: number;
  richtig: boolean;
};

/**
 * Eine Frage bewerten — mit der AUSGELIEFERTEN Sortierung.
 *
 * Der Abstand zwischen Platz 1 und 2 ist das Vertrauenssignal: ein knapper
 * Sieg ist ein Ratespiel, ein deutlicher eine Aussage. Beide Punkte kommen
 * aus derselben Topf-Spreizung wie im Produkt.
 */
export function bewerteFrage(z: Zeile): FrageErgebnis | null {
  if (!z.topf || z.topf.length === 0) return null;
  const bewertbar = z.topf.map((k) => ({
    naeheText: k.nT,
    naeheThema: k.nTh,
    naeheRueckkopplung: k.nR,
    seltenheitsDeckung: k.sD,
    besterZeuge: k.bE,
  }));
  const punkte = bewerteTopf(bewertbar, GEWICHTE);
  const geordnet = z.topf
    .map((k, i) => ({ t: k.t, p: punkte[i] }))
    .sort((a, b) => b.p - a.p);
  const spitze = geordnet[0];
  const zweiter = geordnet[1];
  return {
    abstand: zweiter ? spitze.p - zweiter.p : spitze.p,
    spitze: spitze.p,
    richtig: z.relevant.includes(spitze.t),
  };
}

/** Ein Punkt der Risiko-Deckungs-Kurve. */
export function kurvenPunkt(
  ergebnisse: readonly FrageErgebnis[],
  schwelle: number,
): { deckung: number; praezision: number; gerettet: number; verloren: number } {
  const beantwortet = ergebnisse.filter((e) => e.abstand >= schwelle);
  const abgelehnt = ergebnisse.filter((e) => e.abstand < schwelle);
  const richtigBeantwortet = beantwortet.filter((e) => e.richtig).length;
  return {
    deckung: ergebnisse.length ? beantwortet.length / ergebnisse.length : 0,
    praezision: beantwortet.length ? richtigBeantwortet / beantwortet.length : 0,
    gerettet: abgelehnt.filter((e) => !e.richtig).length,
    verloren: abgelehnt.filter((e) => e.richtig).length,
  };
}

async function main(): Promise<void> {
  const flag = (n: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const datei = flag('datei') ?? 'C:/Users/heinr/.cachly/bench-korpus/merkmale-fremd-A.jsonl';
  if (!existsSync(datei)) {
    console.error(`NICHT GEMESSEN: ${datei} gibt es nicht.`);
    process.exit(2);
  }

  const ergebnisse: FrageErgebnis[] = [];
  const rl = createInterface({ input: createReadStream(datei) });
  for await (const zeile of rl) {
    if (!zeile.trim()) continue;
    let z: Zeile;
    try { z = JSON.parse(zeile) as Zeile; } catch { continue; }
    const e = bewerteFrage(z);
    if (e) ergebnisse.push(e);
  }

  if (ergebnisse.length === 0) {
    console.error('NICHT GEMESSEN: keine auswertbaren Zeilen.');
    process.exit(2);
  }

  const basis = kurvenPunkt(ergebnisse, -Infinity);
  const pct = (x: number) => `${(100 * x).toFixed(1)} %`;

  // Der Name kommt aus der Datei — die erste Fassung schrieb stur
  // „Haelfte A", auch beim B-Lauf. Eine Beschriftung, die nicht aus den
  // Daten kommt, ist eine kleine zweite Wahrheit.
  const haelfte = datei.includes('-B') ? 'Pruefhaelfte B' : datei.includes('-A') ? 'Einstellhaelfte A' : datei;
  console.log(`\n${ergebnisse.length} Fragen (${haelfte}).`);
  console.log(`Ohne Ablehnen: P@1 ${pct(basis.praezision)} bei Deckung 100 %.\n`);
  console.log('  Schwelle   Deckung   P@1 (beantwortet)   abgelehnt falsch/richtig');

  // Die Schwellen tasten den beobachteten Abstandsbereich ab.
  const abstaende = ergebnisse.map((e) => e.abstand).sort((a, b) => a - b);
  const kandidaten = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0];
  for (const s of kandidaten) {
    const k = kurvenPunkt(ergebnisse, s);
    console.log(
      `  ${s.toFixed(2).padStart(8)}${pct(k.deckung).padStart(10)}${pct(k.praezision).padStart(15)}` +
      `${String(k.gerettet).padStart(14)} / ${k.verloren}`,
    );
  }

  const median = abstaende[Math.floor(abstaende.length / 2)];
  console.log(`\n  (Abstand Platz 1 zu 2: Median ${median.toFixed(3)}, groesster ${abstaende[abstaende.length - 1].toFixed(3)})`);

  console.log(`
LESEHILFE: Ablehnen lohnt nur, wo die Spalte "abgelehnt falsch" die Spalte
"richtig" DEUTLICH schlaegt. Lehnt eine Schwelle gleich viele Richtige ab,
ist sie Feigheit, keine Ehrlichkeit.

Fuer den Nutzer heisst eine Ablehnung nicht Schweigen, sondern den ehrlichen
Satz: "nichts im Bestand passt gut genug — das Naechstliegende waere X."
Fellegi und Sunter (1969): der mittlere Ausgang ist ein ERGEBNIS.

DIE REGEL: diese Zahlen kommen von Haelfte A. Eine hier gewaehlte Schwelle
ist eine Kandidatin — bestaetigt wird sie auf Haelfte B, genau einmal.`);
}

main().catch((e) => {
  console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
