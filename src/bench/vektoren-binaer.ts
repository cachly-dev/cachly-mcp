/**
 * ══ Vektoren binaer ablegen statt als JSON ═════════════════════════════════
 *
 * ── Warum ────────────────────────────────────────────────────────────────
 *
 * Gemessen am 24.08.2026: 23072 Vektoren als JSON = **467 MB**. Das sind
 * 20 KB je Vektor — fuer 1024 Zahlen. Jede steht als Text da, mit siebzehn
 * Nachkommastellen, Komma und Anfuehrungszeichen drumherum.
 *
 * Dieselben Zahlen als float32: **4 KB je Vektor**. Fuenfmal kleiner.
 *
 * Bei der geplanten Dauerernte ist das kein Feinschliff, sondern die Frage,
 * ob es ueberhaupt geht:
 *
 *   500 Projekte x 500 Paare x 2 Texte = 500000 Vektoren
 *     als JSON    10 GB     passt NICHT auf node-3 (9,5 GB frei)
 *     als float32  2 GB     passt
 *
 * ── Warum float32 und nicht float64 ──────────────────────────────────────
 *
 * Die Werte eines normalisierten Einbettungsvektors liegen zwischen -1 und 1.
 * float32 hat dort rund sieben Dezimalstellen Genauigkeit. Der Kosinus
 * zwischen zwei Vektoren aendert sich dadurch in der siebten Stelle — die
 * Rangfolge kann das nicht drehen.
 *
 * Das ist kein Glaube: `vektoren-binaer.test.ts` rechnet den Kosinus einmal
 * mit den Ausgangswerten und einmal nach dem Weg durch die Datei und haelt
 * fest, dass der Unterschied unter 1e-6 bleibt.
 *
 * ── Das Format ───────────────────────────────────────────────────────────
 *
 * Zwei Dateien, weil Namen und Zahlen verschieden lang sind:
 *
 *   <name>.vek     Kopf (32 Byte) + alle Vektoren hintereinander, float32
 *   <name>.vek.idx JSON: die Schluessel in derselben Reihenfolge
 *
 * Der Kopf sagt, was drin ist. OHNE ihn waere eine halb geschriebene Datei
 * nicht von einer vollstaendigen zu unterscheiden — und genau das ist die
 * Fehlerklasse, die uns diese Woche mehrfach getroffen hat: es gibt keinen
 * Zustand "abgebrochen", also sieht Stille wie ein Ergebnis aus.
 *
 *   0..3    Kennung "CVEK"
 *   4..7    Fassung (1)
 *   8..11   Zahl der Vektoren
 *   12..15  Laenge eines Vektors (Dimensionen)
 *   16..31  frei, mit Nullen gefuellt
 */

import { openSync, readSync, closeSync, writeFileSync, readFileSync, statSync } from 'node:fs';

export const KENNUNG = 'CVEK';
export const FASSUNG = 1;
export const KOPF_BYTES = 32;

export type Kopf = { anzahl: number; dimensionen: number; fassung: number };

/** Der Kopf als Puffer — 32 Byte, feste Laenge. */
export function kopfSchreiben(anzahl: number, dimensionen: number): Buffer {
  const b = Buffer.alloc(KOPF_BYTES);
  b.write(KENNUNG, 0, 'ascii');
  b.writeUInt32LE(FASSUNG, 4);
  b.writeUInt32LE(anzahl, 8);
  b.writeUInt32LE(dimensionen, 12);
  return b;
}

/**
 * Den Kopf lesen — und pruefen, dass er zur Dateigroesse passt.
 *
 * Die Groessenpruefung ist der eigentliche Zweck. Bricht ein Lauf mitten im
 * Schreiben ab, steht im Kopf "500000 Vektoren", in der Datei liegen aber
 * 300000. Ohne diese Zeile laese der naechste Lauf Muell aus dem Nichts und
 * meldete ein Ergebnis.
 */
