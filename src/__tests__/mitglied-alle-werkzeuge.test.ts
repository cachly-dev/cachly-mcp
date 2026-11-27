/**
 * Abnahme 2.3 und A2-3 (Stufe 2, PR 2): ALLE Werkzeuge einmal als Mitglied.
 *
 * Ein Mitglied meldet sich mit eigenem Benutzer an; das ACL-Muster sperrt
 * Team-Daten (S) und Wissen (W). Ein altes Werkzeug, das dort schreibt, darf
 * den Fehler weder roh an die KI geben ("NOPERM ...") noch still schlucken.
 *
 * Zwei Laeufe, dieselbe Pruefung:
 *   - gegen MockRedis mit dem Muster (schluessel-klassen.ts), immer;
 *   - gegen echten Valkey mit dem Muster aus acl.go, wenn
 *     CACHLY_TEST_VALKEY_URL gesetzt ist (CI-Dienst; lokal Docker). Der Lauf
 *     nutzt Datenbank 9 und raeumt sie danach ab.
 *
 * Je Werkzeug zaehlt die Huelle (rolle.ts), wie viele Schreibbefehle der
 * Speicher abgewiesen hat. Gemeldet wird:
 *   rohes NOPERM        die Antwort enthaelt "NOPERM"                 -> muss 0 sein
 *   still gescheitert   abgewiesen > 0, Antwort ohne Satz, NACH dem
 *                       Server (mitAbweisungsHinweis wie in index.ts) -> muss 0 sein
 *   vom Werkzeug ver-   abgewiesen > 0 und der Satz kam erst vom Server
 *   schluckt            (Liste zur Auskunft, kein Fehler)
 *   Lesewerkzeuge       Abrufe und Briefings duerfen gar nichts Gesperrtes
 *                       versuchen                                     -> muss 0 sein
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { TOOLS } from '../tools.js';
import { MockRedis } from './redis-mock.js';
import { aclAttrappe, apiAttrappe, rollenAntwort } from './helfer/mitglied-attrappe.js';
import {
  alsMitgliedsSpeicher, imWerkzeugLauf, mitAbweisungsHinweis, richteRolleEin, setzeRollenZustandZurueck,
  SCHREIBVERBOT_ANFANG, SchreibVerweigert, abrufMeldungenFertig,
} from '../rolle.js';
import { MITGLIED_MUSTER } from '../schluessel-klassen.js';
import { handleBrainTool } from '../handlers/brain.js';
import { handleContextTool } from '../handlers/context.js';
import { handleInstanceTool } from '../handlers/instances.js';
import { handleCacheTool } from '../handlers/cache.js';
import { handleTeamTool } from '../handlers/team.js';
import { handleRoadmapTool } from '../handlers/roadmap.js';
import { handleAdvancedTool } from '../handlers/advanced.js';
import { handleSyndicateTool } from '../handlers/syndicate.js';
import { handleShareTool } from '../handlers/share.js';
import { handleVizTool } from '../handlers/viz.js';
import { handleFedbrainTool } from '../handlers/fedbrain.js';

const IID = '11111111-2222-4333-8444-555555555555';
const ADRESSE = process.env.CACHLY_TEST_VALKEY_URL ?? '';
const ECHT_DB = 9;
const MITGLIED = 'm-0123456789abcdef';
const MITGLIED_PW = 'mitglied-probe-geheim';
const FRIST_MS = 20_000;

/** Werkzeuge, die vor allem lesen: sie duerfen als Mitglied NICHTS Gesperrtes versuchen. */
const LESEWERKZEUGE = [
  'smart_recall', 'recall_best_solution', 'session_start', 'session_start_summary', 'team_recall',
  'team_whoami', 'team_roster', 'brain_search', 'recall_context', 'list_remembered', 'brain_briefing',
];

type Handler = (n: string, a: Record<string, unknown>, g: (i: string) => Promise<Redis>, f: <T>(p: string, o?: RequestInit) => Promise<T>) => Promise<string | null>;
const HANDLER: Array<[string, Handler]> = [
  ['brain', handleBrainTool as Handler], ['context', handleContextTool as Handler], ['instances', handleInstanceTool as Handler],
  ['cache', handleCacheTool as Handler], ['team', handleTeamTool as Handler], ['roadmap', handleRoadmapTool as Handler],
  ['advanced', handleAdvancedTool as Handler], ['syndicate', handleSyndicateTool as Handler], ['share', handleShareTool as Handler],
  ['viz', handleVizTool as Handler], ['fedbrain', handleFedbrainTool as Handler],
];

