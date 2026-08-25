/**
 * Karte exa5ya3w2m0w — Die widerlegte Lektion liegt gleichberechtigt neben
 * ihrer Korrektur.
 *
 * Gemessen am 20.08.2026: 47 von 521 Lektionen korrigieren AUSDRUECKLICH eine
 * fruehere unter anderem Themennamen — keine einzige war verknuepft. Die
 * widerlegte Fassung konnte jederzeit statt der Korrektur zurueckkommen.
 *
 * Abnahme der Karte: eine ersetzende Lektion verdraengt die alte im Abruf UND
 * nennt sie. GEGENPROBE: zwei Lektionen zum selben Thema OHNE Ersetzung
 * werden weiterhin beide gezeigt — sonst waere aus dem Mischen ein stilles
 * Verschlucken geworden.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte exa5ya3w2m0w — Ersetzung quer ueber Themen', () => {
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

  it('markiert beide Seiten: die neue traegt ersetzt, die alte ersetzt_durch', async () => {
    await lerne('deploy:alte-weisheit', 'Der Timeout liegt am Netz.');
    await lerne('deploy:echte-ursache', 'Der Timeout lag an DNS, nicht am Netz.', { ersetzt: 'deploy:alte-weisheit' });

    const neu = JSON.parse((await redis.get('cachly:lesson:best:deploy:echte-ursache'))!) as { ersetzt?: string };
    const alt = JSON.parse((await redis.get('cachly:lesson:best:deploy:alte-weisheit'))!) as { ersetzt_durch?: string; ersetzt_am?: string };
    expect(neu.ersetzt).toBe('deploy:alte-weisheit');
    expect(alt.ersetzt_durch).toBe('deploy:echte-ursache');
    expect(alt.ersetzt_am).toBeDefined();
  });

  it('ein Verweis auf ein Thema, das nicht existiert, wird NICHT gespeichert', async () => {
    const out = String(await lerne('deploy:neu', 'Text.', { ersetzt: 'gibt:es-nicht' }));
    expect(out).toContain('existiert nicht');
    const neu = JSON.parse((await redis.get('cachly:lesson:best:deploy:neu'))!) as { ersetzt?: string };
    expect(neu.ersetzt).toBeUndefined();
  });

  it('recall_best_solution auf die alte Fassung zeigt das Ersetzt-Banner ZUERST', async () => {
    await lerne('deploy:alte-weisheit', 'Der Timeout liegt am Netz.');
    await lerne('deploy:echte-ursache', 'Der Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });

    const out = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:alte-weisheit',
    }, getConn, noopApiFetch));
    expect(out).toContain('DIESE FASSUNG IST ERSETZT');
    expect(out).toContain('deploy:echte-ursache');
    // Vorgeschichte bleibt lesbar — der alte Text steht weiter drin.
    expect(out).toContain('Der Timeout liegt am Netz.');
  });

  it('smart_recall verdraengt die ersetzte Fassung und NENNT sie', async () => {
    await lerne('deploy:alte-weisheit', 'Der plugh-Timeout liegt am Netz.');
    await lerne('deploy:echte-ursache', 'Der plugh-Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });

    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'plugh timeout',
    }, getConn, noopApiFetch));
    expect(out).toContain('verdraengt');
    expect(out).toContain('deploy:alte-weisheit');
    // Der alte VOLLTEXT erscheint nicht mehr als eigener Treffer.
    expect(out).not.toContain('liegt am Netz');
  });

  it('GEGENPROBE: zwei Lektionen zum selben Thema OHNE Verweis bleiben beide sichtbar', async () => {
    await lerne('deploy:sicht-a', 'Der plugh-Timeout liegt am Netz.');
    await lerne('deploy:sicht-b', 'Der plugh-Timeout lag an DNS.');

    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'plugh timeout',
    }, getConn, noopApiFetch));
    expect(out).toContain('sicht-a');
    expect(out).toContain('sicht-b');
    expect(out).not.toContain('verdraengt');
  });
});
