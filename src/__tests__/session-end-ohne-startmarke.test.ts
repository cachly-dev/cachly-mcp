/**
 * session_end speichert die Zusammenfassung auch ohne Startmarke.
 *
 * Die Startmarke von session_start gibt es nur einmal je Brain
 * (cachly:session:current). Zwei Sitzungen auf demselben Brain: die erste
 * beendet und loescht die Marke. Bis 0.10.277 antwortete das zweite
 * session_end dann "No active session found" und warf die Zusammenfassung
 * weg (Beleg 27.11.2026).
 *
 * GEGENPROBE: mit Marke kommt der Hinweis nicht, die Dauer steht da.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('session_end ohne Startmarke', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const ende = (summary: string) =>
    handleBrainTool('session_end', { instance_id: 'marke-1', summary }, getConn, noopApiFetch);

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('zwei Sitzungen, eine Marke: auch die zweite Zusammenfassung wird gespeichert', async () => {
    await redis.set('cachly:session:current', JSON.stringify({ started: new Date(Date.now() - 30 * 60000).toISOString() }));

    const erste = String(await ende('Sitzung A: Logo getauscht.'));
    expect(erste).toContain('Session saved');
    expect(erste).not.toContain('No session_start marker');
    expect(await redis.get('cachly:session:current')).toBeNull();

    const zweite = String(await ende('Sitzung B: Maker-Kommentar gespeichert.'));
    expect(zweite).not.toContain('No active session found');
    expect(zweite).toContain('Session saved');
    expect(zweite).toContain('No session_start marker found');
    expect(zweite).toContain('Sitzung B: Maker-Kommentar gespeichert.');

    const last = JSON.parse((await redis.get('cachly:session:last'))!) as { summary: string; duration_min?: number };
    expect(last.summary).toBe('Sitzung B: Maker-Kommentar gespeichert.');
    expect(last.duration_min).toBeUndefined();

    const verlauf = await redis.lrange('cachly:session:history', 0, -1);
    expect(verlauf).toHaveLength(2);
  });

  it('GEGENPROBE: mit Startmarke kein Hinweis, Dauer steht in der Antwort', async () => {
    await redis.set('cachly:session:current', JSON.stringify({ started: new Date(Date.now() - 12 * 60000).toISOString() }));
    const out = String(await ende('Sitzung C: Test.'));
    expect(out).toContain('Session saved** · 12 min');
    expect(out).not.toContain('No session_start marker');
  });
});