interface Schema { type?: string; enum?: unknown[]; items?: Schema; minimum?: number; properties?: Record<string, Schema>; required?: string[] }

function wertFuer(name: string, s: Schema, ordner: string): unknown {
  if (s.enum?.length) return s.enum[0];
  if (/path|dir$|_dir|workspace|repo/i.test(name) && s.type !== 'array') return ordner;
  switch (s.type) {
    case 'number': case 'integer': return Math.max(1, s.minimum ?? 1);
    case 'boolean': return false;
    case 'object': return {};
    case 'array': return s.items?.type === 'string' ? ['deploy:web'] : [];
    default: break;
  }
  if (name === 'instance_id') return IID;
  if (/^(topic|lesson_topic|from_topic|to_topic|concept)$/.test(name)) return 'deploy:web';
  if (name === 'outcome') return 'success';
  if (name === 'what_worked') return 'Rollback ueber das Tag v1.2';
  if (/^(handle|author|reviewer|requester|assigned_by|person|user|member)$/.test(name)) return 'bob';
  if (name === 'role') return 'reviewer';
  if (name === 'group') return 'backend';
  if (/key$/.test(name)) return 'probe:schluessel';
  if (/token|share_id|id$/.test(name)) return 'probe-id';
  if (/email/.test(name)) return 'probe@example.invalid';
  if (/url/.test(name)) return 'http://127.0.0.1:9/probe';
  return 'deploy rollback web';
}

function argumenteFuer(werkzeug: { name: string; inputSchema?: Schema }, ordner: string): Record<string, unknown> {
  const props = werkzeug.inputSchema?.properties ?? {};
  const pflicht = new Set(werkzeug.inputSchema?.required ?? []);
  const args: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(props)) {
    const pfad = /path$|dir$|_dir|workspace|repo/i.test(name) && s.type !== 'array';
    if (pflicht.has(name) || pfad || ['what_worked', 'value', 'content', 'query', 'topic', 'handle', 'author'].includes(name)) {
      args[name] = wertFuer(name, s, ordner);
    }
  }
  args.instance_id = IID;
  return args;
}

async function seed(r: { set: (k: string, v: string) => Promise<unknown>; sadd: (k: string, ...m: string[]) => Promise<unknown>; rpush: (k: string, ...v: string[]) => Promise<unknown> }): Promise<void> {
  const jetzt = new Date().toISOString();
  for (const t of ['deploy:web', 'db:pool', 'cache:ttl']) {
    await r.set(`cachly:lesson:best:${t}`, JSON.stringify({
      topic: t, outcome: 'success', severity: 'major', what_worked: `deploy rollback web ${t}`, what_failed: '',
      ts: jetzt, verified_at: jetzt, author: 'anna', tags: ['ops'], recall_count: 1, version: 3,
    }));
    await r.rpush(`cachly:lessons:${t}`, JSON.stringify({ topic: t, outcome: 'success', ts: jetzt }));
  }
  await r.set('cachly:ctx:notiz', 'deploy rollback web notiz');
  await r.sadd(`cachly:team:groups:${IID}`, 'backend');
  await r.sadd(`cachly:team:group:${IID}:backend`, 'anna');
}

interface Befund { werkzeug: string; handler: string; abgewiesen: number; antwort: string; fehler?: string; dauerMs: number; schluessel?: string[] }

