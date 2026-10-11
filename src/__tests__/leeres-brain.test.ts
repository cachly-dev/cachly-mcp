/**
 * smart_recall auf einem LEEREN Brain antwortet sofort (leeres-brain.ts).
 *
 * Anlass (11.10.2026): ein frisch angelegtes Brain brauchte 10,4 s bis zur
 * ersten Antwort, davon 9,2 s Warten auf die Instanz — um dann "nichts
 * gefunden" zu sagen. Ein Brain ohne Eintrag kann nichts liefern; Einbettung,
 * Leser, Sinn-Dienst, Kantenscan und die beiden API-Abfragen (Tarif, Grenze)
 * sind dort reine Wartezeit.
 *
 * Die Proben:
 *   1. Laufendes, leeres Brain: Antwort ohne Einbettung, Leser, Kantenscan, API.
 *   2. Neues Brain, das noch startet: Antwort OHNE auf die Verbindung zu warten;
 *      die Messzeilen folgen, sobald sie steht.
 *   3. Nur Kontext, keine Lektion: der Hinweis "bedeutung-ohne-vektoren" schweigt.
 *      GEGENPROBE: eine Lektion ohne Vektor — der Hinweis kommt.
 *   4. Brain mit Lektionen: der volle Weg, unveraendert (Einbettung, Leser,
 *      Kantenscan, Tarif- und Grenzabfrage laufen).
 *
 * Gegenprobe am Code (11.10.2026, von Hand): ohne die Abkuerzung fuer das
 * leere Brain ist Probe 1 rot (Einbettung und API laufen), ohne die
 * Abkuerzung fuer das startende Brain ist Probe 2 rot (die Antwort wartet auf
 * die Verbindung und laeuft in die Frist), ohne die Lektionenzaehlung ist
 * Probe 3 rot.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

const DIM = 16;
function einheit(i: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[i] = 1;
  return v;
}

const { einbetten, leserPunkteSpy } = vi.hoisted(() => ({
  einbetten: vi.fn(async (_t: string, opts?: { modell?: string }) => {
    if (opts?.modell) throw new Error('kein Zweitmodell in dieser Probe');
    const v = new Array<number>(16).fill(0);
    v[0] = 1;
    return v;
  }),
  leserPunkteSpy: vi.fn(async () => null),
}));
vi.mock('../embeddings.js', async (original) => {
  const echt = await original<typeof import('../embeddings.js')>();
  return { ...echt, hasEmbedProvider: () => true, EMBED_PROVIDER: 'cachly', computeEmbedding: einbetten };
});

vi.mock('../leser.js', async (original) => {
  const echt = await original<typeof import('../leser.js')>();
  return { ...echt, leserAktiv: () => true, leserPunkte: leserPunkteSpy };
});

import { handleBrainTool } from '../handlers/brain.js';
import { MockRedis } from './redis-mock.js';
import { merkeNeuesBrain, neuesBrain, _neueBrainsZuruecksetzen, leeresBrainAntwort } from '../leeres-brain.js';
import { _startwissenZuruecksetzen, starteStartwissen } from '../startwissen.js';
import { setzeAussetzerZurueck, schonGemeldet, OHNE_VEKTOREN } from '../aussetzer.js';
import { suchProtokollSchluessel } from '../recall-trichter.js';
import { packe, VEKTOR_PRAEFIX, NAME_VEKTOR_PRAEFIX } from '../bedeutung.js';

const FRAGE = 'how do I deploy the api';

/** Merkt sich, welche Muster gescannt wurden — der Kantenscan sucht cachly:ckg:node:*. */
function mitScanProtokoll(redis: MockRedis): { redis: MockRedis; muster: string[] } {
  const muster: string[] = [];
  const echt = redis.scanStream.bind(redis);
  redis.scanStream = ((opts: { match: string; count?: number }) => {
    muster.push(opts.match);
    return echt(opts);
  }) as typeof redis.scanStream;
  return { redis, muster };
}

function apiMit(status: string) {
  return vi.fn(async (pfad: string) => {
    if (pfad.endsWith('/memory')) return { recall_limit: -1, total_recall_count: 0 };
    return { id: 'x', name: 'probe', status, tier: 'dev' };
  });
}

