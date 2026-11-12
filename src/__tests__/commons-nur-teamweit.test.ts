/**
 * Zwei Wege aus dem Team hinaus (12.11.2026, MCP 0.10.249):
 *
 * - fedbrain_contribute schickte jede Lektion, deren Namen man kannte, an die
 *   globalen Commons — private und Gruppen-Lektionen eingeschlossen.
 * - brain_federate kopierte jede Lektion samt Knoten und Kanten in ein anderes
 *   Brain, das andere Leute lesen.
 *
 * Seitdem geht nur Teamweites hinaus (istTeamweit / teamweitLesbar in utils.ts).
 * Jeder Test hat seine Positivkontrolle: die teamweite Lektion kommt an. Sonst
 * bewiese "keine Marke im Ausgang" nur, dass gar nichts ging.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { handleFedbrainTool } from '../handlers/fedbrain.js';
import { MockRedis } from './redis-mock.js';

const lektion = (topic: string, marke: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ topic, outcome: 'success', what_worked: `${marke} so geht es`, severity: 'major', ...extra });

type ApiFetch = Parameters<typeof handleFedbrainTool>[3];

describe('fedbrain_contribute: nur teamweite Lektionen gehen in die Commons', () => {
  let redis: MockRedis;
  let gesendet: string[];
  const apiFetch = (async (_pfad: string, opts?: { body?: string }) => {
    gesendet.push(String(opts?.body ?? ''));
    return {};
  }) as unknown as ApiFetch;
  const getConn = (async () => redis as unknown as Redis) as unknown as Parameters<typeof handleFedbrainTool>[2];
  const beitragen = async (key: string) =>
    String(await handleFedbrainTool('fedbrain_contribute', { instance_id: 'i1', lesson_key: key }, getConn, apiFetch));

  beforeEach(async () => {
    redis = new MockRedis();
    gesendet = [];
    await redis.set('cachly:lesson:best:team:offen', lektion('team:offen', 'OFFEN-MARKE', { visibility: 'team' }));
    await redis.set('cachly:lesson:best:geheim:privat', lektion('geheim:privat', 'PRIVAT-MARKE', { visibility: 'private' }));
    await redis.set('cachly:lesson:best:geheim:gruppe', lektion('geheim:gruppe', 'GRUPPE-MARKE', { group: 'backend' }));
  });

  it('Positivkontrolle: die teamweite Lektion geht hinaus', async () => {
    const aus = await beitragen('team:offen');
    expect(aus).toContain('FedBrain Contribute');
    expect(gesendet.join('\n')).toContain('OFFEN-MARKE');
  });

  it('private und Gruppen-Lektion: nichts gesendet, kein Zertifikat', async () => {
    for (const key of ['geheim:privat', 'geheim:gruppe']) {
      const aus = await beitragen(key);
      expect(aus).toContain('not found');
      expect(aus).not.toContain('Certificate');
    }
    expect(gesendet).toEqual([]);
    expect(await redis.smembers('cachly:fedbrain:contributed')).toEqual([]);
  });

  it('die Absage verraet nicht, dass es die private Lektion gibt: wortgleich mit "nicht vorhanden"', async () => {
    const privat = (await beitragen('geheim:privat')).replaceAll('geheim:privat', 'X');
    const fehlt = (await beitragen('gibt:es-nicht')).replaceAll('gibt:es-nicht', 'X');
    expect(privat).toBe(fehlt);
  });
});

describe('brain_federate: nur Teamweites wandert in ein anderes Brain', () => {
  let quelle: MockRedis;
  let ziel: MockRedis;
  const getConn = (async (id: string) => (id === 'quelle' ? quelle : ziel) as unknown as Redis) as unknown as Parameters<typeof handleFedbrainTool>[2];
  const apiFetch = (async () => ({})) as unknown as ApiFetch;
  const knoten = (id: string) => JSON.stringify({ id, domain: id.split(':')[0], type: 'problem', count: 1, ts: '2026-11-12T00:00:00Z' });
  const kante = async (von: string, nach: string) => {
    const key = `cachly:ckg:edge:${von}->${nach}`;
    await quelle.set(key, JSON.stringify({ from: von, to: nach, edgeType: 'related', successes: 3, trials: 3, confidence: 0.9, last_updated: '2026-11-12T00:00:00Z' }));
    await quelle.sadd(`cachly:ckg:idx:from:${von}`, key);
  };

  beforeEach(async () => {
    quelle = new MockRedis();
    ziel = new MockRedis();
    for (const id of ['team:offen', 'team:zwei', 'geheim:privat', 'geheim:gruppe', 'geheim:kaputt']) {
      await quelle.set(`cachly:ckg:node:${id}`, knoten(id));
    }
    await quelle.set('cachly:lesson:best:team:offen', lektion('team:offen', 'OFFEN-MARKE'));
    await quelle.set('cachly:lesson:best:team:zwei', lektion('team:zwei', 'ZWEI-MARKE', { visibility: 'team' }));
    await quelle.set('cachly:lesson:best:geheim:privat', lektion('geheim:privat', 'PRIVAT-MARKE', { visibility: 'private' }));
    await quelle.set('cachly:lesson:best:geheim:gruppe', lektion('geheim:gruppe', 'GRUPPE-MARKE', { group: 'backend' }));
    await quelle.set('cachly:lesson:best:geheim:kaputt', '{kein json');
    await kante('team:offen', 'team:zwei');
    await kante('team:offen', 'geheim:privat');
    await kante('team:zwei', 'geheim:gruppe');
  });

  it('kopiert teamweite Lektionen, Knoten und Kanten; alles Nicht-Teamweite bleibt, auch als Kantenziel', async () => {
    const aus = String(await handleFedbrainTool('brain_federate', { instance_id: 'ziel', source: 'quelle', domain: '*', min_confidence: 0.5 }, getConn, apiFetch));

    // Positivkontrolle
    expect(await ziel.get('cachly:lesson:best:team:offen')).toContain('OFFEN-MARKE');
    expect(await ziel.get('cachly:lesson:best:team:zwei')).toContain('ZWEI-MARKE');
    expect(await ziel.get('cachly:ckg:node:team:zwei')).not.toBeNull();
    expect(await ziel.get('cachly:ckg:edge:team:offen->team:zwei')).not.toBeNull();

    // Nichts, was einen der drei geheimen Namen traegt, ist im Ziel — kein Schluessel, kein Wert.
    const zielSchluessel = await new Promise<string[]>((res) => {
      const alle: string[] = [];
      const s = ziel.scanStream({ match: '*' });
      s.on('data', (b: string[]) => alle.push(...b));
      s.on('end', () => res(alle));
    });
    expect(zielSchluessel.length).toBeGreaterThan(4);
    for (const k of zielSchluessel) {
      expect(k).not.toContain('geheim');
      // Je nach Art lesen: Mengen (Kanten-Index), Liste (Herkunft), sonst Text.
      const werte = k.startsWith('cachly:ckg:idx:')
        ? await ziel.smembers(k)
        : k === 'cachly:fedbrain:federations'
          ? await ziel.lrange(k, 0, -1)
          : [(await ziel.get(k)) ?? ''];
      for (const w of werte) expect(w).not.toMatch(/geheim|PRIVAT-MARKE|GRUPPE-MARKE/);
    }

    expect(aus).toContain('3 not team-wide');
    expect(aus).not.toContain('PRIVAT-MARKE');
    expect(aus).not.toContain('GRUPPE-MARKE');
  });

  it('auch der Probelauf nennt keine geheime Lektion', async () => {
    const aus = String(await handleFedbrainTool('brain_federate', { instance_id: 'ziel', source: 'quelle', domain: '*', dry_run: true }, getConn, apiFetch));
    expect(aus).toContain('DRY RUN');
    expect(aus).toContain('OFFEN-MARKE'.slice(0, 5));
    expect(aus).not.toMatch(/geheim|PRIVAT-MARKE|GRUPPE-MARKE/);
  });
});