async function laufAlle(
  getConn: () => Promise<Redis>,
  api: ReturnType<typeof apiAttrappe>,
  ordner: string,
  protokoll?: { abgewiesen: Array<{ befehl: string; schluessel: string }> },
): Promise<{ befunde: Befund[]; ohneHandler: string[] }> {
  const befunde: Befund[] = [];
  const ohneHandler: string[] = [];
  const werkzeuge = TOOLS as unknown as Array<{ name: string; inputSchema?: Schema }>;
  for (const w of werkzeuge) {
    const args = argumenteFuer(w, ordner);
    const start = Date.now();
    const schonAbgewiesen = protokoll?.abgewiesen.length ?? 0;
    let handler = '';
    const lauf = await imWerkzeugLauf(async () => {
      let uhr: ReturnType<typeof setTimeout> | undefined;
      const zeit = new Promise<never>((_, nein) => { uhr = setTimeout(() => nein(new Error(`Zeitlimit ${FRIST_MS} ms`)), FRIST_MS); });
      zeit.catch(() => undefined);
      try {
        for (const [name, h] of HANDLER) {
          const r = await Promise.race([h(w.name, args, getConn, api.api), zeit]);
          if (r !== null) { handler = name; return { text: String(r) as string | null }; }
        }
        return { text: null as string | null };
      } catch (e) {
        // Wie index.ts: SchreibVerweigert wird eine Antwort, alles andere ein Fehler mit Text.
        if (e instanceof SchreibVerweigert) return { text: `🔒 ${e.message}` as string | null, fehler: 'SchreibVerweigert' };
        return { text: ((e as Error)?.message ?? String(e)) as string | null, fehler: 'Fehler' };
      } finally {
        clearTimeout(uhr);
      }
    });
    if (lauf.ergebnis.text === null) { ohneHandler.push(w.name); continue; }
    befunde.push({
      werkzeug: w.name, handler, abgewiesen: lauf.abgewiesen, antwort: lauf.ergebnis.text,
      ...(lauf.ergebnis.fehler ? { fehler: lauf.ergebnis.fehler } : {}), dauerMs: Date.now() - start,
      ...(protokoll ? { schluessel: protokoll.abgewiesen.slice(schonAbgewiesen).map((x) => `${x.befehl} ${x.schluessel}`) } : {}),
    });
  }
  await abrufMeldungenFertig();
  return { befunde, ohneHandler };
}

function auswerten(titel: string, befunde: Befund[], ohneHandler: string[]): {
  rohNoPerm: string[]; still: string[]; verschluckt: string[]; leseSchreiben: string[];
} {
  const rohNoPerm = befunde.filter((b) => /NOPERM/.test(b.antwort)).map((b) => b.werkzeug);
  const verschluckt = befunde.filter((b) => b.abgewiesen > 0 && !b.antwort.includes(SCHREIBVERBOT_ANFANG)).map((b) => b.werkzeug);
  const nachServer = befunde.map((b) => ({ ...b, antwort: mitAbweisungsHinweis(b.antwort, b.abgewiesen) }));
  const still = nachServer.filter((b) => b.abgewiesen > 0 && !b.antwort.includes(SCHREIBVERBOT_ANFANG)).map((b) => b.werkzeug);
  const leseSchreiben = befunde.filter((b) => LESEWERKZEUGE.includes(b.werkzeug) && b.abgewiesen > 0).map((b) => `${b.werkzeug} (${b.abgewiesen})`);
  const mitSatz = befunde.filter((b) => b.abgewiesen > 0)
    .map((b) => `${b.werkzeug}:${b.abgewiesen}${b.schluessel?.length ? ` [${[...new Set(b.schluessel)].join('; ')}]` : ''}`);
  const fehler = befunde.filter((b) => b.fehler === 'Fehler').map((b) => `${b.werkzeug}: ${b.antwort.split('\n')[0].slice(0, 90)}`);
  console.log([
    `[${titel}] ${befunde.length} Werkzeuge gelaufen, ${ohneHandler.length} nur in index.ts (${ohneHandler.join(', ')})`,
    `[${titel}] rohes NOPERM: ${rohNoPerm.length} ${rohNoPerm.join(', ')}`,
    `[${titel}] still gescheitert (nach dem Server): ${still.length} ${still.join(', ')}`,
    `[${titel}] abgewiesen, mit Satz: ${mitSatz.length} ${mitSatz.join(', ')}`,
    `[${titel}] davon vom Werkzeug verschluckt, Satz vom Server: ${verschluckt.length} ${verschluckt.join(', ')}`,
    `[${titel}] Lesewerkzeuge mit abgewiesenem Schreiben: ${leseSchreiben.length} ${leseSchreiben.join(', ')}`,
    `[${titel}] andere Fehler (Attrappe/Argumente, kein NOPERM): ${fehler.length}`,
    ...fehler.map((f) => `    ${f}`),
  ].join('\n'));
  return { rohNoPerm, still, verschluckt, leseSchreiben };
}

