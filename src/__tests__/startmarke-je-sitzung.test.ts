/**
 * Zwei Sitzungen auf demselben Brain nehmen sich weder Startzeit noch
 * Entscheidungsprotokoll weg.
 *
 * Bis 0.10.285 gab es die Startmarke nur einmal je Brain
 * (cachly:session:current). Fenster A startet, 20 Minuten spaeter Fenster B:
 * das session_end von A meldete dann die Dauer ab dem Start von B und nahm
 * das ganze Entscheidungsprotokoll mit, auch die Lektion von B.
 *
 * Eine Sitzung ist ein MCP-Prozess; hier stellt setzeSitzungsKennung zwei
 * Prozesse in einem Testlauf nach.
 *
 * GEGENPROBE: Marken und Protokollzeilen einer aelteren Fassung (ohne
 * Kennung) zaehlen weiter fuer die Sitzung, die zuerst endet.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { handleBrainTool } from '../handlers/brain.js';
import { setzeSitzungsKennung, startmarkenSchluessel } from '../sitzungs-kennung.js';
import type { Redis } from 'ioredis';
import { MockRedis } from './redis-mock.js';

const ID = 'marke-je-sitzung';
const MIN = 60_000;

describe('Startmarke und Entscheidungsprotokoll je Sitzung', () => {
  let redis: MockRedis;
  const getConn = async () => redis as unknown as Redis;
  const noopApiFetch = async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response;
  const als = (sid: string) => setzeSitzungsKennung(sid);
  const ende = (summary: string) =>
    handleBrainTool('session_end', { instance_id: ID, summary }, getConn, noopApiFetch).then(String);
  const lernt = (topic: string) =>
    handleBrainTool('learn_from_attempts', {
      instance_id: ID, topic, outcome: 'success', what_worked: `${topic} erledigt`,
    }, getConn, noopApiFetch);
  const letzte = async () =>
    JSON.parse((await redis.get('cachly:session:last'))!) as {
      summary: string; duration_min?: number; decision_log?: { topic: string; sid?: string }[];
    };
  const starteVor = async (sid: string, minuten: number) => {
    const started = new Date(Date.now() - minuten * MIN).toISOString();
    await redis.set(startmarkenSchluessel(sid), JSON.stringify({ started }));
    await redis.set('cachly:session:current', JSON.stringify({ started, focus: 'x', provider: '', sid }));
  };

  beforeEach(() => {
    redis = new MockRedis();
  });
  afterAll(() => als('nach-dem-test'));

  it('session_start schreibt die eigene Marke und die gemeinsame mit Kennung', async () => {
    als('sitzung-a');
    await handleBrainTool('session_start', { instance_id: ID, focus: 'Logo' }, getConn, noopApiFetch);
    const eigene = JSON.parse(String(await redis.get(startmarkenSchluessel('sitzung-a'))));
    expect(typeof eigene.started).toBe('string');
    expect(eigene.focus).toBeUndefined();
    const gemeinsam = JSON.parse(String(await redis.get('cachly:session:current')));
    expect(gemeinsam.sid).toBe('sitzung-a');
    expect(gemeinsam.started).toBe(eigene.started);
  });

  it('A endet nach B-Start: Dauer ab dem eigenen Start, B behaelt Marke und Dauer', async () => {
    await starteVor('sitzung-a', 50);
    await starteVor('sitzung-b', 30); // gemeinsame Marke gehoert jetzt B

    als('sitzung-a');
    const a = await ende('Sitzung A: Logo getauscht.');
    expect(a).toContain('Session saved** · 50 min');
    expect(a).not.toContain('No session_start marker');
    expect(await redis.get(startmarkenSchluessel('sitzung-a'))).toBeNull();
    // Die fremde gemeinsame Marke bleibt liegen.
    expect(JSON.parse(String(await redis.get('cachly:session:current'))).sid).toBe('sitzung-b');

    als('sitzung-b');
    const b = await ende('Sitzung B: Maker-Kommentar.');
    expect(b).toContain('Session saved** · 30 min');
    expect(b).not.toContain('No session_start marker');
    expect(await redis.get('cachly:session:current')).toBeNull();
    expect(await redis.get(startmarkenSchluessel('sitzung-b'))).toBeNull();
  });

  it('Entscheidungsprotokoll: jede Sitzung bekommt nur ihre eigenen Lektionen', async () => {
    await starteVor('sitzung-a', 40);
    await starteVor('sitzung-b', 20);
    als('sitzung-a');
    await lernt('logo:getauscht');
    als('sitzung-b');
    await lernt('maker:kommentar');
    als('sitzung-a');
    await lernt('logo:geprueft');

    als('sitzung-a');
    await ende('Sitzung A.');
    const a = await letzte();
    expect(a.decision_log?.map((d) => d.topic)).toEqual(['logo:getauscht', 'logo:geprueft']);
    expect(a.decision_log?.some((d) => 'sid' in d)).toBe(false);
    expect(await redis.lrange('cachly:session:decision-log', 0, -1)).toHaveLength(1);

    als('sitzung-b');
    await ende('Sitzung B.');
    const b = await letzte();
    expect(b.decision_log?.map((d) => d.topic)).toEqual(['maker:kommentar']);
    expect(await redis.lrange('cachly:session:decision-log', 0, -1)).toHaveLength(0);
  });

  it('ohne eigene Marke und mit fremder gemeinsamer: gespeichert ohne Dauer, fremde Marke bleibt', async () => {
    await starteVor('sitzung-b', 15);
    als('sitzung-c');
    const c = await ende('Sitzung C ohne session_start.');
    expect(c).toContain('Session saved');
    expect(c).toContain('No session_start marker found');
    expect((await letzte()).duration_min).toBeUndefined();
    expect(JSON.parse(String(await redis.get('cachly:session:current'))).sid).toBe('sitzung-b');
  });

  it('GEGENPROBE: Marke und Protokollzeilen ohne Kennung (aeltere Fassung) zaehlen wie bisher', async () => {
    await redis.set('cachly:session:current', JSON.stringify({ started: new Date(Date.now() - 12 * MIN).toISOString() }));
    await redis.rpush('cachly:session:decision-log',
      JSON.stringify({ ts: 't', topic: 'alt:ohne-kennung', outcome: 'success', what_worked: 'w' }),
      'kein json');
    als('sitzung-d');
    const d = await ende('Sitzung D.');
    expect(d).toContain('Session saved** · 12 min');
    expect(await redis.get('cachly:session:current')).toBeNull();
    expect((await letzte()).decision_log?.map((e) => e.topic)).toEqual(['alt:ohne-kennung']);
    expect(await redis.lrange('cachly:session:decision-log', 0, -1)).toHaveLength(0);
  });
});
