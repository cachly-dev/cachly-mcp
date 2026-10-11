/**
 * session_start und die anderen fruehen Lesewerkzeuge antworten auf ein
 * NEUES Brain, das noch startet, sofort (leeres-brain.ts).
 *
 * Anlass (11.10.2026): Probe von aussen mit 0.10.179, session_start als erster
 * Aufruf — 16,0 s bis zur Antwort, davon 9,7 s Warten auf die Instanz, um dann
 * "0 lessons" zu melden. smart_recall antwortete seit #722 schon sofort.
 *
 * Die Proben:
 *   1. session_start auf einem neuen, startenden Brain: Antwort ohne auf die
 *      Verbindung zu warten; Sitzungsbeginn, Serie und gesehene Fassung kommen
 *      nach, sobald sie steht.
 *   2. Jedes fruehe Lesewerkzeug ebenso, mit der ersten Zeile, die es auch im
 *      vollen Weg bei leerem Ergebnis gibt.
 *   3. Laeuft die neue Instanz, nimmt session_start den vollen Weg — und fragt
 *      danach nicht mehr nach dem Stand.
 *   4. Ein Brain, das NICHT dieser Prozess angelegt hat: keine Abkuerzung,
 *      keine zusaetzliche API-Abfrage — auch wenn die API "provisioning" sagt.
 *   5. Schreibwerkzeuge warten weiter auf die Verbindung (kein Datenverlust).
 *
 * Gegenprobe am Code (11.10.2026, von Hand): ohne die Abfrage in session_start
 * ist Probe 1 rot (die Antwort laeuft in die Frist), ohne die in einem der
 * Lesewerkzeuge ist dessen Zeile in Probe 2 rot.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { handleBrainTool } from '../handlers/brain.js';
import { handleContextTool } from '../handlers/context.js';
import { handleRoadmapTool } from '../handlers/roadmap.js';
import { handleAdvancedTool } from '../handlers/advanced.js';
import { handleSyndicateTool } from '../handlers/syndicate.js';
import { MockRedis } from './redis-mock.js';
import {
  merkeNeuesBrain, neuesBrain, _neueBrainsZuruecksetzen, startetLautLetztemBlick, NEUES_BRAIN,
} from '../leeres-brain.js';
import {
  _startwissenZuruecksetzen, starteStartwissen, holeStartwissenHinweis, STARTWISSEN_MARKE, type StartwissenUmfeld,
} from '../startwissen.js';
import { handleShareTool } from '../handlers/share.js';

type Handler = (
  name: string, args: Record<string, unknown>, verbindung: (id: string) => Promise<Redis>, api: never,
) => Promise<string | null>;

function apiMit(status: string) {
  return vi.fn(async (pfad: string) => {
    if (pfad.endsWith('/memory')) return { recall_limit: -1, total_recall_count: 0 };
    if (pfad.startsWith('/api/v1/instances/')) return { id: 'x', name: 'probe', status, tier: 'dev' };
    return null;
  });
}

const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRIST = 'FRIST: die Antwort wartet auf die Verbindung';

/** Eine Verbindung, die erst steht, wenn der Test es sagt. */
function spaeteVerbindung() {
  let verbinde: (r: Redis) => void = () => {};
  const versprechen = new Promise<Redis>((r) => { verbinde = r; });
  const verbindung = vi.fn(() => versprechen);
  return { verbindung, verbinde };
}

/** Antwort oder FRIST, je nachdem, was zuerst kommt. */
async function antwortOderFrist(antwort: Promise<string | null>, ms = 1500): Promise<string> {
  return String(await Promise.race([antwort, warte(ms).then(() => FRIST)]));
}

beforeEach(() => {
  _neueBrainsZuruecksetzen();
  _startwissenZuruecksetzen();
});

