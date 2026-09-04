/**
 * Karte rekvh30prcet — Der Verweis auf die Ersetzung nennt den Grund, nicht
 * nur den Nachfolger.
 *
 * Anlass (Mukesh, dev.to 02.09.2026): der Test fuer ein Gedaechtnis ist nicht
 * nur "sagt es das Neue?", sondern "kann es das Alte zeigen und sagen, warum
 * es fiel?". Seit Karte 5hlj9vvxeopp wird das Warum gespeichert — aber der
 * Abruf einer ersetzten Fassung nannte nur den Nachfolger.
 *
 * GEGENPROBE: ohne grund steht 'Grund nicht erfasst', nie ein leerer Satz.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte rekvh30prcet — Grund am Ersetzt-Verweis', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what, ...extra,
    }, getConn, noopApiFetch);

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('speichert den Grund auf der ALTEN Fassung und zeigt ihn in recall_best_solution', async () => {
    await lerne('deploy:alte-weisheit', 'Der Timeout liegt am Netz.');
    const out = String(await lerne('deploy:echte-ursache', 'Der Timeout lag an DNS, nicht am Netz.', {
      ersetzt: 'deploy:alte-weisheit', grund: 'tcpdump zeigte 30 s DNS-Wartezeit, das Netz war frei',
    }));
    expect(out).toContain('samt Grund');

    const alt = JSON.parse((await redis.get('cachly:lesson:best:deploy:alte-weisheit'))!) as { ersetzt_grund?: string };
    expect(alt.ersetzt_grund).toBe('tcpdump zeigte 30 s DNS-Wartezeit, das Netz war frei');

    const abruf = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:alte-weisheit',
    }, getConn, noopApiFetch));
    expect(abruf).toContain('DIESE FASSUNG IST ERSETZT');
    expect(abruf).toContain('Grund: tcpdump zeigte 30 s DNS-Wartezeit');
  });

  it('smart_recall nennt den Grund in der Verdraengungs-Notiz', async () => {
    await lerne('deploy:alte-weisheit', 'Der Deploy-Timeout liegt am Netz.');
    await lerne('deploy:echte-ursache', 'Der Deploy-Timeout lag an DNS, nicht am Netz.', {
      ersetzt: 'deploy:alte-weisheit', grund: 'DNS-Wartezeit gemessen',
    });
    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'deploy timeout netz',
    }, getConn, noopApiFetch));
    expect(out).toContain('verdraengt');
    expect(out).toContain('Grund: DNS-Wartezeit gemessen');
  });

  it('GEGENPROBE: ohne grund steht "Grund nicht erfasst" — und die learn-Ausgabe bittet um die Zeile', async () => {
    await lerne('deploy:alte-weisheit', 'Der Timeout liegt am Netz.');
    const out = String(await lerne('deploy:echte-ursache', 'Der Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' }));
    expect(out).toContain('Grund nicht erfasst');

    const abruf = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:alte-weisheit',
    }, getConn, noopApiFetch));
    expect(abruf).toContain('Grund nicht erfasst');
    expect(abruf).not.toContain('Grund: ');
  });
});