const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  einbetten.mockClear();
  leserPunkteSpy.mockClear();
  setzeAussetzerZurueck();
  _neueBrainsZuruecksetzen();
  _startwissenZuruecksetzen();
});

describe('smart_recall: leeres Brain', () => {
  it('antwortet ohne Einbettung, Leser, Kantenscan und API-Abfrage — und zaehlt die Suche', async () => {
    const { redis, muster } = mitScanProtokoll(new MockRedis());
    const api = apiMit('running');
    const text = String(await handleBrainTool(
      'smart_recall', { instance_id: 'leer-1', query: FRAGE },
      async () => redis as unknown as Redis, api as never,
    ));

    expect(text).toContain('This Brain is still empty');
    expect(text).not.toContain('brand new');
    expect(einbetten).not.toHaveBeenCalled();
    expect(leserPunkteSpy).not.toHaveBeenCalled();
    expect(api).not.toHaveBeenCalled();
    expect(muster.some((m) => m.startsWith('cachly:ckg:node:'))).toBe(false);
    expect(schonGemeldet(OHNE_VEKTOREN)).toBe(false);

    // Dieselben Messzeilen wie im vollen Weg bei "nichts gefunden".
    await warte(20);
    expect(await redis.lrange(suchProtokollSchluessel('leer-1'), 0, -1)).toHaveLength(1);
    expect((await redis.hgetall('cachly:stats:drei-ausgaenge:leer-1')).schweigen).toBe('1');
  });

  it('ein neues Brain, das noch startet: Antwort sofort, ohne auf die Verbindung zu warten', async () => {
    merkeNeuesBrain('neu-1', true);
    const redis = new MockRedis();
    let verbinde: (r: Redis) => void = () => {};
    const verbindung = new Promise<Redis>((r) => { verbinde = r; });
    const api = apiMit('provisioning');

    const antwort = handleBrainTool(
      'smart_recall', { instance_id: 'neu-1', query: FRAGE }, () => verbindung, api as never,
    );
    const frist = warte(2000).then(() => 'FRIST: die Antwort wartet auf die Verbindung');
    const text = String(await Promise.race([antwort, frist]));

    expect(text).toContain('This Brain is brand new and still empty');
    expect(text).toContain('last 30 commits');
    expect(api).toHaveBeenCalledTimes(1);
    expect(einbetten).not.toHaveBeenCalled();
    expect(leserPunkteSpy).not.toHaveBeenCalled();

    // Steht die Verbindung, kommen die Messzeilen nach.
    verbinde(redis as unknown as Redis);
    await warte(20);
    expect(await redis.lrange(suchProtokollSchluessel('neu-1'), 0, -1)).toHaveLength(1);
  });

  it('laeuft die neue Instanz, nimmt sie den normalen Weg — und fragt danach nicht mehr nach dem Stand', async () => {
    merkeNeuesBrain('neu-2', true);
    const redis = new MockRedis();
    const api = apiMit('running');
    const verbindung = vi.fn(async () => redis as unknown as Redis);

    const erste = String(await handleBrainTool('smart_recall', { instance_id: 'neu-2', query: FRAGE }, verbindung, api as never));
    expect(erste).toContain('This Brain is still empty');
    expect(verbindung).toHaveBeenCalledTimes(1);
    expect(neuesBrain('neu-2')?.laeuft).toBe(true);

    api.mockClear();
    await handleBrainTool('smart_recall', { instance_id: 'neu-2', query: FRAGE }, verbindung, api as never);
    expect(api).not.toHaveBeenCalled();
  });

  it('ist der Git-Import ausgegangen (kein Repo), faellt der Satz dazu weg', async () => {
    merkeNeuesBrain('neu-3', true);
    const redis = new MockRedis();
    await starteStartwissen({
      instanzId: 'neu-3',
      verbindung: async () => redis as unknown as Redis,
      ausGit: async () => '',
      projektOrdner: async () => process.cwd(),
      gitWurzel: async () => '',
      schlafen: async () => {},
      protokoll: () => {},
    });
    const text = String(await handleBrainTool(
      'smart_recall', { instance_id: 'neu-3', query: FRAGE },
      async () => redis as unknown as Redis, apiMit('running') as never,
    ));
    expect(text).toContain('This Brain is still empty');
    expect(text).not.toContain('commits');
  });
});

