#!/usr/bin/env node
/**
 * ══ Längenkorrektur der Seltenheitsdeckung — der vorregistrierte Lauf ═════
 *
 * Karte evpcpv1oreo4. Vorregistrierung: VORREGISTRIERUNG-laengenkorrektur.md
 * (Erwartungen standen VOR dem ersten Lauf fest).
 *
 * Der Mechanismus ist bewiesen (verlust-zerlegen.ts): bei den
 * Seltenheits-Verlusten ist der falsche Sieger 663 Zeichen lang, die
 * richtige Antwort 306 — lange Texte decken seltene Fragewörter zufällig
 * ab. Kandidat: BM25-Längennormierung auf der Treffersumme.
 *
 * Der Messstand rechnet die Deckung aus den TEXTEN nach (fremdsatz-teil),
 * prüft sie gegen die gespeicherten Merkmale (Sanity — Erwartung 1) und
 * bewertet dann jede Formel mit dem AUSGELIEFERTEN bewerteTopf.
 *
 * Aufruf:
 *   npx tsx src/bench/laengenkorrektur-messen.ts
 *     [--merkmale <jsonl>]   Vorgabe: merkmale-fremd-A.jsonl (Hälfte A)
 *     [--satz <json>]        Vorgabe: fremdsatz-teil.json
 */

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import {
  bewerteTopf, GEWICHTE, Seltenheit, inhaltsWoerter, grobStamm,
} from '../rangfolge.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; relevant: string[]; topf: Kandidat[] };
type Lektion = { topic: string; what_worked?: string; what_failed?: string };

/** BM25-Längennormierung: teilt die Treffersumme durch den Längenfaktor. */
export function laengenFaktor(w: number, avgW: number, b: number): number {
  return 1 - b + (b * w) / avgW;
}

