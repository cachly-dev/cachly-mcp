/**
 * Woran eine Pruefung gescheitert ist (`ursache`, 11.11.2026).
 *
 * Anlass: Reid Marlow auf dev.to. Eine Pruefung, die an der Umgebung scheitert
 * (Staging in der Zeitgrenze, Lockfile hinkt), stellte eine gueltige Regel
 * unter Verdacht: smart_recall zeigte "❌ … FEHLGESCHLAGEN", und ein Agent,
 * der das liest, ueberspringt die Lektion.
 *
 * "'Assertion failed' is news about the note. 'Staging timed out' is news
 * about the day."
 *
 * Die tragenden Pruefungen:
 *   1. ursache="umgebung" markiert NICHT als gefallen, weder im Speicher noch
 *      im Abruf.
 *   2. ursache="aussage" und keine Angabe verhalten sich wie vorher.
 *   3. Eine bestandene Pruefung hebt beides auf.
 *   4. Ein unbekannter Wert wird abgewiesen, nicht still als "aussage" gelesen.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { pruefeMeldung, wendeAn } from '../pruefung-melden.js';
import { confidenceBadge } from '../confidence.js';
import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from './redis-mock.js';

const JETZT = '2026-11-11T12:00:00.000Z';
const melde = (u: unknown) => pruefeMeldung(u as never, JETZT);

const alt = {
  topic: 'deploy:staging',
  what_worked: 'DEPLOY MIT scripts/deploy.sh',
  ts: '2026-10-01T00:00:00.000Z',
  verified_at: '2026-10-01T00:00:00.000Z',
  confidence: 0.9,
};

describe('pruefeMeldung — die Fehlerart', () => {
  it('nimmt ursache="umgebung" bei einem Fehlschlag an', () => {
    const r = melde({ topic: 'deploy:staging', haelt: false, ursache: 'umgebung', befund: 'staging timed out' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.eintrag.ursache).toBe('umgebung');
  });

  it('verlangt auch bei der Umgebung einen Befund', () => {
    expect(melde({ topic: 'x', haelt: false, ursache: 'umgebung' }).ok).toBe(false);
  });

  it.each(['env', 'Umgebung', 'environment', 1, true])('raet die Fehlerart nicht, wenn sie %o ist', (wert) => {
    const r = melde({ topic: 'x', haelt: false, ursache: wert, befund: 'weg' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.grund).toMatch(/umgebung/);
  });

  it('eine bestandene Pruefung hat keine Fehlerart', () => {
    const r = melde({ topic: 'x', haelt: true, ursache: 'umgebung' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.eintrag.ursache).toBeUndefined();
  });

  it('ohne Angabe bleibt die Fehlerart leer (= aussage, wie bisher)', () => {
    const r = melde({ topic: 'x', haelt: false, befund: 'Port tot' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.eintrag.ursache).toBeUndefined();
  });
});

describe('wendeAn — Umgebung ist keine Nachricht ueber die Lektion', () => {
  /** Die tragende Pruefung. */
  it('umgebung: markiert NICHT als gefallen und laesst verified_at und Zuversicht stehen', () => {
    const n = wendeAn(alt, { topic: alt.topic, haelt: false, ts: JETZT, befund: 'staging timed out', ursache: 'umgebung' });
    expect(n.pruefung_gefallen_am).toBeUndefined();
    expect(n.pruefung_befund).toBeUndefined();
    expect(n.verified_at).toBe(alt.verified_at);
    expect(n.confidence).toBe(alt.confidence);
    expect(n.pruefung_umgebung_am).toBe(JETZT);
    expect(n.pruefung_umgebung_befund).toBe('staging timed out');
  });

  it('umgebung: eine fruehere gefallene Pruefung bleibt, wie sie war', () => {
    const vorher = { ...alt, pruefung_gefallen_am: '2026-11-01', pruefung_befund: 'Skript fehlt' };
    const n = wendeAn(vorher, { topic: alt.topic, haelt: false, ts: JETZT, befund: 'timeout', ursache: 'umgebung' });
    expect(n.pruefung_gefallen_am).toBe('2026-11-01');
    expect(n.pruefung_befund).toBe('Skript fehlt');
  });

  it.each([['aussage', 'aussage' as const], ['ohne Angabe', undefined]])(
    '%s: markiert wie bisher und ersetzt den Umgebungshinweis', (_n, ursache) => {
      const vorher = { ...alt, pruefung_umgebung_am: '2026-11-10', pruefung_umgebung_befund: 'timeout' };
      const n = wendeAn(vorher, { topic: alt.topic, haelt: false, ts: JETZT, befund: 'make deploy statt Skript', ursache });
      expect(n.pruefung_gefallen_am).toBe(JETZT);
      expect(n.pruefung_befund).toBe('make deploy statt Skript');
      expect(n.pruefung_umgebung_am).toBeUndefined();
    },
  );

  it('bestanden: hebt Fehlschlag UND Umgebungshinweis auf', () => {
    const vorher = { ...alt, pruefung_gefallen_am: '2026-11-01', pruefung_befund: 'x',
      pruefung_umgebung_am: '2026-11-10', pruefung_umgebung_befund: 'timeout' };
    const n = wendeAn(vorher, { topic: alt.topic, haelt: true, ts: JETZT });
    for (const f of ['pruefung_gefallen_am', 'pruefung_befund', 'pruefung_umgebung_am', 'pruefung_umgebung_befund']) {
      expect(n[f], f).toBeUndefined();
    }
  });

  it('die Pruefspur behaelt die Fehlerart', () => {
    const n = wendeAn(alt, { topic: alt.topic, haelt: false, ts: JETZT, befund: 'timeout', ursache: 'umgebung' });
    expect((n.pruefspur as Array<{ ursache?: string }>).at(-1)?.ursache).toBe('umgebung');
  });
});

