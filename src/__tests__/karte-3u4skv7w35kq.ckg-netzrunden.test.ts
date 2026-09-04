/**
 * Karte 3u4skv7w35kq — N+1 ueber Netzgrenzen: die Zahl MESSEN, nicht schaetzen.
 *
 * Der Fund: ckgRecordCollaboration machte je Co-Toucher-Paar vier
 * Redis-Round-Trips (get+set+sadd+sadd, symmetrisch also acht) — bei 25
 * Co-Touchern rund 200 Runden JE DATEI, in learn_from_attempts mal acht
 * Dateien. Ueber einen Cloud-Redis ist jede Runde eine Netzlatenz.
 *
 * Diese Proben zaehlen die Runden mit einem Proxy um den MockRedis und
 * halten fest: gebuendelt sind es VIER je Datei (smembers + mget +
 * pipeline-exec + sadd), und die geschriebenen Kanten sind BYTE-GLEICH
 * mit dem Einzelweg (dieselbe Fortschreibungs-Rechnung, eine Wahrheit).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import { ckgRecordCollaboration, ckgUpdateEdge, ckgUpdateEdgesGebuendelt } from '../ckg.js';
import { MockRedis } from './redis-mock.js';

/** Zaehlt jede Methode, die eine Netz-Runde waere (pipeline.exec = EINE). */
function mitZaehler(redis: MockRedis): { redis: Redis; runden: () => number } {
  let runden = 0;
  const zaehlbar = new Set(['get', 'set', 'sadd', 'smembers', 'mget', 'del', 'hgetall', 'hset', 'lrange']);
  const proxy = new Proxy(redis, {
    get(ziel, eigenschaft, empfaenger) {
      if (eigenschaft === 'pipeline') {
        return () => {
          const p = ziel.pipeline();
          return new Proxy(p, {
            get(pz, pe) {
              if (pe === 'exec') { return async () => { runden += 1; return pz.exec(); }; }
              return Reflect.get(pz, pe);
            },
          });
        };
      }
      const wert = Reflect.get(ziel, eigenschaft, empfaenger);
      if (typeof wert === 'function' && zaehlbar.has(String(eigenschaft))) {
        return (...args: unknown[]) => { runden += 1; return (wert as (...a: unknown[]) => unknown).apply(ziel, args); };
      }
      return wert;
    },
  });
  return { redis: proxy as unknown as Redis, runden: () => runden };
}

describe('ckgRecordCollaboration — Netzrunden gezaehlt', () => {
  let mock: MockRedis;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    mock = new MockRedis();
    // Zehn Vorgaenger auf der Datei — ein normal warmer Bestand.
    for (let i = 0; i < 10; i++) await mock.sadd('cachly:ckg:file:touchers:file:lib-db', `person:p${i}`);
  });

  afterEach(() => vi.useRealTimers());

  it('FINDE: hoechstens VIER Runden je Datei — nicht vier je Kante', async () => {
    const { redis, runden } = mitZaehler(mock);
    await ckgRecordCollaboration(redis, 'file:lib-db', 'person:neu');
    // smembers + mget + pipeline.exec + sadd = 4. Der alte Weg lag bei
    // 2 + 20 Kanten x 4 = 82 Runden fuer dieselben zehn Vorgaenger.
    expect(runden()).toBeLessThanOrEqual(4);
    // Und die Kanten stehen wirklich da — beide Richtungen.
    expect(await mock.get('cachly:ckg:edge:person:neu:collaborates:person:p3')).toBeTruthy();
    expect(await mock.get('cachly:ckg:edge:person:p3:collaborates:person:neu')).toBeTruthy();
  });

  it('GEGENPROBE: der Buendelweg schreibt BYTE-GLEICH zum Einzelweg', async () => {
    const einzel = new MockRedis();
    await ckgUpdateEdge(einzel as unknown as Redis, 'person:a', 'collaborates', 'person:b', true);
    await ckgUpdateEdge(einzel as unknown as Redis, 'person:a', 'collaborates', 'person:b', true);

    const buendel = new MockRedis();
    await ckgUpdateEdgesGebuendelt(buendel as unknown as Redis, [
      { from: 'person:a', edgeType: 'collaborates', to: 'person:b', success: true },
      { from: 'person:a', edgeType: 'collaborates', to: 'person:b', success: true },
    ]);

    const k = 'cachly:ckg:edge:person:a:collaborates:person:b';
    expect(await buendel.get(k)).toBe(await einzel.get(k));
    // Duplikat im Buendel wurde sequenziell fortgeschrieben: trials=2.
    expect(JSON.parse((await buendel.get(k)) as string).trials).toBe(2);
  });

  it('GEGENPROBE: ohne pipeline-Faehigkeit faellt der Weg auf Einzel-Aufrufe zurueck', async () => {
    const nackt = new MockRedis() as unknown as Record<string, unknown>;
    delete nackt.pipeline;
    await ckgUpdateEdgesGebuendelt(nackt as unknown as Redis, [
      { from: 'person:x', edgeType: 'collaborates', to: 'person:y', success: true },
    ]);
    expect(await (nackt as unknown as MockRedis).get('cachly:ckg:edge:person:x:collaborates:person:y')).toBeTruthy();
  });

  it('GEGENPROBE: leere Aenderungsliste macht NULL Runden', async () => {
    const { redis, runden } = mitZaehler(new MockRedis());
    await ckgUpdateEdgesGebuendelt(redis, []);
    expect(runden()).toBe(0);
  });
});
