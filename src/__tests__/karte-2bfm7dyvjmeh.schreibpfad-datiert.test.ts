import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ABNAHME Karte 2bfm7dyvjmeh — die Datierung haengt WIRKLICH im Schreibpfad.
 *
 * Das reine Modul ist in zeit-normalisieren.test.ts geprueft. Diese Datei
 * prueft das, was ein Modul-Test nicht sehen kann: dass learn_from_attempts
 * es auch benutzt, und zwar auf allen drei Textfeldern.
 *
 * Die Fehlerklasse dahinter ist im Haus bekannt: eine Funktion existiert,
 * ist getestet, und der Auslieferpfad ruft sie nie ("Messstand und
 * Auslieferstand sind zwei Systeme", 20.08.2026). Ein Modul ohne Aufrufer
 * ist Dekoration mit gruenem Haken.
 */
const quelle = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// Kommentare raus: eine Zusage, die nur in der Erklaerung steht, ist keine.
const nurCode = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('Schreibpfad datiert — nicht nur das Modul kann es', () => {
  const brain = nurCode(quelle('handlers/brain.ts'));

  it('brain.ts holt sich die Normalisierung', () => {
    expect(brain).toContain("from '../zeit-normalisieren.js'");
  });

  it('alle DREI Textfelder laufen hindurch, nicht nur what_worked', () => {
    // what_failed traegt den Fehlweg und ist im Abruf oft das Entscheidende;
    // context traegt die Einordnung. Ein datiertes what_worked neben einem
    // undatierten what_failed waere ein halber Fix.
    for (const feld of ['repariertWorked', 'repariertFailed', 'repariertCtx']) {
      expect(brain, `${feld} laeuft nicht durch normalisiereZeit`).toMatch(
        new RegExp(`normalisiereZeit\\(${feld}`),
      );
    }
  });

  it('die Normalisierung passiert VOR dem Speichern, nicht erst beim Anzeigen', () => {
    // Sonst stuende im Bestand weiter "gestern" und der naechste Abruf
    // haette nichts gewonnen — genau der Fehler, den die Karte behebt.
    const stelleNormalisierung = brain.indexOf('normalisiereZeit(repariertWorked');
    const stelleSpeichern = brain.indexOf('cachly:lesson:best:');
    expect(stelleNormalisierung).toBeGreaterThan(0);
    expect(stelleSpeichern).toBeGreaterThan(0);
    expect(stelleNormalisierung).toBeLessThan(stelleSpeichern);
  });

  it('die Aenderung am fremden Text wird dem Nutzer GEMELDET', () => {
    // Eine stille Aenderung an fremden Worten ist die Sorte Hilfe, die
    // niemand bestellt hat.
    expect(brain).toContain('datiert > 0');
  });

  it('GEGENPROBE: der Originaltext wird ergaenzt, nicht ersetzt', () => {
    // Im Modul festgenagelt; hier wird geprueft, dass der Schreibpfad das
    // Ergebnis der ERGAENZENDEN Funktion speichert und nicht etwa selbst
    // noch einen Ersetzungsschritt anhaengt.
    expect(brain).not.toMatch(/what_worked\s*=\s*[^;]*\.replace\(/);
  });
});
