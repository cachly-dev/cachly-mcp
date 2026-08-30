/**
 * Karte kdqyy5syhxqn — Drei Etiketten, die keine Selbstauskunft brauchen.
 *
 * Der Vertrag: widersprochen/korrigiert/veraltet folgen aus EREIGNISSEN im
 * Bestand — niemand (Mensch oder Modell) wird gefragt, ob es geholfen hat.
 * Und die Gegenprobe der Karte: ein Abruf ohne spätere Ereignisse bekommt
 * KEIN Etikett, statt ersatzweise "benutzt" zu heißen.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { etikettenFuer, lieferJournalSchluessel } from '../etiketten.js';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('etikettenFuer — rein mechanisch', () => {
  const T0 = '2026-08-01T12:00:00.000Z';

  it('widersprochen: die Ersetzung kam NACH der Lieferung', () => {
    expect(etikettenFuer(T0, { ersetzt_durch: 'x', ersetzt_am: '2026-08-05T00:00:00Z' }))
      .toEqual(['widersprochen']);
  });

  it('veraltet: die Ersetzung war zur Lieferung SCHON da', () => {
    expect(etikettenFuer(T0, { ersetzt_durch: 'x', ersetzt_am: '2026-07-20T00:00:00Z' }))
      .toEqual(['veraltet']);
  });

  it('korrigiert: eine Bearbeitung binnen 14 Tagen nach der Lieferung', () => {
    expect(etikettenFuer(T0, { audit_trail: [{ ts: '2026-08-10T00:00:00Z' }] }))
      .toEqual(['korrigiert']);
  });

  it('eine Bearbeitung NACH der Frist ist keine Korrektur der Lieferung', () => {
    expect(etikettenFuer(T0, { audit_trail: [{ ts: '2026-09-20T00:00:00Z' }] })).toEqual([]);
  });

  it('eine Bearbeitung VOR der Lieferung zaehlt nicht — sie war schon drin', () => {
    expect(etikettenFuer(T0, { audit_trail: [{ ts: '2026-07-10T00:00:00Z' }] })).toEqual([]);
  });

  it('DIE GEGENPROBE DER KARTE: ohne spaetere Ereignisse KEIN Etikett', () => {
    // Nicht ersatzweise "benutzt" — ein leeres Array ist die ehrliche Antwort.
    expect(etikettenFuer(T0, {})).toEqual([]);
    expect(etikettenFuer(T0, null)).toEqual([]);
  });
});

describe('Das Liefer-Journal im Abruf', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => { redis = new MockRedis(); });

  it('smart_recall schreibt die gelieferten Themen ins Journal', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:x', outcome: 'success', what_worked: 'Der plugh-Weg.',
    }, getConn, noopApiFetch);
    await handleBrainTool('smart_recall', { instance_id: 'i1', query: 'plugh' }, getConn, noopApiFetch);

    const journal = await redis.lrange(lieferJournalSchluessel('i1'), 0, -1);
    expect(journal.length).toBe(1);
    const zeile = JSON.parse(journal[0]) as { ts: string; themen: string[] };
    expect(zeile.themen).toContain('deploy:x');
    expect(Date.parse(zeile.ts)).not.toBeNaN();
  });

  it('brain_metrics zaehlt die Etiketten aus dem Journal — ohne jede Selbstauskunft', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:alt', outcome: 'success', what_worked: 'Der plugh-Weg.',
    }, getConn, noopApiFetch);
    await handleBrainTool('smart_recall', { instance_id: 'i1', query: 'plugh' }, getConn, noopApiFetch);
    // Die Lieferzeit deterministisch in die Vergangenheit legen: im Test
    // passieren Lieferung und Ersetzung sonst im selben Millisekunden-Tick,
    // und 'ersetzt_am > geliefert' ist bewusst STRENG (ein Wettlauf ist
    // kein Vorwurf — siehe etiketten.ts).
    const k = lieferJournalSchluessel('i1');
    const [alteZeile] = await redis.lrange(k, 0, 0);
    const umdatiert = { ...JSON.parse(alteZeile), ts: new Date(Date.now() - 3_600_000).toISOString() };
    await redis.ltrim(k, 1, 0);
    await redis.lpush(k, JSON.stringify(umdatiert));
    // NACH der Lieferung ersetzt -> widersprochen.
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:neu', outcome: 'success',
      what_worked: 'Der echte Weg.', ersetzt: 'deploy:alt',
    }, getConn, noopApiFetch);

    const out = String(await handleBrainTool('brain_metrics', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toContain('widersprochen');
    expect(out).toMatch(/1 widersprochen/);
  });
});