describe('confidenceBadge — der leise Hinweis', () => {
  it('ein gruenes Haekchen bleibt gruen und bekommt den Hinweis angehaengt', () => {
    const b = confidenceBadge(1.0, 0, undefined, undefined, { am: '2026-11-11T09:00:00Z', befund: 'staging timed out' });
    expect(b.startsWith('✅')).toBe(true);
    expect(b).toContain('failed on the environment, not on this lesson');
    expect(b).toContain('staging timed out');
    expect(b).not.toContain('CHECK FAILED');
  });

  it('neben einer gefallenen Pruefung schweigt er', () => {
    const b = confidenceBadge(1.0, 0, undefined, { am: '2026-11-01', befund: 'Skript fehlt' }, { am: '2026-11-11', befund: 'timeout' });
    expect(b).toContain('CHECK FAILED');
    expect(b).not.toContain('environment');
  });

  it('ohne Hinweis bleibt der Badge unveraendert', () => {
    expect(confidenceBadge(1.0, 0)).toBe('✅');
    expect(confidenceBadge(1.0, 0, undefined, undefined, { am: '' })).toBe('✅');
  });
});

/**
 * Der ganze Weg, wie ein Agent ihn geht: melden, dann abrufen.
 * Gegenprobe: dieselbe Meldung mit ursache="aussage" MUSS "CHECK FAILED"
 * zeigen — sonst beweist der erste Fall nichts.
 */
describe('lesson_verified -> recall_best_solution', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const apiFetch = (async () => null) as unknown as Parameters<typeof handleBrainTool>[3];

  beforeEach(async () => {
    redis = new MockRedis();
    await redis.set(`cachly:lesson:best:${alt.topic}`, JSON.stringify({
      ...alt, outcome: 'success', severity: 'major', what_failed: '', tags: ['deploy'], verified_at: new Date().toISOString(),
    }));
  });

  async function meldeUndHole(ursache: string) {
    const meldung = String(await handleBrainTool('lesson_verified',
      { instance_id: 'i1', topic: alt.topic, haelt: false, ursache, befund: 'staging timed out' }, getConn, apiFetch));
    const abruf = String(await handleBrainTool('recall_best_solution',
      { instance_id: 'i1', topic: alt.topic }, getConn, apiFetch));
    return { meldung, abruf };
  }

  it('umgebung: keine Markierung, der Abruf zeigt den leisen Hinweis', async () => {
    const { meldung, abruf } = await meldeUndHole('umgebung');
    expect(meldung).toContain('an der Umgebung gescheitert');
    expect(meldung).not.toContain('ist als fraglich markiert');
    expect(abruf).not.toContain('CHECK FAILED');
    expect(abruf).toContain('failed on the environment');
    const gespeichert = JSON.parse((await redis.get(`cachly:lesson:best:${alt.topic}`))!);
    expect(gespeichert.pruefung_gefallen_am).toBeUndefined();
  });

  it('Gegenprobe aussage: markiert und zeigt CHECK FAILED', async () => {
    const { meldung, abruf } = await meldeUndHole('aussage');
    expect(meldung).toContain('ist als fraglich markiert');
    expect(abruf).toContain('CHECK FAILED');
  });
});
