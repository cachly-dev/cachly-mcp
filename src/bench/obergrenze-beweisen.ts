#!/usr/bin/env node
/**
 * ══ Die Obergrenze der Gewichtung — bewiesen, nicht gesucht ═══════════════
 *
 * ── Der Auftrag (Karte g0si2vjfhdob, Heinrich 26.08.2026) ─────────────────
 *
 * "Wir suchen seit Wochen bessere GEWICHTE. Niemand hat gemessen, wie viel
 * mit DIESEN MerkmALEN überhaupt maximal drin ist." Genau das steht hier:
 * die Schranke, über die KEINE Gewichtung hinauskommt.
 *
 * ── Das Argument (Dominanz statt Brute-Force) ─────────────────────────────
 *
 * Der Sortierer ist eine Linearkombination mit nichtnegativen Gewichten
 * über den fünf (topf-gespreizten) Merkmalen. Für jede solche Gewichtung
 * gilt: wer einen Kandidaten in ALLEN Merkmalen erreicht und in einem
 * übertrifft (DOMINIERT), steht bei JEDER Gewichtung über ihm.
 *
 *   Platz 1 erreichbar  ⇒ die richtige Antwort hat KEINEN Dominator.
 *   Top 3 erreichbar    ⇒ sie hat höchstens ZWEI Dominatoren.
 *
 * Beide Bedingungen sind NOTWENDIG. Die Zählung ist damit eine ECHTE
 * OBERGRENZE — großzügig gerechnet: je Frage darf eine eigene Gewichtung
 * gewählt werden. Was eine EINZIGE, gemeinsame Gewichtung erreicht, liegt
 * noch einmal darunter. Wer die Obergrenze niedrig findet, hat bewiesen,
 * dass der Engpass die MERKMALE sind, nicht die Gewichte.
 *
 * Spreizen ändert je Merkmal nur die Skala, nie die Ordnung — Dominanz auf
 * den Rohwerten und auf den gespreizten Werten ist dieselbe. Gerechnet
 * wird auf den Rohwerten der Auszüge.
 *
 * DIE REGEL: Hälfte A. Die Schranke ist eine Analyse, keine Einstellung —
 * aber sie bleibt auf derselben Hälfte wie alle Analysen.
 *
 * Aufruf:  npx tsx src/bench/obergrenze-beweisen.ts [--datei <jsonl>]
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number };
type Zeile = { query: string; relevant: string[]; topf: Kandidat[] };

const MERKMALE = ['nT', 'nTh', 'nR', 'sD', 'bE'] as const;

/** a dominiert b: in allen Merkmalen >= und in mindestens einem >. */
export function dominiert(a: Kandidat, b: Kandidat): boolean {
  let strikt = false;
  for (const m of MERKMALE) {
    if (a[m] < b[m]) return false;
    if (a[m] > b[m]) strikt = true;
  }
  return strikt;
}

/** Die wenigsten Dominatoren unter den richtigen Antworten einer Frage. */
export function wenigsteDominatoren(z: Zeile): number | null {
  if (!z.topf?.length || !z.relevant?.length) return null;
  const relevant = new Set(z.relevant);
  const richtige = z.topf.filter((k) => relevant.has(k.t));
  if (richtige.length === 0) return null; // nicht im Topf — keine Gewichtung hilft
  let bestes = Infinity;
  for (const r of richtige) {
    let n = 0;
    for (const k of z.topf) {
      if (k !== r && dominiert(k, r)) n++;
    }
    if (n < bestes) bestes = n;
  }
  return bestes;
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

  let fragen = 0;
  let imTopf = 0;
  let platz1Moeglich = 0;
  let top3Moeglich = 0;
  const verteilung = new Map<number, number>();

  const rl = createInterface({ input: createReadStream(datei) });
  for await (const zeile of rl) {
    if (!zeile.trim()) continue;
    let z: Zeile;
    try { z = JSON.parse(zeile) as Zeile; } catch { continue; }
    fragen++;
    const d = wenigsteDominatoren(z);
    if (d === null) continue;
    imTopf++;
    if (d === 0) platz1Moeglich++;
    if (d <= 2) top3Moeglich++;
    const klasse = d === 0 ? 0 : d <= 2 ? 1 : d <= 9 ? 2 : 3;
    verteilung.set(klasse, (verteilung.get(klasse) ?? 0) + 1);
  }

  if (fragen === 0) { console.error('NICHT GEMESSEN: keine Zeilen.'); process.exit(2); }

  const haelfte = datei.includes('-B') ? 'Pruefhaelfte B' : datei.includes('-A') ? 'Einstellhaelfte A' : datei;
  const pct = (n: number) => `${(100 * n / fragen).toFixed(1)} %`;
  console.log(`\n${fragen} Fragen (${haelfte}) · richtige Antwort im Topf: ${imTopf} (${pct(imTopf)})\n`);
  console.log('OBERGRENZE fuer JEDE nichtnegative Gewichtung dieser fuenf Merkmale');
  console.log('(grosszuegig: eigene Gewichtung je Frage erlaubt):\n');
  console.log(`  Platz 1 hoechstens   ${pct(platz1Moeglich)}   (richtige Antwort ohne Dominator)`);
  console.log(`  Top 3   hoechstens   ${pct(top3Moeglich)}   (hoechstens zwei Dominatoren)`);
  console.log('\nDominatoren der besten richtigen Antwort:');
  const namen = ['0 (Platz 1 offen)', '1-2 (Top 3 offen)', '3-9', '10+'];
  for (const [klasse, name] of namen.entries()) {
    const n = verteilung.get(klasse) ?? 0;
    console.log(`  ${name.padEnd(20)} ${String(n).padStart(5)}  (${pct(n)})`);
  }

  console.log(`
LESEHILFE: Die Schranke ist NOTWENDIG, nicht hinreichend — eine einzige
gemeinsame Gewichtung bleibt darunter. Liegt die heutige Findequote nahe
an der Schranke, ist jede weitere Gewichts-Suche bewiesenermassen fast
wertlos: der Engpass sind dann die MERKMALE. Neue Signale (andere Tueren,
andere Einbettung, Symptomfeld) verschieben die Schranke — Gewichte nie.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`NICHT GEMESSEN: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
}
