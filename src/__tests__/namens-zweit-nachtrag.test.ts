/**
 * Namens- und Zweit-Vektoren bekommen einen Nachtrag wie der Volltext-Vektor.
 *
 * Anlass (21.10.2026, LongMemEval-Probe): eine Frage wurde mit 85/89 Namens- und
 * 83/89 Zweit-Vektoren gesichert. Der Volltext hatte seit Karte hcg8neyut0kd einen
 * Vermerk und heilte; Namens-Vektoren fehlten nach einem Aussetzer fuer immer,
 * Zweit-Vektoren heilten nur, solange die Deckung unter 80 % lag.
 *
 * GEGENPROBE: auf dem Stand davor (814ecfbf) sind die beiden "holt nach"-Proben rot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../embeddings.js', () => ({
  computeEmbedding: vi.fn(),
  hasEmbedProvider: () => true,
  // 'cachly': nur dann rechnet der Schreibpfad den Zweit-Vektor.
  EMBED_PROVIDER: 'cachly',
}));

import { handleBrainTool } from '../handlers/brain.js';
import { handleTeamTool } from '../handlers/team.js';
import { computeEmbedding } from '../embeddings.js';
import {
  NAME_VEKTOR_NACHTRAG, ZWEIT_VEKTOR_NACHTRAG, NAME_VEKTOR_PRAEFIX, ZWEIT_VEKTOR_PRAEFIX,
  VEKTOR_PRAEFIX, textFuerNamensVektor, packe,
} from '../bedeutung.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

const embedMock = vi.mocked(computeEmbedding);
const ausstehen = () => new Promise((r) => setTimeout(r, 150));

/** Einbettung, die fuer genau einen Fall scheitert, sonst einen Vektor liefert. */
function scheitertBei(fall: (text: string, opts?: { modell?: string }) => boolean) {
  embedMock.mockImplementation(async (text: string, opts?: { modell?: string }) => {
    if (fall(text, opts)) throw new Error('The operation was aborted due to timeout');
    return [0.1, 0.2, 0.3];
  });
}

