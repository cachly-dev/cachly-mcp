/**
 * Wächter: eine Bench-Schwelle ändert sich nur MIT Eintrag im Schwellen-Buch.
 *
 * ── Der Anlass (Karte nvouhp2o4ib8, Gegenrede-Lauf 1, Der Betreiber) ───────
 *
 * `home.precisionAt1` fiel am 19.08.2026 von 0,90 auf 0,67 — als gewöhnlicher,
 * grün gemergter PR. Die Senkung selbst war vermutlich richtig; der Befund
 * ist, dass sie durchging wie jede Codezeile, obwohl sie die Aussagekraft
 * ALLER künftigen grünen Läufe verändert. Um drei Uhr nachts zeigt ein
 * Deploy dasselbe grüne Häkchen, egal wie die Schwelle gestern hieß.
 *
 * ── Die Zeremonie ──────────────────────────────────────────────────────────
 *
 * Jede Schwelle steht in schwellen-buch.json mit Wert, Datum und Begründung.
 * Diese Probe vergleicht Code gegen Buch in BEIDE Richtungen. Wer eine
 * Schwelle ändert, MUSS das Buch mitändern — und der Buch-Diff trägt die
 * Begründung sichtbar in den Review. Keine Sperre, aber auch kein stiller
 * Durchmarsch mehr.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FLOORS } from '../bench/gate.js';
import { UNTERGRENZEN } from '../bench/echter-korpus.js';

type Eintrag = { wert: number; seit: string; begruendung: string };

const BUCH = JSON.parse(
  readFileSync(new URL('../bench/schwellen-buch.json', import.meta.url), 'utf8'),
) as Record<string, Eintrag | string>;

/** Alle Schwellen aus dem Code, flach: name -> Wert. */
export function schwellenAusCode(): Record<string, number> {
  const raus: Record<string, number> = {};
  for (const [korpusName, werte] of Object.entries(FLOORS)) {
    for (const [metrik, wert] of Object.entries(werte)) {
      if (typeof wert === 'number') raus[`gate.${korpusName}.${metrik}`] = wert;
    }
  }
  for (const [name, wert] of Object.entries(UNTERGRENZEN)) {
    if (typeof wert === 'number') raus[`korpus.${name}`] = wert;
  }
  return raus;
}

/** Reiner Vergleich — getrennt testbar (Gegenprobe unten). */
export function vergleiche(
  code: Record<string, number>,
  buch: Record<string, Eintrag | string>,
): string[] {
  const fehler: string[] = [];
  for (const [name, wert] of Object.entries(code)) {
    const e = buch[name];
    if (!e || typeof e === 'string') {
      fehler.push(`${name}=${wert} steht im Code, aber nicht im Schwellen-Buch.`);
      continue;
    }
    if (e.wert !== wert) {
      fehler.push(
        `${name}: Code sagt ${wert}, Buch sagt ${e.wert}. Wer die Schwelle aendert, `
        + 'traegt sie MIT Datum und Begruendung ins Buch ein (schwellen-buch.json).',
      );
    }
  }
  for (const name of Object.keys(buch)) {
    if (name.startsWith('_')) continue;
    if (!(name in code)) fehler.push(`${name} steht im Buch, aber nicht mehr im Code — Leiche entfernen.`);
  }
  return fehler;
}

describe('Das Schwellen-Buch', () => {
  it('jede Schwelle im Code steht mit gleichem Wert im Buch — und umgekehrt', () => {
    const fehler = vergleiche(schwellenAusCode(), BUCH);
    expect(fehler, fehler.join('\n')).toEqual([]);
  });

  it('jeder Eintrag traegt Datum und eine echte Begruendung', () => {
    for (const [name, e] of Object.entries(BUCH)) {
      if (name.startsWith('_') || typeof e === 'string') continue;
      expect(e.seit, `${name}: seit fehlt`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // 40 Zeichen sind keine Begruendung-Simulation ("angepasst") mehr.
      expect(e.begruendung.length, `${name}: Begruendung zu duenn`).toBeGreaterThanOrEqual(40);
    }
  });

  it('GEGENPROBE: eine still gesenkte Schwelle wird rot und nennt die Zeremonie', () => {
    const code = schwellenAusCode();
    const gesenkt = { ...code, 'gate.home.precisionAt1': code['gate.home.precisionAt1']! - 0.1 };
    const fehler = vergleiche(gesenkt, BUCH);
    expect(fehler.length).toBeGreaterThan(0);
    expect(fehler[0]).toContain('gate.home.precisionAt1');
    expect(fehler.join(' ')).toContain('Begruendung');
  });

  it('GEGENPROBE: das Zaehlwerk findet ueberhaupt Schwellen', () => {
    // Eine gruene Null aus einem kaputten Import waere der stille Tod des
    // ganzen Waechters.
    expect(Object.keys(schwellenAusCode()).length).toBeGreaterThanOrEqual(10);
  });
});
