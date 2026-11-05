/**
 * Der Nachtrag bettet kein Thema nach, dessen eigene Einbettung noch laeuft
 * (05.11.2026).
 *
 * Der Vermerk entsteht write-ahead, VOR der Einbettung. Waehrend einer
 * Schreibwelle stehen darum fast alle Themen im Nachtrags-Set — nicht weil
 * ihnen etwas fehlt, sondern weil ihre Einbettung noch wartet (seit 0.10.231
 * in der Schreib-Schlange des Clients). Jede fertige Lektion holte bis zu drei
 * davon "nach" und schickte denselben Text ein zweites Mal. Nachgestellt mit
 * 400 Lektionen: 186 von 1.386 Anfragen doppelt.
 *
 * GEGENPROBE: ohne laufendeSchreibungen in heileVektorNachtrag ist der erste
 * Fall rot (A wird zweimal eingebettet).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../embeddings.js', () => ({
  computeEmbedding: vi.fn(),
  hasEmbedProvider: () => true,
  EMBED_PROVIDER: 'cachly',
}));

import { handleBrainTool } from '../handlers/brain.js';
import { computeEmbedding } from '../embeddings.js';
import { VEKTOR_PRAEFIX, NAME_VEKTOR_PRAEFIX, ZWEIT_VEKTOR_PRAEFIX } from '../bedeutung.js';
import { AUSSETZER_VORSATZ, OHNE_SCHREIBVEKTOR } from '../aussetzer.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

const embedMock = vi.mocked(computeEmbedding);
const ausstehen = (ms = 150) => new Promise((r) => setTimeout(r, ms));

describe('Nachtrag und laufende Schreibungen', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const lerne = (topic: string, text: string) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic, outcome: 'success', what_worked: text,
    }, getConn, noopApiFetch);

  beforeEach(() => {
    redis = new MockRedis();
    embedMock.mockReset();
  });

  it('eine noch wartende Einbettung wird nicht ein zweites Mal geschickt', async () => {
    let loslassen: () => void = () => {};
    const haengt = new Promise<void>((r) => { loslassen = r; });
    embedMock.mockImplementation(async (text: string) => {
      if (text.includes('Alpha-Weg')) await haengt; // A wartet, wie in der Schreib-Schlange
      return [0.1, 0.2, 0.3];
    });

    await lerne('deploy:alpha', 'Alpha-Weg: Zeitgrenze auf 30 s.');
    await lerne('deploy:beta', 'Beta-Weg: DNS-Eintrag nachgezogen.');
    await ausstehen(); // B ist fertig und hat seinen Nachtrag gemacht

    const rufeFuerA = () => embedMock.mock.calls.filter(([t]) => String(t).includes('Alpha-Weg')).length;
    // A selbst: Volltext (wartet noch). Ein Nachtrag durch B haette einen zweiten geschickt.
    expect(rufeFuerA(), 'A wird nur von seinem eigenen Block eingebettet').toBe(1);

    loslassen();
    await ausstehen();
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:alpha`), 'A bekommt seinen Vektor trotzdem').not.toBeNull();
  });

  it('ein haengendes vec2 haelt den Namens-Vektor nicht auf (05.11.2026)', async () => {
    // node-4: nach 11 Minuten 221 vec, 26 vec2, 0 Namens-Vektoren.
    let loslassen: () => void = () => {};
    const haengt = new Promise<void>((r) => { loslassen = r; });
    embedMock.mockImplementation(async (_text: string, opts?: { modell?: string }) => {
      if (opts?.modell) await haengt; // vec2 rechnet ein langsamer Dienst
      return [0.1, 0.2, 0.3];
    });
    await lerne('deploy:gamma', 'Gamma-Weg: Cache geleert.');
    await ausstehen();
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:gamma`)).not.toBeNull();
    expect(await redis.get(`${NAME_VEKTOR_PRAEFIX}deploy:gamma`), 'der Namens-Vektor wartet nicht auf vec2').not.toBeNull();
    expect(await redis.get(`${ZWEIT_VEKTOR_PRAEFIX}deploy:gamma`)).toBeNull();
    loslassen();
    await ausstehen();
    expect(await redis.get(`${ZWEIT_VEKTOR_PRAEFIX}deploy:gamma`), 'vec2 kommt danach trotzdem').not.toBeNull();
  });

  it('ein gescheitertes vec2 hinterlaesst seinen Grund (05.11.2026)', async () => {
    // BEAM-Messung 4: 75 von 133 vec2 fehlten, kein Wort warum.
    embedMock.mockImplementation(async (_text: string, opts?: { modell?: string }) => {
      if (opts?.modell) throw new Error('embedding provider error: ollama API 500');
      return [0.1, 0.2, 0.3];
    });
    await lerne('deploy:delta', 'Delta-Weg: Port freigegeben.');
    await ausstehen();
    const vermerk = await redis.hgetall(`${AUSSETZER_VORSATZ}${OHNE_SCHREIBVEKTOR}`);
    expect(vermerk.text ?? '').toContain('Zweit-Vektor nicht geschrieben');
    expect(vermerk.text ?? '').toContain('ollama API 500');
  });

  it('KONTROLLE: ein Thema, dessen Block vorbei ist, heilt der Nachtrag weiter', async () => {
    // Erster Versuch fuer A scheitert (Block endet), danach gelingt alles.
    let erster = true;
    embedMock.mockImplementation(async (text: string) => {
      if (text.includes('Alpha-Weg') && erster) { erster = false; throw new Error('The operation was aborted due to timeout'); }
      return [0.1, 0.2, 0.3];
    });
    await lerne('deploy:alpha', 'Alpha-Weg: Zeitgrenze auf 30 s.');
    await ausstehen();
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:alpha`)).toBeNull();

    await lerne('deploy:beta', 'Beta-Weg: DNS-Eintrag nachgezogen.');
    await ausstehen();
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:alpha`), 'der Nachtrag durch B holt A nach').not.toBeNull();
  });
});
