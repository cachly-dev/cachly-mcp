/**
 * Sprachübergreifender Formattest für packe() — Pflichtstück aus der
 * Vektor-Lücke im REST-Lernweg (Roadmap rm_mt3ob5zo_waqd, 22.08.2026).
 *
 * Der REST-Lernweg (POST /api/v1/instances/:id/learn) bekam einen eigenen
 * Go-Nachbau des Packformats (api/internal/handler/lesson_vector.go,
 * packVector), weil kein Go-Pfad zuvor cachly:lesson:vec:* schrieb. Damit
 * beide Schreiber (MCP hier, REST in Go) für dieselbe Lektion denselben
 * Vektor-Byte-Inhalt ablegen, müssen sie für DENSELBEN Eingangsvektor
 * DENSELBEN base64-String liefern.
 *
 * Der erwartete String unten wurde EINMAL mit packe() erzeugt und dann in
 * BEIDE Tests eingetragen: hier und in
 * api/internal/handler/lesson_vector_test.go
 * (TestPackVectorMatchesTSReference).
 *
 * WER DAS PACKFORMAT AENDERT (hier in packe() ODER in packVector auf der
 * Go-Seite), MUSS BEIDE TESTS AENDERN — das ist der Zweck dieser Datei.
 */

import { describe, it, expect } from 'vitest';
import { packe } from './bedeutung.js';

describe('packe() — sprachübergreifender Formattest', () => {
  it('packt den festen Referenzvektor byteidentisch zum Go-Nachbau (packVector)', () => {
    // 8 krumme Werte, mit Vorzeichenwechsel und einer echten Null — genug,
    // um Skala-Berechnung, Rundung und Auffüllen (laenge % 4 == 1) gemeinsam
    // zu treffen.
    const vektor = [0.7834, -0.9912, 0.0027, -0.5, 0.1299, -0.4413, 0, 0.31785];
    expect(packe(vektor)).toBe('AQgAxr7/O2SBAMARxwApAAA=');
  });
});
