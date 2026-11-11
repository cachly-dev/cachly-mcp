/**
 * Der Schreibweg fragt nach dem Ersetzen (11.11.2026).
 *
 * Anlass: Edward Izgorodin unter dem Artikel zum Alters-Ranking — wer eine
 * Korrektur schreibt, hat die alte Lektion selten vor sich, also soll der
 * Schreibweg sie zeigen und fragen. Der Ersetzungs-Vorschlag fragte bisher nur
 * bei einem Korrektur-Signalwort, die Doppelung erst ab 0,80.
 *
 * Dazu zwei Befunde aus demselben Tag:
 *   - Beide Hinweise nannten Namen privater und Gruppen-Lektionen (ein Name
 *     ist ein Wegweiser), und der Doppelungs-Vermerk landet im Briefing.
 *   - Die Widerspruchswarnung (success -> failure) kam nie in der Antwort an.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';
import { Vektorbestand, packe, VEKTOR_PRAEFIX } from '../bedeutung.js';
import {
  DOPPEL_SCHLUESSEL, nahHinweis, pruefeNachbarn, waehleNahe, type DoppelLektion,
} from '../doppel-kandidat.js';
import { NAH_ANZAHL, NAH_UNTERGRENZE } from '../rangfolge-stellschrauben.js';
import { handleBrainTool } from '../handlers/brain.js';

const TEXT = 'Der Deploy laeuft ueber make deploy-api und nicht mehr ueber das alte Skript.';
const lek = (topic: string, extra: Partial<DoppelLektion> = {}): DoppelLektion => ({ topic, what_worked: TEXT, ...extra });
const vektor = (winkel: number): number[] => {
  const v = new Array(16).fill(0);
  v[0] = Math.cos(winkel);
  v[1] = Math.sin(winkel);
  return v;
};
const fuerNaehe = (naehe: number) => vektor(Math.acos(naehe));

describe('waehleNahe', () => {
  it('ab NAH_UNTERGRENZE, ohne die Doppelung, die naechsten zuerst, hoechstens NAH_ANZAHL', () => {
    expect(NAH_UNTERGRENZE).toBe(0.74);
    const nahe = waehleNahe(lek('neu'), [
      { lektion: lek('doppel'), naehe: 0.86 },
      { lektion: lek('a'), naehe: 0.75 },
      { lektion: lek('b'), naehe: 0.79 },
      { lektion: lek('c'), naehe: 0.77 },
      { lektion: lek('d'), naehe: 0.76 },
      { lektion: lek('zu-weit'), naehe: 0.739 },
    ], 'doppel');
    expect(nahe.map((n) => n.topic)).toEqual(['b', 'c', 'd']);
    expect(nahe.length).toBe(NAH_ANZAHL);
  });

  it('ohne Text oder schon verknuepft: nicht genannt', () => {
    const nahe = waehleNahe(lek('neu'), [
      { lektion: lek('leer', { what_worked: '' }), naehe: 0.78 },
      { lektion: lek('verknuepft', { ersetzt_durch: 'neu' }), naehe: 0.78 },
      { lektion: lek('ok'), naehe: 0.75 },
    ]);
    expect(nahe.map((n) => n.topic)).toEqual(['ok']);
  });
});

describe('pruefeNachbarn: nur teamweite Namen', () => {
  let redis: MockRedis;
  const r = () => redis as unknown as Redis;
  const lege = async (topic: string, naehe: number, extra: Record<string, unknown> = {}) => {
    await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify({ ...lek(topic), outcome: 'success', ...extra }));
    await redis.set(`${VEKTOR_PRAEFIX}${topic}`, packe(fuerNaehe(naehe)));
  };
  beforeEach(() => { redis = new MockRedis(); });

  it('KONTROLLE: ein teamweiter Nachbar bei 0,76 wird genannt', async () => {
    await lege('deploy:altes-skript', 0.76);
    const e = await pruefeNachbarn(r(), lek('deploy:make-target'), vektor(0), new Vektorbestand(0));
    expect(e.doppel).toBeNull();
    expect(e.nahe.map((n) => n.topic)).toEqual(['deploy:altes-skript']);
  });

  it('private und Gruppen-Nachbarn werden nicht genannt, weder als Nachbar noch als Doppelung', async () => {
    await lege('deploy:team', 0.76);
    await lege('deploy:privat', 0.78, { visibility: 'private' });
    await lege('deploy:gruppe', 0.9, { group: 'backend' });
    const e = await pruefeNachbarn(r(), lek('deploy:make-target'), vektor(0), new Vektorbestand(0));
    expect(e.doppel).toBeNull();
    expect(e.nahe.map((n) => n.topic)).toEqual(['deploy:team']);
    expect(await redis.hgetall(DOPPEL_SCHLUESSEL)).toEqual({});
  });

  it('eine NEUE private Lektion: der Schreiber sieht die Doppelung, das Briefing bekommt keinen Vermerk', async () => {
    await lege('deploy:alt', 0.88);
    const e = await pruefeNachbarn(r(), lek('deploy:neu-privat', { visibility: 'private' }), vektor(0), new Vektorbestand(0));
    expect(e.doppel?.alt).toBe('deploy:alt');
    expect(await redis.hgetall(DOPPEL_SCHLUESSEL)).toEqual({});
  });

  it('KONTROLLE: eine NEUE teamweite Lektion wird wie bisher vermerkt', async () => {
    await lege('deploy:alt', 0.88);
    const e = await pruefeNachbarn(r(), lek('deploy:neu'), vektor(0), new Vektorbestand(0));
    expect(e.doppel?.alt).toBe('deploy:alt');
    expect(Object.keys(await redis.hgetall(DOPPEL_SCHLUESSEL))).toEqual(['deploy:neu']);
  });
});

describe('nahHinweis', () => {
  it('nennt Namen und Naehe und fragt', () => {
    const s = nahHinweis([{ topic: 'deploy:altes-skript', naehe: 0.76 }]);
    expect(s).toContain('`deploy:altes-skript` (0.76)');
    expect(s).toContain('Does this one replace one of them?');
    expect(s).toContain('ersetzt=');
  });

  it('leer ohne Nachbarn oder wenn ein anderer Hinweis den Namen schon nennt', () => {
    expect(nahHinweis([])).toBe('');
    expect(nahHinweis([{ topic: 'a', naehe: 0.75 }], '🔁 This sounds like a correction of `a` …')).toBe('');
  });
});

describe('learn_from_attempts: die Widerspruchswarnung kommt an', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  beforeEach(() => { redis = new MockRedis(); });

  it('success, dann failure desselben Themas: die Antwort sagt es', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success', what_worked: 'Fassung eins laeuft.',
    }, getConn, noopApiFetch);
    const out = String(await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'failure', what_worked: 'Doch nicht.',
      what_failed: 'Fassung eins scheitert seit dem Umzug.', grund: 'Der Umzug hat den Weg gebrochen.',
    }, getConn, noopApiFetch));
    expect(out).toContain('Contradiction detected');
  });

  it('KONTROLLE: success, dann success mit grund — keine Widerspruchswarnung', async () => {
    await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success', what_worked: 'Fassung eins laeuft.',
    }, getConn, noopApiFetch);
    const out = String(await handleBrainTool('learn_from_attempts', {
      instance_id: 'i1', topic: 'deploy:probe', outcome: 'success', what_worked: 'Fassung zwei laeuft.',
      grund: 'Genauer formuliert.',
    }, getConn, noopApiFetch));
    expect(out).not.toContain('Contradiction detected');
  });
});
