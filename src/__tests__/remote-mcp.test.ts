import { createServer, type Server as HttpServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  ABLEHNUNG_TTL_MS,
  ANLEITUNG_OHNE_KOPF,
  BegrenzterSpeicher,
  MAX_AUTH_KOPF,
  ZUGANG_MAX,
  ZUGANG_TTL_MS,
  ZugangAbgelehnt,
  baueKontext,
  baueZugangsAufloeser,
  bereinigeArgumente,
  hashDesSchluessels,
  imMandant,
  istRemoteErlaubt,
  leseBearer,
  leseInstanzKopf,
  mandantKontext,
  poolSchluessel,
} from '../remote-zugang.js';

/**
 * ABNAHME Remote-MCP (HTTP-Modus): hinter /mcp steht das Brain des Aufrufers.
 * Der Kern ist die Trennung der Mandanten, nicht die Bequemlichkeit.
 */

const KEY_A = 'cky_live_AAAAAAAAAAAAAAAAAAAAAAAA';
const KEY_B = 'cky_live_BBBBBBBBBBBBBBBBBBBBBBBB';
const INST_1 = '11111111-1111-4111-8111-111111111111';
const INST_2 = '22222222-2222-4222-8222-222222222222';

describe('Kopf lesen', () => {
  it('nimmt Bearer mit cky_-Schluessel', () => {
    expect(leseBearer(`Bearer ${KEY_A}`)).toEqual({ art: 'ok', schluessel: KEY_A });
    expect(leseBearer(`bearer   ${KEY_A}`)).toEqual({ art: 'ok', schluessel: KEY_A });
  });

  it('fehlender oder leerer Kopf ist "fehlt", kein Fehler', () => {
    expect(leseBearer(undefined)).toEqual({ art: 'fehlt' });
    expect(leseBearer('   ')).toEqual({ art: 'fehlt' });
  });

  it('lehnt Basic, Token ohne Schema und fremde Formen ab', () => {
    expect(leseBearer('Basic dXNlcjpwYXNz')).toEqual({ art: 'abgelehnt', grund: 'kein-bearer' });
    expect(leseBearer(KEY_A)).toEqual({ art: 'abgelehnt', grund: 'kein-bearer' });
    expect(leseBearer('Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc')).toEqual({ art: 'abgelehnt', grund: 'form' });
    expect(leseBearer('Bearer cky_ kurz')).toEqual({ art: 'abgelehnt', grund: 'kein-bearer' });
  });

  it('begrenzt die Kopfgroesse', () => {
    const lang = `Bearer cky_${'a'.repeat(MAX_AUTH_KOPF)}`;
    expect(leseBearer(lang)).toEqual({ art: 'abgelehnt', grund: 'zu-lang' });
  });

  it('doppelter Kopf wird abgelehnt', () => {
    expect(leseBearer([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`])).toEqual({ art: 'abgelehnt', grund: 'mehrfach' });
  });

  it('der Grund einer Ablehnung enthaelt nie den Kopf', () => {
    const r = leseBearer('Bearer cky_!!!!!!!!!!!!!!!!!!!');
    expect(JSON.stringify(r)).not.toContain('!!!!');
  });

  it('X-Cachly-Instance: nur UUID', () => {
    expect(leseInstanzKopf(INST_1.toUpperCase())).toEqual({ art: 'ok', instanzId: INST_1 });
    expect(leseInstanzKopf(undefined)).toEqual({ art: 'fehlt' });
    expect(leseInstanzKopf('../../etc/passwd')).toEqual({ art: 'abgelehnt' });
    expect(leseInstanzKopf('x'.repeat(5000))).toEqual({ art: 'abgelehnt' });
    expect(leseInstanzKopf([INST_1, INST_2])).toEqual({ art: 'abgelehnt' });
  });
});

describe('Pool-Schluessel', () => {
  it('enthaelt den Hash des Schluessels und die Instanz, nie den Schluessel', () => {
    const k = poolSchluessel(KEY_A, INST_1);
    expect(k).toBe(`${hashDesSchluessels(KEY_A)}:${INST_1}`);
    expect(k).not.toContain(KEY_A);
    expect(k).not.toContain('cky_');
  });

  it('gleiche Instanz mit anderem Schluessel ergibt einen anderen Eintrag', () => {
    expect(poolSchluessel(KEY_A, INST_1)).not.toBe(poolSchluessel(KEY_B, INST_1));
    expect(poolSchluessel(KEY_A, INST_1)).not.toBe(poolSchluessel(KEY_A, INST_2));
    expect(poolSchluessel(KEY_A, INST_1)).not.toBe(INST_1);
  });

  it('ein Pool mit diesen Schluesseln gibt einem fremden Schluessel nichts heraus', () => {
    const pool = new BegrenzterSpeicher<string>({ max: 10, ttlMs: 1000 });
    pool.set(poolSchluessel(KEY_A, INST_1), 'verbindung-von-A');
    expect(pool.get(poolSchluessel(KEY_B, INST_1))).toBeUndefined();
    expect(pool.get(INST_1)).toBeUndefined();
    expect(pool.get(poolSchluessel(KEY_A, INST_1))).toBe('verbindung-von-A');
  });
});

describe('Begrenzter Speicher: Ablaufzeit und Obergrenze', () => {
  it('ein Eintrag laeuft nach der Lebensdauer ab, auch wenn er oft benutzt wird', () => {
    let t = 0;
    const weg: string[] = [];
    const s = new BegrenzterSpeicher<string>({ max: 5, ttlMs: 600_000, jetzt: () => t, beiEntfernen: (_w, g) => weg.push(g) });
    s.set('k', 'v');
    t = 599_000;
    expect(s.get('k')).toBe('v'); // Zugriff verlaengert NICHT
    t = 600_001;
    expect(s.get('k')).toBeUndefined();
    expect(weg).toEqual(['abgelaufen']);
  });

  it('bei Ueberlauf geht der am laengsten ungenutzte; die Verbindung wird geschlossen', () => {
    const geschlossen: string[] = [];
    const s = new BegrenzterSpeicher<string>({ max: 2, ttlMs: 1000, beiEntfernen: (w, g) => { if (g === 'verdraengt') geschlossen.push(w); } });
    s.set('a', 'A');
    s.set('b', 'B');
    s.get('a'); // a ist jetzt neuer als b
    s.set('c', 'C');
    expect(geschlossen).toEqual(['B']);
    expect(s.has('a') && s.has('c') && !s.has('b')).toBe(true);
    expect(s.groesse).toBe(2);
  });

  it('Standardgrenzen: 200 Eintraege, 10 Minuten', () => {
    expect(ZUGANG_MAX).toBe(200);
    expect(ZUGANG_TTL_MS).toBe(600_000);
  });

  it('vergissWenn entfernt nur denselben Wert (ein neuer Eintrag bleibt)', () => {
    const s = new BegrenzterSpeicher<object>({ max: 5, ttlMs: 1000 });
    const alt = {};
    const neu = {};
    s.set('k', neu);
    s.vergissWenn('k', alt);
    expect(s.get('k')).toBe(neu);
  });
});

describe('Zugang aufloesen: die API entscheidet', () => {
  const liste = (ids: string[]) => ({ status: 200, body: { data: ids.map((id) => ({ id })) } });

  it('ohne Kopf und mit genau einer Instanz: diese', async () => {
    const z = baueZugangsAufloeser(async () => liste([INST_1]));
    await expect(z.loese(KEY_A, undefined)).resolves.toBe(INST_1);
  });

  it('mehrere oder keine Instanz: Fehler mit Hinweis auf den Kopf', async () => {
    const viele = baueZugangsAufloeser(async () => liste([INST_1, INST_2]));
    await expect(viele.loese(KEY_A, undefined)).rejects.toThrow(/X-Cachly-Instance/);
    const keine = baueZugangsAufloeser(async () => liste([]));
    await expect(keine.loese(KEY_A, undefined)).rejects.toThrow(/noch kein Brain/);
  });

  it('gebundener Schluessel (Liste 403): Hinweis auf den Kopf, kein Absturz', async () => {
    const z = baueZugangsAufloeser(async () => ({ status: 403, body: null }));
    const fehler = await z.loese(KEY_A, undefined).catch((e: unknown) => e);
    expect(fehler).toBeInstanceOf(ZugangAbgelehnt);
    expect((fehler as ZugangAbgelehnt).httpStatus).toBe(400);
    expect((fehler as ZugangAbgelehnt).message).toContain('X-Cachly-Instance');
  });

  it('mit Kopf: die API wird nach GENAU dieser Instanz gefragt; fremde Instanz wird abgelehnt', async () => {
    const gefragt: string[] = [];
    const z = baueZugangsAufloeser(async (pfad, schluessel) => {
      gefragt.push(`${pfad}|${schluessel}`);
      return { status: schluessel === KEY_A ? 200 : 403, body: null };
    });
    await expect(z.loese(KEY_A, INST_1)).resolves.toBe(INST_1);
    const fremd = await z.loese(KEY_B, INST_1).catch((e: unknown) => e);
    expect((fremd as ZugangAbgelehnt).httpStatus).toBe(403);
    expect(gefragt).toEqual([`/api/v1/instances/${INST_1}|${KEY_A}`, `/api/v1/instances/${INST_1}|${KEY_B}`]);
  });

  it('403 und 404 klingen gleich (kein Orakel fuer fremde Instanz-IDs)', async () => {
    const a = await baueZugangsAufloeser(async () => ({ status: 403, body: null })).loese(KEY_A, INST_1).catch((e: Error) => e.message);
    const b = await baueZugangsAufloeser(async () => ({ status: 404, body: null })).loese(KEY_A, INST_1).catch((e: Error) => e.message);
    expect(a).toBe(b);
  });

  it('falscher Schluessel: 401, und die Fehlermeldung enthaelt ihn nicht', async () => {
    const z = baueZugangsAufloeser(async () => ({ status: 401, body: null }));
    const fehler = (await z.loese(KEY_A, undefined).catch((e: unknown) => e)) as ZugangAbgelehnt;
    expect(fehler.httpStatus).toBe(401);
    expect(fehler.message).not.toContain(KEY_A);
    expect(fehler.message).not.toContain('cky_');
  });

  it('Ergebnisse gelten 10 Minuten, danach fragt der Server die API erneut (Widerruf wirkt)', async () => {
    let t = 0;
    let widerrufen = false;
    let aufrufe = 0;
    const z = baueZugangsAufloeser(
      async () => { aufrufe++; return widerrufen ? { status: 401, body: null } : liste([INST_1]); },
      { jetzt: () => t },
    );
    await z.loese(KEY_A, undefined);
    await z.loese(KEY_A, undefined);
    expect(aufrufe).toBe(1); // zweiter Aufruf aus dem Speicher
    widerrufen = true;
    t = ZUGANG_TTL_MS - 1;
    await expect(z.loese(KEY_A, undefined)).resolves.toBe(INST_1); // noch im Fenster
    t = ZUGANG_TTL_MS + 1;
    await expect(z.loese(KEY_A, undefined)).rejects.toThrow(/abgelehnt/);
    expect(aufrufe).toBe(2);
  });

  it('ein abgelehnter Schluessel trifft die API nicht bei jedem Versuch, aber nach einer Minute wieder', async () => {
    let t = 0;
    let aufrufe = 0;
    const z = baueZugangsAufloeser(async () => { aufrufe++; return { status: 401, body: null }; }, { jetzt: () => t });
    for (let i = 0; i < 5; i++) await z.loese(KEY_A, undefined).catch(() => undefined);
    expect(aufrufe).toBe(1);
    t = ABLEHNUNG_TTL_MS + 1;
    await z.loese(KEY_A, undefined).catch(() => undefined);
    expect(aufrufe).toBe(2);
  });

  it('Netzfehler und 5xx werden NICHT gemerkt', async () => {
    let aufrufe = 0;
    const z = baueZugangsAufloeser(async () => {
      aufrufe++;
      if (aufrufe === 1) throw new Error('ECONNRESET');
      if (aufrufe === 2) return { status: 503, body: null };
      return liste([INST_1]);
    });
    await expect(z.loese(KEY_A, undefined)).rejects.toThrow('ECONNRESET');
    await expect(z.loese(KEY_A, undefined)).rejects.toThrow(/503/);
    await expect(z.loese(KEY_A, undefined)).resolves.toBe(INST_1);
  });

  it('zwei Schluessel teilen nie ein Ergebnis', async () => {
    const z = baueZugangsAufloeser(async (_p, schluessel) => liste([schluessel === KEY_A ? INST_1 : INST_2]));
    const [a, b] = await Promise.all([z.loese(KEY_A, undefined), z.loese(KEY_B, undefined)]);
    expect([a, b]).toEqual([INST_1, INST_2]);
  });
});

describe('Argumente im HTTP-Modus', () => {
  it('instance_id wird gesetzt; eine ANDERE Instanz ist ein Fehler, kein stilles Umbiegen', () => {
    expect(bereinigeArgumente({ query: 'x' }, INST_1)).toEqual({ args: { query: 'x', instance_id: INST_1 } });
    expect(bereinigeArgumente({ instance_id: INST_1.toUpperCase() }, INST_1)).toEqual({ args: { instance_id: INST_1 } });
    expect('fehler' in bereinigeArgumente({ instance_id: INST_2 }, INST_1)).toBe(true);
  });

  it('Pfade des Servers fliegen raus', () => {
    const r = bereinigeArgumente({ workspace_path: '/etc', repo_path: '/', dir: '/', project_dir: '/', query: 'q' }, INST_1);
    expect(r).toEqual({ args: { query: 'q', instance_id: INST_1 } });
  });

  it('nur Kernwerkzeuge ohne Dateizugriff sind freigegeben', () => {
    for (const ok of ['smart_recall', 'learn_from_attempts', 'session_start', 'recall_best_solution', 'cache_get', 'roadmap_list']) {
      expect(istRemoteErlaubt(ok)).toBe(true);
    }
    for (const nein of ['brain_from_git', 'index_project', 'autopilot', 'cls_install_hooks', 'brain_watch', 'setup_ai_memory', 'gibt_es_nicht']) {
      expect(istRemoteErlaubt(nein)).toBe(false);
    }
  });

  it('die Anleitung nennt Kopf, autopilot und die Schluessel-Seite', () => {
    expect(ANLEITUNG_OHNE_KOPF).toContain('claude mcp add --transport http cachly https://mcp.cachly.dev/mcp --header "Authorization: Bearer <key>"');
    expect(ANLEITUNG_OHNE_KOPF).toContain('npx @cachly-dev/mcp-server@latest autopilot');
    expect(ANLEITUNG_OHNE_KOPF).toContain('https://cachly.dev/setup-ai');
  });
});

// ── AsyncLocalStorage durch das echte SDK ────────────────────────────────────

function sseOderJson(text: string): { result?: { content?: Array<{ text?: string }>; tools?: unknown[]; isError?: boolean }; error?: unknown } {
  const zeile = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(zeile ? zeile.slice(5) : text);
}

const KOPF = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

async function rpc(url: string, methode: string, params: unknown, extra: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...KOPF, ...extra },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: methode, params }),
  });
  return { status: r.status, text: await r.text() };
}

describe('AsyncLocalStorage: zwei gleichzeitige Anfragen, zwei Welten', () => {
  let http: HttpServer;
  let url = '';

  beforeAll(async () => {
    http = createServer((req, res) => {
      const bearer = leseBearer(req.headers.authorization);
      if (bearer.art !== 'ok') { res.writeHead(401); res.end(); return; }
      const inst = req.headers['x-test-instanz'] === '2' ? INST_2 : INST_1;
      const kontext = baueKontext(bearer.schluessel, inst);
      void imMandant(kontext, async () => {
        const s = new Server({ name: 't', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'wer', inputSchema: { type: 'object' } }] }));
        s.setRequestHandler(CallToolRequestSchema, async () => {
          // Die Antwort kommt NACH einer Pause, in der die andere Anfrage laeuft.
          const vorher = mandantKontext();
          await new Promise((r) => setTimeout(r, 60));
          await Promise.resolve();
          const nachher = mandantKontext();
          return { content: [{ type: 'text', text: JSON.stringify({ vorher: vorher?.schluesselHash, nachher: nachher?.schluesselHash, instanz: nachher?.instanzId }) }] };
        });
        const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void t.close(); void s.close(); });
        await s.connect(t);
        await t.handleRequest(req, res);
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => { await new Promise<void>((r) => http.close(() => r())); });

  it('jede Anfrage sieht nur ihren eigenen Schluessel-Hash, vor und nach dem Warten', async () => {
    const aufruf = (key: string, instanz: string) =>
      rpc(url, 'tools/call', { name: 'wer', arguments: {} }, { Authorization: `Bearer ${key}`, 'X-Test-Instanz': instanz });
    const antworten = await Promise.all([
      aufruf(KEY_A, '1'), aufruf(KEY_B, '2'), aufruf(KEY_A, '1'), aufruf(KEY_B, '2'),
      aufruf(KEY_A, '1'), aufruf(KEY_B, '2'),
    ]);
    const hashA = hashDesSchluessels(KEY_A);
    const hashB = hashDesSchluessels(KEY_B);
    const gesehen = antworten.map((a) => JSON.parse(sseOderJson(a.text).result!.content![0].text!) as { vorher: string; nachher: string; instanz: string });
    gesehen.forEach((g, i) => {
      const erwartet = i % 2 === 0 ? { h: hashA, inst: INST_1 } : { h: hashB, inst: INST_2 };
      expect(g.vorher).toBe(erwartet.h);
      expect(g.nachher).toBe(erwartet.h);
      expect(g.instanz).toBe(erwartet.inst);
    });
  });

  it('ausserhalb einer Anfrage gibt es keinen Kontext', () => {
    expect(mandantKontext()).toBeUndefined();
  });
});

// ── Der echte Server im HTTP-Modus, gegen eine Attrappe der API ──────────────

describe('HTTP-Server (echter Prozess, Attrappen-API auf Loopback)', () => {
  let api: HttpServer;
  let kind: ChildProcess;
  let base = '';
  let stderr = '';
  const apiAnfragen: Array<{ pfad: string; auth: string }> = [];

  beforeAll(async () => {
    api = createServer((req, res) => {
      const auth = String(req.headers.authorization ?? '');
      apiAnfragen.push({ pfad: req.url ?? '', auth });
      res.setHeader('Content-Type', 'application/json');
      if (auth !== `Bearer ${KEY_A}`) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
      if (req.url === '/api/v1/instances') { res.end(JSON.stringify({ data: [{ id: INST_1, status: 'running' }] })); return; }
      if (req.url === `/api/v1/instances/${INST_1}`) { res.end(JSON.stringify({ id: INST_1, status: 'running' })); return; }
      res.writeHead(403); res.end('{"error":"forbidden"}');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const apiPort = (api.address() as AddressInfo).port;

    const frei = createServer();
    await new Promise<void>((r) => frei.listen(0, '127.0.0.1', r));
    const port = (frei.address() as AddressInfo).port;
    await new Promise<void>((r) => frei.close(() => r()));

    const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const index = fileURLToPath(new URL('../index.ts', import.meta.url));
    kind = spawn(process.execPath, [tsx, index], {
      env: {
        ...process.env,
        PORT: String(port),
        CACHLY_API_URL: `http://127.0.0.1:${apiPort}`,
        // Ein Schluessel im Prozess darf im HTTP-Modus nie gelten.
        CACHLY_JWT: 'cky_live_PROZESSSCHLUESSEL_DARF_NIE_GELTEN',
        CACHLY_BRAIN_INSTANCE_ID: INST_2,
        CACHLY_UPDATE_CHECK: 'false',
        CACHLY_NO_TELEMETRY: '1',
        HOME: process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
        USERPROFILE: process.env.TEMP ?? process.env.TMPDIR ?? '/tmp',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    kind.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    base = `http://127.0.0.1:${port}`;
    const bis = Date.now() + 45_000;
    for (;;) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* noch nicht da */ }
      if (Date.now() > bis) throw new Error(`Server startete nicht. stderr: ${stderr.slice(0, 500)}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }, 60_000);

  afterAll(async () => {
    kind?.kill();
    await new Promise<void>((r) => api.close(() => r()));
  });

  const aufruf = (name: string, args: Record<string, unknown>, kopf: Record<string, string> = {}) =>
    rpc(`${base}/mcp`, 'tools/call', { name, arguments: args }, kopf);

  it('/health zeigt keine Suchanfragen mehr', async () => {
    const h = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    expect(h.status).toBe('ok');
    expect(JSON.stringify(h)).not.toContain('zeroResults');
  });

  it('ohne Kopf: die Werkzeugliste bleibt sichtbar', async () => {
    const r = await rpc(`${base}/mcp`, 'tools/list', {});
    expect(r.status).toBe(200);
    expect(sseOderJson(r.text).result!.tools!.length).toBeGreaterThan(5);
  });

  it('ohne Kopf: ein Werkzeugaufruf bekommt die Anleitung, keinen 500er', async () => {
    const r = await aufruf('smart_recall', { query: 'x' });
    expect(r.status).toBe(200);
    const antwort = sseOderJson(r.text).result!;
    expect(antwort.content![0].text).toContain('claude mcp add --transport http cachly https://mcp.cachly.dev/mcp');
    expect(antwort.content![0].text).toContain('autopilot');
    expect(antwort.content![0].text).toContain('https://cachly.dev/setup-ai');
  });

  it('der Schluessel des Prozesses gilt im HTTP-Modus nicht', async () => {
    await aufruf('smart_recall', { query: 'x' });
    expect(apiAnfragen.some((a) => a.auth.includes('PROZESSSCHLUESSEL'))).toBe(false);
  });

  it('falscher Schluessel: HTTP 401 mit WWW-Authenticate, der Schluessel steht nicht in der Antwort', async () => {
    const falsch = 'cky_live_FALSCHFALSCHFALSCHFALSCH';
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...KOPF, Authorization: `Bearer ${falsch}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const text = await r.text();
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect(text).not.toContain(falsch);
  });

  it('kein Basic, kein zu langer Kopf', async () => {
    const basic = await rpc(`${base}/mcp`, 'tools/list', {}, { Authorization: 'Basic abc' });
    expect(basic.status).toBe(401);
    const lang = await rpc(`${base}/mcp`, 'tools/list', {}, { Authorization: `Bearer cky_${'a'.repeat(400)}` });
    expect(lang.status).toBe(401);
  });

  it('gueltiger Schluessel + fremde Instanz im Kopf: 403', async () => {
    const r = await rpc(`${base}/mcp`, 'tools/list', {}, { Authorization: `Bearer ${KEY_A}`, 'X-Cachly-Instance': INST_2 });
    expect(r.status).toBe(403);
  });

  it('gueltiger Schluessel: Zugang ueber die API, instance_id einer fremden Instanz wird abgewiesen', async () => {
    const r = await aufruf('smart_recall', { query: 'x', instance_id: INST_2 }, { Authorization: `Bearer ${KEY_A}` });
    expect(r.status).toBe(200);
    const text = sseOderJson(r.text).result!.content![0].text!;
    expect(text).toContain('nicht die, die dieser Schluessel freigibt');
  });

  it('gueltiger Schluessel: kein Anmelde-Ablauf, kein Anlegen eines Kontos (Fund der Live-Probe)', async () => {
    const r = await aufruf('learn_from_attempts', { topic: 't', outcome: 'success', what_worked: 'w' }, { Authorization: `Bearer ${KEY_A}` });
    expect(r.text).not.toMatch(/sign in|device|verify/i);
    expect(apiAnfragen.some((x) => x.pfad.includes('/auth/'))).toBe(false);
  });

  it('Werkzeuge mit Dateizugriff laufen nicht, Pfade werden nicht gelesen', async () => {
    const r = await aufruf('brain_from_git', { repo_path: '/' }, { Authorization: `Bearer ${KEY_A}` });
    const text = sseOderJson(r.text).result!.content![0].text!;
    expect(text).toContain('nicht verfuegbar');
    const r2 = await aufruf('index_project', { dir: '/' }, { Authorization: `Bearer ${KEY_A}` });
    expect(sseOderJson(r2.text).result!.content![0].text!).toContain('nicht verfuegbar');
  });

  it('kein Schluessel in stderr', () => {
    expect(stderr).not.toContain(KEY_A);
    expect(stderr).not.toContain('PROZESSSCHLUESSEL');
  });
});
