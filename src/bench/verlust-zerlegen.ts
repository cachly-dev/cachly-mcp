#!/usr/bin/env node
/**
 * ══ Die verlorenen Antworten zerlegen: WO und WORAN sterben sie? ══════════
 *
 * ── Der Befund, der diesen Messstand verlangt (30.08.2026) ────────────────
 *
 * Drei vorregistrierte Laeufe endeten am selben Punkt: die Decke der
 * Vorauswahl liegt bei 79 %, gezeigt werden 52 % — **1089 von 4000
 * richtigen Antworten liegen im Topf und werden nicht gezeigt.** Der
 * Engpass ist die SORTIERUNG. Aber "die Sortierung ist schuld" ist noch
 * keine Baustelle. Dieses Werkzeug macht daraus zwei beantwortbare Fragen:
 *
 *   WO   sterben sie? (Platz 4-5? 6-10? tiefer?) — knapp verloren heisst
 *        ein anderer Hebel als weit verloren.
 *   WORAN sterben sie? Je verlorener Antwort: welches Merkmal traegt den
 *        groessten Punktrueckstand gegen den gezeigten Platz 1?
 *
 * ── Datengrundlage ────────────────────────────────────────────────────────
 *
 * Die Merkmals-Auszuege der EINSTELLHAELFTE (merkmale-fremd-A.jsonl):
 * je Frage der volle Topf mit den fuenf Merkmalen je Kandidat. Punkte
 * werden mit dem AUSGELIEFERTEN bewerteTopf + GEWICHTE gerechnet — es ist
 * dieselbe Pipeline wie im A/B-Lauf, keine nachgebaute.
 *
 * DIE REGEL: nur Haelfte A. Was hier gefunden wird, ist eine Hypothese;
 * ein daraus gebauter Umbau wird auf A eingestellt und auf B genau EINMAL
 * bestaetigt.
 *
 * Aufruf:  npx tsx src/bench/verlust-zerlegen.ts [--datei <jsonl>]
 *
 * ── ERSTER LAUF (30.08.2026, Haelfte A: 1999 Fragen, 624 verloren) ────────
 *
 *   WO:    16 % Platz 4-5 · 25 % Platz 6-10 · 22 % Platz 11-25 · 36 % tiefer
 *   WORAN: text 60 % (mittl. Rueckstand 0,28) · seltenheit 39 % (0,59!)
 *          zeuge und rueckkopplung je ~0 %.
 *
 * Und die Nachmessung mit Kontrollgruppe: bei den SELTENHEITS-Verlusten ist
 * der falsche Sieger im Median 663 Zeichen lang, die richtige Antwort 306 —
 * mehr als doppelt. Bei den TEXT-Verlusten: 421 gegen 444, KEIN Effekt.
 * Die Laengenverzerrung der Deckung ist damit belegt und spezifisch: lange
 * Texte decken seltene Fragewoerter zufaellig ab, und das hoechste Gewicht
 * (1,3) belohnt genau das. Folgekarte: Laengenkorrektur der Deckung,
 * eingestellt auf A, bestaetigt auf B.
 */

