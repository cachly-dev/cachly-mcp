import { describe, expect, it } from 'vitest';
import { autoSitzungsSchritt } from './auto-sitzung.js';

/**
 * Die Sitzungs-Automatik (11.11.2026): ein ausdrueckliches session_start
 * zaehlt als Start. Vorher loeste der erste smart_recall danach ein zweites,
 * unsichtbares session_start aus und wartete rund 6 s darauf.
 */
describe('autoSitzungsSchritt', () => {
  const frisch = { gestartet: false, startetGerade: false, instanz: 'i-1' };

  it('ein ausdrueckliches session_start wird als Start gemerkt, nicht doppelt ausgefuehrt', () => {
    expect(autoSitzungsSchritt('session_start', frisch)).toBe('als-gestartet-merken');
  });

  it('danach startet der erste smart_recall KEINE zweite Sitzung', () => {
    // Der Zustand nach dem Merken: gestartet.
    expect(autoSitzungsSchritt('smart_recall', { ...frisch, gestartet: true })).toBe('nichts');
  });

  it('ohne ausdrueckliches session_start startet der erste Werkzeugaufruf die Sitzung wie bisher', () => {
    expect(autoSitzungsSchritt('smart_recall', frisch)).toBe('starten');
    expect(autoSitzungsSchritt('learn_from_attempts', frisch)).toBe('starten');
  });

  it('andere Sitzungswerkzeuge loesen nichts aus', () => {
    for (const w of ['session_end', 'session_start_summary', 'auto_learn_session']) {
      expect(autoSitzungsSchritt(w, frisch), w).toBe('nichts');
    }
  });

  it('startet gerade eine Sitzung, wartet jeder weitere Aufruf darauf', () => {
    const laeuft = { ...frisch, startetGerade: true };
    expect(autoSitzungsSchritt('smart_recall', laeuft)).toBe('abwarten');
    expect(autoSitzungsSchritt('session_start', laeuft)).toBe('abwarten');
  });

  it('ohne Instanz gibt es nichts zu starten', () => {
    expect(autoSitzungsSchritt('smart_recall', { ...frisch, instanz: '' })).toBe('nichts');
    expect(autoSitzungsSchritt('session_start', { ...frisch, instanz: '' })).toBe('nichts');
  });
});
