import { describe, it, expect } from 'vitest';
import { autorAbzeichen, fremdanteil } from '../autor-abzeichen';

/**
 * GROW-045 — `session_start_summary` haelt seine eigene Zusage.
 *
 * Die Werkzeug-Spezifikation sagt zum Parameter `author`:
 *
 *   "Your name or handle (optional). Same as session_start — used for team
 *    lesson filtering."
 *
 * Der Handler holte den Wert aus den Argumenten und benutzte ihn nirgends.
 * eslint meldete ihn seit Monaten als ungenutzte Variable. Wer den Parameter
 * setzte, bekam exakt dieselbe Ausgabe wie ohne ihn.
 *
 * Fehlerklasse: eine Zusage an zwei Orten, nur einer gepflegt.
 */
describe('autorAbzeichen', () => {
  it('nennt den Teamkollegen', () => {
    expect(autorAbzeichen('marc', 'heinrich')).toBe(' · 👤 marc');
  });

  it('schweigt bei den eigenen Lektionen', () => {
    // Sonst stuende in einem Brain, das ueberwiegend einer Person gehoert,
    // hinter jeder Zeile derselbe Name — und das Abzeichen saegte den Ast ab,
    // auf dem es sitzt.
    expect(autorAbzeichen('heinrich', 'heinrich')).toBe('');
  });

  it('schweigt, wenn niemand als Autor eingetragen ist', () => {
    expect(autorAbzeichen(null, 'heinrich')).toBe('');
    expect(autorAbzeichen('', 'heinrich')).toBe('');
    expect(autorAbzeichen('   ', 'heinrich')).toBe('');
  });

  it('nennt den Autor auch, wenn der Anfragende sich nicht zu erkennen gibt', () => {
    // Ohne eigenen Namen ist jede Lektion potenziell fremd; die Angabe hilft
    // trotzdem, weil sie sagt, WER es wusste.
    expect(autorAbzeichen('marc', '')).toBe(' · 👤 marc');
    expect(autorAbzeichen('marc', undefined)).toBe(' · 👤 marc');
  });

  it('Randleerzeichen aendern die Zuordnung nicht', () => {
    expect(autorAbzeichen(' heinrich ', 'heinrich')).toBe('');
  });
});

describe('fremdanteil', () => {
  const L = (author?: string | null) => ({ author });

  it('zaehlt nur die Lektionen anderer', () => {
    expect(fremdanteil([L('marc'), L('heinrich'), L('marc'), L(null)], 'heinrich')).toBe(2);
  });

  it('GEGENPROBE: ohne eigenen Namen wird nichts behauptet', () => {
    // Ohne zu wissen, wer fragt, laesst sich "fremd" nicht bestimmen. Lieber
    // null als eine Zahl, die nur so aussieht wie eine Messung.
    expect(fremdanteil([L('marc'), L('heinrich')], '')).toBe(0);
    expect(fremdanteil([L('marc')], undefined)).toBe(0);
  });

  it('GEGENPROBE: ein Brain, in dem alles von mir ist, meldet null', () => {
    expect(fremdanteil([L('heinrich'), L('heinrich')], 'heinrich')).toBe(0);
  });

  it('leere Liste ergibt null, nicht NaN', () => {
    expect(fremdanteil([], 'heinrich')).toBe(0);
  });
});