describe('Nachtrag fuer Namens- und Zweit-Vektoren', () => {
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

  it('gelingt alles, bleibt kein Vermerk liegen', async () => {
    scheitertBei(() => false);
    await lerne('deploy:gesund');
    await ausstehen();
    expect(await redis.get(`${NAME_VEKTOR_PRAEFIX}deploy:gesund`)).not.toBeNull();
    expect(await redis.get(`${ZWEIT_VEKTOR_PRAEFIX}deploy:gesund`)).not.toBeNull();
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).toEqual([]);
    expect(await redis.smembers(ZWEIT_VEKTOR_NACHTRAG)).toEqual([]);
  });

  it('ein gescheiterter Namens-Vektor wird vermerkt und beim naechsten Schreiben nachgeholt', async () => {
    scheitertBei((text) => text === textFuerNamensVektor('deploy:kaputt'));
    await lerne('deploy:kaputt');
    await ausstehen();
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:kaputt`)).not.toBeNull();
    expect(await redis.get(`${NAME_VEKTOR_PRAEFIX}deploy:kaputt`)).toBeNull();
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).toContain('deploy:kaputt');

    scheitertBei(() => false);
    await lerne('deploy:spaeter');
    await ausstehen();
    expect(await redis.get(`${NAME_VEKTOR_PRAEFIX}deploy:kaputt`)).not.toBeNull();
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).not.toContain('deploy:kaputt');
  });

  it('ein gescheiterter Zweit-Vektor wird vermerkt und beim naechsten Schreiben nachgeholt', async () => {
    scheitertBei((_text, opts) => Boolean(opts?.modell));
    await lerne('deploy:ohne-zweit');
    await ausstehen();
    expect(await redis.get(`${VEKTOR_PRAEFIX}deploy:ohne-zweit`)).not.toBeNull();
    expect(await redis.get(`${ZWEIT_VEKTOR_PRAEFIX}deploy:ohne-zweit`)).toBeNull();
    expect(await redis.smembers(ZWEIT_VEKTOR_NACHTRAG)).toContain('deploy:ohne-zweit');

    scheitertBei(() => false);
    await lerne('deploy:spaeter');
    await ausstehen();
    expect(await redis.get(`${ZWEIT_VEKTOR_PRAEFIX}deploy:ohne-zweit`)).not.toBeNull();
    expect(await redis.smembers(ZWEIT_VEKTOR_NACHTRAG)).not.toContain('deploy:ohne-zweit');
  });

  it('brain_doctor nennt ausstehende Nachtraege je Vektorart', async () => {
    scheitertBei((text, opts) => text === textFuerNamensVektor('deploy:kaputt') || Boolean(opts?.modell));
    await lerne('deploy:kaputt');
    await ausstehen();
    const doc = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(doc).toContain('Vector backfill pending');
    expect(doc).toMatch(/0 full-text, 1 topic-name, 1 second-model/);
    expect(doc).toContain('Topic-name coverage: 0%');
    expect(doc).toContain('1 of 1 embedded lessons lack a topic-name vector (1 queued');
    expect(doc).not.toContain('not queued');
  });

  it('brain_doctor nennt Namens-Luecken ohne Vermerk (Altbestand) gesondert', async () => {
    scheitertBei(() => false);
    await lerne('deploy:alt');
    await ausstehen();
    await redis.del(`${NAME_VEKTOR_PRAEFIX}deploy:alt`);
    const doc = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(doc).toContain('1 of 1 embedded lessons lack a topic-name vector (0 queued');
    expect(doc).toContain('1 older ones not queued and not healed automatically');
  });

  it('brain_doctor meldet vollstaendige Namens-Deckung', async () => {
    scheitertBei(() => false);
    await lerne('deploy:gesund');
    await ausstehen();
    const doc = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(doc).toContain('Topic-name coverage: 100%');
    expect(doc).not.toContain('Vector backfill pending');
  });

  // 04.11.2026: Eine Lektion mit topic "" (vor 0.10.226 noch angenommen) liess
  // bei jeder Suche eine Einbettung mit 0 Zeichen an die API gehen; der Vermerk
  // blieb fuer immer. GEGENPROBE: ohne den Fix in brain.ts sind beide Proben rot.
  const leerEingebettet = () => embedMock.mock.calls.filter(([text]) => String(text).trim() === '');

  it('ein Thema ohne Namenstext ("--") bettet nie leer ein und laesst keinen Vermerk liegen', async () => {
    scheitertBei(() => false);
    await lerne('--');
    await ausstehen();
    expect(leerEingebettet()).toEqual([]);
    expect(await redis.get(`${VEKTOR_PRAEFIX}--`)).not.toBeNull();
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).not.toContain('--');
  });

  it('ein alter Vermerk zu einem leeren Thema verfaellt, statt bei jedem Lauf leer einzubetten', async () => {
    scheitertBei(() => false);
    await redis.set('cachly:lesson:best:', JSON.stringify({ topic: '', outcome: 'success', what_worked: 'x' }));
    await redis.sadd(NAME_VEKTOR_NACHTRAG, '');
    await lerne('deploy:danach');
    await ausstehen();
    expect(leerEingebettet()).toEqual([]);
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).toEqual([]);
  });

  it('eine geloeschte Lektion erledigt ihren Vermerk von selbst', async () => {
    scheitertBei((text) => text === textFuerNamensVektor('deploy:weg'));
    await lerne('deploy:weg');
    await ausstehen();
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).toContain('deploy:weg');
    await redis.del('cachly:lesson:best:deploy:weg');

    scheitertBei(() => false);
    await lerne('deploy:spaeter');
    await ausstehen();
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).not.toContain('deploy:weg');
    expect(await redis.get(`${NAME_VEKTOR_PRAEFIX}deploy:weg`)).toBeNull();
  });

  // 0.10.242: Luecken OHNE Vermerk (Bestand von vor 0.10.214) werden erkannt,
  // vorgemerkt und gedrosselt geheilt. GEGENPROBE: ohne vermerkeNamensLuecken
  // in brain.ts bleibt jede Probe hier rot.
  async function altbestand(n: number): Promise<string[]> {
    const themen = Array.from({ length: n }, (_, i) => `alt:thema-${i}`);
    for (const t of themen) {
      await redis.set(`cachly:lesson:best:${t}`, JSON.stringify({ topic: t, outcome: 'success', what_worked: `Weg ${t}` }));
      await redis.set(`${VEKTOR_PRAEFIX}${t}`, packe([0.3, 0.2, 0.1]));
    }
    return themen;
  }
  const rufe = () => handleBrainTool('smart_recall', { instance_id: 'i1', query: 'Weg' }, getConn, noopApiFetch);
  const namenEmbeds = (themen: string[]) =>
    embedMock.mock.calls.filter(([text, o]) => !(o as { modell?: string } | undefined)?.modell
      && themen.some((t) => text === textFuerNamensVektor(t))).length;

  it('Altlücken ohne Vermerk werden nach einigen Abrufen geheilt, je Abruf hoechstens 2 Namens-Einbettungen', async () => {
    scheitertBei(() => false);
    const themen = await altbestand(7);
    let letzter = 0;
    for (let n = 1; n <= 5; n++) {
      await rufe();
      await ausstehen();
      const gesamt = namenEmbeds(themen);
      expect(gesamt - letzter).toBeLessThanOrEqual(2);
      letzter = gesamt;
    }
    for (const t of themen) {
      expect(await redis.get(`${NAME_VEKTOR_PRAEFIX}${t}`)).not.toBeNull();
    }
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).toEqual([]);
    expect(letzter).toBe(7);
    const doc = String(await handleTeamTool('brain_doctor', { instance_id: 'i1' }, getConn, noopApiFetch));
    expect(doc).toContain('Topic-name coverage: 100%');
  });

  it('ein Thema ohne Namenstext wird nie vorgemerkt', async () => {
    scheitertBei(() => false);
    await altbestand(1);
    await redis.set('cachly:lesson:best:--', JSON.stringify({ topic: '--', outcome: 'success', what_worked: 'x' }));
    await redis.set(`${VEKTOR_PRAEFIX}--`, packe([0.3, 0.2, 0.1]));
    for (let n = 0; n < 3; n++) { await rufe(); await ausstehen(); }
    expect(await redis.smembers(NAME_VEKTOR_NACHTRAG)).not.toContain('--');
    expect(leerEingebettet()).toEqual([]);
  });
});
