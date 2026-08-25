/**
 * Karte g4j4fy030fsp — Haengende Ersetzung nach Loeschung.
 *
 * Der Schreibweg weist einen Verweis auf ein nie existierendes Thema ab
 * (karte-exa5ya3w2m0w). UNGEPRUEFT war die Loeschung NACH der Markierung:
 * A ersetzt B, dann wird A geloescht (cache_delete kann jeden Schluessel
 * treffen, Ops-Aufraeumen ebenso). Vorher zeigte recall_best_solution dann
 * "die gueltige Antwort steht in A" — ein Wegweiser ins Leere — und
 * smart_recall schickte mit derselben Formel in ein geloeschtes Thema.
 *
 * Abnahme: fehlt der Nachfolger, sagt der Abruf das offen und erklaert die
 * alte Fassung wieder fuer gueltig (mit Vorsicht), statt stumm auf ein
 * Nichts zu verweisen. GEGENPROBEN: existiert der Nachfolger, bleibt alles
 * exakt wie bisher (Banner, Verdraengung, Wegweiser).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

describe('Karte g4j4fy030fsp — haengende Ersetzung nach Loeschung', () => {
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

  it('recall_best_solution: Nachfolger geloescht -> alte Fassung gilt wieder, kein Wegweiser ins Leere', async () => {
    await lerne('deploy:alte-weisheit', 'Der Timeout liegt am Netz.');
    await lerne('deploy:echte-ursache', 'Der Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });
    await redis.del('cachly:lesson:best:deploy:echte-ursache');

    const out = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:alte-weisheit',
    }, getConn, noopApiFetch));

    expect(out).toContain('geloescht');
    expect(out).toContain('gilt wieder');
    // Der geloeschte Nachfolger wird GENANNT (Vorgeschichte), aber nicht
    // laenger als Ort der gueltigen Antwort ausgegeben.
    expect(out).toContain('deploy:echte-ursache');
    expect(out).not.toContain('die gueltige Antwort steht in');
    // Der Inhalt der alten Fassung ist wieder lesbar.
    expect(out).toContain('liegt am Netz');
  });

  it('smart_recall: Nachfolger geloescht -> alte Fassung bleibt Treffer, Notiz sagt es offen', async () => {
    await lerne('deploy:alte-weisheit', 'Der plugh-Timeout liegt am Netz.');
    await lerne('deploy:echte-ursache', 'Der xyzzy-Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });
    await redis.del('cachly:lesson:best:deploy:echte-ursache');

    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'plugh timeout',
    }, getConn, noopApiFetch));

    // Die alte Fassung ist als Treffer da (nicht verdraengt) …
    expect(out).toContain('liegt am Netz');
    // … und die Notiz erklaert die Lage, statt in ein totes Thema zu schicken.
    expect(out).toContain('geloescht');
    expect(out).toContain('gilt wieder');
    expect(out).not.toContain('die gueltige Antwort:');
  });

  it('GEGENPROBE recall: existierender Nachfolger -> Banner und Wegweiser unveraendert', async () => {
    await lerne('deploy:alte-weisheit', 'Der Timeout liegt am Netz.');
    await lerne('deploy:echte-ursache', 'Der Timeout lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });

    const out = String(await handleBrainTool('recall_best_solution', {
      instance_id: 'i1', topic: 'deploy:alte-weisheit',
    }, getConn, noopApiFetch));

    expect(out).toContain('DIESE FASSUNG IST ERSETZT');
    expect(out).toContain('die gueltige Antwort steht in');
    expect(out).not.toContain('gilt wieder');
  });

  it('GEGENPROBE smart_recall: existierender Nachfolger ausserhalb der Liste -> Wegweiser unveraendert', async () => {
    await lerne('deploy:alte-weisheit', 'Der plugh-Timeout liegt am Netz.');
    // Nachfolger existiert, matcht die Query aber nicht (andere Woerter).
    await lerne('deploy:echte-ursache', 'Der xyzzy-Ausfall lag an DNS.', { ersetzt: 'deploy:alte-weisheit' });

    const out = String(await handleBrainTool('smart_recall', {
      instance_id: 'i1', query: 'plugh timeout',
    }, getConn, noopApiFetch));

    expect(out).toContain('die gueltige Antwort:');
    expect(out).not.toContain('gilt wieder');
  });
});
