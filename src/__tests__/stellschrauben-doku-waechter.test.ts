/**
 * Waechter: der Doku-Block jeder Stellschraube nennt den GELTENDEN Wert.
 *
 * Anlass 26.08.2026 (PR #516): Ueber EINGANG_SORTIER_GEWICHT = 0.7 stand zwei
 * Tage lang "0,2 liegt mittig im Band" — die Zahl war am 24.08. angehoben
 * worden, der Satz darueber nicht. Ein Kommentar, der eine Zahl behauptet,
 * die nicht mehr gilt, ist die Drift-Klasse "Waechter mit fester Zahl
 * bewacht die Vergangenheit", nur als Prosa.
 *
 * Die Schwester-Probe `stellschrauben-stehen-nur-hier.test.ts` verhindert,
 * dass Werte ABGESCHRIEBEN werden; diese hier verhindert, dass der Satz
 * ueber dem Wert luegt. Regel: Wer eine Stellschraube dreht, dreht den Satz
 * darueber mit — und dieser Test macht das Vergessen rot.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const QUELLE = new URL('../rangfolge-stellschrauben.ts', import.meta.url);

/** Rein und hier getestet: findet je Stellschraube, ob ihr Doku-Block den
 *  Wert nennt (Punkt- oder Komma-Schreibweise). */
export function pruefeStellschraubenDoku(quelltext: string): { name: string; wert: string; genannt: boolean }[] {
  const raus: { name: string; wert: string; genannt: boolean }[] = [];
  const re = /\/\*\*([\s\S]*?)\*\/\s*export const ([A-Z_]+) = ([0-9.]+);/g;
  for (const m of quelltext.matchAll(re)) {
    const doc = m[1];
    const name = m[2];
    const wert = m[3];
    const varianten = [wert, wert.replace('.', ',')];
    raus.push({ name, wert, genannt: varianten.some((v) => doc.includes(v)) });
  }
  return raus;
}

describe('Stellschrauben-Doku-Waechter', () => {
  it('jeder Doku-Block nennt den Wert, der gilt', () => {
    const ergebnis = pruefeStellschraubenDoku(readFileSync(QUELLE, 'utf8'));
    expect(ergebnis.length, 'keine Stellschraube gefunden — Muster kaputt?').toBeGreaterThanOrEqual(3);
    const stumm = ergebnis.filter((e) => !e.genannt).map((e) => `${e.name}=${e.wert}`);
    expect(stumm, 'Doku-Block nennt den geltenden Wert nicht').toEqual([]);
  });

  it('GEGENPROBE: auf einer echten Drift wird der Waechter rot', () => {
    // Woertlich der Fall vom 26.08.: Kommentar sagt 0,2 — Code sagt 0,7.
    const drift = `/**\n * 0,2 liegt mittig im Band.\n */\nexport const GEWICHT = 0.7;\n`;
    const [e] = pruefeStellschraubenDoku(drift);
    expect(e.genannt).toBe(false);
  });

  it('GEGENPROBE: ein ehrlicher Block besteht — auch in Komma-Schreibweise', () => {
    const ehrlich = `/**\n * 0,7 seit dem 24.08., vorher 0,2.\n */\nexport const GEWICHT = 0.7;\n`;
    const [e] = pruefeStellschraubenDoku(ehrlich);
    expect(e.genannt).toBe(true);
  });
});
