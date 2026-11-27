/**
 * Stufe 2, PR 2: Die Rolle kommt aus der API, Mitglieder schreiben ueber die API.
 *
 * Abnahme 2.1 (.stufe2/ABNAHMEN-stufe-2.md, PR 2) mit den 8 Pflichtfaellen:
 *   1. team_whoami zeigt Rolle und Herkunft aus GET /role; ein gefaelschter
 *      Hash-Eintrag "admin" aendert weder die Ausgabe noch requireRole.
 *   2. team_assign_role schreibt nichts (0 Schreibbefehle) und nennt die Seite.
 *   3. Mitglied ruft learn_from_attempts: genau 1 POST /learn, 0 Schreiben auf cachly:lesson:*.
 *   4. viewer ruft learn_from_attempts: Antwort nennt die Rolle, kein NOPERM.
 *   5. Mitglied ruft smart_recall: Zaehler an /lessons/recalled, 0 Schreiben auf cachly:lesson:best:*.
 *   6. Besitzer: alles wie heute, 0 Aufrufe von /learn.
 *   7. Alte API (GET /role -> 404): Verhalten wie heute.
 *   8. /connection mit username -> der Redis-Client bekommt ihn; 409
 *      member_access_unavailable -> ein Satz, kein Verbindungsversuch.
 *
 * Gegenproben (von Hand, siehe PR-Text): requireRole wieder aus dem Hash ->
 * Fall 1 rot; username in anmeldeOptionen weglassen -> Fall 8 rot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Redis } from 'ioredis';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { MockRedis } from './redis-mock.js';
import { aclAttrappe, apiAttrappe, aufrufeNach, rollenAntwort, apiFehlerMit } from './helfer/mitglied-attrappe.js';
import { handleTeamTool, requireRole, ROLES_KEY } from '../handlers/team.js';
import { handleBrainTool } from '../handlers/brain.js';
import {
  holeRolle, richteRolleEin, setzeRollenZustandZurueck, alsMitgliedsSpeicher, istMitglied, zugangVon,
  imWerkzeugLauf, mitAbweisungsHinweis, SchreibVerweigert, schreibverbotText, istNoPerm, apiFehler,
  markiereApiFehler, abrufMeldungenFertig, meldeAbrufe, ROLLE_FRISCH_MS, alsRollenAuskunft,
} from '../rolle.js';
import { holeVerbindungsAuskunft, anmeldungAus, baueSpeicherClient, anmeldeOptionen } from '../speicher-zugang.js';
import { installiereClientKopf, clientKopfWert, CLIENT_KOPF, istApiAdresse } from '../client-kopf.js';

const IID = 'i-rolle';

type Werkzeug = (name: string, args: Record<string, unknown>) => Promise<string>;

function lege(redis: MockRedis, topic: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  return redis.set(`cachly:lesson:best:${topic}`, JSON.stringify({
    topic, outcome: 'success', severity: 'major', what_worked: `Loesung fuer ${topic} mit plugh-wort`, what_failed: '',
    ts: new Date().toISOString(), verified_at: new Date().toISOString(), author: 'alice', tags: ['ops'], recall_count: 0, ...extra,
  }));
}

function werkzeuge(redis: unknown, api: ReturnType<typeof apiAttrappe>['api']): { brain: Werkzeug; team: Werkzeug } {
  const getConn = async () => redis as Redis;
  return {
    brain: async (name, args) => String(await handleBrainTool(name, { instance_id: IID, ...args }, getConn, api)),
    team: async (name, args) => String(await handleTeamTool(name, { instance_id: IID, ...args }, getConn, api)),
  };
}

beforeEach(() => setzeRollenZustandZurueck());
afterEach(() => setzeRollenZustandZurueck());

// ── Pflichtfall 1 ────────────────────────────────────────────────────────────
describe('Fall 1: team_whoami und requireRole lesen die Rolle aus GET /role, nicht aus dem Hash', () => {
  it('gefaelschter Hash-Eintrag "admin" aendert team_whoami nicht', async () => {
    const mock = new MockRedis();
    await mock.hset(ROLES_KEY(IID), 'bob', 'admin'); // Faelschung
    const api = apiAttrappe({ rolle: rollenAntwort('contributor', 'default') });
    richteRolleEin({ abruf: api.api });
    const { team } = werkzeuge(alsMitgliedsSpeicher(mock, { role: 'contributor', instanceId: IID }), api.api);

    const aus = await team('team_whoami', { handle: 'bob' });
    expect(aus).toContain('`contributor`');
    expect(aus).toContain('default for members');
    expect(aus).not.toContain('`admin`');
    expect(aufrufeNach(api, 'GET', /\/role$/)).toHaveLength(1);
  });

  it('requireRole: contributor laut API bleibt ohne Admin-Recht, auch wenn der Hash "admin" sagt', async () => {
    const mock = new MockRedis();
    await mock.hset(ROLES_KEY(IID), 'bob', 'admin');
    const api = apiAttrappe({ rolle: rollenAntwort('contributor') });
    richteRolleEin({ abruf: api.api });
    const nein = await requireRole(mock as unknown as Redis, IID, 'bob', 'admin', 'view the governance audit log');
    expect(nein).toMatch(/Permission denied/);
    expect(nein).toContain('contributor');
    expect(nein).toContain('cachly.dev/team');
    // Ueber das Werkzeug: team_audit bleibt zu.
    const { team } = werkzeuge(mock, api.api);
    expect(await team('team_audit', { requester: 'bob' })).toMatch(/Permission denied/);
  });

  it('requireRole: admin laut API darf, auch ohne jeden Hash-Eintrag', async () => {
    const mock = new MockRedis();
    const api = apiAttrappe({ rolle: rollenAntwort('admin', 'owner') });
    richteRolleEin({ abruf: api.api });
    expect(await requireRole(mock as unknown as Redis, IID, 'irgendwer', 'admin', 'x')).toBeNull();
  });
});

// ── Pflichtfall 2 ────────────────────────────────────────────────────────────
describe('Fall 2: team_assign_role schreibt nichts und nennt die Dashboard-Seite', () => {
  it('0 Schreibbefehle, Satz mit cachly.dev/team', async () => {
    const { redis, protokoll } = aclAttrappe(new MockRedis(), { mitglied: false });
    const api = apiAttrappe({ rolle: rollenAntwort('admin', 'owner') });
    richteRolleEin({ abruf: api.api });
    const { team } = werkzeuge(redis, api.api);
    const aus = await team('team_assign_role', { handle: 'bob', role: 'reviewer', assigned_by: 'anna' });
    expect(protokoll.schreiben).toEqual([]);
    expect(aus).toContain('https://cachly.dev/team');
    expect(aus).toMatch(/Nothing was changed/);
  });
});

// ── Pflichtfall 3 ────────────────────────────────────────────────────────────
describe('Fall 3: Mitglied lernt -> genau ein POST /learn, kein Schreiben auf cachly:lesson:*', () => {
  it('learn_from_attempts als contributor', async () => {
    const { redis: roh, protokoll } = aclAttrappe(new MockRedis(), { mitglied: true });
    const redis = alsMitgliedsSpeicher(roh, { role: 'contributor', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('contributor') });
    richteRolleEin({ abruf: api.api });
    const { brain } = werkzeuge(redis, api.api);

    const lauf = await imWerkzeugLauf(() => brain('learn_from_attempts', {
      topic: 'deploy:web', outcome: 'success', what_worked: 'Rollback ueber das Tag v1.2', severity: 'major',
    }));
    const lernen = aufrufeNach(api, 'POST', /\/learn$/);
    expect(lernen).toHaveLength(1);
    expect(lernen[0].pfad).toBe(`/api/v1/instances/${IID}/learn`);
    expect(lernen[0].koerper).toMatchObject({ topic: 'deploy:web', outcome: 'success', what_worked: 'Rollback ueber das Tag v1.2', source: 'mcp' });
    expect(protokoll.schreiben.filter((s) => s.schluessel.startsWith('cachly:lesson'))).toEqual([]);
    expect(protokoll.abgewiesen).toEqual([]);
    expect(lauf.abgewiesen).toBe(0);
    expect(lauf.ergebnis).toContain('Lesson stored');
    expect(lauf.ergebnis).not.toMatch(/NOPERM/);
  });

  it('team_learn als contributor geht ebenfalls an POST /learn', async () => {
    const { redis: roh, protokoll } = aclAttrappe(new MockRedis(), { mitglied: true });
    const redis = alsMitgliedsSpeicher(roh, { role: 'contributor', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('contributor') });
    richteRolleEin({ abruf: api.api });
    const { team } = werkzeuge(redis, api.api);
    const aus = await team('team_learn', { author: 'bob', topic: 'db:pool', outcome: 'success', what_worked: 'pool size 20' });
    expect(aufrufeNach(api, 'POST', /\/learn$/)).toHaveLength(1);
    expect(protokoll.abgewiesen).toEqual([]);
    expect(aus).toContain('Lesson stored');
  });

  it('Freigabepflicht: die Antwort der API (proposed) wird als Vorschlag gemeldet', async () => {
    const redis = alsMitgliedsSpeicher(new MockRedis(), { role: 'contributor', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('contributor'), vorschlag: true });
    richteRolleEin({ abruf: api.api });
    const { brain } = werkzeuge(redis, api.api);
    const aus = await brain('learn_from_attempts', { topic: 'x:y', outcome: 'success', what_worked: 'z' });
    expect(aus).toMatch(/submitted for review/);
  });

  it('private Lektion eines Mitglieds: klarer Satz, kein Aufruf, nichts geschrieben', async () => {
    const { redis: roh, protokoll } = aclAttrappe(new MockRedis(), { mitglied: true });
    const redis = alsMitgliedsSpeicher(roh, { role: 'contributor', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('contributor') });
    richteRolleEin({ abruf: api.api });
    const { brain } = werkzeuge(redis, api.api);
    const aus = await brain('learn_from_attempts', { topic: 'x:privat', outcome: 'success', what_worked: 'z', visibility: 'private' });
    expect(aus).toMatch(/Nicht gespeichert/);
    expect(aufrufeNach(api, 'POST', /\/learn$/)).toHaveLength(0);
    expect(protokoll.schreiben).toEqual([]);
  });

  it('team_confirm als reviewer geht an POST /lessons/confirm', async () => {
    const mock = new MockRedis();
    await lege(mock, 'db:pool');
    const { redis: roh, protokoll } = aclAttrappe(mock, { mitglied: true });
    const redis = alsMitgliedsSpeicher(roh, { role: 'reviewer', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('reviewer', 'assigned') });
    richteRolleEin({ abruf: api.api });
    const { team } = werkzeuge(redis, api.api);
    const aus = await team('team_confirm', { topic: 'db:pool', reviewer: 'bob', level: 'senior', note: 'passt' });
    const best = aufrufeNach(api, 'POST', /\/lessons\/confirm$/);
    expect(best).toHaveLength(1);
    expect(best[0].koerper).toMatchObject({ topic: 'db:pool', tier: 'senior', note: 'passt' });
    expect(protokoll.schreiben).toEqual([]);
    expect(aus).toMatch(/senior-reviewed/);
  });
});

// ── Pflichtfall 4 ────────────────────────────────────────────────────────────
describe('Fall 4: viewer lernt -> Satz mit der Rolle, kein NOPERM', () => {
  it('learn_from_attempts als viewer', async () => {
    const redis = alsMitgliedsSpeicher(new MockRedis(), { role: 'viewer', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('viewer'), lernenVerboten: 'viewer' });
    richteRolleEin({ abruf: api.api });
    const { brain } = werkzeuge(redis, api.api);
    const aus = await brain('learn_from_attempts', { topic: 'deploy:web', outcome: 'success', what_worked: 'x' });
    expect(aus).toContain('viewer');
    expect(aus).toMatch(/Nichts wurde gespeichert/);
    expect(aus).not.toMatch(/NOPERM/);
  });

  it('team_learn als viewer: die Rolle laut API sperrt schon vor dem Aufruf', async () => {
    const redis = alsMitgliedsSpeicher(new MockRedis(), { role: 'viewer', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('viewer') });
    richteRolleEin({ abruf: api.api });
    const { team } = werkzeuge(redis, api.api);
    const aus = await team('team_learn', { author: 'bob', topic: 'a:b', outcome: 'success', what_worked: 'c' });
    expect(aus).toMatch(/Permission denied/);
    expect(aus).toContain('viewer');
    expect(aufrufeNach(api, 'POST', /\/learn$/)).toHaveLength(0);
  });
});

// ── Pflichtfall 5 ────────────────────────────────────────────────────────────
describe('Fall 5: Mitglied ruft smart_recall -> Zaehler an /lessons/recalled, kein Schreiben auf best:*', () => {
  it('smart_recall und recall_best_solution', async () => {
    const mock = new MockRedis();
    await lege(mock, 'deploy:plugh');
    await lege(mock, 'cache:plugh');
    const { redis: roh, protokoll } = aclAttrappe(mock, { mitglied: true });
    const redis = alsMitgliedsSpeicher(roh, { role: 'contributor', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('contributor') });
    richteRolleEin({ abruf: api.api });
    const { brain } = werkzeuge(redis, api.api);

    const lauf = await imWerkzeugLauf(() => brain('smart_recall', { query: 'plugh-wort loesung' }));
    await abrufMeldungenFertig();
    expect(lauf.ergebnis).toContain('plugh');
    const gemeldet = aufrufeNach(api, 'POST', /\/lessons\/recalled$/);
    expect(gemeldet.length).toBe(1);
    expect((gemeldet[0].koerper as { topics: string[] }).topics.sort()).toEqual(['cache:plugh', 'deploy:plugh']);
    expect(protokoll.schreiben.filter((s) => s.schluessel.startsWith('cachly:lesson:best:'))).toEqual([]);
    // Ein Lesewerkzeug darf am Speicher gar nichts Gesperrtes versuchen.
    expect(protokoll.abgewiesen).toEqual([]);
    expect(lauf.abgewiesen).toBe(0);

    const lauf2 = await imWerkzeugLauf(() => brain('recall_best_solution', { topic: 'deploy:plugh' }));
    await abrufMeldungenFertig();
    expect(lauf2.ergebnis).toContain('deploy:plugh');
    expect(aufrufeNach(api, 'POST', /\/lessons\/recalled$/).length).toBe(2);
    expect(protokoll.abgewiesen).toEqual([]);
    // Die Lektion selbst ist unveraendert (recall_count bleibt 0 im Speicher).
    expect(JSON.parse((await mock.get('cachly:lesson:best:deploy:plugh'))!).recall_count).toBe(0);
  });

  it('ohne vector_token (Mitglied bei Schutz) faellt smart_recall still auf den normalen Weg', async () => {
    const mock = new MockRedis();
    await lege(mock, 'deploy:plugh');
    const redis = alsMitgliedsSpeicher(mock, { role: 'contributor', instanceId: IID });
    const api = apiAttrappe({ rolle: rollenAntwort('contributor') });
    const tarif = { id: IID, tier: 'team', status: 'running' }; // Team-Tarif, aber kein vector_token
    const mitTarif = async <T>(pfad: string, o?: RequestInit): Promise<T> =>
      (/\/instances\/[^/]+$/.test(pfad) ? tarif as T : api.api<T>(pfad, o));
    richteRolleEin({ abruf: mitTarif });
    const aus = String(await handleBrainTool('smart_recall', { instance_id: IID, query: 'plugh-wort' }, async () => redis as unknown as Redis, mitTarif));
    expect(aus).toContain('deploy:plugh');
    expect(aus).not.toMatch(/NOPERM|Das darf nur/);
  });
});

// ── Pflichtfall 6 ────────────────────────────────────────────────────────────
describe('Fall 6: Besitzer (kein access, Rolle admin) verhaelt sich wie vorher', () => {
  const lernArgs = { topic: 'deploy:web', outcome: 'success', what_worked: 'Rollback ueber das Tag v1.2', severity: 'major' };
  const ohneZeit = (s: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T').replace(/\d+ ?ms\b/g, 'N ms')
    .replace(/receipt: `[0-9a-f]+`/g, 'receipt: `R`');

  it('learn_from_attempts schreibt direkt, 0 Aufrufe von /learn, Ausgabe wie ohne Rollen-API', async () => {
    const vorher = new MockRedis();
    const ausVorher = await werkzeuge(vorher, apiAttrappe({ rolle: null }).api).brain('learn_from_attempts', lernArgs);

    const jetzt = new MockRedis();
    const api = apiAttrappe({ rolle: rollenAntwort('admin', 'owner') });
    richteRolleEin({ abruf: api.api });
    const ausJetzt = await werkzeuge(jetzt, api.api).brain('learn_from_attempts', lernArgs);

    expect(aufrufeNach(api, 'POST', /\/learn$/)).toHaveLength(0);
    expect(istMitglied(jetzt)).toBe(false);
    const a = JSON.parse((await vorher.get('cachly:lesson:best:deploy:web'))!);
    const b = JSON.parse((await jetzt.get('cachly:lesson:best:deploy:web'))!);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    expect(b.what_worked).toBe(a.what_worked);
    expect(ohneZeit(ausJetzt)).toBe(ohneZeit(ausVorher));
  });

  it('smart_recall des Besitzers zaehlt wie vorher im Speicher, ohne /lessons/recalled', async () => {
    const mock = new MockRedis();
    await lege(mock, 'deploy:plugh');
    const api = apiAttrappe({ rolle: rollenAntwort('admin', 'owner') });
    richteRolleEin({ abruf: api.api });
    await werkzeuge(mock, api.api).brain('smart_recall', { query: 'plugh-wort' });
    await abrufMeldungenFertig();
    expect(aufrufeNach(api, 'POST', /\/lessons\/recalled$/)).toHaveLength(0);
    // fire-and-forget im Speicher: einen Takt abwarten
    await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse((await mock.get('cachly:lesson:best:deploy:plugh'))!).recall_count).toBe(1);
  });
});

// ── Pflichtfall 7 ────────────────────────────────────────────────────────────
describe('Fall 7: alte API (GET /role -> 404) = Verhalten wie heute', () => {
  it('team_whoami und team_assign_role lesen und schreiben den Hash wie bisher', async () => {
    const mitAlt = new MockRedis();
    const ohne = new MockRedis();
    const api = apiAttrappe({ rolle: null });
    richteRolleEin({ abruf: api.api });
    const alt = werkzeuge(mitAlt, api.api);
    const a1 = await alt.team('team_assign_role', { handle: 'anna', role: 'admin' });
    const a2 = await alt.team('team_whoami', { handle: 'anna' });
    expect(await holeRolle(IID)).toBeNull();
    expect(await mitAlt.hgetall(ROLES_KEY(IID))).toEqual({ anna: 'admin' });

    setzeRollenZustandZurueck(); // gar keine Rollen-API eingerichtet
    const leer = werkzeuge(ohne, api.api);
    expect(await leer.team('team_assign_role', { handle: 'anna', role: 'admin' })).toBe(a1);
    expect(await leer.team('team_whoami', { handle: 'anna' })).toBe(a2);
  });

  it('404 wird 60 s gemerkt (kein zweiter Abruf)', async () => {
    const api = apiAttrappe({ rolle: null });
    richteRolleEin({ abruf: api.api });
    expect(await holeRolle(IID)).toBeNull();
    expect(await holeRolle(IID)).toBeNull();
    expect(aufrufeNach(api, 'GET', /\/role$/)).toHaveLength(1);
  });
});

// ── Pflichtfall 8 ────────────────────────────────────────────────────────────
describe('Fall 8: /connection mit username -> der Client bekommt ihn; 409 -> ein Satz', () => {
  class Spion { static zuletzt: Record<string, unknown> | null = null; constructor(o: Record<string, unknown>) { Spion.zuletzt = o; } }

  it('Mitglied: username und Passwort gehen an new Redis(), die Verbindung ist umhuellt', async () => {
    const auskunft = await holeVerbindungsAuskunft(async () => ({
      password: 'pw-mitglied', username: 'm-0123456789abcdef', access: 'member', role: 'contributor', tls_enabled: false,
    }), 'Team-Brain');
    const anmeldung = anmeldungAus(auskunft);
    const { nutzbar } = baueSpeicherClient(Spion, { host: 'h', port: 1 }, anmeldung, IID);
    expect(Spion.zuletzt).toMatchObject({ host: 'h', port: 1, username: 'm-0123456789abcdef', password: 'pw-mitglied' });
    expect(istMitglied(nutzbar)).toBe(true);
    expect(zugangVon(nutzbar)).toMatchObject({ access: 'member', role: 'contributor', username: 'm-0123456789abcdef' });
  });

  it('Besitzer: nur das Passwort, kein username, keine Huelle (wie vor Stufe 2)', () => {
    const anmeldung = anmeldungAus({ password: 'voll', tls_enabled: false });
    const { roh, nutzbar } = baueSpeicherClient(Spion, { host: 'h' }, anmeldung, IID);
    expect(Spion.zuletzt).toEqual({ host: 'h', password: 'voll' });
    expect(nutzbar).toBe(roh);
    expect(anmeldeOptionen(anmeldung)).not.toHaveProperty('username');
  });

  it('409 member_access_unavailable: ein Satz, kein Weiter ohne Passwort', async () => {
    let gefragt = 0;
    const fehler = markiereApiFehler(new McpError(ErrorCode.InternalError, 'cachly API error 409: Der Zugang ...'), 409,
      { code: 'member_access_unavailable', reason: 'acl_failed' });
    const versuch = holeVerbindungsAuskunft(async () => { gefragt++; throw fehler; }, 'Team-Brain');
    await expect(versuch).rejects.toThrow(/Der Zugang fuer Mitglieder zu Brain "Team-Brain" geht gerade nicht \(Grund: acl_failed\)/);
    await expect(versuch).rejects.toBeInstanceOf(McpError);
    expect(gefragt).toBe(1);
  });

  it('500 an /connection: wie bisher ohne Auskunft weiter (kein Satz)', async () => {
    const aus = await holeVerbindungsAuskunft(async () => { throw apiFehlerMit(500); }, 'B');
    expect(aus).toBeUndefined();
  });

  it('Quelltext: baueVerbindung fragt /connection vor dem Bau des Clients und baut ihn nur ueber baueSpeicherClient', () => {
    const quelle = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const anfang = quelle.indexOf('async function baueVerbindung(');
    const ende = quelle.indexOf('\n}\n', anfang);
    const rumpf = quelle.slice(anfang, ende);
    expect(anfang).toBeGreaterThan(0);
    expect(rumpf.indexOf('holeVerbindungsAuskunft(')).toBeGreaterThan(0);
    expect(rumpf.indexOf('holeVerbindungsAuskunft(')).toBeLessThan(rumpf.indexOf('baueSpeicherClient('));
    expect(rumpf).not.toMatch(/new Redis\(/);
  });
});

// ── Bausteine ────────────────────────────────────────────────────────────────
describe('holeRolle', () => {
  it('ohne Einrichtung: null (altes Verhalten), kein Abruf', async () => {
    expect(await holeRolle(IID)).toBeNull();
  });

  it('haelt die Antwort 60 s; danach alter Stand sofort und neue Antwort im Hintergrund', async () => {
    const api = apiAttrappe({ rolle: rollenAntwort('reviewer', 'assigned') });
    richteRolleEin({ abruf: api.api });
    const echt = Date.now;
    try {
      let jetzt = 1_000_000;
      Date.now = () => jetzt;
      expect((await holeRolle(IID))?.role).toBe('reviewer');
      expect((await holeRolle(IID))?.role).toBe('reviewer');
      expect(aufrufeNach(api, 'GET', /\/role$/)).toHaveLength(1);
      api.rolle = rollenAntwort('viewer', 'assigned');
      jetzt += ROLLE_FRISCH_MS + 1;
      expect((await holeRolle(IID))?.role).toBe('reviewer'); // alter Stand, Abruf laeuft
      await new Promise((r) => setTimeout(r, 0));
      expect(aufrufeNach(api, 'GET', /\/role$/)).toHaveLength(2);
      expect((await holeRolle(IID))?.role).toBe('viewer');
    } finally {
      Date.now = echt;
    }
  });

  it('getrennt je Bereich (HTTP-Modus: je Schluessel)', async () => {
    let bereich = 'a';
    const api = apiAttrappe({ rolle: rollenAntwort('admin') });
    richteRolleEin({ abruf: api.api, bereich: () => bereich });
    await holeRolle(IID);
    bereich = 'b';
    api.rolle = rollenAntwort('viewer');
    expect((await holeRolle(IID))?.role).toBe('viewer');
    expect(aufrufeNach(api, 'GET', /\/role$/)).toHaveLength(2);
  });

  it('unbekannte Form (z. B. { data: [] }) gilt wie eine alte API', () => {
    expect(alsRollenAuskunft({ data: [] })).toBeNull();
    expect(alsRollenAuskunft({ role: 'superadmin' })).toBeNull();
    expect(alsRollenAuskunft(rollenAntwort('viewer'))?.can.learn).toBe(false);
  });
});

describe('Huelle: NOPERM wird ein Satz, auch in Buendeln, und wird je Aufruf gezaehlt', () => {
  it('ein abgewiesener Befehl wirft SchreibVerweigert mit der Rolle', async () => {
    const { redis: roh } = aclAttrappe(new MockRedis(), { mitglied: true });
    const redis = alsMitgliedsSpeicher(roh, { role: 'viewer', instanceId: IID });
    const lauf = await imWerkzeugLauf(async () => {
      await expect(redis.set('cachly:lesson:best:x', '1')).rejects.toBeInstanceOf(SchreibVerweigert);
      await expect(redis.set('cachly:team:roles:x', '1')).rejects.toThrow(schreibverbotText('viewer'));
      await redis.set('cachly:lesson:best:y', '1').catch(() => {}); // verschluckt
      expect(await redis.set('cachly:ctx:frei', '1')).toBe('OK');
      return 'fertig';
    });
    expect(lauf.abgewiesen).toBe(3);
    expect(mitAbweisungsHinweis(lauf.ergebnis, lauf.abgewiesen, lauf.rolle)).toContain('Das darf nur der Besitzer oder ein Admin. Deine Rolle: viewer.');
  });

  it('pipeline: Einzelfehler werden uebersetzt, nicht roh durchgereicht', async () => {
    const { redis: roh } = aclAttrappe(new MockRedis(), { mitglied: true });
    const redis = alsMitgliedsSpeicher(roh, { role: 'contributor', instanceId: IID }) as unknown as { pipeline(): { set(k: string, v: string): unknown; exec(): Promise<[unknown, unknown][]> } };
    const p = redis.pipeline();
    p.set('cachly:ctx:a', '1');
    p.set('cachly:meta:brain:x', '1');
    const erg = await p.exec();
    expect(erg[0][0]).toBeNull();
    expect(erg[1][0]).toBeInstanceOf(SchreibVerweigert);
  });

  it('mitAbweisungsHinweis haengt den Satz nur einmal an und nur bei Abweisung', () => {
    expect(mitAbweisungsHinweis('ok', 0)).toBe('ok');
    const einmal = mitAbweisungsHinweis('ok', 2, 'contributor');
    expect(einmal).toContain('2 Schreibbefehle');
    expect(mitAbweisungsHinweis(einmal, 1, 'contributor')).toBe(einmal);
  });

  it('istNoPerm erkennt auch abgebrochene Transaktionen', () => {
    expect(istNoPerm(new Error('NOPERM this user has no permissions'))).toBe(true);
    expect(istNoPerm(Object.assign(new Error('EXECABORT Transaction discarded'), { previousErrors: [new Error('NOPERM x')] }))).toBe(true);
    expect(istNoPerm(new Error('WRONGTYPE'))).toBe(false);
  });
});

describe('Fehler der API reisen mit Status und Code', () => {
  it('markiereApiFehler laesst den Protokoll-Code eines McpError in Ruhe', () => {
    const e = markiereApiFehler(new McpError(ErrorCode.InternalError, 'cachly API error 403: no'), 403, { code: 'role_viewer', role: 'viewer' });
    expect(e.code).toBe(ErrorCode.InternalError);
    expect(apiFehler(e)).toEqual({ status: 403, code: 'role_viewer', role: 'viewer' });
  });

  it('ohne Markierung: Status aus dem Text', () => {
    expect(apiFehler(new Error('Access denied (403): x')).status).toBe(403);
    expect(apiFehler(new Error('cachly API error 404: not found')).status).toBe(404);
  });
});

describe('Abrufzaehler: gesammelt, in Paketen zu 25, nicht wartend', () => {
  it('30 Themen -> 2 Aufrufe, doppelte nur einmal', async () => {
    const api = apiAttrappe();
    const themen = Array.from({ length: 30 }, (_, i) => `t:${i}`);
    meldeAbrufe(api.api, IID, [...themen, 't:0']);
    await abrufMeldungenFertig();
    const auf = aufrufeNach(api, 'POST', /\/lessons\/recalled$/);
    expect(auf.map((a) => (a.koerper as { topics: string[] }).topics.length)).toEqual([25, 5]);
  });
});

describe('Kopf X-Cachly-Client an jedem Aufruf der API', () => {
  it('nur fuer Adressen der API, ein eigener Kopf bleibt', async () => {
    const gesehen: Array<{ url: string; kopf: string | null }> = [];
    const ziel = {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        gesehen.push({ url, kopf: new Headers(init?.headers).get(CLIENT_KOPF) });
        return new Response('{}');
      }) as typeof fetch,
    };
    const zurueck = installiereClientKopf(() => 'https://api.cachly.dev', clientKopfWert('0.10.281'), ziel);
    await ziel.fetch('https://api.cachly.dev/api/v1/instances/x/role', { headers: { Authorization: 'Bearer k' } });
    await ziel.fetch('https://registry.npmjs.org/@cachly-dev/mcp-server');
    await ziel.fetch('https://api.cachly.dev/health', { headers: { [CLIENT_KOPF]: 'eigen' } });
    zurueck();
    expect(gesehen).toEqual([
      { url: 'https://api.cachly.dev/api/v1/instances/x/role', kopf: 'mcp/0.10.281' },
      { url: 'https://registry.npmjs.org/@cachly-dev/mcp-server', kopf: null },
      { url: 'https://api.cachly.dev/health', kopf: 'eigen' },
    ]);
    expect(istApiAdresse('https://api.cachly.dev.evil.example/x', 'https://api.cachly.dev')).toBe(false);
  });
});
