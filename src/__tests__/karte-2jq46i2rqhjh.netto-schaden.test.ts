/**
 * Karte 2jq46i2rqhjh — Netto-verhinderter-Schaden statt Trefferquote.
 *
 * Mads Hansen: "confirmed useful recalls minus corrections and incidents
 * caused by bad recalls." Unsere Zaehlung hatte keinen Term fuer Schaden —
 * ein Abruf, der eine Stunde in die falsche Richtung schickt, zaehlte wie
 * einer, der nie stattfand.
 *
 * DIE AKZEPTANZ DER KARTE: die Kennzahl KANN NEGATIV werden. Eine Zahl,
 * die nur steigen kann, misst nichts — genau das prueft die zweite Probe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import { lieferJournalSchluessel } from '../etiketten.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte 2jq46i2rqhjh — Netto-verhinderter-Schaden', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what, ...extra,
    }, getConn, noopApiFetch);

  beforeEach(() => { redis = new MockRedis(); });

  it('ohne Daten: der ehrliche Leerstand, keine Null-Behauptung', async () => {
    const out = String(await handleBrainTool('brain_metrics', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toContain('Netto-verhinderter-Schaden');
    expect(out).toContain('Noch keine Wirkungs- oder Schadens-Daten');
  });

  it('DIE AKZEPTANZ: nur Schaden, kein Nutzen -> die Zahl ist NEGATIV', async () => {
    await lerne('deploy:alt', 'Der plugh-Weg.');
    await handleBrainTool('smart_recall', { instance_id: 'i1', query: 'plugh' }, getConn, noopApiFetch);
    // Lieferung in die Vergangenheit datieren (deterministisch), dann widerlegen.
    const k = lieferJournalSchluessel('i1');
    const [zeile] = await redis.lrange(k, 0, 0);
    const alt = { ...JSON.parse(zeile), ts: new Date(Date.now() - 3_600_000).toISOString() };
    await redis.ltrim(k, 1, 0);
    await redis.lpush(k, JSON.stringify(alt));
    await lerne('deploy:neu', 'Der echte Weg.', { ersetzt: 'deploy:alt' });

    const out = String(await handleBrainTool('brain_metrics', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toMatch(/\*\*-1\*\*/);
    expect(out).toContain('1 spaeter widerlegt');
  });

  it('gemeldete Wirkung hebt die Zahl — Nutzen und Schaden verrechnen sich', async () => {
    await lerne('deploy:alt', 'Der plugh-Weg.');
    // Zwei bestaetigte Wirkungen von Hand in die Spur (das Melde-Werkzeug
    // selbst ist anderswo geprobt — hier zaehlt die Verrechnung).
    await redis.rpush('cachly:wirkung:i1',
      JSON.stringify({ geholfen: true, thema: 'deploy:alt' }),
      JSON.stringify({ geholfen: true, thema: 'deploy:alt' }),
      JSON.stringify({ geholfen: false, thema: 'deploy:alt' }));

    const out = String(await handleBrainTool('brain_metrics', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(out).toMatch(/\*\*\+2\*\*/);
    expect(out).toContain('2 bestaetigt geholfen');
    // geholfen=false ist KEIN Schaden im Sinne der Kennzahl — nur
    // widerlegte/veraltete LIEFERUNGEN sind es. Der Eintrag zaehlt zur
    // Gesamtzahl, nicht zum Abzug.
    expect(out).toContain('3 Eintraege');
  });
});
