/**
 * Karte hcg8neyut0kd Teil (c) — der Vektor-Nachtrag.
 *
 * Vorher: scheiterte die Einbettung beim Schreiben, fehlte der Vektor FUER
 * IMMER — der Bedeutungsabgleich überging die Lektion still (drei
 * Kundeninstanzen, monatelang). Jetzt wird das Thema vermerkt und beim
 * nächsten Schreiben nachgebettet.
 *
 * Die Proben mocken das embeddings-Modul (vi.mock) — geprüft wird die MECHANIK: vermerken, nachholen,
 * bei erneutem Scheitern zurücklegen, bei gelöschter Lektion verfallen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// computeEmbedding wird gemockt, hasEmbedProvider liefert true — der ganze
// Rest des Handlers bleibt echt.
vi.mock('../embeddings.js', () => ({
  computeEmbedding: vi.fn(),
  hasEmbedProvider: () => true,
  EMBED_PROVIDER: 'test-provider',
}));

import { handleBrainTool } from '../handlers/brain.js';
import { computeEmbedding } from '../embeddings.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

const embedMock = vi.mocked(computeEmbedding);

/** fire-and-forget ausstehen lassen. */
const ausstehen = () => new Promise((r) => setTimeout(r, 120));

describe('Karte hcg8neyut0kd (c) — Vektor-Nachtrag', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;

  const lerne = (topic: string) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: `Weg fuer ${topic}.`,
    }, getConn, noopApiFetch);

  beforeEach(() => {
    redis = new MockRedis();
    embedMock.mockReset();
  });

  it('ein gescheitertes Einbetten VERMERKT das Thema statt es zu vergessen', async () => {
    embedMock.mockRejectedValue(new Error('fetch failed'));
    await lerne('deploy:kaputt');
    await ausstehen();

    expect(embedMock).toHaveBeenCalled();
    const vermerkt = await redis.smembers('cachly:vek:nachtrag');
    expect(vermerkt).toContain('deploy:kaputt');
    expect(await redis.get('cachly:lesson:vec:deploy:kaputt')).toBeNull();
  });

  it('das naechste Schreiben holt den Vektor NACH', async () => {
    embedMock.mockRejectedValue(new Error('fetch failed'));
    await lerne('deploy:kaputt');
    await ausstehen();

    // Der Dienst ist wieder da: das naechste Schreiben bettet sich selbst
    // UND traegt den Rueckstand nach.
    embedMock.mockResolvedValue([0.1, 0.2, 0.3]);
    await lerne('deploy:gesund');
    await ausstehen();

    expect(await redis.get('cachly:lesson:vec:deploy:kaputt')).not.toBeNull();
    expect(await redis.smembers('cachly:vek:nachtrag')).not.toContain('deploy:kaputt');
  });

  it('scheitert der Nachtrag erneut, geht das Thema ZURUECK in den Vermerk', async () => {
    embedMock.mockRejectedValue(new Error('fetch failed'));
    await lerne('deploy:kaputt');
    await ausstehen();
    // Auch das zweite Schreiben scheitert komplett.
    await lerne('deploy:auch-kaputt');
    await ausstehen();

    const vermerkt = await redis.smembers('cachly:vek:nachtrag');
    expect(vermerkt).toContain('deploy:kaputt');
    expect(vermerkt).toContain('deploy:auch-kaputt');
  });

  it('eine GELOESCHTE Lektion erledigt ihren Nachtrag von selbst', async () => {
    embedMock.mockRejectedValue(new Error('fetch failed'));
    await lerne('deploy:kaputt');
    await ausstehen();
    await redis.del('cachly:lesson:best:deploy:kaputt');

    embedMock.mockResolvedValue([0.1, 0.2, 0.3]);
    await lerne('deploy:gesund');
    await ausstehen();

    expect(await redis.smembers('cachly:vek:nachtrag')).toEqual([]);
    expect(await redis.get('cachly:lesson:vec:deploy:kaputt')).toBeNull();
  });
});
