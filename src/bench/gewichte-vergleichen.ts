/**
 * ══ Zwei Gewichtungen GEPAART vergleichen ══════════════════════════════════
 *
 * ── Warum das nicht dieselbe Rechnung ist wie zwei Messläufe ──────────────
 *
 * Zwei Läufe nebeneinander liefern zwei Prozentzahlen. Der naheliegende
 * Vergleich rechnet dann mit dem Standardfehler jeder Zahl — und bei 349
 * Fragen ist der ±2,5 Punkte gross. Ein Unterschied von 2,3 Punkten waere
 * damit "nicht belastbar", und man wuerde eine echte Verbesserung wegwerfen.
 *
 * Das ist der falsche Test. Beide Gewichtungen sehen **dieselben Fragen** und
 * **denselben Bestand**. Nur die Verrechnung unterscheidet sich. Was zaehlt,
 * ist nicht die Streuung ueber Fragen, sondern wie viele Fragen ihre Antwort
 * WECHSELN — und in welche Richtung.
 *
 * Dafuer gibt es McNemars Test: er sieht nur die Fragen, bei denen sich etwas
 * geaendert hat, und fragt, ob die Richtung ein Zufall sein kann. 20 gegen 12
 * ist etwas anderes als 200 gegen 192, obwohl beide netto +8 ergeben.
 *
 * ── Was er NICHT kann ────────────────────────────────────────────────────
 *
 * Er sagt nichts darueber, ob der Unterschied WICHTIG ist — nur, ob er echt
 * ist. Und er gilt nur fuer den Bestand, auf dem gemessen wurde.
 *
 * Aufruf:
 *   npx tsx src/bench/gewichte-vergleichen.ts --merkmale <datei.jsonl> \
 *     --a text=1,thema=0.6,rueckkopplung=0.3,seltenheit=1.3,eingang=0.2 \
 *     --b text=1,thema=0,rueckkopplung=0.15,seltenheit=1.3,eingang=0.7
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { bewerteTopf, spreizeImTopf, type GEWICHTE } from '../rangfolge.js';

type Kandidat = { t: string; nT: number; nTh: number; nR: number; sD: number; bE: number; bZ?: number };
type Zeile = { query: string; art: string; relevant: string[]; topf: Kandidat[] };
type Einstellung = {
  text: number; thema: number; rueckkopplung: number; seltenheit: number; eingang: number;
};

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** "text=1,thema=0" → Einstellung. Fehlende Achsen bleiben auf 0. */
export function leseEinstellung(text: string): Einstellung {
  const e: Einstellung = { text: 1, thema: 0, rueckkopplung: 0, seltenheit: 0, eingang: 0 };
  for (const teil of text.split(',').filter(Boolean)) {
    const [k, v] = teil.split('=');
    if (k in e) (e as unknown as Record<string, number>)[k.trim()] = Number(v);
  }
  return e;
}

/** Der Platz der besten richtigen Antwort, 1-basiert. 0 = gar nicht dabei. */
export function platzVon(z: Zeile, e: Einstellung): number {
  const bewertbar = z.topf.map((k) => ({
    naeheText: k.nT, naeheThema: k.nTh, naeheRueckkopplung: k.nR, seltenheitsDeckung: k.sD,
    // Aeltere Merkmalsdateien tragen bZ nicht: 0 fuer alle = keine Wirkung.
    besterZeuge: k.bZ ?? 0,
  }));
  let punkte = bewerteTopf(bewertbar, {
    text: e.text, thema: e.thema, rueckkopplung: e.rueckkopplung, seltenheit: e.seltenheit,
  } as typeof GEWICHTE);
  if (e.eingang > 0) {
    const g = spreizeImTopf(z.topf.map((k) => k.bE));
    punkte = punkte.map((p, i) => p + e.eingang * g[i]);
  }
  const rang = z.topf.map((k, i) => ({ t: k.t, p: punkte[i] })).sort((a, b) => b.p - a.p);
  const gold = new Set(z.relevant);
  for (let i = 0; i < rang.length; i++) if (gold.has(rang[i].t)) return i + 1;
  return 0;
}

