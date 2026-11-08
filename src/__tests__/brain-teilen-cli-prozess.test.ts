import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

/**
 * Brain teilen (Vertrag 08.11.2026): die Befehle invite, refer, join, join --brain
 * gegen eine nachgebildete Gegenstelle, genau nach Vertrag. Echte Prozesse.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const SCHLUESSEL = 'cky_live_teilentest0000000000000000';
const INSTANZ = '11111111-2222-3333-4444-555555555555';
const FREMD = '99999999-8888-7777-6666-555555555555';

interface Anfrage { methode: string; pfad: string; authorization: string; body: string }
type Antwort = { status: number; body: unknown };
type Regeln = (a: Anfrage) => Antwort | undefined;

async function gegenstelle(regeln: Regeln): Promise<{ url: string; anfragen: Anfrage[]; server: Server }> {
  const anfragen: Anfrage[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      const a: Anfrage = {
        methode: req.method ?? '', pfad: (req.url ?? '').split('?')[0] ?? '',
        authorization: String(req.headers.authorization ?? ''), body,
      };
      anfragen.push(a);
      const r = regeln(a) ?? { status: 404, body: { error: 'not found' } };
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, anfragen, server };
}

function umgebung(apiUrl: string, heim: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^path$/i.test(k) || /^CACHLY_/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, PATH: '', HOME: heim, USERPROFILE: heim, APPDATA: heim, CACHLY_API_URL: apiUrl, CACHLY_AUTO_INDEX: 'false', CACHLY_UPDATE_CHECK: 'false', CACHLY_STARTWISSEN: 'false' };
}

async function befehl(apiUrl: string, heim: string, cwd: string, args: string[]): Promise<{ aus: string; code: number | null }> {
  const kind = spawn(process.execPath, [tsxCli, einstieg, ...args], { env: umgebung(apiUrl, heim), cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let aus = '';
  kind.stdout.on('data', (c) => { aus += String(c); });
  kind.stderr.on('data', (c) => { aus += String(c); });
  const code = await new Promise<number | null>((r) => {
    const t = setTimeout(() => { kind.kill(); r(null); }, 45_000);
    kind.once('exit', (c) => { clearTimeout(t); r(c); });
  });
  return { aus, code };
}

function schluesselAb(heim: string, mitInstanz = true): void {
  mkdirSync(join(heim, '.cachly'), { recursive: true });
  writeFileSync(join(heim, '.cachly', 'credentials.json'), JSON.stringify({ apiKey: SCHLUESSEL, ...(mitInstanz ? { instanceId: INSTANZ } : {}) }));
}

describe('Brain teilen: invite, refer, join (echter Prozess, nachgebildete API)', () => {
  let aufraeumen: Array<() => void> = [];
  afterEach(() => { for (const f of aufraeumen) f(); aufraeumen = []; });
  const neu = async (regeln: Regeln) => {
    const g = await gegenstelle(regeln);
    const heim = mkdtempSync(join(tmpdir(), 'cachly-teilen-'));
    aufraeumen.push(() => g.server.close(), () => rmSync(heim, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    return { g, heim };
  };
  const teilenPfad = `/api/v1/instances/${INSTANZ}/share`;

  it('invite <email> ruft POST /instances/<id>/share mit {email} und nennt wen und welches Brain', async () => {
    const { g, heim } = await neu((a) => a.methode === 'POST' && a.pfad === teilenPfad
      ? { status: 201, body: { org_id: 'org-1', invite_sent_to: 'kollegin@example.com', instance: { id: INSTANZ, name: 'Team-Brain' } } }
      : undefined);
    schluesselAb(heim);

    const r = await befehl(g.url, heim, heim, ['invite', 'kollegin@example.com']);

    const a = g.anfragen.find((x) => x.pfad === teilenPfad);
    expect(a, JSON.stringify(g.anfragen)).toBeDefined();
    expect(a!.methode).toBe('POST');
    expect(a!.authorization).toBe(`Bearer ${SCHLUESSEL}`);
    expect(JSON.parse(a!.body)).toEqual({ email: 'kollegin@example.com' });
    expect(r.code).toBe(0);
    expect(r.aus).toContain('kollegin@example.com');
    expect(r.aus).toContain('Team-Brain');
    expect(r.aus).toMatch(/email/i);
    expect(r.aus).toContain('join <token>');
    // Kein Werbetext mehr unter invite.
    expect(g.anfragen.some((x) => x.pfad === '/api/v1/referral/me')).toBe(false);
  }, 60_000);

  it('invite ohne E-Mail: Hinweis zur Nutzung, keine Anfrage', async () => {
    const { g, heim } = await neu(() => undefined);
    schluesselAb(heim);
    const r = await befehl(g.url, heim, heim, ['invite']);
    expect(r.code).toBe(1);
    expect(r.aus).toContain('invite <email>');
    expect(g.anfragen.filter((x) => x.pfad.includes('/share'))).toEqual([]);
  }, 60_000);

  it.each([
    [400, /not a valid email/i],
    [404, /not found in your account/i],
    [409, /already has access/i],
  ])('invite: Antwort %i wird verstaendlich gemeldet', async (status, muster) => {
    const { g, heim } = await neu((a) => a.pfad === teilenPfad ? { status, body: { error: 'x' } } : undefined);
    schluesselAb(heim);
    const r = await befehl(g.url, heim, heim, ['invite', 'wer@example.com']);
    expect(r.code).toBe(1);
    expect(r.aus).toMatch(muster);
    expect(r.aus).not.toContain('HTTP');
  }, 60_000);

  it('refer ruft /referral/me und zeigt den Link', async () => {
    const { g, heim } = await neu((a) => a.pfad === '/api/v1/referral/me'
      ? { status: 200, body: { code: 'abc', url: 'https://cachly.dev/r/abc', referral_count: 2 } }
      : undefined);
    schluesselAb(heim);
    const r = await befehl(g.url, heim, heim, ['refer']);
    expect(g.anfragen.some((x) => x.pfad === '/api/v1/referral/me' && x.authorization === `Bearer ${SCHLUESSEL}`)).toBe(true);
    expect(r.code).toBe(0);
    expect(r.aus).toContain('https://cachly.dev/r/abc');
  }, 60_000);

  it('join <token> ruft accept-invite und schreibt die Instanz-ID in die Editor-Datei', async () => {
    const { g, heim } = await neu((a) => a.methode === 'POST' && a.pfad === '/api/v1/orgs/accept-invite'
      ? { status: 200, body: { org_id: 'org-1', instances: [{ id: FREMD, name: 'Geteiltes Brain' }] } }
      : undefined);
    schluesselAb(heim, false);
    const projekt = join(heim, 'projekt');
    mkdirSync(join(projekt, '.cursor'), { recursive: true });

    const r = await befehl(g.url, heim, projekt, ['join', 'TOKEN-1']);

    const a = g.anfragen.find((x) => x.pfad === '/api/v1/orgs/accept-invite');
    expect(a, JSON.stringify(g.anfragen)).toBeDefined();
    expect(JSON.parse(a!.body)).toEqual({ token: 'TOKEN-1' });
    expect(a!.authorization).toBe(`Bearer ${SCHLUESSEL}`);
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(projekt, '.cursor', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(FREMD);
    expect(readFileSync(join(projekt, '.cursor', 'mcp.json'), 'utf8')).not.toContain(SCHLUESSEL);
    expect(existsSync(join(heim, '.claude', 'mcp.json'))).toBe(true);
    expect(r.aus).toContain('Geteiltes Brain');
  }, 90_000);

  it('join mit altem Token (nur /api/invite kennt ihn): Meldung "alter Link-Typ", nichts wird geschrieben', async () => {
    const { g, heim } = await neu((a) => {
      if (a.pfad === '/api/v1/orgs/accept-invite') return { status: 404, body: { error: 'invalid token' } };
      if (a.pfad === '/api/invite/ALT') return { status: 200, body: { instance_id: FREMD, instance_name: 'Alt', tier: 'free', expires_at: '2099-01-01T00:00:00Z' } };
      return undefined;
    });
    schluesselAb(heim);
    const projekt = join(heim, 'projekt');
    mkdirSync(join(projekt, '.cursor'), { recursive: true });

    const r = await befehl(g.url, heim, projekt, ['join', 'ALT']);

    expect(r.code).toBe(1);
    expect(r.aus).toContain('This old link type does not give access to the Brain.');
    expect(g.anfragen.some((x) => x.pfad === '/api/invite/ALT')).toBe(true);
    expect(existsSync(join(projekt, '.cursor', 'mcp.json'))).toBe(false);
  }, 90_000);

  it('join mit unbekanntem Token: allgemeine Meldung, keine Alt-Link-Meldung', async () => {
    const { g, heim } = await neu(() => undefined);
    schluesselAb(heim);
    const r = await befehl(g.url, heim, heim, ['join', 'NIX']);
    expect(r.code).toBe(1);
    expect(r.aus).toMatch(/Could not accept the invitation/);
    expect(r.aus).not.toContain('old link type');
  }, 60_000);

  it('join --brain <id> prueft GET /instances/<id> und schreibt die ID', async () => {
    const { g, heim } = await neu((a) => a.methode === 'GET' && a.pfad === `/api/v1/instances/${FREMD}`
      ? { status: 200, body: { id: FREMD, name: 'Geteilt via Web', status: 'running' } }
      : undefined);
    schluesselAb(heim);
    const projekt = join(heim, 'projekt');
    mkdirSync(join(projekt, '.vscode'), { recursive: true });

    const r = await befehl(g.url, heim, projekt, ['join', '--brain', FREMD]);

    expect(g.anfragen.some((x) => x.pfad === `/api/v1/instances/${FREMD}` && x.authorization === `Bearer ${SCHLUESSEL}`)).toBe(true);
    expect(g.anfragen.some((x) => x.pfad === '/api/v1/orgs/accept-invite')).toBe(false);
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(projekt, '.vscode', 'mcp.json'), 'utf8'));
    expect(cfg.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(FREMD);
  }, 90_000);

  it('join --brain ohne Zugriff (404): klare Meldung, nichts geschrieben', async () => {
    const { g, heim } = await neu(() => undefined);
    schluesselAb(heim);
    const projekt = join(heim, 'projekt');
    mkdirSync(join(projekt, '.vscode'), { recursive: true });
    const r = await befehl(g.url, heim, projekt, ['join', '--brain', FREMD]);
    expect(r.code).toBe(1);
    expect(r.aus).toMatch(/do not have access/i);
    expect(existsSync(join(projekt, '.vscode', 'mcp.json'))).toBe(false);
  }, 60_000);
});
