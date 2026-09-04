/**
 * Arm E: die Zeile, die das Nacherzaehlen abstellt.
 *
 * Gemessen am 04.09.2026 an 480 Bench-Sitzungen: ein Modell mit Gedaechtnis
 * schreibt selbst 2,2-mal so viel wie eines ohne (7.756 gegen 3.474
 * Ausgabe-Token), und jedes selbst geschriebene Wort wird in jedem folgenden
 * Zug erneut als Eingabe bezahlt. Der groessere Posten ist damit nicht die
 * Abrufantwort, sondern die Rechenschaft ueber sie.
 *
 * Geprueft wird hier dreierlei, und das dritte ist das wichtigste:
 *   1. Der Schalter wirkt, wenn er steht.
 *   2. Er wirkt NICHT, wenn er fehlt — der Auslieferstand bleibt unberuehrt.
 *   3. Die Zeile verbietet das Nacherzaehlen und ERLAUBT das Pruefen. Ohne
 *      diese Trennung waere sie ein Auftrag, schlampiger zu arbeiten.
 */

import { describe, it, expect } from 'vitest';
import {
  kurzfassenHinweis, KURZFASSEN_ZEILE, KURZFASSEN_SCHALTER,
} from '../antwort-hinweis.js';

const mit = (wert?: string): NodeJS.ProcessEnv =>
  (wert === undefined ? {} : { [KURZFASSEN_SCHALTER]: wert }) as NodeJS.ProcessEnv;

describe('kurzfassenHinweis — der Schalter', () => {
  it('gibt die Zeile, wenn der Schalter auf 1 steht', () => {
    expect(kurzfassenHinweis(mit('1'))).toBe(KURZFASSEN_ZEILE);
  });

  it('gibt null, wenn der Schalter fehlt — der Auslieferstand bleibt gleich', () => {
    expect(kurzfassenHinweis(mit())).toBeNull();
  });

  it.each(['0', 'true', 'ja', 'yes', '', ' 1', '1 '])(
    'gibt null bei %o — nur die exakte 1 zaehlt', (wert) => {
      expect(kurzfassenHinweis(mit(wert))).toBeNull();
    },
  );

  it('gibt null und keinen leeren String — sonst rutscht eine Leerzeile durch', () => {
    const r = kurzfassenHinweis(mit());
    expect(r).toBeNull();
    expect(r).not.toBe('');
  });
});

describe('KURZFASSEN_ZEILE — was sie sagt und was nicht', () => {
  it('verbietet das Auflisten und das Melden der Befolgung', () => {
    expect(KURZFASSEN_ZEILE).toMatch(/do not list them/i);
    expect(KURZFASSEN_ZEILE).toMatch(/do not report that you followed/i);
  });

  /**
   * Die tragende Pruefung. Der naheliegende Kurzschluss beim Kuerzen dieser
   * Zeile waere "just give the result" — und das liest sich als Erlaubnis,
   * die Pruefung wegzulassen. Genau die 95 geloesten Zellen haengen daran.
   */
  it('erlaubt das Pruefen ausdruecklich — und zwar wie gewohnt', () => {
    expect(KURZFASSEN_ZEILE).toMatch(/verify your work/i);
    expect(KURZFASSEN_ZEILE).toMatch(/as you normally would/i);
  });

  it('sagt nicht, dass weniger geprueft werden soll', () => {
    expect(KURZFASSEN_ZEILE).not.toMatch(/skip|don't verify|do not verify|no need to check/i);
  });

  it('bleibt eine Zeile — der Hinweis darf nicht selbst zum Posten werden', () => {
    expect(KURZFASSEN_ZEILE).not.toContain('\n');
    expect(KURZFASSEN_ZEILE.length).toBeLessThan(320);
  });

  it('nennt einen Grund, nicht nur ein Verbot', () => {
    expect(KURZFASSEN_ZEILE).toMatch(/the reader wants/i);
  });
});
