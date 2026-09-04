/**
 * Karte cgf6kcyrg02s, Schritt "Bestand nachrechnen": Lektionen mit Erst-,
 * aber ohne Zweitvektor bekommen ihn beim Lesen nach — drei je Abruf —
 * und brain_doctor zeigt die Deckung des Zweitmodells.
 *
 * Warum: der Heiler sah nur Erstvektor-Luecken. Eine Instanz aus der Zeit
 * vor dem Zweitmodell blieb damit fuer immer unter der 80-%-Schwelle, das
 * Merkmal fuer immer aus — und von aussen sah das wie "an" aus.
 *
 * GEGENPROBE: liegt die Deckung schon ueber der Schwelle, wird nichts
 * nachgerechnet (kein einziger Zweitmodell-Aufruf).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const embedMock = vi.hoisted(() => ({ zweitAufrufe: 0 }));

vi.mock('../embeddings.js', async (original) => {
  const echt = await original<typeof import('../embeddings.js')>();
  return {
    ...echt,
    hasEmbedProvider: () => true,
    EMBED_PROVIDER: 'cachly',
    computeEmbedding: vi.fn(async (_t: string, opts?: { modell?: string }) => {
      if (opts?.modell) embedMock.zweitAufrufe++;
      const v = new Array(32).fill(0); v[0] = 1; return v;
    }),
  };
});

import { handleBrainTool } from '../handlers/brain.js';
import { handleTeamTool } from '../handlers/team.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { ZWEIT_VEKTOR_PRAEFIX } from '../bedeutung.js';

describe('Karte cgf6kcyrg02s — Zweitvektoren nachrechnen', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const warte = () => new Promise((r) => setTimeout(r, 80));

  beforeEach(async () => {
    redis = new MockRedis();
    embedMock.zweitAufrufe = 0;
    for (let i = 1; i <= 6; i++) {
      await handleBrainTool('learn_from_attempts', {
        instance_id: 'z1', topic: `deploy:dienst-${i}`, outcome: 'success',
        what_worked: `Dienst ${i} lauscht auf Port 80${i}0 und braucht das Deploy-Token.`,
      }, getConn, noopApiFetch);
    }
    await warte();
  });

  it('Altbestand ohne Zweitvektor: der Abruf rechnet hoechstens drei nach, der Doctor zeigt die Deckung', async () => {
    // Altbestand simulieren: alle Zweitvektoren weg.
    for (let i = 1; i <= 6; i++) await redis.del(`${ZWEIT_VEKTOR_PRAEFIX}deploy:dienst-${i}`);
    embedMock.zweitAufrufe = 0;

    const vorher = String(await handleTeamTool('brain_doctor', { instance_id: 'z1' }, getConn, noopApiFetch));
    expect(vorher).toMatch(/Second-model coverage: 0%/);
    expect(vorher).toContain('stays OFF');

    await handleBrainTool('smart_recall', { instance_id: 'z1', query: 'deploy dienst port token' }, getConn, noopApiFetch);
    await warte();

    let da = 0;
    for (let i = 1; i <= 6; i++) if (await redis.get(`${ZWEIT_VEKTOR_PRAEFIX}deploy:dienst-${i}`)) da++;
    expect(da).toBeGreaterThanOrEqual(1);
    expect(da).toBeLessThanOrEqual(3);
  });

  it('GEGENPROBE: volle Deckung — kein einziger Zweitmodell-Aufruf beim Lesen', async () => {
    embedMock.zweitAufrufe = 0;
    const doc = String(await handleTeamTool('brain_doctor', { instance_id: 'z1' }, getConn, noopApiFetch));
    expect(doc).toMatch(/Second-model coverage: 100%/);
    await handleBrainTool('smart_recall', { instance_id: 'z1', query: 'deploy dienst port token' }, getConn, noopApiFetch);
    await warte();
    // Die Frage-Einbettung mit Zweitmodell ist erlaubt (ein Aufruf), Nachrechnung nicht.
    expect(embedMock.zweitAufrufe).toBeLessThanOrEqual(1);
  });
});
