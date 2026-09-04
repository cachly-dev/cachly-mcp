/**
 * Karte eutmy0ly93ch — session_end nennt, was das Gedaechtnis gekostet hat:
 * Recalls, Wiederholungen (fast gleiche Anfrage), Token der Antworten.
 *
 * Anlass (Raju Dandigam, dev.to 02.09.2026, plus eigener Bench-Mitschnitt):
 * die Umformulierungs-Schleife — gleicher Abruf, andere Woerter, kein Fehler
 * dazwischen — ist im Erfolgsbild unsichtbar und der teuerste Pfad.
 *
 * GEGENPROBE: drei VERSCHIEDENE Anfragen zaehlen 0 Wiederholungen.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { istWiederholung, wortmenge, vergissSitzungsKosten } from '../sitzungs-kosten.js';

describe('Karte eutmy0ly93ch — Gedaechtnis-Kosten je Sitzung', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const recall = (query: string) =>
    handleBrainTool('smart_recall', { instance_id: 'kosten-1', query }, getConn, noopApiFetch);
  const ende = () =>
    handleBrainTool('session_end', { instance_id: 'kosten-1', summary: 'Probe.' }, getConn, noopApiFetch);

  beforeEach(async () => {
    redis = new MockRedis();
    vergissSitzungsKosten('kosten-1');
    await redis.set('cachly:session:current', JSON.stringify({ started: new Date().toISOString() }));
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'kosten-1', topic: 'deploy:timeout', outcome: 'success',
      what_worked: 'Der Deploy-Timeout lag an DNS, nicht am Netz.',
    }, getConn, noopApiFetch);
  });

  it('Wortmengen: Umformulierung ist Wiederholung, anderes Thema nicht', () => {
    expect(istWiederholung(wortmenge('deploy timeout netz'), wortmenge('timeout beim deploy im netz'))).toBe(true);
    expect(istWiederholung(wortmenge('deploy timeout netz'), wortmenge('redis eviction policy'))).toBe(false);
    expect(istWiederholung(wortmenge('x'), wortmenge('x'))).toBe(false);
  });

  it('drei umformulierte Abrufe: session_end meldet 3 Recalls, 2 Wiederholungen und den Hinweis', async () => {
    await recall('deploy timeout netz');
    await recall('timeout beim deploy im netz');
    await recall('netz deploy timeout ursache');
    const out = String(await ende());
    expect(out).toContain('3 Recalls, davon 2 Wiederholungen');
    expect(out).toContain('Token Werkzeugantworten');
    expect(out).toContain('Einmal abrufen, dann handeln');

    const last = JSON.parse((await redis.get('cachly:session:last'))!) as { memory_cost?: { recalls: number; wiederholungen: number } };
    expect(last.memory_cost?.recalls).toBe(3);
    expect(last.memory_cost?.wiederholungen).toBe(2);
  });

  it('GEGENPROBE: drei verschiedene Anfragen = 0 Wiederholungen, kein Hinweis; danach ist der Zaehler leer', async () => {
    await recall('deploy timeout netz');
    await recall('redis eviction policy');
    await recall('keycloak realm import');
    const out = String(await ende());
    expect(out).toContain('3 Recalls, davon 0 Wiederholungen');
    expect(out).not.toContain('Einmal abrufen, dann handeln');

    await redis.set('cachly:session:current', JSON.stringify({ started: new Date().toISOString() }));
    const leer = String(await ende());
    expect(leer).not.toContain('Gedächtnis-Kosten');
  });
});