async function main(): Promise<void> {
  const flag = (n: string, standard: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i === -1 ? standard : process.argv[i + 1];
  };
  const merkmalePfad = flag('merkmale', 'C:/Users/heinr/.cachly/bench-korpus/merkmale-fremd-A.jsonl');
  const satzPfad = flag('satz', 'C:/Users/heinr/.cachly/bench-korpus/fremdsatz-teil.json');
  for (const p of [merkmalePfad, satzPfad]) {
    if (!existsSync(p)) { console.error(`NICHT GEMESSEN: ${p} fehlt.`); process.exit(2); }
  }

  const satz = JSON.parse(readFileSync(satzPfad, 'utf8')) as { lektionen?: Lektion[]; lessons?: Lektion[] };
  const lektionen = satz.lektionen ?? satz.lessons ?? [];
  const volltext = (l: Lektion): string =>
    [l.topic, l.what_worked, l.what_failed].filter(Boolean).join(' ');
  const seltenheit = new Seltenheit(lektionen.map(volltext));
  const textWoerter = new Map(lektionen.map(
    (l) => [l.topic, new Set([...inhaltsWoerter(volltext(l))].map(grobStamm))] as const,
  ));
  const avgW = [...textWoerter.values()].reduce((a, s) => a + s.size, 0) / textWoerter.size;
  console.log(`${lektionen.length} Lektionen · mittlere Wortzahl ${avgW.toFixed(1)} Staemme`);

  const zeilen: Zeile[] = [];
  const rl = createInterface({ input: createReadStream(merkmalePfad) });
  for await (const z of rl) {
    if (!z.trim()) continue;
    try { zeilen.push(JSON.parse(z) as Zeile); } catch { /* kaputte Zeile */ }
  }

  // ── Sanity (Erwartung 1): nachgerechnete Deckung == gespeicherte ────────
  let maxAbweichung = 0;
  let geprueft = 0;
  for (const z of zeilen) {
    const fw = inhaltsWoerter(z.query);
    for (const k of z.topf) {
      const tw = textWoerter.get(k.t);
      if (!tw) continue;
      const neu = seltenheit.deckung(fw, tw);
      const d = Math.abs(neu - k.sD);
      if (d > maxAbweichung) maxAbweichung = d;
      geprueft++;
    }
  }
  console.log(`Sanity: ${geprueft} Deckungen nachgerechnet, groesste Abweichung ${maxAbweichung.toFixed(5)}`);
  if (maxAbweichung >= 0.001) {
    console.error('NICHT GEMESSEN: die Nachrechnung weicht ab — der Messstand rechnet eine andere Deckung als die gespeicherte. Erwartung 1 der Vorregistrierung verletzt; es wird NICHTS gefolgert.');
    process.exit(3);
  }

  // ── Formel-Kandidaten bewerten ──────────────────────────────────────────
  // --nur <b>: fuer den EINEN Bestaetigungslauf auf Haelfte B laeuft nur
  // die Kontrolle und das gewaehlte b — wer dort das ganze Raster faehrt,
  // hat B als zweite Einstellhaelfte benutzt.
  const nur = flag('nur', '');
  const alle: Array<{ name: string; b: number | null }> = [
    { name: 'F0 heute', b: null },
    { name: 'b=0.25', b: 0.25 },
    { name: 'b=0.50', b: 0.5 },
    { name: 'b=0.75', b: 0.75 },
    { name: 'b=1.00', b: 1.0 },
  ];
  const formeln = nur
    ? alle.filter((f) => f.b === null || String(f.b) === nur)
    : alle;

  console.log('\n  Formel     P@1      @3       Seltenheits-Verluste');
  for (const f of formeln) {
    let p1 = 0; let p3 = 0; let seltenheitsVerluste = 0;
    for (const z of zeilen) {
      if (!z.topf?.length || !z.relevant?.length) continue;
      const fw = inhaltsWoerter(z.query);
      const bewertbar = z.topf.map((k) => {
        let sD = k.sD;
        if (f.b !== null) {
          const tw = textWoerter.get(k.t);
          const w = tw?.size ?? avgW;
          sD = k.sD / laengenFaktor(w, avgW, f.b);
        }
        return {
          naeheText: k.nT, naeheThema: k.nTh, naeheRueckkopplung: k.nR,
          seltenheitsDeckung: sD, besterZeuge: k.bE,
        };
      });
      void fw;
      const punkte = bewerteTopf(bewertbar, GEWICHTE);
      const geordnet = z.topf.map((k, i) => ({ t: k.t, p: punkte[i] })).sort((a, b) => b.p - a.p);
      const relevant = new Set(z.relevant);
      const platz = geordnet.findIndex((x) => relevant.has(x.t)) + 1;
      if (platz === 1) p1++;
      if (platz >= 1 && platz <= 3) p3++;

      // Zaehlt wie verlust-zerlegen: verloren UND schuldig=seltenheit —
      // hier vereinfacht als "verloren und Platz-1-Text laenger als 1,5x
      // der richtigen Antwort waere zirkulaer; stattdessen zaehlen wir ALLE
      // Verluste und weisen die Formel daran, @3 zu heben. Die praezise
      // Schuldigen-Zaehlung liefert verlust-zerlegen nach dem Lauf.
      if (platz > 3) seltenheitsVerluste++;
    }
    const n = zeilen.length;
    console.log(`  ${f.name.padEnd(9)} ${(100 * p1 / n).toFixed(1)} %   ${(100 * p3 / n).toFixed(1)} %   ${seltenheitsVerluste} verloren gesamt`);
  }

  console.log(`
LESEHILFE UND REGEL (Vorregistrierung): Erwartung 2 verlangt @3 +0,5 Punkte
bei mindestens einem b, Erwartung 3 hoechstens −0,5 auf P@1. Die praezise
Zaehlung der Seltenheits-Verluste (Erwartung 4, −20 %) laeuft danach ueber
verlust-zerlegen.ts mit einer --formel-Variante. Das gewaehlte b wird auf
Haelfte B GENAU EINMAL bestaetigt, erst dann Produktvorgabe.`);
}

// Nur beim direkten Aufruf laufen — laengenFaktor wird importiert
// (Fehlerklasse aus PR #539: main() beim Import beendete den Testprozess).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
