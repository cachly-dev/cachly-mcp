import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  KOPF_BYTES, kopfLesen, kopfSchreiben, kosinus, lesen, schreiben,
} from '../vektoren-binaer.js';

const ORDNER = mkdtempSync(join(tmpdir(), 'vek-'));
afterAll(() => rmSync(ORDNER, { recursive: true, force: true }));

/** Ein Vektor, wie ihn bge-m3 liefert: 1024 Werte zwischen -1 und 1. */
function vektor(saat: number, dim = 1024): number[] {
  const aus: number[] = [];
  let x = saat;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    aus.push((x / 2147483648) * 2 - 1);
  }
  return aus;
}

describe('Die Datei sagt, was in ihr steht', () => {
  it('Kopf schreiben und lesen ergibt dieselben Zahlen', () => {
    const k = kopfLesen(kopfSchreiben(1234, 1024));
    expect(k.anzahl).toBe(1234);
    expect(k.dimensionen).toBe(1024);
  });

  it('eine fremde Datei wird als solche erkannt', () => {
    // Ohne Kennung waere jede beliebige Datei ein gueltiger Vektorbestand,
    // und die Messung liefe auf Zufallszahlen.
    const fremd = Buffer.alloc(KOPF_BYTES);
    fremd.write('JPEG', 0, 'ascii');
    expect(() => kopfLesen(fremd)).toThrow(/Keine Vektordatei/);
  });

  it('KONTROLLE: eine abgebrochene Datei wird NICHT gelesen', () => {
    /*
     * Der wichtigste Test hier.
     *
     * Bricht ein Lauf mitten im Schreiben ab, steht im Kopf "500000
     * Vektoren", in der Datei liegen 300000. Ohne die Groessenpruefung laese
     * der naechste Lauf Muell aus dem Nichts — und meldete ein Ergebnis.
     *
     * Dieselbe Fehlerklasse wie den ganzen 24.08.2026: es gibt keinen
     * Zustand "abgebrochen", also sieht Stille wie ein Ergebnis aus.
     */
    const kopf = kopfSchreiben(1000, 1024);
    const zuKlein = KOPF_BYTES + 300 * 1024 * 4;
    expect(() => kopfLesen(kopf, zuKlein)).toThrow(/abgebrochen/);
  });

  it('KONTROLLE: die richtige Groesse geht durch', () => {
    // Sonst waere die Probe darueber gruen, weil ALLES abgelehnt wird.
    const kopf = kopfSchreiben(1000, 1024);
    expect(() => kopfLesen(kopf, KOPF_BYTES + 1000 * 1024 * 4)).not.toThrow();
  });
});

describe('Schreiben und Lesen erhaelt die Vektoren', () => {
  const eintraege: Array<[string, number[]]> = [
    ['frage:aaa', vektor(1)],
    ['lektion:bbb', vektor(2)],
    ['frage:ccc', vektor(3)],
  ];
  const ziel = join(ORDNER, 'probe.vek');
  schreiben(ziel, eintraege);
  const zurueck = lesen(ziel);

  it('alle Schluessel sind da, in derselben Reihenfolge', () => {
    expect(Object.keys(zurueck)).toEqual(['frage:aaa', 'lektion:bbb', 'frage:ccc']);
  });

  it('die Werte stimmen bis auf float32-Genauigkeit', () => {
    for (const [k, v] of eintraege) {
      for (let i = 0; i < v.length; i++) {
        expect(Math.abs(zurueck[k][i] - v[i])).toBeLessThan(1e-6);
      }
    }
  });

  it('der Kosinus aendert sich nicht messbar — darauf kommt es an', () => {
    /*
     * Die Genauigkeit einzelner Zahlen ist gleichgueltig. Was zaehlt, ist die
     * Rangfolge, und die haengt am Kosinus. Wenn der bis zur sechsten Stelle
     * gleich bleibt, kann float32 keine zwei Kandidaten vertauschen.
     */
    const vorher = kosinus(eintraege[0][1], eintraege[1][1]);
    const nachher = kosinus(zurueck['frage:aaa'], zurueck['lektion:bbb']);
    expect(Math.abs(vorher - nachher)).toBeLessThan(1e-6);
  });

  it('die Datei ist fuenfmal kleiner als JSON', () => {
    /*
     * Der ganze Grund fuer dieses Format. Gemessen am 24.08.2026: 23072
     * Vektoren als JSON waren 467 MB — 20 KB je Vektor fuer 1024 Zahlen.
     */
    const binaer = statSync(ziel).size;
    const alsJson = join(ORDNER, 'probe.json');
    writeFileSync(alsJson, JSON.stringify(Object.fromEntries(eintraege)));
    const json = statSync(alsJson).size;
    expect(binaer).toBeLessThan(json / 4);
  });
});

describe('Was NICHT geschrieben wird', () => {
  it('ein leerer Bestand ist ein Abbruch, kein Ergebnis', () => {
    expect(() => schreiben(join(ORDNER, 'leer.vek'), [])).toThrow(/NICHT GESCHRIEBEN/);
  });

  it('verschieden lange Vektoren gehoeren nicht in eine Datei', () => {
    // Sonst waere jeder Vektor danach um ein paar Zahlen verschoben, und
    // NICHTS wuerde einen Fehler melden — die Messung liefe einfach falsch.
    expect(() => schreiben(join(ORDNER, 'krumm.vek'), [
      ['a', vektor(1, 1024)],
      ['b', vektor(2, 768)],
    ])).toThrow(/768 Dimensionen/);
  });

  it('KONTROLLE: ein Index, der nicht passt, wird bemerkt', () => {
    const ziel = join(ORDNER, 'krummer-index.vek');
    schreiben(ziel, [['a', vektor(1)], ['b', vektor(2)]]);
    writeFileSync(`${ziel}.idx`, JSON.stringify({ schluessel: ['a'] }));
    expect(() => lesen(ziel)).toThrow(/gehoeren nicht zusammen/);
  });
});