import { createReadStream, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { bewerteTopf, spreizeImTopf, GEWICHTE } from '../rangfolge.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; relevant: string[]; topf: Kandidat[] };

/** Die Merkmalsbeitraege eines Kandidaten, wie bewerteTopf sie addiert. */
export function beitraege(topf: Kandidat[]): Map<string, Record<string, number>> {
  const t = spreizeImTopf(topf.map((k) => k.nT));
  const th = spreizeImTopf(topf.map((k) => k.nTh));
  const r = spreizeImTopf(topf.map((k) => k.nR));
  const s = spreizeImTopf(topf.map((k) => k.sD));
  const b = spreizeImTopf(topf.map((k) => k.bE));
  const raus = new Map<string, Record<string, number>>();
  for (const [i, k] of topf.entries()) {
    raus.set(k.t, {
      text: GEWICHTE.text * t[i],
      thema: GEWICHTE.thema * th[i],
      rueckkopplung: GEWICHTE.rueckkopplung * r[i],
      seltenheit: GEWICHTE.seltenheit * s[i],
      zeuge: GEWICHTE.zeuge * b[i],
    });
  }
  return raus;
}

export type Verlust = {
  /** Platz der besten richtigen Antwort (1-basiert). */
  platz: number;
  /** Punktrueckstand der besten richtigen Antwort auf Platz 1. */
  rueckstand: number;
  /** Das Merkmal mit dem groessten Beitrags-Rueckstand gegen Platz 1. */
  schuldig: string;
  /** Wie viel dieses Merkmal allein am Rueckstand traegt. */
  anteil: number;
};

/** Zerlegt EINE Frage. null, wenn sie nicht "verloren" ist (siehe Kopf). */
export function zerlegeFrage(z: Zeile, abKlasse = 3): Verlust | null {
  if (!z.topf?.length || !z.relevant?.length) return null;
  const punkte = bewerteTopf(
    z.topf.map((k) => ({
      naeheText: k.nT, naeheThema: k.nTh, naeheRueckkopplung: k.nR,
      seltenheitsDeckung: k.sD, besterZeuge: k.bE,
    })),
    GEWICHTE,
  );
  const geordnet = z.topf
    .map((k, i) => ({ t: k.t, p: punkte[i] }))
    .sort((a, b) => b.p - a.p);
  const relevant = new Set(z.relevant);
  const platz = geordnet.findIndex((x) => relevant.has(x.t)) + 1;
  if (platz === 0 || platz <= abKlasse) return null; // nicht im Topf oder gut genug

  const beste = geordnet[platz - 1];
  const spitze = geordnet[0];
  const beitrag = beitraege(z.topf);
  const bBeste = beitrag.get(beste.t)!;
  const bSpitze = beitrag.get(spitze.t)!;
  let schuldig = 'text';
  let groesster = -Infinity;
  for (const merkmal of Object.keys(bBeste)) {
    const defizit = bSpitze[merkmal] - bBeste[merkmal];
    if (defizit > groesster) { groesster = defizit; schuldig = merkmal; }
  }
  return {
    platz,
    rueckstand: spitze.p - beste.p,
    schuldig,
    anteil: groesster,
  };
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--datei');
  const datei = i > -1
    ? process.argv[i + 1]
    : 'C:/Users/heinr/.cachly/bench-korpus/merkmale-fremd-A.jsonl';
  if (!existsSync(datei)) {
    console.error(`NICHT GEMESSEN: ${datei} gibt es nicht.`);
    process.exit(2);
  }

  const verluste: Verlust[] = [];
  let fragen = 0;
  const rl = createInterface({ input: createReadStream(datei) });
  for await (const zeile of rl) {
    if (!zeile.trim()) continue;
    let z: Zeile;
    try { z = JSON.parse(zeile) as Zeile; } catch { continue; }
    fragen++;
    const v = zerlegeFrage(z);
    if (v) verluste.push(v);
  }

  if (verluste.length === 0) {
    console.error('NICHT GEMESSEN: keine verlorene Antwort gefunden — Muster kaputt?');
    process.exit(2);
  }

  const haelfte = datei.includes('-B') ? 'Pruefhaelfte B' : datei.includes('-A') ? 'Einstellhaelfte A' : datei;
  console.log(`\n${fragen} Fragen (${haelfte}), davon ${verluste.length} VERLOREN`);
  console.log('(richtige Antwort im Topf, aber jenseits von Platz 3).\n');

  console.log('WO sie sterben:');
  const klassen: Array<[string, (p: number) => boolean]> = [
    ['Platz 4-5   (knapp)', (p) => p <= 5],
    ['Platz 6-10', (p) => p > 5 && p <= 10],
    ['Platz 11-25', (p) => p > 10 && p <= 25],
    ['tiefer', (p) => p > 25],
  ];
  for (const [name, passt] of klassen) {
    const n = verluste.filter((v) => passt(v.platz)).length;
    console.log(`  ${name.padEnd(22)} ${String(n).padStart(5)}  (${Math.round((100 * n) / verluste.length)} %)`);
  }

  console.log('\nWORAN sie sterben (Merkmal mit dem groessten Beitrags-Rueckstand):');
  const jeMerkmal = new Map<string, { n: number; summe: number }>();
  for (const v of verluste) {
    const e = jeMerkmal.get(v.schuldig) ?? { n: 0, summe: 0 };
    e.n++; e.summe += v.anteil;
    jeMerkmal.set(v.schuldig, e);
  }
  for (const [merkmal, e] of [...jeMerkmal.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${merkmal.padEnd(14)} ${String(e.n).padStart(5)}  (${Math.round((100 * e.n) / verluste.length)} %)  mittlerer Rueckstand ${(e.summe / e.n).toFixed(2)}`);
  }

  const median = verluste.map((v) => v.rueckstand).sort((a, b) => a - b)[Math.floor(verluste.length / 2)];
  console.log(`\nPunktrueckstand auf Platz 1: Median ${median.toFixed(2)}`);

  console.log(`
LESEHILFE: "schuldig" ist das Merkmal, bei dem die richtige Antwort am
meisten gegen den gezeigten Platz 1 verliert. Dominiert EIN Merkmal, ist
das die Baustelle. Verteilt es sich, ist die Sortierung nicht an einer
Schraube krank — dann braucht es ein NEUES Signal, keine Gewichtsdreherei
(die Gewichts-Zerlegung vom 29.08. hat genau das schon gezeigt).

DIE REGEL: Haelfte A. Ein Umbau aus diesem Befund wird auf A eingestellt
und auf B genau EINMAL bestaetigt.`);
}

// Nur beim direkten Aufruf laufen — beitraege/zerlegeFrage werden von
// anderen Messstaenden importiert (Fehlerklasse aus PR #539: main() beim
// Import beendete den Testprozess mit exit 2).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
