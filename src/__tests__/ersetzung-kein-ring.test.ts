/**
 * Zwei Lektionen koennen sich nicht gegenseitig ersetzen.
 *
 * Gemessen am 03.09.2026 am echten Bestand: von 735 Lektionen trugen ZWEI
 * eine Ersetzungs-Kante — und die zwei zeigten aufeinander.
 *
 *   verfahren:designworkshop-hat-kein-auswerten...  ersetzt  designworkshop:auswerten...
 *   designworkshop:auswerten...                     ersetzt  verfahren:designworkshop-hat-kein...
 *
 * Beide koennen nicht die aktuelle Fassung sein. Das ist nicht nur unschoen:
 * die Verdraengung im Abruf haengt an der Reihenfolge, also unterdrueckt ein
 * Ring je nach Lesepfad mal die eine und mal die andere Fassung — und die
 * Korrektur kann still die Korrigierte verdecken.
 *
 * GEGENPROBE in derselben Datei: eine Kette A -> B -> C bleibt erlaubt.
 * Wer den Ring mit "ein Ziel darf nie selbst ersetzen" verbietet, verbietet
 * auch die Kette, und die ist der Normalfall einer zweimal korrigierten
 * Tatsache.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Ersetzung — kein Ring', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what, ...extra,
    }, getConn, noopApiFetch);

  const gelesen = async (topic: string) =>
    JSON.parse((await redis.get(`cachly:lesson:best:${topic}`))!) as {
      ersetzt?: string; ersetzt_durch?: string;
    };

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('lehnt die Rueckkante ab und sagt, was zu tun ist', async () => {
    await lerne('node:adresse-alt', 'node-4 liegt auf 10.8.0.4.');
    await lerne('node:adresse-neu', 'node-4 liegt auf 10.8.0.7, nicht auf .4.',
      { ersetzt: 'node:adresse-alt' });

    // Jetzt der Ring: die alte will die neue ersetzen.
    const aus = String(await lerne('node:adresse-alt', 'Doch wieder .4.', {
      ersetzt: 'node:adresse-neu',
      grund: 'Gegenprobe fuer den Ring',
    }));

    expect(aus).toContain('koennen sich nicht gegenseitig ersetzen');
    const alt = await gelesen('node:adresse-alt');
    expect(alt.ersetzt).toBeUndefined();

    // Die bestehende, richtige Kante bleibt unangetastet.
    const neu = await gelesen('node:adresse-neu');
    expect(neu.ersetzt).toBe('node:adresse-alt');
  });

  it('GEGENPROBE: die Kette A -> B -> C bleibt erlaubt', async () => {
    await lerne('port:a', 'Der Port ist 3001.');
    await lerne('port:b', 'Der Port ist 3201, nicht 3001.', { ersetzt: 'port:a' });
    const aus = String(await lerne('port:c', 'Der Port ist 3095.', { ersetzt: 'port:b' }));

    expect(aus).not.toContain('koennen sich nicht gegenseitig ersetzen');
    expect((await gelesen('port:c')).ersetzt).toBe('port:b');
    expect((await gelesen('port:b')).ersetzt).toBe('port:a');
    expect((await gelesen('port:b')).ersetzt_durch).toBe('port:c');
  });

  it('GEGENPROBE: eine Kante auf ein unbeteiligtes Thema bleibt erlaubt', async () => {
    await lerne('x:eins', 'Text eins.');
    await lerne('x:zwei', 'Text zwei.');
    const aus = String(await lerne('x:drei', 'Text drei.', { ersetzt: 'x:eins' }));

    expect(aus).not.toContain('koennen sich nicht gegenseitig ersetzen');
    expect((await gelesen('x:drei')).ersetzt).toBe('x:eins');
  });
});
