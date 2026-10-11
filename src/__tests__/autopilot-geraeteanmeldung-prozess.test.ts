import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/*
 * Die Einrichtung als echter Prozess, gegen eine nachgebaute Gegenstelle.
 *
 * Befund 11.10.2026: der erste Anmeldeversuch von `autopilot` ging an
 * /api/v1/auth/device/code. Diese Adresse gibt es im Server nicht
 * (routes.go: /auth/device, ohne /api/v1). Jeder Lauf bekam 404 und fiel
 * still auf Keycloak zurueck. Gemessen am 23.08.: setup_auth_started 13,
 * setup_auth_completed 3.
 *
 * Zweiter Teil: die Weboberflaeche zeigt seit diesem Zweig EINEN Befehl mit
 * Schluessel und Instanz (`init --instance-id … --api-key …`). Der dritte
 * Fall belegt, dass dieser Befehl keine Anmeldung startet und beides ablegt.
 *
 * Kein Browser: PATH ist leer (ENOENT, wie in Containern und SSH-Sitzungen).
 * Kein Netz: alle Anfragen gehen an 127.0.0.1.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const SCHLUESSEL = 'cky_live_prozesstest00000000000000000000';
const INSTANZ = '11111111-2222-3333-4444-555555555555';

interface Anfrage { methode: string; pfad: string; auth: string }

async function starteGegenstelle(): Promise<{ url: string; anfragen: Anfrage[]; server: Server }> {
  const anfragen: Anfrage[] = [];
  let abfragen = 0;
  const server = createServer((req, res) => {
    req.on('data', () => { /* Koerper hier ohne Belang */ });
    req.on('end', () => {
      const pfad = (req.url ?? '').split('?')[0] ?? '';
      anfragen.push({ methode: req.method ?? '', pfad, auth: String(req.headers.authorization ?? '') });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && pfad === '/auth/device') {
        return json(200, { device_code: 'dc-auto', user_code: 'AUTO-CODE', verification_uri: 'http://127.0.0.1:9/device', interval: 0 });
      }
      if (req.method === 'POST' && pfad === '/auth/device/token') {
        // Erst "wartet noch" (200 + error, wie der echte Server), dann der Schluessel.
        abfragen++;
        if (abfragen < 2) return json(200, { error: 'authorization_pending' });
        return json(200, { access_token: SCHLUESSEL, token_type: 'api_key' });
      }
      // Ab hier soll der Lauf enden: 401 beendet die Einrichtung mit Exit 1.
      if (pfad === '/api/v1/instances') return json(401, { error: 'test stops here' });
      if (pfad === '/api/v1/telemetry/mcp') return json(200, { ok: true });
      return json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, anfragen, server };
}

/** Startet die Befehlszeile und wartet auf ihr Ende. */
async function starteBefehl(args: string[], apiUrl: string, heim: string, mehrEnv: Record<string, string> = {}): Promise<{ code: number | null; ausgabe: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^path$/i.test(k)) continue;
    if (/^CACHLY_/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    PATH: '',
    HOME: heim,
    USERPROFILE: heim,
    APPDATA: heim,
    CACHLY_API_URL: apiUrl,
    CACHLY_AUTO_INDEX: 'false',
    CACHLY_NO_TELEMETRY: '1',
  }, mehrEnv);

  const kind = spawn(process.execPath, [tsxCli, einstieg, ...args], { env, cwd: heim, stdio: ['pipe', 'pipe', 'pipe'] });
  let ausgabe = '';
  kind.stdout.on('data', (c) => { ausgabe += String(c); });
  kind.stderr.on('data', (c) => { ausgabe += String(c); });
  kind.stdin.end();
  const code = await new Promise<number | null>((r) => {
    const t = setTimeout(() => { kind.kill(); r(null); }, 50_000);
    kind.once('exit', (c) => { clearTimeout(t); r(c); });
  });
  return { code, ausgabe };
}

describe('autopilot: Geraete-Anmeldung an der echten Adresse (echter Prozess)', () => {
  let aufraeumen: Array<() => void> = [];
  afterEach(() => { for (const f of aufraeumen) f(); aufraeumen = []; });

  it('fragt /auth/device und /auth/device/token, nie die tote /api/v1-Adresse', async () => {
    const g = await starteGegenstelle();
    const heim = mkdtempSync(join(tmpdir(), 'cachly-autopilot-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

    const { code, ausgabe } = await starteBefehl(['autopilot'], g.url, heim);

    const pfade = g.anfragen.map((a) => a.pfad);
    expect(pfade).not.toContain('/api/v1/auth/device/code');
    expect(pfade).not.toContain('/api/v1/auth/device/token');
    expect(pfade.filter((p) => p === '/auth/device').length).toBe(1);
    expect(pfade.filter((p) => p === '/auth/device/token').length).toBe(2);

    // Die Adresse traegt den Code und steht allein auf ihrer Zeile.
    expect(ausgabe.split(/\r?\n/)).toContain('http://127.0.0.1:9/device?code=AUTO-CODE');

    // Der Schluessel aus der Abfrage wird direkt benutzt — kein Umtausch noetig.
    expect(pfade).not.toContain('/api/v1/api-keys');
    const liste = g.anfragen.find((a) => a.pfad === '/api/v1/instances');
    expect(liste?.auth).toBe(`Bearer ${SCHLUESSEL}`);

    // Ende kommt von der Gegenstelle (401 bei der Instanzliste), nicht von der Anmeldung.
    expect(ausgabe).not.toContain('Auth error');
    expect(code).toBe(1);
  }, 60_000);

  it('mit CACHLY_JWT startet keine Geraete-Anmeldung', async () => {
    const g = await starteGegenstelle();
    const heim = mkdtempSync(join(tmpdir(), 'cachly-autopilot-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

    await starteBefehl(['autopilot'], g.url, heim, { CACHLY_JWT: SCHLUESSEL });

    expect(g.anfragen.some((a) => a.pfad.startsWith('/auth/device'))).toBe(false);
    expect(g.anfragen.find((a) => a.pfad === '/api/v1/instances')?.auth).toBe(`Bearer ${SCHLUESSEL}`);
  }, 60_000);

  it('der Befehl aus der Weboberflaeche (init mit Schluessel und Instanz) braucht keine Anmeldung', async () => {
    const g = await starteGegenstelle();
    const heim = mkdtempSync(join(tmpdir(), 'cachly-init-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

    const { code } = await starteBefehl(['init', '--instance-id', INSTANZ, '--api-key', SCHLUESSEL], g.url, heim);

    expect(code).toBe(0);
    expect(g.anfragen.some((a) => a.pfad.startsWith('/auth/device'))).toBe(false);

    // Instanz in der Projektdatei, Schluessel in der Ablage, aus der der Server liest.
    const projekt = JSON.parse(readFileSync(join(heim, '.mcp.json'), 'utf8'));
    expect(projekt.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(INSTANZ);
    const ablage = join(heim, '.cachly', 'credentials.json');
    expect(existsSync(ablage)).toBe(true);
    expect(JSON.parse(readFileSync(ablage, 'utf8')).apiKey).toBe(SCHLUESSEL);
  }, 60_000);
});
