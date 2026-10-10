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
 * Der echte Server ohne Schluessel, gegen eine nachgebaute Gegenstelle.
 *
 * Befund 11.10.2026 (Produktions-DB, 60 Tage): jeder Start ohne Schluessel
 * ergab `first_call_no_jwt` und sofort `device_flow_started`. Am 19./20.09.
 * dazu `device_browser_failed` mit `enoent`, dann `device_flow_failed`
 * timeout. Von 8 Starts kam 1 durch; ueber das Claude-Code-Plugin entstand
 * seit dem 28.08. kein Konto.
 *
 * Warum ein Prozess und nicht die Funktion: der Fehler lag nicht IN einer
 * Funktion, sondern in der REIHENFOLGE zweier Pruefungen in handleTool. Ein
 * Test der einzelnen Funktion haette ihn nie gesehen. Dieser Test war gegen
 * den alten Ablauf rot (Gegenprobe im PR beschrieben).
 *
 * Kein Browser: PATH ist leer, also findet der Server weder `cmd` noch
 * `xdg-open` noch `open` (ENOENT) — genau der gemessene Fall aus Containern
 * und SSH-Sitzungen. Kein Netz: alle Anfragen gehen an 127.0.0.1.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const SCHLUESSEL = 'cky_trial_prozesstest0000000000000000';
const INSTANZ = '11111111-2222-3333-4444-555555555555';

interface Anfrage { methode: string; pfad: string; ua: string; koerper: string }

async function starteGegenstelle(sofortTestStatus: number): Promise<{ url: string; anfragen: Anfrage[]; server: Server }> {
  const anfragen: Anfrage[] = [];
  const server = createServer((req, res) => {
    let koerper = '';
    req.on('data', (c) => { koerper += String(c); });
    req.on('end', () => {
      const pfad = (req.url ?? '').split('?')[0] ?? '';
      anfragen.push({ methode: req.method ?? '', pfad, ua: String(req.headers['user-agent'] ?? ''), koerper });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && pfad === '/auth/instant-trial') {
        if (sofortTestStatus !== 201) return json(sofortTestStatus, { error: 'rate limited' });
        return json(201, { api_key: SCHLUESSEL, instance_id: INSTANZ, trial: true, trial_ends_at: '2026-10-25T12:00:00Z' });
      }
      if (req.method === 'POST' && pfad === '/auth/device') {
        return json(200, { device_code: 'dc-test', user_code: 'TEST-CODE', verification_uri: 'http://127.0.0.1:9/device', interval: 30 });
      }
      if (pfad === '/auth/device/token') return json(200, { error: 'authorization_pending' });
      if (pfad === '/api/v1/telemetry/mcp') return json(200, { ok: true });
      if (pfad === '/health') return json(200, { status: 'ok', db: 'ok' });
      return json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, anfragen, server };
}

/** Startet den Server, schickt initialize + EINEN Werkzeugaufruf, liefert die Antwort. */
async function rufeWerkzeug(apiUrl: string, heim: string): Promise<string> {
  // Umgebung wie beim Claude-Code-Plugin mit leeren Feldern: die Platzhalter
  // kommen unersetzt an. Beide muessen als "nichts" gelten.
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
    CACHLY_JWT: '${user_config.api_key}',
    CACHLY_BRAIN_INSTANCE_ID: '${user_config.instance_id}',
    CACHLY_QUELLE: 'claude-code-plugin',
    CACHLY_AUTO_INDEX: 'false',
  });

  const kind = spawn(process.execPath, [tsxCli, einstieg], { env, cwd: heim, stdio: ['pipe', 'pipe', 'pipe'] });
  let puffer = '';
  let antwort: { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } } | null = null;
  kind.stdout.on('data', (c) => {
    puffer += String(c);
    let nl;
    while ((nl = puffer.indexOf('\n')) >= 0) {
      const z = puffer.slice(0, nl).trim();
      puffer = puffer.slice(nl + 1);
      if (!z.startsWith('{')) continue;
      try {
        const j = JSON.parse(z);
        if (j.id === 1) antwort = j;
      } catch { /* Teilzeile */ }
    }
  });
  kind.stderr.on('data', () => { /* Protokoll des Servers, hier ohne Belang */ });

  kind.stdin.write([
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_api_status', arguments: {} } }),
  ].join('\n') + '\n');

  const bis = Date.now() + 50_000;
  while (!antwort && Date.now() < bis) await new Promise((r) => setTimeout(r, 100));
  // stdin schliessen: der Server beendet sich dann selbst (stdin-ende.ts),
  // samt dem Kindprozess, den tsx startet. kill() allein liesse den auf
  // Windows weiterlaufen — mit dem Testordner als Arbeitsverzeichnis.
  const ende = new Promise<void>((r) => kind.once('exit', () => r()));
  kind.stdin.end();
  await Promise.race([ende, new Promise((r) => setTimeout(r, 10_000))]);
  kind.kill();
  const a = antwort as typeof antwort;
  if (!a) throw new Error('Server hat auf den Werkzeugaufruf nicht geantwortet');
  if (a.error) throw new Error('Werkzeugaufruf mit Fehler: ' + a.error.message);
  return (a.result?.content ?? []).map((c) => c.text ?? '').join('\n');
}

