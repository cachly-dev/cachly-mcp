import { describe, expect, it } from 'vitest';
import { repariereFelder, hatFeldmarke } from './feldreparatur.js';

/**
 * Die Probe zum echten Vorfall vom 22.08.2026.
 *
 * Dieselbe Lektion wurde ZWEIMAL hintereinander verklebt geschrieben, ohne
 * dass etwas rot wurde. Die Rueckmeldung des Werkzeugs zeigte den kaputten
 * Text sogar an — und sah trotzdem aus wie ein Erfolg.
 *
 * Die zweite Haelfte dieser Datei ist deshalb wichtiger als die erste: eine
 * Reparatur, die auch dort zugreift, wo nichts kaputt ist, richtet mehr
 * Schaden an als der Fehler.
 */

describe('repariereFelder — trennt, was verklebt hereinkommt', () => {
  it('holt what_failed aus what_worked heraus — der echte Fall', () => {
    const kaputt = {
      what_worked: 'STICHPROBE 8 VON 68 ERZEUGTE DEN DAUERALARM.</what_worked>\n'
        + '<parameter name="what_failed">Die Kostenrechnung galt 500 Instanzen.',
    };
    const heil = repariereFelder(kaputt);
    expect(heil.what_worked).toBe('STICHPROBE 8 VON 68 ERZEUGTE DEN DAUERALARM.');
    expect(heil.what_failed).toBe('Die Kostenrechnung galt 500 Instanzen.');
  });

  it('erkennt auch die schlichte Form ohne parameter-Huelle', () => {
    const heil = repariereFelder({ what_worked: 'A behoben</what_worked><what_failed>B blieb offen' });
    expect(heil.what_worked).toBe('A behoben');
    expect(heil.what_failed).toBe('B blieb offen');
  });

  it('holt auch den context heraus, wenn drei Felder verkleben', () => {
    const heil = repariereFelder({
      what_worked: 'eins</what_worked><what_failed>zwei</what_failed><context>drei',
    });
    expect(heil.what_worked).toBe('eins');
    expect(heil.what_failed).toBe('zwei');
    expect(heil.context).toBe('drei');
  });

  it('ueberschreibt ein bereits gefuelltes Feld NICHT, sondern haengt an', () => {
    // Sonst loescht die Reparatur genau den Text, den jemand richtig
    // uebergeben hat — schlimmer als der Fehler.
    const heil = repariereFelder({
      what_worked: 'A</what_worked><what_failed>aus dem Klebefall',
      what_failed: 'richtig uebergeben',
    });
    expect(heil.what_failed).toContain('richtig uebergeben');
    expect(heil.what_failed).toContain('aus dem Klebefall');
  });

  it('wirft nie Text weg', () => {
    const kaputt = { what_worked: 'eins</what_worked><what_failed>zwei</what_failed><context>drei' };
    const heil = repariereFelder(kaputt);
    for (const wort of ['eins', 'zwei', 'drei']) {
      const drin = [heil.what_worked, heil.what_failed, heil.context].join(' ');
      expect(drin).toContain(wort);
    }
  });

  it('laesst keine Marke stehen', () => {
    const heil = repariereFelder({ what_worked: 'A</what_worked><what_failed>B' });
    const alles = [heil.what_worked, heil.what_failed, heil.context].join(' ');
    expect(alles).not.toMatch(/<\/?[a-z_]*(what_worked|what_failed|context)/i);
  });
});

describe('repariereFelder — KONTROLLEN, sie darf nicht ueberall zugreifen', () => {
  it('laesst eine saubere Lektion Zeichen fuer Zeichen unveraendert', () => {
    const sauber = {
      what_worked: 'Voreinstellung auf 200 gesetzt, gemessen 0,35 s.',
      what_failed: 'Die Kostenrechnung galt 500 Instanzen.',
      context: 'Diagnoseweg: curl gegen den Admin-Endpunkt.',
    };
    expect(repariereFelder(sauber)).toEqual(sauber);
  });

  it('fasst Fliesstext NICHT an, der die Feldnamen nur ERWAEHNT', () => {
    // Genau der Satz aus der Lektion ueber diesen Fehler. Wer hier zugreift,
    // zerlegt jede Lektion, die ueber das Problem SCHREIBT.
    const t = 'Die Fassung trug den what_failed-Text innerhalb von what_worked.';
    const heil = repariereFelder({ what_worked: t });
    expect(heil.what_worked).toBe(t);
    expect(heil.what_failed).toBeUndefined();
  });

  it('fasst spitze Klammern ohne Feldnamen nicht an', () => {
    const t = 'Der Vergleich war a < b und die Antwort kam als <html> zurueck.';
    expect(repariereFelder({ what_worked: t }).what_worked).toBe(t);
  });

  it('kommt mit leeren und fehlenden Feldern zurecht, statt zu werfen', () => {
    expect(() => repariereFelder({ what_worked: '' })).not.toThrow();
    expect(repariereFelder({ what_worked: '' }).what_worked).toBe('');
  });
});

describe('hatFeldmarke — die billige Vorpruefung', () => {
  it('sagt Ja bei einer echten Marke', () => {
    expect(hatFeldmarke('A</what_worked>B')).toBe(true);
    expect(hatFeldmarke('<parameter name="what_failed">B')).toBe(true);
  });

  it('sagt Nein bei blosser Erwaehnung und bei leerem Text', () => {
    expect(hatFeldmarke('what_failed stand in what_worked')).toBe(false);
    expect(hatFeldmarke('')).toBe(false);
    expect(hatFeldmarke(undefined)).toBe(false);
  });

  it('ist bei wiederholtem Aufruf stabil — lastIndex darf nicht nachwirken', () => {
    // Ein globaler regulaerer Ausdruck merkt sich seine Position. Ohne
    // Ruecksetzen liefert derselbe Aufruf beim zweiten Mal false.
    const t = 'A</what_worked>B';
    expect(hatFeldmarke(t)).toBe(true);
    expect(hatFeldmarke(t)).toBe(true);
    expect(hatFeldmarke(t)).toBe(true);
  });
});
