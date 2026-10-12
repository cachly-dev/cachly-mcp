import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/*
 * Der echte Server findet seinen Schluessel im Heimordner — ohne ihn in der
 * Umgebung oder in einer Projektdatei zu haben. Gegen eine nachgebaute
 * Gegenstelle auf 127.0.0.1, nie die Produktion.
 *
 * Warum (12.10.2026): Die VS-Code-Erweiterung schrieb den Schluessel bis 0.12.6
 * in .mcp.json und in .claude/hooks/*.mjs im Projekt. Sie schreibt jetzt nur noch
 * Adresse und Instanz dorthin und legt den Schluessel in
 * ~/.cachly/credentials.json. Das geht nur auf, wenn der Server ihn dort bei
 * JEDEM Start findet (credentials.ts, resolveApiKey) — hier ist es belegt:
 * Authorization: Bearer <Schluessel aus der Heim-Datei> kommt an der
 * Gegenstelle an, obwohl CACHLY_JWT nirgends gesetzt ist. Die Gegenprobe ohne
 * Heim-Datei schickt den Schluessel nicht.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const SCHLUESSEL = 'cky_live_heimordnertest000000000000';
const INSTANZ = '22222222-3333-4444-5555-666666666666';

interface Anfrage { methode: string; pfad: string; authorization: string }

async function starteGegenstelle(): Promise<{ url: string; anfragen: Anfrage[]; server: Server }> {
  const anfragen: Anfrage[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const pfad = (req.url ?? '').split('?')[0] ?? '';
      anfragen.push({ methode: req.method ?? '', pfad, authorization: String(req.headers.authorization ?? '') });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (pfad === '/health') return json(200, { status: 'ok', db: 'ok' });
      if (pfad === '/api/v1/instances') return json(200, { data: [] });
      // Ohne Schluessel startet der Server die Browser-Anmeldung. Beantwortet die Gegenstelle das nicht, faellt er
      // auf das echte Keycloak zurueck — und dann ginge eine Anfrage an die Produktion. Darum antwortet sie
      // (wie in sofort-test-prozess.test.ts).
      if (req.method === 'POST' && pfad === '/auth/device') {
        return json(200, { device_code: 'dc-test', user_code: 'TEST-CODE', verification_uri: 'http://127.0.0.1:9/device', interval: 30 });
      }
      if (pfad === '/auth/device/token') return json(200, { error: 'authorization_pending' });
      if (pfad === '/api/v1/telemetry/mcp') return json(200, { ok: true });
      if (pfad.startsWith('/api/invite/')) {
        return json(200, { instance_id: INSTANZ, instance_name: 'Team-Brain', tier: 'free', expires_at: '2099-01-01T00:00:00Z' });
      }
      return json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, anfragen, server };
}

function umgebung(apiUrl: string, heim: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^path$/i.test(k) || /^CACHLY_/.test(k)) continue;
    env[k] = v;
  }
  // Kein CACHLY_JWT: genau wie ein Editor, der die neue .mcp.json (nur Adresse und Instanz) startet.
  return { ...env, PATH: '', HOME: heim, USERPROFILE: heim, APPDATA: heim, CACHLY_API_URL: apiUrl, CACHLY_AUTO_INDEX: 'false', CACHLY_UPDATE_CHECK: 'false', CACHLY_STARTWISSEN: 'false', ...extra };
}

/** Startet den Server, schickt initialize + get_api_status, wartet auf die Antwort. */
async function rufeWerkzeug(apiUrl: string, heim: string): Promise<string> {
  const kind = spawn(process.execPath, [tsxCli, einstieg], {
    env: umgebung(apiUrl, heim, { CACHLY_BRAIN_INSTANCE_ID: INSTANZ }),
    cwd: heim,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let puffer = '';
  let antwort: { result?: { content?: Array<{ text?: string }> } } | null = null;
  kind.stdout.on('data', (c) => {
    puffer += String(c);
    let nl;
    while ((nl = puffer.indexOf('\n')) >= 0) {
      const z = puffer.slice(0, nl).trim();
      puffer = puffer.slice(nl + 1);
      if (!z.startsWith('{')) continue;
      try { const j = JSON.parse(z); if (j.id === 1) antwort = j; } catch { /* Teilzeile */ }
    }
  });
  kind.stderr.on('data', () => { /* Protokoll des Servers */ });
  kind.stdin.write([
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_api_status', arguments: {} } }),
  ].join('\n') + '\n');
  const bis = Date.now() + 50_000;
  while (!antwort && Date.now() < bis) await new Promise((r) => setTimeout(r, 100));
  const ende = new Promise<void>((r) => kind.once('exit', () => r()));
  kind.stdin.end();
  await Promise.race([ende, new Promise((r) => setTimeout(r, 10_000))]);
  kind.kill();
  const a = antwort as typeof antwort;
  if (!a) throw new Error('Server hat auf den Werkzeugaufruf nicht geantwortet');
  return (a.result?.content ?? []).map((c) => c.text ?? '').join('\n');
}

/** Ein Kommando des Servers (cls-ingest, join …); `eingabe` geht auf stdin. */
async function rufeBefehl(apiUrl: string, heim: string, cwd: string, args: string[], eingabe = ''): Promise<void> {
  const kind = spawn(process.execPath, [tsxCli, einstieg, ...args], {
    env: umgebung(apiUrl, heim),
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  kind.stdout.on('data', () => undefined);
  kind.stderr.on('data', () => undefined);
  const ende = new Promise<void>((r) => kind.once('exit', () => r()));
  kind.stdin.write(eingabe);
  kind.stdin.end();
  await Promise.race([ende, new Promise((r) => setTimeout(r, 45_000))]);
  kind.kill();
}

function legeSchluesselAb(heim: string): void {
  mkdirSync(join(heim, '.cachly'), { recursive: true });
  writeFileSync(join(heim, '.cachly', 'credentials.json'), JSON.stringify({ apiKey: SCHLUESSEL, instanceId: INSTANZ }));
}

describe('Der Server findet den Schluessel im Heimordner (echter Prozess)', () => {
  let aufraeumen: Array<() => void> = [];
  afterEach(() => { for (const f of aufraeumen) f(); aufraeumen = []; });
  const neuerHeim = (g: { server: Server }) => {
    const heim = mkdtempSync(join(tmpdir(), 'cachly-heimschluessel-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    return heim;
  };

  it('Start OHNE CACHLY_JWT: die Anfrage traegt den Schluessel aus ~/.cachly/credentials.json', async () => {
    const g = await starteGegenstelle();
    const heim = neuerHeim(g);
    legeSchluesselAb(heim);

    const text = await rufeWerkzeug(g.url, heim);

    const mitSchluessel = g.anfragen.filter((a) => a.authorization === `Bearer ${SCHLUESSEL}`);
    expect(mitSchluessel.map((a) => a.pfad)).toContain('/api/v1/instances');
    expect(g.anfragen.some((a) => a.pfad === '/auth/instant-trial'), 'der Server hielt sich fuer schluessellos').toBe(false);
    expect(text).not.toContain('CACHLY_JWT not set');
  }, 60_000);

  it('Gegenprobe: ohne die Heim-Datei geht der Schluessel nirgends hin', async () => {
    const g = await starteGegenstelle();
    const heim = neuerHeim(g);

    const text = await rufeWerkzeug(g.url, heim);

    // Der Server hielt sich fuer schluessellos (Browser-Anmeldung gestartet) und schickte den Heim-Schluessel nirgends hin.
    expect(g.anfragen.some((a) => a.pfad === '/auth/device')).toBe(true);
    expect(g.anfragen.filter((a) => a.authorization.includes(SCHLUESSEL))).toEqual([]);
    expect(text).toContain('TEST-CODE');
  }, 60_000);

  it('cls-ingest (der Git-Hook ohne eingebetteten Schluessel) meldet sich mit dem Schluessel aus dem Heimordner an', async () => {
    const g = await starteGegenstelle();
    const heim = neuerHeim(g);
    legeSchluesselAb(heim);

    const nutzlast = JSON.stringify({ instance_id: INSTANZ, source: 'git_commit', payload: { message: 'fix: x', sha: 'abc', files: ['a.ts'] } });
    await rufeBefehl(g.url, heim, heim, ['cls-ingest', nutzlast]);

    expect(g.anfragen.some((a) => a.authorization === `Bearer ${SCHLUESSEL}`), JSON.stringify(g.anfragen)).toBe(true);
  }, 60_000);

  it('join schreibt den Schluessel nicht in Projektdateien, nur in die globale Datei im Heimordner', async () => {
    const g = await starteGegenstelle();
    const heim = neuerHeim(g);
    legeSchluesselAb(heim);
    const projekt = join(heim, 'projekt');
    mkdirSync(join(projekt, '.cursor'), { recursive: true });
    mkdirSync(join(projekt, '.vscode'), { recursive: true });
    mkdirSync(join(projekt, '.windsurf'), { recursive: true });
    writeFileSync(join(projekt, '.mcp.json'), JSON.stringify({ mcpServers: { cachly: { env: { CACHLY_BRAIN_INSTANCE_ID: 'alt' } } } }));
    // JWT kommt aus dem Heimordner (Start ohne CACHLY_JWT), damit join keine Anmeldung startet.

    await rufeBefehl(g.url, heim, projekt, ['join', 'TOKEN123'], 'y\n');

    for (const datei of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.windsurf/mcp.json']) {
      const pfad = join(projekt, datei);
      expect(existsSync(pfad), datei).toBe(true);
      const text = readFileSync(pfad, 'utf8');
      expect(text, datei).not.toContain(SCHLUESSEL);
      expect(JSON.parse(text).mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID, datei).toBe(INSTANZ);
    }
    // Die globale Datei im Heimordner darf ihn tragen (verlaesst den Rechner nicht).
    const global = JSON.parse(readFileSync(join(heim, '.claude', 'mcp.json'), 'utf8'));
    expect(global.mcpServers.cachly.env.CACHLY_JWT).toBe(SCHLUESSEL);
  }, 90_000);
});
