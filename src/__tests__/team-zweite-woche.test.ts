/**
 * Zweite Woche mit dem Team-Brain (04.11.2026): Fehler, die eine KI beim taeglichen Gebrauch trifft.
 *  - team_recall zeigte "NaNd ago" fuer Lektionen aus team_learn, ignorierte `query`, warf bei limit<0
 *  - roadmap_update nahm jeden Status an; der Eintrag verschwand danach aus roadmap_list
 *  - forget_context warf "n is not iterable" bei `key` statt `keys`
 *  - index_project meldete "vector-searchable", obwohl der Server mit 400 abgelehnt hatte
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';

vi.mock('../embeddings.js', async (orig) => ({
  ...(await orig<typeof import('../embeddings.js')>()),
  hasEmbedProvider: () => true,
  computeEmbedding: async () => [0.1, 0.2, 0.3],
}));

import { handleTeamTool } from '../handlers/team.js';
import { handleRoadmapTool } from '../handlers/roadmap.js';
import { handleContextTool } from '../handlers/context.js';
import { handleCacheTool } from '../handlers/cache.js';

function globZuRegex(muster: string): RegExp {
  return new RegExp('^' + muster.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

class MockRedis {
  store = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();
  async get(k: string) { return this.store.get(k) ?? null; }
  async set(k: string, v: string, ..._r: unknown[]) { this.store.set(k, v); return 'OK'; }
  async del(...ks: string[]) { let n = 0; for (const k of ks) if (this.store.delete(k)) n++; return n; }
  async expire() { return 1; }
  async mget(...ks: string[]) { return ks.map((k) => this.store.get(k) ?? null); }
  async hset(k: string, f: string, v: string) {
    if (!this.hashes.has(k)) this.hashes.set(k, new Map());
    this.hashes.get(k)!.set(f, v); return 1;
  }
  async hget(k: string, f: string) { return this.hashes.get(k)?.get(f) ?? null; }
  async hgetall(k: string) { const h = this.hashes.get(k); return h ? Object.fromEntries(h) : {}; }
  async rpush(k: string, ...v: string[]) {
    if (!this.lists.has(k)) this.lists.set(k, []);
    this.lists.get(k)!.push(...v); return this.lists.get(k)!.length;
  }
  async lrange(k: string, s: number, e: number) { const l = this.lists.get(k) ?? []; return l.slice(s, e < 0 ? l.length + e + 1 : e + 1); }
  async ltrim() { return 'OK'; }
  async sismember() { return 0; }
  async smembers() { return []; }
  async scard() { return 0; }
  scanStream(opts: { match: string }) {
    const re = globZuRegex(opts.match);
    const h: Record<string, (...a: unknown[]) => void> = {};
    setTimeout(() => { h['data']?.([...this.store.keys()].filter((k) => re.test(k))); h['end']?.(); }, 0);
    const s = { on: (ev: string, fn: (...a: unknown[]) => void) => { h[ev] = fn; return s; } };
    return s;
  }
}

const IID = 'team-woche';
let redis: MockRedis;
const verbindung = async () => redis as unknown as Redis;
const apiFetch = (async () => ({ vector_token: 'tok', name: 'x' })) as never;
const team = (name: string, args: Record<string, unknown>) =>
  handleTeamTool(name, { instance_id: IID, ...args }, verbindung, apiFetch);

beforeEach(() => { redis = new MockRedis(); });

describe('team_recall', () => {
  it('zeigt fuer eine frische team_learn-Lektion "today" und nie NaN', async () => {
    await team('team_learn', { author: 'Anna', topic: 'deploy:rollback', outcome: 'success', what_worked: 'previous tag' });
    const out = (await team('team_recall', {}))!;
    expect(out).not.toContain('NaN');
    expect(out).toContain('today');
  });

  it('laesst die Zeitangabe weg, wenn eine alte Lektion gar keine Zeit traegt', async () => {
    redis.store.set('cachly:lesson:best:old:x', JSON.stringify({ topic: 'old:x', outcome: 'success', what_worked: 'w' }));
    const out = (await team('team_recall', {}))!;
    expect(out).not.toContain('NaN');
    expect(out).toContain('old:x');
  });

  it('liest bei alten team_learn-Lektionen das Feld `timestamp`', async () => {
    const vor3Tagen = new Date(Date.now() - 3 * 86400000).toISOString();
    redis.store.set('cachly:lesson:best:old:y', JSON.stringify({ topic: 'old:y', outcome: 'success', what_worked: 'w', timestamp: vor3Tagen }));
    expect((await team('team_recall', {}))!).toContain('3d ago');
  });

  it('nimmt `query` wie `topic` und filtert danach', async () => {
    await team('team_learn', { author: 'A', topic: 'deploy:rollback', outcome: 'success', what_worked: 'w1' });
    await team('team_learn', { author: 'A', topic: 'auth:cookie', outcome: 'success', what_worked: 'w2' });
    const out = (await team('team_recall', { query: 'rollback' }))!;
    expect(out).toContain('deploy:rollback');
    expect(out).not.toContain('auth:cookie');
  });

  it('wirft bei limit < 1 nicht und nimmt den Standard', async () => {
    await team('team_learn', { author: 'A', topic: 'a:b', outcome: 'success', what_worked: 'w' });
    for (const limit of [-3, 0, 'x']) {
      const out = (await team('team_recall', { limit }))!;
      expect(out).toContain('a:b');
    }
  });

  it('meldet bei einem Autor ohne Lektionen nicht "brain ist leer"', async () => {
    await team('team_learn', { author: 'Anna', topic: 'a:b', outcome: 'success', what_worked: 'w' });
    const out = (await team('team_recall', { author: 'Nobody' }))!;
    expect(out).not.toContain('No lessons in this brain yet');
    expect(out).toContain('Nobody');
    expect(out).toContain('team_learn');
  });
});

describe('team_learn', () => {
  it('lehnt einen unbekannten outcome und einen leeren Autor ab', async () => {
    const a = (await team('team_learn', { author: 'A', topic: 'a:b', outcome: 'bogus', what_worked: 'w' }))!;
    expect(a).toContain('outcome must be one of');
    const b = (await team('team_learn', { author: '  ', topic: 'a:b', outcome: 'success', what_worked: 'w' }))!;
    expect(b).toContain('author');
    expect(redis.store.size).toBe(0);
  });
});

describe('roadmap_update', () => {
  const rm = (name: string, args: Record<string, unknown>) =>
    handleRoadmapTool(name, { instance_id: IID, ...args }, verbindung, apiFetch)!;

  it('lehnt einen unbekannten Status ab; der Eintrag bleibt in roadmap_list', async () => {
    const add = (await rm('roadmap_add', { title: 'VAT field', priority: 'high' }))!;
    const id = /`(rm_[a-z0-9_]+)`/.exec(add)![1];
    const out = (await rm('roadmap_update', { id, status: 'bogus' }))!;
    expect(out).toContain('Unknown status');
    expect(out).toContain('in-progress');
    expect((await rm('roadmap_list', {}))!).toContain('VAT field');
  });

  it('lehnt eine unbekannte Prioritaet bei add und update ab', async () => {
    expect((await rm('roadmap_add', { title: 'x', priority: 'urgent' }))!).toContain('Unknown priority');
    const add = (await rm('roadmap_add', { title: 'y' }))!;
    const id = /`(rm_[a-z0-9_]+)`/.exec(add)![1];
    expect((await rm('roadmap_update', { id, priority: 'urgent' }))!).toContain('Unknown priority');
  });
});

describe('forget_context', () => {
  const ctx = (args: Record<string, unknown>) =>
    handleContextTool('forget_context', { instance_id: IID, ...args }, verbindung, apiFetch)!;

  it('nimmt `key` als Text und loescht', async () => {
    redis.store.set('cachly:ctx:custom:wip:billing', 'x');
    const out = (await ctx({ key: 'wip:billing' }))!;
    expect(out).toContain('Forgot 1');
    expect(redis.store.has('cachly:ctx:custom:wip:billing')).toBe(false);
  });

  it('sagt ohne keys klar, was fehlt, statt zu werfen', async () => {
    const out = (await ctx({}))!;
    expect(out).toContain('needs `keys`');
  });
});

describe('index_project', () => {
  let ordner: string;
  const cache = (args: Record<string, unknown>) =>
    handleCacheTool('index_project', { instance_id: IID, ...args }, verbindung, apiFetch)!;

  beforeEach(() => {
    ordner = mkdtempSync(join(tmpdir(), 'idx-'));
    writeFileSync(join(ordner, 'a.ts'), 'export const a = 1;\n');
  });
  afterEach(() => { rmSync(ordner, { recursive: true, force: true }); vi.unstubAllGlobals(); });

  it('sagt ohne dir klar, was fehlt (nicht "in `undefined`")', async () => {
    const out = (await cache({}))!;
    expect(out).toContain('needs `dir`');
    expect(out).not.toContain('undefined');
  });

  it('zaehlt eine vom Server abgelehnte Datei nicht als vector-searchable und versucht sie erneut', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"embedding dimensions 1024 exceed Solo tier limit of 768"}', { status: 400, statusText: 'Bad Request' })));
    const out = (await cache({ dir: ordner }))!;
    expect(out).toContain('Semantic:  **0**');
    expect(out).toContain('Semantic failed for 1 file');
    expect(out).toContain('exceed Solo tier limit');
    // Zweiter Lauf: die Datei gilt nicht als "unveraendert", sie wird erneut versucht.
    const zweiter = (await cache({ dir: ordner }))!;
    expect(zweiter).toContain('Indexed:   **1**');
  });

  it('zaehlt eine angenommene Datei als vector-searchable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const out = (await cache({ dir: ordner }))!;
    expect(out).toContain('Semantic:  **1**');
    expect(out).not.toContain('Semantic failed');
  });
});
