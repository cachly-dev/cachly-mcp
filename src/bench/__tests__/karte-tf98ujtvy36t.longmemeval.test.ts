/**
 * Karte tf98ujtvy36t — der fremde Pruefstand (LongMemEval) misst RETRIEVAL
 * auf Sitzungs-Ebene plus den dritten Ausgang (Abstention).
 *
 * Die Proben sichern die drei Bausteine des Harness, nicht den Datensatz:
 * Sitzungs-Rangliste aus Turn-Treffern, das Abraten-Urteil (Schweigen oder
 * knapper Sieg) und die Ende-zu-Ende-Messung einer kleinen Kunstfrage.
 */
import { describe, it, expect } from 'vitest';
import { sessionRaenge, abgeraten, messeFrage, type LmeFrage } from '../longmemeval.js';
import { ABLEHN_ABSTAND } from '../../rangfolge.js';

describe('sessionRaenge', () => {
  it('FINDE: jede Sitzung zaehlt an der Position ihres BESTEN Turns, einmal', () => {
    expect(sessionRaenge([
      { key: 'cachly:ctx:lme:s2#4' },
      { key: 'cachly:ctx:lme:s1#0' },
      { key: 'cachly:ctx:lme:s2#1' },
      { key: 'cachly:ctx:lme:s3#9' },
    ])).toEqual(['s2', 's1', 's3']);
  });

  it('GEGENPROBE: fremde Schluessel zaehlen nicht als Sitzung', () => {
    expect(sessionRaenge([{ key: 'cachly:lesson:best:deploy' }])).toEqual([]);
  });
});

describe('abgeraten — Schweigen oder knapper Sieg', () => {
  it('keine Treffer -> abgeraten (Schweigen)', () => {
    expect(abgeraten([])).toBe(true);
  });

  it('knapper Abstand unter ABLEHN_ABSTAND -> abgeraten', () => {
    expect(abgeraten([{ score: 1.0 }, { score: 1.0 - ABLEHN_ABSTAND / 2 }])).toBe(true);
  });

  it('GEGENPROBE: klarer Sieg -> NICHT abgeraten', () => {
    expect(abgeraten([{ score: 1.0 }, { score: 0.5 }])).toBe(false);
  });

  it('GEGENPROBE: ein einzelner Treffer ist ein klarer Sieg, kein knapper', () => {
    expect(abgeraten([{ score: 0.9 }])).toBe(false);
  });
});

describe('messeFrage — Ende zu Ende auf einer Kunstfrage', () => {
  const frage = (id: string, q: string, beweis: string[]): LmeFrage => ({
    question_id: id,
    question_type: 'single-session-user',
    question: q,
    answer: 'egal',
    question_date: '2023/05/30',
    haystack_dates: ['2023/05/01', '2023/05/02'],
    haystack_session_ids: ['sitzA', 'sitzB'],
    haystack_sessions: [
      [
        { role: 'user', content: 'Mein xyzzy-Generator zeigt Fehlercode 41 beim Kaltstart.' },
        { role: 'assistant', content: 'Der Fehlercode 41 des xyzzy-Generators bedeutet Unterspannung.' },
      ],
      [
        { role: 'user', content: 'Welche Farbe hat ein Gartenzaun aus Fichtenholz?' },
        { role: 'assistant', content: 'Meist unbehandelt grau oder lasiert braun.' },
      ],
    ],
    answer_session_ids: beweis,
  });

  it('FINDE: die Beweis-Sitzung liegt auf Rang 1', async () => {
    const e = await messeFrage(frage('f1', 'xyzzy-Generator Fehlercode 41', ['sitzA']), 5);
    expect(e.sessionRang).toBe(1);
    expect(e.abs).toBe(false);
  });

  it('GEGENPROBE (_abs): Beweis fehlt im Heuhaufen -> kein Rang, als _abs erkannt', async () => {
    const e = await messeFrage(frage('f2_abs', 'Wie hiess mein Klavierlehrer in Salzburg?', ['answer_f2_abs']), 5);
    expect(e.sessionRang).toBeNull();
    expect(e.abs).toBe(true);
  });
});
