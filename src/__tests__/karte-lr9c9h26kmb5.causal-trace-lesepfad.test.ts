import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import { handleAdvancedTool } from '../handlers/advanced.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

/**
 * Karte lr9c9h26kmb5 — der DRITTE Lesepfad: causal_trace.
 *
 * smart_recall und recall_best_solution ziehen die Zugriffsgrenze (Karte
 * pguy341m6u7s). causal_trace tat es nicht: es liest cachly:lesson:* per
 * Textueberlappung und rendert what_worked/what_failed an jeden Fragenden.
 * causal_trace nimmt keinen author -- es kann nicht beweisen, WER fragt.
 *
 * Also die vorsichtige Richtung: private UND gruppen-beschraenkte Lektionen
 * fallen aus der Spur (fail-closed), team-weite bleiben der Normalfall.
 *
 * Der confused deputy an unserem eigenen Code: das Etikett sagt "group=security",
 * der dritte Weg gab den vollen Inhalt trotzdem heraus. Erst rot, dann gruen.
 */
describe('Karte lr9c9h26kmb5 — causal_trace zieht die Zugriffsgrenze', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () =>
    ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(() => {
    redis = new MockRedis();
  });

  const lerne = (topic: string, was: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool(
      'learn_from_attempts',
      { instance_id: 'i1', topic, outcome: 'success', what_worked: was, ...extra },
      getConn,
      noopApiFetch,
    );

  const spur = (problem: string) =>
    handleAdvancedTool('causal_trace', { instance_id: 'i1', problem }, getConn, noopApiFetch).then(String);

  it('gibt eine gruppen-beschraenkte Lektion NICHT heraus', async () => {
    await lerne('security:schluessel-drehen', 'Der xyzzy Schluessel wird quartalsweise gedreht', {
      group: 'security',
      author: 'alice',
    });
    const out = await spur('xyzzy schluessel');
    expect(out, 'causal_trace kennt den Fragenden nicht — eine Gruppen-Lektion faellt aus der Spur')
      .not.toContain('quartalsweise');
  });

  it('gibt eine PRIVATE Lektion NICHT heraus (Fuzzy-Pfad wie smart_recall)', async () => {
    await lerne('notiz:geheim-pfad', 'Der plugh Pfad braucht das zzyzx Token', {
      visibility: 'private',
    });
    const out = await spur('plugh pfad');
    expect(out, 'privat wird in der Fuzzy-Spur nie eingeblendet').not.toContain('zzyzx');
  });

  it('bricht nicht an Hash-Schluesseln unter cachly:lesson:* ab (WRONGTYPE, 23.10.2026)', async () => {
    // Seit 20.08. liegen die Eingaenge einer Lektion als Hash daneben. Der
    // Fallback las ALLES unter cachly:lesson:* mit GET — Valkey wirft dann
    // WRONGTYPE, und causal_trace endete fuer den Fragenden mit einem Fehler.
    await lerne('deploy:spur-hash', 'Die quux Grenze liegt bei 110 Pods je Knoten');
    await redis.hset('cachly:lesson:eing:deploy:spur-hash', 'e0', 'quux grenze');
    const out = await spur('quux grenze');
    expect(out, 'die Lektion muss trotz Hash daneben gefunden werden').toContain('110 Pods');
  });

  it('GEGENPROBE: eine team-weite Lektion bleibt sichtbar (Normalfall lebt weiter)', async () => {
    // Ohne diese Probe koennte der Filter alles verschlucken und die zwei
    // Proben darueber waeren trotzdem gruen (Unterscheidbarkeit).
    await lerne('deploy:cache-nutzen', 'Die plugh Ebenen werden zwischengespeichert');
    const out = await spur('plugh ebenen');
    expect(out, 'team-weit, keine Grenze — muss durch').toContain('zwischengespeichert');
  });
});
