import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/*
 * `uninstall` als echter Prozess: erst `init` schreibt in ein Projekt mit
 * eigenem Inhalt, dann nimmt `uninstall` es wieder heraus (GROW-027).
 *
 * Belegt: --dry-run aendert nichts. Ohne --yes und ohne Terminal bricht der
 * Befehl ab. --yes stellt CLAUDE.md, AGENTS.md, .mcp.json und post-commit auf
 * den Stand vor init zurueck; es bleiben keine cachly-Dateien und keine leeren
 * Ordner. --global --yes loescht die Schluesseldatei im Heimordner und die
 * bekannten Ablagen im Temp-Ordner, aber keinen fremden Ordner dort.
 *
 * Der Temp-Ordner des Kindprozesses ist ein eigener Ordner: --global rauemt
 * dort auf und darf nie den echten Temp-Ordner dieses Rechners anfassen.
 * Kein Netz: alle Anfragen gehen an 127.0.0.1.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const einstieg = join(hier, '..', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

const SCHLUESSEL = 'cky_live_uninstallprozess0000000000000';
const INSTANZ = '33333333-4444-5555-6666-777777777777';

const CLAUDE_ORIGINAL = '# Mein Projekt\n\nRegeln — äöü:\n- erstens\n- zweitens\n';
const AGENTS_ORIGINAL = 'Agenten-Hinweise ohne Zeilenumbruch am Ende';
const MCP_ORIGINAL = { mcpServers: { fremd: { command: 'node', args: ['mein-server.js'] } } };
const HOOK_ORIGINAL = '#!/bin/sh\necho "mein eigener post-commit"\n';

interface Anfrage { pfad: string; auth: string }

async function starteGegenstelle(): Promise<{ url: string; anfragen: Anfrage[]; server: Server }> {
  const anfragen: Anfrage[] = [];
  const server = createServer((req, res) => {
    req.on('data', () => { /* ohne Belang */ });
    req.on('end', () => {
      const pfad = (req.url ?? '').split('?')[0] ?? '';
      anfragen.push({ pfad, auth: String(req.headers.authorization ?? '') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pfad === `/api/v1/instances/${INSTANZ}/memory` ? { lesson_count: 7 } : {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, anfragen, server };
}

function baum(wurzel: string): Record<string, string> {
  const aus: Record<string, string> = {};
  const geh = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { aus[`${relative(wurzel, p).split('\\').join('/')}/`] = ''; geh(p); }
      else aus[relative(wurzel, p).split('\\').join('/')] = readFileSync(p, 'utf8');
    }
  };
  geh(wurzel);
  return aus;
}

describe('uninstall als echter Prozess: init, dann zurueck', () => {
  let wurzel = '';
  let heim = '';
  let projekt = '';
  let tmpKind = '';
  let gegenstelle: Awaited<ReturnType<typeof starteGegenstelle>>;
  let nachInit: Record<string, string> = {};

  async function starte(args: string[]): Promise<{ code: number | null; ausgabe: string }> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue;
      if (/^path$/i.test(k)) continue;
      if (/^CACHLY_/.test(k)) continue;
      env[k] = v;
    }
    Object.assign(env, {
      PATH: '', HOME: heim, USERPROFILE: heim, APPDATA: heim,
      TMPDIR: tmpKind, TEMP: tmpKind, TMP: tmpKind,
      CACHLY_API_URL: gegenstelle.url, CACHLY_AUTO_INDEX: 'false', CACHLY_NO_TELEMETRY: '1',
    });
    const kind = spawn(process.execPath, [tsxCli, einstieg, ...args], { env, cwd: projekt, stdio: ['pipe', 'pipe', 'pipe'] });
    let ausgabe = '';
    kind.stdout.on('data', (c) => { ausgabe += String(c); });
    kind.stderr.on('data', (c) => { ausgabe += String(c); });
    kind.stdin.end();
    const code = await new Promise<number | null>((r) => {
      const t = setTimeout(() => { kind.kill(); r(null); }, 80_000);
      kind.once('exit', (c) => { clearTimeout(t); r(c); });
    });
    return { code, ausgabe };
  }

  beforeAll(async () => {
    gegenstelle = await starteGegenstelle();
    wurzel = mkdtempSync(join(tmpdir(), 'cachly-uninstall-prozess-'));
    heim = join(wurzel, 'heim');
    projekt = join(wurzel, 'projekt');
    tmpKind = join(wurzel, 'tmp');
    for (const d of [heim, projekt, tmpKind, join(projekt, '.git', 'hooks')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(projekt, 'CLAUDE.md'), CLAUDE_ORIGINAL, 'utf8');
    writeFileSync(join(projekt, 'AGENTS.md'), AGENTS_ORIGINAL, 'utf8');
    writeFileSync(join(projekt, '.mcp.json'), JSON.stringify(MCP_ORIGINAL, null, 2) + '\n', 'utf8');
    writeFileSync(join(projekt, '.git', 'hooks', 'post-commit'), HOOK_ORIGINAL, 'utf8');
    const r = await starte(['init', '--editor', 'claude', '--instance-id', INSTANZ, '--api-key', SCHLUESSEL]);
    expect(r.code, r.ausgabe).toBe(0);
    nachInit = baum(projekt);
  }, 120_000);

  afterAll(() => {
    gegenstelle?.server.close();
    if (wurzel) rmSync(wurzel, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('Vorbedingung: init hat geschrieben, was uninstall zurueckholen soll', () => {
    expect(nachInit['CLAUDE.md']).toContain('cachly-brain-start');
    expect(nachInit['CLAUDE.md']!.startsWith(CLAUDE_ORIGINAL)).toBe(true);
    expect(JSON.parse(nachInit['.mcp.json']!).mcpServers.cachly).toBeTruthy();
    expect(nachInit['.claude/hooks/cachly-ambient-stop.mjs']).toBeTruthy();
    expect(nachInit['.git/hooks/post-commit']).toContain('cachly CLS');
    expect(existsSync(join(heim, '.cachly', 'credentials.json'))).toBe(true);
  });

  it('--dry-run zeigt Zahlen und Plan und aendert nichts', async () => {
    const r = await starte(['uninstall', '--dry-run']);
    expect(r.code, r.ausgabe).toBe(0);
    expect(baum(projekt)).toEqual(nachInit);
    expect(existsSync(join(heim, '.cachly', 'credentials.json'))).toBe(true);
    expect(r.ausgabe).toContain('7 in your Brain');
    expect(r.ausgabe).toContain('account key');
    expect(r.ausgabe).toMatch(/remove block\s+CLAUDE\.md/);
    expect(r.ausgabe).toMatch(/delete file\s+\.claude\/hooks\/cachly-ambient-stop\.mjs/);
    expect(r.ausgabe).toContain('Dry run: nothing was changed.');
    expect(gegenstelle.anfragen.find((a) => a.pfad === `/api/v1/instances/${INSTANZ}/memory`)?.auth).toBe(`Bearer ${SCHLUESSEL}`);
  }, 90_000);

  it('ohne --yes und ohne Terminal: Abbruch mit Hinweis, nichts geaendert', async () => {
    const r = await starte(['uninstall']);
    expect(r.code, r.ausgabe).toBe(1);
    expect(r.ausgabe).toContain('--yes');
    expect(baum(projekt)).toEqual(nachInit);
  }, 90_000);

  it('--yes stellt den Stand vor init her: Fremdes byte-gleich, nichts von cachly uebrig, keine leeren Ordner', async () => {
    const r = await starte(['uninstall', '--yes']);
    expect(r.code, r.ausgabe).toBe(0);
    const nachher = baum(projekt);
    expect(nachher['CLAUDE.md']).toBe(CLAUDE_ORIGINAL);
    expect(nachher['AGENTS.md']).toBe(AGENTS_ORIGINAL);
    expect(nachher['.git/hooks/post-commit']).toBe(HOOK_ORIGINAL);
    expect(JSON.parse(nachher['.mcp.json']!)).toEqual(MCP_ORIGINAL);
    expect(Object.keys(nachher).filter((k) => /cachly/i.test(k))).toEqual([]);
    expect(Object.values(nachher).some((t) => t.includes('cachly-brain-start') || t.includes('cachly-ambient-'))).toBe(false);
    expect(existsSync(join(projekt, '.claude'))).toBe(false);
    expect(existsSync(join(projekt, '.github'))).toBe(false);
    expect(existsSync(join(projekt, '.cursor'))).toBe(false);
    const leer = Object.keys(nachher).filter((k) => k.endsWith('/') && !Object.keys(nachher).some((o) => o !== k && o.startsWith(k)));
    expect(leer.filter((k) => !k.startsWith('.git/'))).toEqual([]);
    expect(r.ausgabe).toContain('never deletes cloud data');
    expect(existsSync(join(heim, '.cachly', 'credentials.json'))).toBe(true);
  }, 90_000);

  it('--global --yes loescht die Schluesseldatei und die bekannten Ablagen, sonst nichts', async () => {
    writeFileSync(join(tmpKind, 'cachly-ambient-bestand-0123456789ab.json'), '{}', 'utf8');
    mkdirSync(join(tmpKind, 'cachly-lernen'), { recursive: true });
    writeFileSync(join(tmpKind, 'cachly-lernen', 'a.jsonl'), '{}', 'utf8');
    mkdirSync(join(tmpKind, 'cachly-mein-projekt'), { recursive: true });
    writeFileSync(join(tmpKind, 'cachly-mein-projekt', 'main.ts'), 'export {}', 'utf8');
    const r = await starte(['uninstall', '--global', '--yes']);
    expect(r.code, r.ausgabe).toBe(0);
    expect(existsSync(join(heim, '.cachly', 'credentials.json'))).toBe(false);
    expect(existsSync(join(heim, '.cachly'))).toBe(false);
    expect(existsSync(join(tmpKind, 'cachly-ambient-bestand-0123456789ab.json'))).toBe(false);
    expect(existsSync(join(tmpKind, 'cachly-lernen'))).toBe(false);
    expect(readFileSync(join(tmpKind, 'cachly-mein-projekt', 'main.ts'), 'utf8')).toBe('export {}');
    expect(r.ausgabe).toContain('lose their access');
  }, 90_000);

  it('danach: nichts mehr zu finden', async () => {
    const r = await starte(['uninstall', '--global', '--yes']);
    expect(r.code, r.ausgabe).toBe(0);
    expect(r.ausgabe).toContain('Nothing found');
  }, 90_000);
});
