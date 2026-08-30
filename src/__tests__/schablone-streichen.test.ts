import { describe, expect, it } from 'vitest';
import { MIN_REST, nachDemStreichen, streicheSchablone } from '../bench/schablone-streichen';

/**
 * Proben für das Streichen von PR-Schablone (Karte ee7pmtjujucs).
 *
 * Die tragende Regel: **zeilenweise streichen, nicht die Lektion verwerfen.**
 * Ein PR-Text besteht oft aus Schablone PLUS echtem Inhalt — wer die ganze
 * Lektion wegwirft, wirft den Inhalt mit weg.
 */

const ECHT =
  'Clarify the error message for attempted hijack after response body data is written. ' +
  'The previous message pointed at the wrong layer and sent people looking in net/http.';

describe('Streichen', () => {
  it('laesst echten Inhalt in Ruhe', () => {
    const { rest, gestrichen } = streicheSchablone(ECHT);
    expect(gestrichen).toBe(0);
    expect(rest).toBe(ECHT);
  });

  /*
   * Der Fall, der die ganze Datei begründet: Schablone UND Inhalt in einem
   * Text. Beides zu verwerfen wäre bequem und falsch.
   */
  it('streicht die Schablone und behaelt den Inhalt', () => {
    const gemischt = [
      'Fixes: #4460',
      '',
      '## Pull Request Checklist',
      '- [ ] Open your pull request against the master branch',
      '- [x] All tests pass in available CI pipelines',
      '',
      ECHT,
    ].join('\n');
    const { rest, gestrichen } = streicheSchablone(gemischt);
    expect(gestrichen).toBeGreaterThanOrEqual(4);
    expect(rest).toContain('Clarify the error message');
    expect(rest).not.toContain('Pull Request Checklist');
    expect(rest).not.toContain('[ ]');
  });

  it('zaehlt, wie viel gestrichen wurde', () => {
    // Ohne die Zahl waere "gestrichen" eine Behauptung, und niemand koennte
    // pruefen, ob zu viel verschwand.
    const { gestrichen } = streicheSchablone('Signed-off-by: A\nCo-authored-by: B\n' + ECHT);
    expect(gestrichen).toBe(2);
  });

  it('ein blosser Verweis ist Schablone, ein Verweis MIT Text nicht', () => {
    expect(streicheSchablone('Closes #123').rest).toBe('');
    // Sonst faellt "Fixes #123 by rewriting the retry loop" mit weg — und das
    // ist genau der Satz, der zaehlt.
    expect(streicheSchablone('Fixes #123 by rewriting the retry loop').rest)
      .toContain('rewriting the retry loop');
  });

  it('leerer Text bleibt leer, ohne Absturz', () => {
    expect(streicheSchablone('').rest).toBe('');
    expect(streicheSchablone('   ').rest).toBe('');
  });
});

describe('Urteil nach dem Streichen', () => {
  it('genug Rest wird behalten', () => {
    const e = nachDemStreichen(ECHT);
    expect('rest' in e).toBe(true);
  });

  it('zu wenig Rest wird verworfen — MIT dem gelesenen Wert', () => {
    const nurSchablone = '## Checklist\n- [ ] tests\n- [x] docs\nSigned-off-by: A';
    const e = nachDemStreichen(nurSchablone);
    expect('verworfen' in e).toBe(true);
    if ('verworfen' in e) {
      // Erst der gelesene Wert, dann das Urteil: WIE VIELE Zeilen, WIE VIEL Rest.
      expect(e.verworfen).toMatch(/\d+ gestrichenen Schablonenzeilen/);
      expect(e.verworfen).toContain(String(MIN_REST));
    }
  });

  it('GEGENPROBE: eine Lektion knapp ueber der Grenze bleibt', () => {
    // Waere jede kurze Lektion verworfen, verloere das Paket die knappen
    // aber richtigen Eintraege.
    const knapp = 'x'.repeat(MIN_REST + 1);
    expect('rest' in nachDemStreichen(knapp)).toBe(true);
  });
});

describe('Schablone MITTEN im Text (zweiter Durchgang)', () => {
  /*
   * Der Fall, der nach dem ersten Durchgang übrig blieb: die Ernte ebnet
   * Zeilenumbrüche ein, also steht kein Muster mehr am Zeilenanfang.
   */
  it('streicht eine eingeebnete Unterschriftszeile', () => {
    const t = 'The intermediate CA is already in the systems trust. Signed-off-by: Josef Johansson josef@oderland.se resolves #564';
    const { rest } = streicheSchablone(t);
    expect(rest).toContain('intermediate CA is already in the systems trust');
    expect(rest).not.toContain('Signed-off-by');
    expect(rest).not.toContain('@oderland.se');
  });

  it('streicht eingeebnete Vorlagen-Ueberschriften', () => {
    const t = 'Type of change Bug fix Description Fixed several bugs in the workflow files';
    const { rest } = streicheSchablone(t);
    expect(rest).not.toContain('Type of change');
    expect(rest).toContain('Fixed several bugs');
  });

  /*
   * Die Gegenprobe, die das Muster davor bewahrt, zu breit zu werden: ein
   * Satz, der zufällig ähnliche Wörter enthält, bleibt unangetastet.
   */
  it('GEGENPROBE: aehnliche Woerter im Fliesstext bleiben stehen', () => {
    const t = 'We changed the type of the change event so that all tests pass deterministically now.';
    const { rest, gestrichen } = streicheSchablone(t);
    expect(gestrichen).toBe(0);
    expect(rest).toBe(t);
  });

  it('jeder Inline-Treffer wird gezaehlt', () => {
    const t = 'Fix. Signed-off-by: A a@b.c Type of change Bug fix more text here to stay';
    expect(streicheSchablone(t).gestrichen).toBeGreaterThanOrEqual(2);
  });
});
