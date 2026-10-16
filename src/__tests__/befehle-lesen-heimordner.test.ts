import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Die Befehle im Terminal finden Schluessel und Instanz in ~/.cachly/credentials.json.
 *
 * Warum (GROW-025, 16.10.2026): `status`, `digest`, `health` und sechs weitere
 * Befehle lasen nur CACHLY_JWT / CACHLY_BRAIN_INSTANCE_ID aus der Umgebung. Seit
 * "Schluessel nie ins Projekt" (#784) legt `autopilot` beides in die Datei im
 * Heimordner; die Umgebung setzt nur der Editor fuer den Server. Im Terminal
 * meldete `status` darum jedem so eingerichteten Nutzer "CACHLY_JWT must be set".
 *
 * Gegenprobe: in index.ts den status-Zweig wieder auf process.env lesen lassen
 * -> rot (keine Anfrage, Meldung statt Kasten).
 *
 * Kein Netz: alle Anfragen gehen an 127.0.0.1.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const SCHLUESSEL = 'cky_live_heimordnertest000000000000000000';
const INSTANZ = '22222222-3333-4444-5555-666666666666';

interface Anfrage { pfad: string; auth: string }

async function starteGegenstelle(): Promise<{ url: string; anfragen: Anfrage[]; server: Server }> {
  const anfragen: Anfrage[] = [];
  const server = createServer((req, res) => {
    req.on('data', () => { /* ohne Belang */ });
    req.on('end', () => {
      const pfad = (req.url ?? '').split('?')[0] ?? '';
      anfragen.push({ pfad, auth: String(req.headers.authorization ?? '') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (pfad === `/api/v1/instances/${INSTANZ}/memory`) {
        res.end(JSON.stringify({ lesson_count: 7, total_recall_count: 3, iq_boost_pct: 12, team_authors: [] }));
        return;
      }
      res.end(JSON.stringify({}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, anfragen, server };
}

async function starteBefehl(args: string[], apiUrl: string, heim: string): Promise<{ code: number | null; ausgabe: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^CACHLY_/.test(k)) continue; // genau das ist der Punkt: keine Umgebung
    env[k] = v;
  }
  Object.assign(env, {
    HOME: heim,
    USERPROFILE: heim,
    APPDATA: heim,
    CACHLY_API_URL: apiUrl,
    CACHLY_AUTO_INDEX: 'false',
    CACHLY_NO_TELEMETRY: '1',
  });
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

describe('Terminal-Befehle lesen ~/.cachly/credentials.json (echter Prozess)', () => {
  let aufraeumen: Array<() => void> = [];
  afterEach(() => { for (const f of aufraeumen) f(); aufraeumen = []; });

  it('status: ohne CACHLY_JWT in der Umgebung, Schluessel und Instanz aus dem Heimordner', async () => {
    const g = await starteGegenstelle();
    const heim = mkdtempSync(join(tmpdir(), 'cachly-befehle-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    mkdirSync(join(heim, '.cachly'));
    writeFileSync(join(heim, '.cachly', 'credentials.json'), JSON.stringify({ apiKey: SCHLUESSEL, instanceId: INSTANZ }));

    const { code, ausgabe } = await starteBefehl(['status'], g.url, heim);

    expect(ausgabe).not.toContain('must be set');
    expect(ausgabe).not.toContain('No cachly key');
    const speicher = g.anfragen.find((a) => a.pfad === `/api/v1/instances/${INSTANZ}/memory`);
    expect(speicher, `Anfragen: ${JSON.stringify(g.anfragen)}\n${ausgabe}`).toBeDefined();
    expect(speicher!.auth).toBe(`Bearer ${SCHLUESSEL}`);
    expect(ausgabe).toContain('Brain status');
    expect(code).toBe(0);
  }, 60_000);

  it('status: ganz ohne Schluessel nennt die Meldung beide Quellen', async () => {
    const g = await starteGegenstelle();
    const heim = mkdtempSync(join(tmpdir(), 'cachly-befehle-leer-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

    const { code, ausgabe } = await starteBefehl(['status'], g.url, heim);

    expect(ausgabe).toContain('~/.cachly/credentials.json');
    expect(g.anfragen.filter((a) => a.pfad.includes('/memory'))).toEqual([]);
    expect(code).toBe(1);
  }, 60_000);
});
