import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from './redis-mock.js';

/**
 * smart_recall `limit` — die verlangte Trefferzahl kommt am ausgelieferten Pfad an.
 *
 * Das Modul (verlangteTiefe, GROW-043.recall-tiefe.test.ts) prueft nur die Zahl.
 * Hier zaehlt die Ausgabe: 25 passende Lektionen, und es erscheinen genau so viele,
 * wie verlangt — ohne Wert weiter 8, nie mehr als 20.
 * Anlass: LoCoMo mit einem Speicher je Gespraech braucht top_k = 20 (29.10.2026).
 */
describe('smart_recall limit', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () =>
    ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(async () => {
    redis = new MockRedis();
    for (let i = 0; i < 25; i++) {
      const n = String(i).padStart(2, '0');
      await handleBrainTool(
        'learn_from_attempts',
        { instance_id: 'i1', topic: `plugh:fall${n}`, outcome: 'success', what_worked: `plugh Befund ${n}: Ventil ${n} klemmt bei Kaelte ${i * 3} Grad` },
        getConn,
        noopApiFetch,
      );
    }
  });

  const zaehle = async (args: Record<string, unknown>) => {
    const out = String(await handleBrainTool('smart_recall', { instance_id: 'i1', query: 'plugh Ventil klemmt', ...args }, getConn, noopApiFetch));
    return new Set(out.match(/plugh:fall\d\d/g) ?? []).size;
  };

  it('ohne limit bleibt es bei 8', async () => {
    expect(await zaehle({})).toBe(8);
  });

  it('limit 20 liefert 20', async () => {
    expect(await zaehle({ limit: 20 })).toBe(20);
  });

  it('limit 3 liefert 3', async () => {
    expect(await zaehle({ limit: 3 })).toBe(3);
  });

  it('GEGENPROBE: mehr als 20 gibt es nicht, auch wenn 25 passen', async () => {
    expect(await zaehle({ limit: 1000 })).toBe(20);
  });
});
