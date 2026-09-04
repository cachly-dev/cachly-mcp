/**
 * Karte 4l030ay5xtj9 — Tatsachen altern: gilt_ab und gilt_bis.
 *
 * Mads Hansen (dev.to, 20.08.2026): observed-at und valid-from sind zwei
 * verschiedene Dinge. "node-4 ist Peer .7" gilt seit der Einrichtung am
 * 13.08. — nicht seit dem Tag, an dem es jemand aufschrieb.
 *
 * Die Grenze der Karte, hier festgenagelt: gilt_ab ist eine Aussage ueber
 * die TATSACHE, KEIN Verfall. Alter im Ranking riss am 19.08. alle
 * Bench-Floors — die Gegenprobe unten haelt fest, dass eine alte Lektion
 * OHNE gilt_bis vollkommen unmarkiert bleibt.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte 4l030ay5xtj9 — gilt_ab und gilt_bis', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what, ...extra,
    }, getConn, noopApiFetch);

  beforeEach(() => { redis = new MockRedis(); });

  it('gilt_ab wird gespeichert und im Abruf genannt', async () => {
    await lerne('whisper:node4', 'node-4 ist Peer .7.', { gilt_ab: '2026-08-13' });
    const out = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'whisper:node4',
    }, getConn, noopApiFetch));
    expect(out).toContain('Gilt seit 2026-08-13');
  });

  it('ein unlesbares gilt_ab wird NICHT gespeichert — kein erfundenes Datum', async () => {
    await lerne('deploy:x', 'Text.', { gilt_ab: 'irgendwann im Sommer' });
    const roh = JSON.parse((await redis.get('cachly:lesson:best:deploy:x'))!) as { gilt_ab?: string };
    expect(roh.gilt_ab).toBeUndefined();
  });

  it('die Ersetzung setzt gilt_bis auf der ALTEN Fassung', async () => {
    await lerne('deploy:alt', 'Der Timeout liegt am Netz.');
    await lerne('deploy:neu', 'Der Timeout lag an DNS.', { ersetzt: 'deploy:alt' });
    const alt = JSON.parse((await redis.get('cachly:lesson:best:deploy:alt'))!) as { gilt_bis?: string };
    expect(alt.gilt_bis).toBeDefined();
  });

  it('eine abgelaufene Tatsache wird als GESCHICHTE angeboten, bleibt aber lesbar', async () => {
    await lerne('deploy:alt', 'Der plugh-Timeout liegt am Netz.');
    // gilt_bis von Hand in die Vergangenheit legen — der Fall "Tatsache
    // abgelaufen ohne Nachfolger" (z. B. Server abgeschaltet).
    const roh = JSON.parse((await redis.get('cachly:lesson:best:deploy:alt'))!) as Record<string, unknown>;
    roh.gilt_bis = '2026-01-01T00:00:00.000Z';
    await redis.set('cachly:lesson:best:deploy:alt', JSON.stringify(roh));

    const einzeln = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:alt',
    }, getConn, noopApiFetch));
    expect(einzeln).toContain('GALT BIS 2026-01-01');
    expect(einzeln).toContain('liegt am Netz'); // lesbar bleibt lesbar

    const suche = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'plugh timeout',
    }, getConn, noopApiFetch));
    expect(suche).toContain('galt bis 2026-01-01');
    expect(suche).toContain('liegt am Netz'); // auffindbar bleibt auffindbar
  });

  it('GEGENPROBE: eine alte Lektion OHNE gilt_bis bleibt voellig unmarkiert', async () => {
    // Der Verfalls-Irrweg vom 19.08. darf nicht durch die Hintertuer
    // zurueckkommen: Alter allein ist KEIN Makel.
    await lerne('deploy:alt-aber-wahr', 'Der plugh-Timeout liegt am Netz.');
    const roh = JSON.parse((await redis.get('cachly:lesson:best:deploy:alt-aber-wahr'))!) as Record<string, unknown>;
    roh.ts = '2024-01-01T00:00:00.000Z'; // uralt
    await redis.set('cachly:lesson:best:deploy:alt-aber-wahr', JSON.stringify(roh));

    const suche = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'plugh timeout',
    }, getConn, noopApiFetch));
    expect(suche).not.toContain('Geschichte');
    expect(suche).toContain('liegt am Netz');
  });
});