describe('session_start: neues Brain, das noch startet', () => {
  it('antwortet sofort mit einem ehrlichen Briefing — und schreibt nach, sobald die Verbindung steht', async () => {
    merkeNeuesBrain('neu-s1', true);
    const { verbindung, verbinde } = spaeteVerbindung();
    const api = apiMit('provisioning');

    const text = await antwortOderFrist(handleBrainTool(
      'session_start', { instance_id: 'neu-s1', focus: 'deploy the api', provider: 'claude' }, verbindung, api as never,
    ));

    expect(text).toContain('🧠 **Session Briefing** · claude');
    expect(text).toContain(NEUES_BRAIN);
    expect(text).toContain('last 30 commits');
    expect(text).toContain('smart_recall');
    expect(text).toContain('learn_from_attempts');
    expect(text).toContain('brain_seed_starter(instance_id="neu-s1")');
    expect(text).toContain('0 lessons · 0 context entries');
    // index.ts startet an diesem Satz den Import aus Git SYNCHRON — er waere
    // nicht wahr und hielte die Antwort an, bis die Instanz laeuft.
    expect(text).not.toContain('Welcome! Your AI Brain is live.');
    // Eine einzige API-Abfrage: der Stand der Instanz.
    expect(api.mock.calls.map((c) => String(c[0]))).toEqual(['/api/v1/instances/neu-s1']);
    expect(startetLautLetztemBlick('neu-s1')).toBe(true);

    const redis = new MockRedis();
    verbinde(redis as unknown as Redis);
    await warte(20);
    const beginn = JSON.parse(String(await redis.get('cachly:session:current')));
    expect(beginn).toMatchObject({ focus: 'deploy the api', provider: 'claude' });
    expect(JSON.parse(String(await redis.get('cachly:streak:current')))).toMatchObject({ days: 1, record: 1 });
    expect(await redis.get('cachly:mcp:version:last_seen')).toBeTruthy();
  });

  it('ohne Git-Import (CACHLY_STARTWISSEN=false) faellt der Satz dazu weg', async () => {
    merkeNeuesBrain('neu-s2', false);
    const { verbindung } = spaeteVerbindung();
    const text = await antwortOderFrist(handleBrainTool(
      'session_start', { instance_id: 'neu-s2' }, verbindung, apiMit('provisioning') as never,
    ));
    expect(text).toContain(NEUES_BRAIN);
    expect(text).not.toContain('commits');
  });

  it('laeuft die neue Instanz, nimmt session_start den vollen Weg — und fragt danach nicht mehr nach dem Stand', async () => {
    merkeNeuesBrain('neu-s3', true);
    const redis = new MockRedis();
    const verbindung = vi.fn(async () => redis as unknown as Redis);
    const api = apiMit('running');

    const erste = String(await handleBrainTool('session_start', { instance_id: 'neu-s3' }, verbindung, api as never));
    expect(erste).toContain('Welcome! Your AI Brain is live.');
    expect(erste).not.toContain(NEUES_BRAIN);
    expect(neuesBrain('neu-s3')?.laeuft).toBe(true);
    expect(startetLautLetztemBlick('neu-s3')).toBe(false);

    api.mockClear();
    await handleBrainTool('session_start', { instance_id: 'neu-s3' }, verbindung, api as never);
    expect(api.mock.calls.map((c) => String(c[0]))).not.toContain('/api/v1/instances/neu-s3');
  });
});