describe('leeresBrainAntwort', () => {
  // index.ts wertet eine smart_recall-Antwort mit "no lessons" als Fehlschlag
  // (srHit). Ohne den Satzteil zaehlte ein leeres Brain im Trichter als Treffer.
  it.each([
    { startet: true, lerntAusGit: true },
    { startet: false, lerntAusGit: false },
  ])('enthaelt "no lessons" (%o)', (lage) => {
    expect(leeresBrainAntwort(FRAGE, lage)).toContain('no lessons');
  });
});

describe('smart_recall: der Hinweis "bedeutung-ohne-vektoren"', () => {
  it('schweigt bei 0 Lektionen (nur Kontext im Brain)', async () => {
    const redis = new MockRedis();
    await redis.set('cachly:ctx:notiz:deploy', 'deploy the api with the release workflow');
    const text = String(await handleBrainTool(
      'smart_recall', { instance_id: 'ctx-1', query: FRAGE },
      async () => redis as unknown as Redis, apiMit('running') as never,
    ));
    // Kein leeres Brain: der Kontext wird gefunden.
    expect(text).not.toContain('still empty');
    expect(text).toContain('notiz:deploy');
    expect(schonGemeldet(OHNE_VEKTOREN)).toBe(false);
  });

  it('GEGENPROBE: eine Lektion ohne Vektor — der Hinweis kommt', async () => {
    const redis = new MockRedis();
    await redis.set('cachly:lesson:best:deploy:api', JSON.stringify({
      topic: 'deploy:api', outcome: 'success', what_worked: 'deploy the api with the release workflow', ts: '2026-10-01T00:00:00Z',
    }));
    await handleBrainTool(
      'smart_recall', { instance_id: 'lek-0', query: FRAGE },
      async () => redis as unknown as Redis, apiMit('running') as never,
    );
    expect(schonGemeldet(OHNE_VEKTOREN)).toBe(true);
  });
});

// Steht am Ende: der Vektorbestand in handlers/brain.ts haelt geladene Vektoren
// 60 s im Prozess, die Proben darueber brauchen einen leeren.
describe('smart_recall: Brain mit Lektionen nimmt den vollen Weg', () => {
  it('Einbettung, Leser, Kantenscan, Tarif- und Grenzabfrage laufen wie bisher', async () => {
    const { redis, muster } = mitScanProtokoll(new MockRedis());
    const lektionen = [
      { topic: 'deploy:api-release', what_worked: 'Deploy the api via the release workflow, then check health.', richtung: 0 },
      { topic: 'deploy:api-rollback', what_worked: 'Roll the api deploy back with the previous image tag.', richtung: 1 },
    ];
    for (const l of lektionen) {
      await redis.set(`cachly:lesson:best:${l.topic}`, JSON.stringify({
        topic: l.topic, outcome: 'success', what_worked: l.what_worked, ts: '2026-10-01T00:00:00Z',
      }));
      await redis.set(`${VEKTOR_PRAEFIX}${l.topic}`, packe(einheit(l.richtung)));
      await redis.set(`${NAME_VEKTOR_PRAEFIX}${l.topic}`, packe(einheit(l.richtung)));
    }
    const api = apiMit('running');
    const text = String(await handleBrainTool(
      'smart_recall', { instance_id: 'voll-1', query: FRAGE },
      async () => redis as unknown as Redis, api as never,
    ));

    expect(text).not.toContain('still empty');
    expect(text).toContain('deploy:api-release');
    expect(einbetten).toHaveBeenCalledWith(FRAGE);
    expect(leserPunkteSpy).toHaveBeenCalledTimes(1);
    expect(muster.some((m) => m.startsWith('cachly:ckg:node:'))).toBe(true);
    const pfade = api.mock.calls.map((c) => String(c[0]));
    expect(pfade).toContain('/api/v1/instances/voll-1');
    expect(pfade).toContain('/api/v1/instances/voll-1/memory');
  });
});
