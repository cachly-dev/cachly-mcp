/**
 * Ein Abruf, eine Zaehlung (03.09.2026).
 *
 * Das Dashboard zeigte 7.306 "Recalls" in der Analytics und 2.628 auf der
 * Startseite — dieselbe Instanz, dieselbe Woche. Ursache: `incr` auf
 * cachly:stats:recalls_total stand INNERHALB der Schleife ueber die bis zu
 * fuenf angezeigten Treffer. Damit zaehlte die Kennzahl Anzeigen, hiess aber
 * Abrufe, und "Knowledge reuse" war ein Verhaeltnis zweier Trefferzahlen
 * statt eines Anteils von Abrufen.
 *
 * Dieselbe Fehlerklasse hatten wir zweimal: PR #158 (Heartbeat-Pings) und
 * die Ersparnis-Rechnung (wertbeitrag.ts, "nur der erste Abruf zaehlt").
 *
 * GEGENPROBE: ein Abruf ohne Treffer zaehlt gar nicht.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('recalls_total zaehlt Abrufe, nicht Treffer', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  beforeEach(async () => {
    redis = new MockRedis();
    for (let i = 1; i <= 5; i++) {
      await handleBrainTool('learn_from_attempts', {
        instance_id: 'z1', topic: `deploy:dienst-${i}`, outcome: 'success',
        what_worked: `Dienst ${i} lauscht auf Port 80${i}0 und braucht das Deploy-Token.`,
        author: 'alice',
      }, getConn, noopApiFetch);
    }
  });

  it('EIN Abruf mit fuenf Treffern zaehlt EINS', async () => {
    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'z1', query: 'deploy dienst port token',
    }, getConn, noopApiFetch));
    expect(out).toContain('deploy:dienst'); // es gab wirklich Treffer
    await new Promise((r) => setTimeout(r, 60));
    expect(await redis.get('cachly:stats:recalls_total:z1')).toBe('1');
  });

  it('zwei Abrufe zaehlen zwei — und fremdes Wissen einmal je Abruf', async () => {
    for (let i = 0; i < 2; i++) {
      await handleBrainTool('smart_recall', {
        instance_id: 'z1', query: 'deploy dienst port token', author: 'bob',
      }, getConn, noopApiFetch);
    }
    await new Promise((r) => setTimeout(r, 80));
    expect(await redis.get('cachly:stats:recalls_total:z1')).toBe('2');
    // Alle fuenf Lektionen sind von alice, Abrufer ist bob: zwei Abrufe,
    // zwei Zaehlungen — nicht zehn.
    expect(await redis.get('cachly:stats:cross_author_recalls:z1')).toBe('2');
  });

  it('GEGENPROBE: ein Abruf ohne Treffer zaehlt nicht', async () => {
    const leer = new MockRedis();
    await handleBrainTool('smart_recall', {
      instance_id: 'z2', query: 'voellig anderes thema ohne treffer',
    }, async () => leer as unknown as Redis, noopApiFetch);
    await new Promise((r) => setTimeout(r, 60));
    expect(await leer.get('cachly:stats:recalls_total:z2')).toBeNull();
  });
});