describe('die anderen fruehen Lesewerkzeuge: neues Brain, das noch startet', () => {
  const faelle: Array<{ werkzeug: string; handler: Handler; args: Record<string, unknown>; kopf: string }> = [
    { werkzeug: 'recall_best_solution', handler: handleBrainTool, args: { topic: 'deploy:api' }, kopf: '📭 No lessons found for `deploy:api`.' },
    { werkzeug: 'roadmap_list', handler: handleRoadmapTool, args: {}, kopf: '📋 **Roadmap is empty.**' },
    { werkzeug: 'roadmap_next', handler: handleRoadmapTool, args: {}, kopf: '📋 **Roadmap is empty.**' },
    { werkzeug: 'recall_context', handler: handleContextTool, args: { key: 'architektur' }, kopf: '⚠️ No cached context found for key `architektur`.' },
    { werkzeug: 'recall_context', handler: handleContextTool, args: { key: 'deploy*' }, kopf: '⚠️ No cached context found matching pattern `deploy*`.' },
    { werkzeug: 'list_remembered', handler: handleContextTool, args: {}, kopf: '📭 No cached context found.' },
    { werkzeug: 'brain_search', handler: handleSyndicateTool, args: { query: 'deploy' }, kopf: '🔎 **Brain Search: "deploy"**' },
    { werkzeug: 'causal_trace', handler: handleAdvancedTool, args: { problem: 'deploy fails' }, kopf: '🔍 **Causal Trace: "deploy fails"**' },
    { werkzeug: 'brain_predict', handler: handleSyndicateTool, args: { context: 'deploy' }, kopf: '🔮 **Brain Predict: "deploy"**' },
  ];

  it.each(faelle)('$werkzeug $args antwortet sofort', async ({ werkzeug, handler, args, kopf }) => {
    merkeNeuesBrain('neu-w', true);
    const { verbindung } = spaeteVerbindung();
    const api = apiMit('provisioning');

    const text = await antwortOderFrist(handler(werkzeug, { instance_id: 'neu-w', ...args }, verbindung, api as never));

    expect(text.startsWith(kopf)).toBe(true);
    expect(text).toContain(`${NEUES_BRAIN} and still empty`);
    expect(text).toContain('last 30 commits');
    expect(verbindung).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('ein Brain, das NICHT dieser Prozess angelegt hat: keine Abkuerzung und keine API-Abfrage, auch bei "provisioning"', async () => {
    const { verbindung } = spaeteVerbindung();
    const api = apiMit('provisioning');
    const text = await antwortOderFrist(
      handleBrainTool('recall_best_solution', { instance_id: 'alt-1', topic: 'deploy:api' }, verbindung, api as never),
      300,
    );
    expect(text).toBe(FRIST);
    expect(verbindung).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
  });

  it('meldet die API einen Fehler statt eines Stands, nimmt das Werkzeug den vollen Weg', async () => {
    merkeNeuesBrain('neu-f', true);
    const redis = new MockRedis();
    const api = vi.fn(async () => { throw new Error('503'); });
    const text = String(await handleRoadmapTool(
      'roadmap_list', { instance_id: 'neu-f' }, async () => redis as unknown as Redis, api as never,
    ));
    expect(text).toBe('📋 **Roadmap is empty.**\n\nUse `roadmap_add` to create your first item.');
    expect(neuesBrain('neu-f')?.laeuft).toBe(true);
  });
});

describe('Schreibwerkzeuge warten weiter auf die Instanz', () => {
  it.each([
    { werkzeug: 'learn_from_attempts', handler: handleBrainTool as Handler,
      args: { topic: 'probe:schreiben', outcome: 'success', what_worked: 'schreibt erst, wenn die Instanz laeuft' } },
    { werkzeug: 'remember_context', handler: handleContextTool as Handler,
      args: { key: 'probe', content: 'schreibt erst, wenn die Instanz laeuft' } },
  ])('$werkzeug antwortet nicht vor der Verbindung', async ({ werkzeug, handler, args }) => {
    merkeNeuesBrain('neu-schreiben', true);
    const { verbindung } = spaeteVerbindung();
    const text = await antwortOderFrist(
      handler(werkzeug, { instance_id: 'neu-schreiben', ...args }, verbindung, apiMit('provisioning') as never),
      300,
    );
    expect(text).toBe(FRIST);
    expect(verbindung).toHaveBeenCalled();
  });
});

/*
 * Ordner ohne Git: der Startvorrat (16 Lektionen) laedt im Hintergrund,
 * sobald die Instanz laeuft. Bis #730 spielte ihn der erste session_start
 * synchron ein; mit der Sofort-Antwort entfiel das, und genau die Nutzer ohne
 * Git sahen ein leeres Brain (Abnahme 11.10.2026).
 *
 * Gegenprobe am Code (11.10.2026, von Hand): ohne den Zweig fuer den
 * Startvorrat in startwissen.ts ist die erste Probe rot (kein-repo statt
 * startvorrat, nichts geladen).
 */
describe('Startvorrat: neues Brain in einem Ordner ohne Git', () => {
  function umfeld(
    instanzId: string,
    verbindung: (id: string) => Promise<Redis>,
    laden: (a: { instance_id: string }) => Promise<unknown>,
    extra: Partial<StartwissenUmfeld> = {},
  ): StartwissenUmfeld {
    return {
      instanzId, verbindung, startvorrat: laden,
      ausGit: vi.fn(async () => ''),
      projektOrdner: async () => process.cwd(),
      gitWurzel: async () => '',
      schlafen: async () => {}, anlaufMs: 0, protokoll: () => {}, env: {},
      ...extra,
    };
  }
  const echterVorrat = (redis: MockRedis) => vi.fn((a: { instance_id: string }) => handleShareTool(
    'brain_seed_starter', a, async () => redis as unknown as Redis, (async () => null) as never,
  ));

  it('laedt einmal, sobald die Instanz laeuft — der Werkzeugaufruf wartet nicht darauf', async () => {
    merkeNeuesBrain('neu-sv', true, true);
    const { verbindung, verbinde } = spaeteVerbindung();
    const redis = new MockRedis();
    const laden = echterVorrat(redis);
    const lauf = starteStartwissen(umfeld('neu-sv', verbindung, laden));

    // Waehrenddessen: session_start antwortet sofort und sagt, was kommt.
    const text = await antwortOderFrist(handleBrainTool(
      'session_start', { instance_id: 'neu-sv' }, verbindung, apiMit('provisioning') as never,
    ));
    expect(text).toContain(NEUES_BRAIN);
    expect(text).toContain('the Brain is loading 16 starter lessons');
    expect(text).not.toContain('brain_seed_starter(');
    expect(laden).not.toHaveBeenCalled();

    verbinde(redis as unknown as Redis);
    const ergebnis = await lauf;
    expect(ergebnis).toMatchObject({ art: 'startvorrat', lektionen: 16 });
    expect(laden).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(await redis.get(STARTWISSEN_MARKE)))).toMatchObject({ stand: 'fertig', startvorrat: 16 });
    expect(holeStartwissenHinweis()).toContain('loaded 16 starter lessons');

    // Ein zweiter Prozess (Neustart) laedt nicht noch einmal.
    _startwissenZuruecksetzen();
    const zweiter = await starteStartwissen(umfeld('neu-sv', async () => redis as unknown as Redis, laden));
    expect(zweiter.art).toBe('hat-lektionen');
    expect(laden).toHaveBeenCalledTimes(1);
  });

  it('steht die Marke schon (anderer Prozess), laedt er nicht — auch nicht in ein leeres Brain', async () => {
    const redis = new MockRedis();
    await redis.set(STARTWISSEN_MARKE, JSON.stringify({ stand: 'sitzungsstart' }));
    const laden = echterVorrat(redis);
    const ergebnis = await starteStartwissen(umfeld('neu-sv2', async () => redis as unknown as Redis, laden));
    expect(ergebnis.art).toBe('schon-erledigt');
    expect(laden).not.toHaveBeenCalled();
  });

  it('nur in ein leeres Brain', async () => {
    const redis = new MockRedis();
    await redis.set('cachly:lesson:best:eigen:notiz', JSON.stringify({ topic: 'eigen:notiz', outcome: 'success', what_worked: 'x' }));
    const laden = echterVorrat(redis);
    const ergebnis = await starteStartwissen(umfeld('neu-sv3', async () => redis as unknown as Redis, laden));
    expect(ergebnis.art).toBe('hat-lektionen');
    expect(laden).not.toHaveBeenCalled();
  });

  it('CACHLY_STARTVORRAT=false schaltet ihn ab', async () => {
    const redis = new MockRedis();
    const laden = echterVorrat(redis);
    const ergebnis = await starteStartwissen(umfeld('neu-sv4', async () => redis as unknown as Redis, laden, {
      env: { CACHLY_STARTVORRAT: 'false' },
    }));
    expect(ergebnis.art).toBe('kein-repo');
    expect(laden).not.toHaveBeenCalled();
  });

  it('im Git-Repo kommt die Geschichte, nicht der Startvorrat', async () => {
    const redis = new MockRedis();
    const laden = echterVorrat(redis);
    const ergebnis = await starteStartwissen(umfeld('neu-sv5', async () => redis as unknown as Redis, laden, {
      gitWurzel: async () => process.cwd(),
    }));
    expect(ergebnis.art).toBe('fertig');
    expect(laden).not.toHaveBeenCalled();
  });
});

describe('session_start: ein gefuelltes Brain bleibt unberuehrt', () => {
  it('keine Abfrage des Instanzstands, das volle Briefing wie bisher', async () => {
    const redis = new MockRedis();
    await redis.set('cachly:session:last', JSON.stringify({ summary: 'prior work', ts: new Date().toISOString() }));
    await redis.set('cachly:lesson:best:deploy:api', JSON.stringify({
      topic: 'deploy:api', outcome: 'success', what_worked: 'deploy via the release workflow', ts: new Date().toISOString(),
    }));
    const api = apiMit('running');
    const text = String(await handleBrainTool(
      'session_start', { instance_id: 'voll-s1', focus: 'deploy' }, async () => redis as unknown as Redis, api as never,
    ));
    expect(text).toContain('📊 **Brain:** 1 lessons');
    expect(text).toContain('deploy:api');
    expect(text).not.toContain(NEUES_BRAIN);
    expect(api.mock.calls.map((c) => String(c[0]))).not.toContain('/api/v1/instances/voll-s1');
    expect(startetLautLetztemBlick('voll-s1')).toBe(false);
  });
});
