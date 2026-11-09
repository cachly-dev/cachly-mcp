import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { meldeKopf, meldeRumpf } from '../melde-weg.js';

/*
 * Der Schluessel reist beim Melde-Weg nur im Kopf, nie im Rumpf.
 *
 * Bis 0.10.235 schickte sendFunnelEvent den Schluessel im Rumpf mit — als
 * `jwt`, an vielen Stellen zusaetzlich als `api_key`. Die API las daraus den
 * Inhaber eines Tokens, ohne die Unterschrift zu pruefen (behoben in der API,
 * api/cmd/server/telemetrie_ausweis.go). Seit 0.10.236 steht der Schluessel nur
 * noch in `Authorization: Bearer`, wie bei jedem anderen Aufruf.
 *
 * Der Prozess-Test startet den echten Server gegen eine nachgebaute
 * Gegenstelle und liest mit, was am Melde-Weg ankommt.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const SCHLUESSEL = 'cky_live_kopftest000000000000000000000';

interface Anfrage { pfad: string; auth: string; koerper: string }

async function starteGegenstelle(): Promise<{ url: string; anfragen: Anfrage[]; server: Server }> {
  const anfragen: Anfrage[] = [];
  const server = createServer((req, res) => {
    let koerper = '';
    req.on('data', (c) => { koerper += String(c); });
    req.on('end', () => {
      const pfad = (req.url ?? '').split('?')[0] ?? '';
      anfragen.push({ pfad, auth: String(req.headers.authorization ?? ''), koerper });
      res.writeHead(pfad === '/api/v1/telemetry/mcp' ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(pfad === '/api/v1/telemetry/mcp' ? '{"ok":true}' : '{"error":"not found"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, anfragen, server };
}

describe('Melde-Weg: Schluessel nur im Kopf', () => {
  it('meldeKopf setzt Authorization nur mit Schluessel', () => {
    expect(meldeKopf(SCHLUESSEL)).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${SCHLUESSEL}` });
    expect(meldeKopf('')).toEqual({ 'Content-Type': 'application/json' });
    expect(meldeKopf('   ')).toEqual({ 'Content-Type': 'application/json' });
    expect(meldeKopf(undefined)).toEqual({ 'Content-Type': 'application/json' });
  });

  it('meldeRumpf laesst jedes Schluesselfeld fallen, auch wenn ein Aufrufer es mitgibt', () => {
    const rumpf = meldeRumpf(
      { event: 'session_start', version: '1' },
      { api_key: SCHLUESSEL, jwt: SCHLUESSEL, apiKey: SCHLUESSEL, token: SCHLUESSEL, instance_id: 'i-1' },
      { born_at: undefined, recalls_total: undefined, starter_seeded: false },
    );
    expect(JSON.stringify(rumpf)).not.toContain(SCHLUESSEL);
    expect(rumpf).toMatchObject({ event: 'session_start', version: '1', instance_id: 'i-1', metrics: { starter_seeded: false } });
  });

  let aufraeumen: Array<() => void> = [];
  afterEach(() => { for (const f of aufraeumen) f(); aufraeumen = []; });

  it('echter Server: das Verbunden-Ereignis traegt den Schluessel im Kopf, nicht im Rumpf', async () => {
    const g = await starteGegenstelle();
    const heim = mkdtempSync(join(tmpdir(), 'cachly-meldekopf-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined || /^CACHLY_/.test(k)) continue;
      env[k] = v;
    }
    Object.assign(env, {
      HOME: heim, USERPROFILE: heim, APPDATA: heim,
      CACHLY_API_URL: g.url,
      CACHLY_JWT: SCHLUESSEL,
      CACHLY_AUTO_INDEX: 'false',
    });
    const kind = spawn(process.execPath, [tsxCli, einstieg], { env, cwd: heim, stdio: ['pipe', 'pipe', 'pipe'] });
    kind.stdout.on('data', () => { /* Antworten hier ohne Belang */ });
    kind.stderr.on('data', () => { /* Protokoll des Servers */ });
    kind.stdin.write([
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'kopftest', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    ].join('\n') + '\n');

    const melde = () => g.anfragen.filter((a) => a.pfad === '/api/v1/telemetry/mcp');
    const bis = Date.now() + 40_000;
    while (!melde().some((a) => a.koerper.includes('mcp_verbunden')) && Date.now() < bis) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const ende = new Promise<void>((r) => kind.once('exit', () => r()));
    kind.stdin.end();
    await Promise.race([ende, new Promise((r) => setTimeout(r, 10_000))]);
    kind.kill();

    const verbunden = melde().find((a) => a.koerper.includes('mcp_verbunden'));
    expect(verbunden, 'kein mcp_verbunden am Melde-Weg angekommen').toBeDefined();
    expect(verbunden!.auth).toBe(`Bearer ${SCHLUESSEL}`);
    // Kein einziges Ereignis darf den Schluessel im Rumpf tragen.
    for (const a of melde()) {
      expect(a.koerper).not.toContain(SCHLUESSEL);
      const j = JSON.parse(a.koerper) as Record<string, unknown>;
      expect(j).not.toHaveProperty('api_key');
      expect(j).not.toHaveProperty('jwt');
    }
  }, 90_000);
});
