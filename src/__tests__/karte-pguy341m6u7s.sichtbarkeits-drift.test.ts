/**
 * Karte pguy341m6u7s — Sichtbarkeits-Drift im Recall-Pfad ("persistence is
 * not permission", Rodrigo Diego, 25.08.2026).
 *
 * Die Leitfrage: prueft der LESEpfad die Sichtbarkeit von HEUTE — auch in
 * den Nebenpfaden? Der Hauptpfad tut es (private Lektionen fliegen aus
 * smart_recall zur Lesezeit). Die Luecke sitzt in den ersetzt-Wegweisern
 * von heute frueh: Banner und Verdraengungs-Notiz nennen den NACHFOLGER
 * beim Topic-Namen und leiten zu recall_best_solution — auch wenn der
 * Nachfolger PRIVAT ist. Das leakt Existenz + Namen und liefert die
 * Abruf-Anleitung gleich mit.
 *
 * Abnahme: ein privater Nachfolger wird NIE beim Namen genannt; die alte,
 * team-sichtbare Fassung bleibt Treffer (Verdraengung durch Unsichtbares
 * waere stiller Wissensverlust — dasselbe Muster wie beim geloeschten
 * Nachfolger, Karte g4j4fy030fsp). GEGENPROBEN: team-sichtbare Nachfolger
 * verhalten sich exakt wie bisher; Lesezeit-Filter fuer private bleibt.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte pguy341m6u7s — Sichtbarkeits-Drift im Recall-Pfad', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string, what: string, extra: Record<string, unknown> = {}) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: what, ...extra,
    }, getConn, noopApiFetch);

  /** Nachtraeglicher Drift: Sichtbarkeit direkt in der Zeile verengen. */
  const macheePrivat = async (topic: string) => {
    const raw = await redis.get(`cachly:lesson:best:${topic}`);
    const l = JSON.parse(raw!);
    l.visibility = 'private';
    await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(l));
  };

  beforeEach(() => {
    redis = new MockRedis();
  });

  it('DRIFT-BEWEIS: eine nachtraeglich privat gestellte Lektion verschwindet aus smart_recall', async () => {
    await lerne('deploy:sichtbar', 'Der plugh-Timeout liegt am Netz.');
    await macheePrivat('deploy:sichtbar');
    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'plugh timeout',
    }, getConn, noopApiFetch));
    expect(out).not.toContain('liegt am Netz');
  });

  it('smart_recall: PRIVATER Nachfolger wird nicht beim Namen genannt, die alte Fassung bleibt Treffer', async () => {
    await lerne('deploy:alte-weisheit', 'Der plugh-Timeout liegt am Netz.');
    await lerne('deploy:geheime-ursache', 'Der xyzzy-Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });
    await macheePrivat('deploy:geheime-ursache');

    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'plugh timeout',
    }, getConn, noopApiFetch));

    // Kein Namens-Leak, keine Abruf-Anleitung auf ein privates Topic:
    expect(out).not.toContain('deploy:geheime-ursache');
    expect(out).not.toContain('die gueltige Antwort:');
    // Die team-sichtbare alte Fassung bleibt lesbar (kein stiller Verlust):
    expect(out).toContain('liegt am Netz');
  });

  it('recall_best_solution: das Ersetzt-Banner nennt einen PRIVATEN Nachfolger nicht beim Namen', async () => {
    await lerne('deploy:alte-weisheit', 'Der Timeout liegt am Netz.');
    await lerne('deploy:geheime-ursache', 'Der Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });
    await macheePrivat('deploy:geheime-ursache');

    const out = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:alte-weisheit',
    }, getConn, noopApiFetch));

    expect(out).not.toContain('deploy:geheime-ursache');
    expect(out).not.toContain('die gueltige Antwort steht in');
    // Ehrlich bleiben: DASS ersetzt wurde, darf gesagt werden — nur nicht wodurch.
    expect(out.toLowerCase()).toContain('ersetzt');
  });

  it('GEGENPROBE: team-sichtbarer Nachfolger — Banner und Wegweiser exakt wie bisher', async () => {
    await lerne('deploy:alte-weisheit', 'Der Timeout liegt am Netz.');
    await lerne('deploy:echte-ursache', 'Der Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });

    const recall = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:alte-weisheit',
    }, getConn, noopApiFetch));
    expect(recall).toContain('DIESE FASSUNG IST ERSETZT');
    expect(recall).toContain('deploy:echte-ursache');
  });
});