describe('Abnahme 2.3: alle Werkzeuge als Mitglied gegen MockRedis mit dem ACL-Muster', () => {
  let ordner = '';
  beforeAll(() => { ordner = mkdtempSync(join(tmpdir(), 'cachly-mitglied-')); });
  afterAll(() => { setzeRollenZustandZurueck(); rmSync(ordner, { recursive: true, force: true }); });

  it('kein rohes NOPERM, nichts still gescheitert, Lesewerkzeuge schreiben nichts Gesperrtes', async () => {
    const mock = new MockRedis();
    await seed(mock as unknown as Parameters<typeof seed>[0]);
    const { redis: roh, protokoll } = aclAttrappe(mock, { mitglied: true, unbekannt: 'null' });
    const redis = alsMitgliedsSpeicher(roh, { role: 'contributor', instanceId: IID }) as unknown as Redis;
    const api = apiAttrappe({ rolle: rollenAntwort('contributor') });
    richteRolleEin({ abruf: api.api });
    const { befunde, ohneHandler } = await laufAlle(async () => redis, api, ordner, protokoll);
    const e = auswerten('Attrappe', befunde, ohneHandler);
    expect(befunde.length).toBeGreaterThan(100);
    expect(e.rohNoPerm).toEqual([]);
    expect(e.still).toEqual([]);
    expect(e.leseSchreiben).toEqual([]);
    // Bestand: Team-Daten unveraendert (das Muster hat jeden Versuch abgewiesen).
    expect(protokoll.abgewiesen.every((s) => !s.schluessel.startsWith('cachly:ctx:'))).toBe(true);
  }, 600_000);
});

describe.runIf(ADRESSE)('Abnahme A2-3: alle Werkzeuge als Mitglied gegen echten Valkey mit dem ACL-Muster', () => {
  let besitzer: Redis;
  let mitglied: Redis;
  let ordner = '';

  beforeAll(async () => {
    ordner = mkdtempSync(join(tmpdir(), 'cachly-mitglied-echt-'));
    besitzer = new Redis(ADRESSE, { db: ECHT_DB, maxRetriesPerRequest: 2, connectTimeout: 5000 });
    if ((await besitzer.dbsize()) !== 0) {
      throw new Error(`Datenbank ${ECHT_DB} unter CACHLY_TEST_VALKEY_URL ist nicht leer; dieser Lauf raeumt sie danach ab und startet nur leer.`);
    }
    await seed(besitzer);
    await besitzer.call('ACL', 'DELUSER', MITGLIED);
    await besitzer.call('ACL', 'SETUSER', MITGLIED, 'on', `>${MITGLIED_PW}`, ...MITGLIED_MUSTER);
    const url = new URL(ADRESSE);
    mitglied = new Redis({
      host: url.hostname, port: Number(url.port || 6379), db: ECHT_DB,
      username: MITGLIED, password: MITGLIED_PW, maxRetriesPerRequest: 1, connectTimeout: 5000,
    });
    expect(await mitglied.ping()).toBe('PONG');
  });

  afterAll(async () => {
    setzeRollenZustandZurueck();
    await mitglied?.quit().catch(() => undefined);
    if (besitzer?.status === 'ready') {
      await besitzer.flushdb();
      await besitzer.call('ACL', 'DELUSER', MITGLIED).catch(() => undefined);
    }
    await besitzer?.quit().catch(() => undefined);
    rmSync(ordner, { recursive: true, force: true });
  });

  it('kein rohes NOPERM, nichts still gescheitert, Lesewerkzeuge schreiben nichts Gesperrtes; Team-Daten unveraendert', async () => {
    const redis = alsMitgliedsSpeicher(mitglied, { role: 'contributor', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('contributor') });
    richteRolleEin({ abruf: api.api });
    const vorher = {
      gruppe: await besitzer.smembers(`cachly:team:group:${IID}:backend`),
      lektionen: (await besitzer.keys('cachly:lesson:best:*')).sort(),
    };
    const { befunde, ohneHandler } = await laufAlle(async () => redis, api, ordner);
    const e = auswerten('Valkey', befunde, ohneHandler);
    expect(befunde.length).toBeGreaterThan(100);
    expect(e.rohNoPerm).toEqual([]);
    expect(e.still).toEqual([]);
    expect(e.leseSchreiben).toEqual([]);
    expect(await besitzer.smembers(`cachly:team:group:${IID}:backend`)).toEqual(vorher.gruppe);
    expect((await besitzer.keys('cachly:lesson:best:*')).sort()).toEqual(vorher.lektionen);
    expect(await besitzer.hgetall(`cachly:team:roles:${IID}`)).toEqual({});
  }, 900_000);
});
