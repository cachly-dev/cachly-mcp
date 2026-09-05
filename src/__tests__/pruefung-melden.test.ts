/**
 * „Ich habe nachgeprüft" — die Gegenrichtung zu „Lesen ist kein Prüfen".
 *
 * Am 04.09.2026 wurde behoben, dass jeder Abruf `verified_at` auf jetzt
 * setzte. Dabei entstand eine Lücke, die beim Messen von Stufe 6 auffiel:
 * seither lässt sich das Feld NUR NOCH beim Schreiben setzen. Jede Lektion
 * verfällt unaufhaltsam, und der einzige Ausweg ist ein vollständiger
 * Neuschrieb mit `grund` — eine Begründung für eine Änderung, die keine ist.
 *
 * Die drei Prüfungen, an denen hier alles hängt:
 *   1. `haelt` wird NIE geraten. Weder true noch false als Vorgabe.
 *   2. Ein Fehlschlag LÖSCHT NICHTS. Er markiert.
 *   3. Ein Fehlschlag ohne Befund wird abgewiesen — eine Warnung ohne Inhalt
 *      ist Lärm.
 */

import { describe, it, expect } from 'vitest';
import {
  pruefeMeldung, wendeAn, BEFEHL_GRENZE, BEFUND_GRENZE,
} from '../pruefung-melden.js';

const JETZT = '2026-09-05T12:00:00.000Z';
const gut = (u: unknown) => pruefeMeldung(u as never, JETZT);

describe('pruefeMeldung — was hereinkommen darf', () => {
  it('nimmt eine bestandene Pruefung an', () => {
    const r = gut({ topic: 'deploy:bau-hero-node1', haelt: true,
                    geprueft_mit: 'curl -s http://127.0.0.1:3220/bereit' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.eintrag).toMatchObject({
      topic: 'deploy:bau-hero-node1', haelt: true, ts: JETZT,
      geprueft_mit: 'curl -s http://127.0.0.1:3220/bereit',
    });
  });

  it('nimmt einen Fehlschlag MIT Befund an', () => {
    const r = gut({ topic: 'whisper:node4', haelt: false,
                    befund: 'Port 3095 antwortet nicht mehr, jetzt 3096.' });
    expect(r.ok).toBe(true);
  });

  it('weist einen Fehlschlag OHNE Befund ab', () => {
    const r = gut({ topic: 'whisper:node4', haelt: false });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.grund).toMatch(/befund/i);
  });

  it('weist eine Meldung ohne topic ab', () => {
    expect(gut({ haelt: true }).ok).toBe(false);
  });

  /**
   * Die tragende Pruefung. Ein fehlendes `haelt` als `false` zu lesen
   * markierte richtige Lektionen als gefallen; als `true` zu lesen machte
   * ungeprueftes frisch. Beide Richtungen sind schlimmer als eine Absage.
   */
  it.each([undefined, null, '', 'true', 'ja', 1, 0])(
    'raet `haelt` nicht, wenn es %o ist', (wert) => {
      const r = gut({ topic: 'x', haelt: wert, befund: 'irgendwas' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.grund).toMatch(/true oder false/);
    },
  );

  it('weist einen zu langen Befehl ab', () => {
    const r = gut({ topic: 'x', haelt: true, geprueft_mit: 'c'.repeat(BEFEHL_GRENZE + 1) });
    expect(r.ok).toBe(false);
  });

  it('weist einen mehrzeiligen Befehl ab', () => {
    const r = gut({ topic: 'x', haelt: true, geprueft_mit: 'curl a\ncurl b' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.grund).toMatch(/EIN Befehl/);
  });

  it('weist einen zu langen Befund ab', () => {
    const r = gut({ topic: 'x', haelt: false, befund: 'b'.repeat(BEFUND_GRENZE + 1) });
    expect(r.ok).toBe(false);
  });

  it('laesst den Befehl weg, wenn keiner mitkam', () => {
    const r = gut({ topic: 'x', haelt: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.eintrag.geprueft_mit).toBeUndefined();
  });
});

describe('wendeAn — was sich an der Lektion aendert', () => {
  const alt = {
    topic: 'whisper:node4',
    what_worked: 'WHISPER LAEUFT AUF 10.8.0.7:3095',
    ts: '2026-06-01T00:00:00.000Z',
    verified_at: '2026-06-01T00:00:00.000Z',
    confidence: 0.5,
  };

  it('bestanden: setzt verified_at und Zuversicht zurueck', () => {
    const n = wendeAn(alt, { topic: 'whisper:node4', haelt: true, ts: JETZT });
    expect(n.verified_at).toBe(JETZT);
    expect(n.confidence).toBe(1.0);
  });

  it('bestanden: hebt eine fruehere gefallene Pruefung auf', () => {
    const vorher = { ...alt, pruefung_gefallen_am: '2026-08-01', pruefung_befund: 'weg' };
    const n = wendeAn(vorher, { topic: 'whisper:node4', haelt: true, ts: JETZT });
    expect(n.pruefung_gefallen_am).toBeUndefined();
    expect(n.pruefung_befund).toBeUndefined();
  });

  /** Ein Fehlschlag heisst nicht, dass die Lektion falsch ist — vielleicht war
   *  der Dienst nur gerade aus. Sie wird fraglich, nicht geloescht. */
  it('gefallen: loescht NICHTS und aendert den Text nicht', () => {
    const n = wendeAn(alt, {
      topic: 'whisper:node4', haelt: false, ts: JETZT, befund: 'Port tot',
    });
    expect(n.what_worked).toBe(alt.what_worked);
    expect(n.ts).toBe(alt.ts);
    expect(n.pruefung_gefallen_am).toBe(JETZT);
    expect(n.pruefung_befund).toBe('Port tot');
  });

  it('gefallen: laesst verified_at unangetastet', () => {
    const n = wendeAn(alt, {
      topic: 'whisper:node4', haelt: false, ts: JETZT, befund: 'Port tot',
    });
    expect(n.verified_at).toBe(alt.verified_at);
  });

  it('schreibt eine Pruefspur und kappt sie bei zwanzig', () => {
    let l: Record<string, unknown> = { ...alt };
    for (let i = 0; i < 25; i++) {
      l = wendeAn(l, { topic: 'x', haelt: true, ts: `2026-09-0${(i % 9) + 1}` });
    }
    expect((l.pruefspur as unknown[]).length).toBe(20);
  });

  it('fasst die urspruengliche Lektion nicht an', () => {
    const kopie = JSON.parse(JSON.stringify(alt));
    wendeAn(alt, { topic: 'x', haelt: true, ts: JETZT });
    expect(alt).toEqual(kopie);
  });
});