/**
 * McNemars Test, zweiseitig, mit Stetigkeitskorrektur.
 *
 * Nur die Fragen zaehlen, bei denen sich etwas geaendert hat: `hin` sind die,
 * die mit B richtig und mit A falsch sind, `weg` die umgekehrten. Gleich
 * gebliebene tragen keine Information ueber den Unterschied.
 */
export function mcnemar(hin: number, weg: number): { chi: number; p: number } {
  const n = hin + weg;
  if (n === 0) return { chi: 0, p: 1 };
  const chi = ((Math.abs(hin - weg) - 1) ** 2) / n;
  // Ueberlebensfunktion der Chi-Quadrat-Verteilung mit einem Freiheitsgrad:
  // p = erfc(sqrt(chi/2)). erfc als Abramowitz-Stegun-Naeherung (7.1.26),
  // Fehler unter 1,5e-7 — reicht fuer eine Entscheidung ueber 0,05 bei weitem.
  const x = Math.sqrt(chi / 2);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-x * x);
  return { chi, p: 1 - y };
}

async function main(): Promise<void> {
  const pfad = flag('merkmale');
  const aText = flag('a');
  const bText = flag('b');
  if (!pfad || !aText || !bText) {
    console.error('NICHT GEMESSEN: --merkmale, --a und --b sind Pflicht.');
    process.exit(2);
  }
  const A = leseEinstellung(aText);
  const B = leseEinstellung(bText);

  const zeilen: Zeile[] = [];
  const leser = createInterface({ input: createReadStream(resolve(pfad)), crlfDelay: Infinity });
  for await (const z of leser) if (z.trim()) zeilen.push(JSON.parse(z) as Zeile);
  if (zeilen.length < 30) {
    console.error(`NICHT GEMESSEN: nur ${zeilen.length} Fragen.`);
    process.exit(3);
  }

  const proz = (x: number) => `${(x * 100).toFixed(1)} %`;
  console.log('');
  console.log('⚖️  Gepaarter Vergleich zweier Gewichtungen');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`  ${zeilen.length} Fragen · dieselben Fragen, derselbe Bestand`);
  console.log(`  A: ${aText}`);
  console.log(`  B: ${bText}`);
  console.log('');

  for (const bis of [1, 3, 10]) {
    let hin = 0; let weg = 0; let beide = 0; let keins = 0;
    for (const z of zeilen) {
      const a = platzVon(z, A);
      const b = platzVon(z, B);
      const aOk = a >= 1 && a <= bis;
      const bOk = b >= 1 && b <= bis;
      if (aOk && bOk) beide++;
      else if (!aOk && bOk) hin++;
      else if (aOk && !bOk) weg++;
      else keins++;
    }
    const aQuote = (beide + weg) / zeilen.length;
    const bQuote = (beide + hin) / zeilen.length;
    const { chi, p } = mcnemar(hin, weg);
    const urteil = p < 0.05 ? 'belastbar' : 'kann Zufall sein';
    console.log(`  ${bis === 1 ? 'Platz 1     ' : bis === 3 ? 'Findequote@3' : 'Top 10      '}`
      + `  A ${proz(aQuote)} → B ${proz(bQuote)}`
      + `   (+${hin} / −${weg})   p = ${p < 0.001 ? '< 0,001' : p.toFixed(3)}  ${urteil}`);
    void chi; void keins;
  }

  console.log('──────────────────────────────────────────────────────────────────────');
  console.log('  (+x / −y): x Fragen wurden mit B richtig und waren mit A falsch,');
  console.log('  y umgekehrt. Nur diese tragen Information ueber den Unterschied —');
  console.log('  deshalb McNemar und nicht der Standardfehler zweier Prozentzahlen.');
}

main().catch((e) => {
  console.error('NICHT GEMESSEN:', e instanceof Error ? e.message : String(e));
  process.exit(4);
});