/** Ereignisnamen, die an /api/v1/telemetry/mcp gingen. */
function ereignisse(anfragen: Anfrage[]): string[] {
  return anfragen
    .filter((a) => a.pfad === '/api/v1/telemetry/mcp')
    .map((a) => { try { return String(JSON.parse(a.koerper).event); } catch { return ''; } });
}

async function warteAufEreignis(anfragen: Anfrage[], name: string, ms = 5000): Promise<void> {
  const bis = Date.now() + ms;
  while (!ereignisse(anfragen).includes(name) && Date.now() < bis) await new Promise((r) => setTimeout(r, 50));
}

describe('Start ohne Schluessel: Sofort-Test vor der Browser-Anmeldung (echter Prozess)', () => {
  let aufraeumen: Array<() => void> = [];
  afterEach(() => { for (const f of aufraeumen) f(); aufraeumen = []; });

  it('Sofort-Test gelingt: keine Anmeldung, Schluessel in allen drei Ablagen, Werkzeug antwortet mit Hinweis', async () => {
    const g = await starteGegenstelle(201);
    const heim = mkdtempSync(join(tmpdir(), 'cachly-sofort-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

    const text = await rufeWerkzeug(g.url, heim);
    await warteAufEreignis(g.anfragen, 'instant_trial_started');

    // Keine Browser-Anmeldung.
    expect(g.anfragen.some((a) => a.pfad === '/auth/device'), 'Browser-Anmeldung wurde gestartet').toBe(false);
    expect(text).not.toContain('must sign in');

    // Genau EIN Sofort-Test, mit der Herkunft des Plugins im User-Agent.
    const tests = g.anfragen.filter((a) => a.pfad === '/auth/instant-trial');
    expect(tests.length).toBe(1);
    expect(tests[0]!.ua).toMatch(/^cachly-claude-code-plugin\//);

    // Das Werkzeug lief mit Schluessel, und der Hinweis steht einmal dahinter.
    expect(text).not.toContain('CACHLY_JWT not set');
    expect(text.match(/test Brain was created/g)?.length).toBe(1);

    // Ablage 1: ~/.cachly/credentials.json — dort lesen die Hooks.
    const cred = JSON.parse(readFileSync(join(heim, '.cachly', 'credentials.json'), 'utf8'));
    expect(cred.apiKey).toBe(SCHLUESSEL);
    // Ablage 2: ~/.claude/mcp.json — damit der Schluessel den Neustart ueberlebt.
    const mcpPfad = join(heim, '.claude', 'mcp.json');
    expect(existsSync(mcpPfad)).toBe(true);
    const mcp = JSON.parse(readFileSync(mcpPfad, 'utf8'));
    expect(mcp.mcpServers.cachly.env.CACHLY_JWT).toBe(SCHLUESSEL);
    expect(mcp.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(INSTANZ);
    // Ablage 3 (der Prozess selbst) ist oben belegt: das Werkzeug lief mit Schluessel.

    const ev = ereignisse(g.anfragen);
    expect(ev).toContain('first_call_no_jwt');
    expect(ev).toContain('instant_trial_started');
    expect(ev).not.toContain('device_flow_started');
  }, 60_000);

  it('Sofort-Test scheitert (429): die Browser-Anmeldung startet wie bisher', async () => {
    const g = await starteGegenstelle(429);
    const heim = mkdtempSync(join(tmpdir(), 'cachly-sofort-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

    const text = await rufeWerkzeug(g.url, heim);
    await warteAufEreignis(g.anfragen, 'device_flow_started');

    expect(g.anfragen.filter((a) => a.pfad === '/auth/instant-trial').length).toBe(1);
    expect(g.anfragen.some((a) => a.pfad === '/auth/device')).toBe(true);
    expect(text).toContain('must sign in');
    expect(text).toContain('TEST-CODE');
    expect(text).not.toContain('test Brain was created');
    expect(existsSync(join(heim, '.cachly', 'credentials.json'))).toBe(false);
    expect(ereignisse(g.anfragen)).toContain('device_flow_started');
  }, 60_000);
});