export function kopfLesen(puffer: Buffer, dateiBytes?: number): Kopf {
  if (puffer.length < KOPF_BYTES) throw new Error('Datei zu kurz fuer einen Kopf');
  const kennung = puffer.toString('ascii', 0, 4);
  if (kennung !== KENNUNG) {
    throw new Error(`Keine Vektordatei: Kennung "${kennung}" statt "${KENNUNG}"`);
  }
  const fassung = puffer.readUInt32LE(4);
  if (fassung !== FASSUNG) {
    throw new Error(`Fassung ${fassung} — dieses Programm kennt nur ${FASSUNG}`);
  }
  const anzahl = puffer.readUInt32LE(8);
  const dimensionen = puffer.readUInt32LE(12);
  if (dimensionen === 0) throw new Error('Kopf nennt 0 Dimensionen');

  if (dateiBytes !== undefined) {
    const erwartet = KOPF_BYTES + anzahl * dimensionen * 4;
    if (dateiBytes !== erwartet) {
      throw new Error(
        `Datei ist ${dateiBytes} Byte, der Kopf verspricht ${erwartet} `
        + `(${anzahl} Vektoren a ${dimensionen}). Der Lauf ist abgebrochen — `
        + 'die Datei ist NICHT brauchbar.',
      );
    }
  }
  return { anzahl, dimensionen, fassung };
}

/**
 * Alle Vektoren in eine Datei schreiben.
 *
 * @param ziel     Pfad der .vek-Datei; daneben entsteht .vek.idx
 * @param eintraege Schluessel und Vektor, in der Reihenfolge, in der sie
 *                  geschrieben werden sollen
 */
export function schreiben(ziel: string, eintraege: Array<[string, number[]]>): void {
  if (eintraege.length === 0) {
    // Eine leere Vektordatei ist fast immer ein abgebrochener Lauf. Sie zu
    // schreiben hiesse, den Abbruch als Ergebnis zu buchen.
    throw new Error('NICHT GESCHRIEBEN: keine Vektoren uebergeben.');
  }
  const dim = eintraege[0][1].length;
  const teile: Buffer[] = [kopfSchreiben(eintraege.length, dim)];
  const schluessel: string[] = [];

  for (const [k, v] of eintraege) {
    if (v.length !== dim) {
      throw new Error(`"${k}" hat ${v.length} Dimensionen, erwartet ${dim}. `
        + 'Verschieden lange Vektoren gehoeren nicht in eine Datei.');
    }
    const f = new Float32Array(v);
    teile.push(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
    schluessel.push(k);
  }

  writeFileSync(ziel, Buffer.concat(teile));
  writeFileSync(`${ziel}.idx`, JSON.stringify({ schluessel }));
}

/**
 * Alle Vektoren aus einer Datei lesen.
 *
 * Gibt eine einfache Zuordnung Schluessel → Vektor zurueck, damit die
 * bestehenden Messwerkzeuge nichts umlernen muessen.
 */
export function lesen(quelle: string): Record<string, number[]> {
  const bytes = statSync(quelle).size;
  const fd = openSync(quelle, 'r');
  try {
    const kopfPuffer = Buffer.alloc(KOPF_BYTES);
    readSync(fd, kopfPuffer, 0, KOPF_BYTES, 0);
    const kopf = kopfLesen(kopfPuffer, bytes);

    const { schluessel } = JSON.parse(readFileSync(`${quelle}.idx`, 'utf8')) as { schluessel: string[] };
    if (schluessel.length !== kopf.anzahl) {
      throw new Error(
        `Der Schluesselindex nennt ${schluessel.length} Eintraege, der Kopf `
        + `${kopf.anzahl}. Die beiden Dateien gehoeren nicht zusammen.`,
      );
    }

    const daten = Buffer.alloc(kopf.anzahl * kopf.dimensionen * 4);
    readSync(fd, daten, 0, daten.length, KOPF_BYTES);
    /*
     * Buffer.buffer kann groesser sein als der Buffer selbst (Node teilt sich
     * einen Pool). Deshalb byteOffset und Laenge mitgeben — ohne sie liest
     * Float32Array in fremden Speicher hinein.
     */
    const alle = new Float32Array(daten.buffer, daten.byteOffset, kopf.anzahl * kopf.dimensionen);

    const aus: Record<string, number[]> = {};
    for (let i = 0; i < kopf.anzahl; i++) {
      aus[schluessel[i]] = Array.from(alle.subarray(i * kopf.dimensionen, (i + 1) * kopf.dimensionen));
    }
    return aus;
  } finally {
    closeSync(fd);
  }
}

/** Kosinus zweier Vektoren — zum Pruefen, dass float32 nichts kaputt macht. */
export function kosinus(a: readonly number[], b: readonly number[]): number {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / (Math.sqrt(aa) * Math.sqrt(bb));
}
