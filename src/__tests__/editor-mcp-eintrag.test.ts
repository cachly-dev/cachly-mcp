import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexMcpBlock, installCodexMcp, installGeminiMcp, ohneCodexMcpEintrag, setzeCodexMcpEintrag,
} from '../editor-mcp-eintrag.js';

/**
 * MCP-Eintrag fuer Codex (.codex/config.toml) und Gemini CLI (.gemini/settings.json),
 * GROW-018. Fremder Inhalt bleibt Zeile fuer Zeile; ein zweiter Lauf aendert nichts.
 *
 * Gegenprobe: in ohneCodexMcpEintrag die Untertabellen-Erkennung `(?:\.[^\]]*)?` aus
 * CACHLY_KOPF nehmen -> der Fall mit [mcp_servers.cachly.env] wird rot.
 */

const ENV = { CACHLY_BRAIN_INSTANCE_ID: 'inst-1' };
let ordner: string[] = [];
afterEach(() => { for (const o of ordner) rmSync(o, { recursive: true, force: true }); ordner = []; });
const projekt = () => { const p = mkdtempSync(join(tmpdir(), 'cachly-editor-mcp-')); ordner.push(p); return p; };

describe('Codex: .codex/config.toml', () => {
  it('der Block: npx, Server-Argumente, env als Inline-Tabelle', () => {
    expect(codexMcpBlock(ENV)).toBe(
      '[mcp_servers.cachly]\ncommand = "npx"\nargs = ["-y", "@cachly-dev/mcp-server@latest"]\nenv = { CACHLY_BRAIN_INSTANCE_ID = "inst-1" }',
    );
  });

  it('fremder Inhalt bleibt, der Block kommt ans Ende; zweiter Lauf: unveraendert', () => {
    const fremd = 'model = "o3"\n\n[mcp_servers.fremd]\ncommand = "node"\n';
    const r1 = setzeCodexMcpEintrag(fremd, ENV);
    if ('grund' in r1) throw new Error(r1.grund);
    expect(r1.text.startsWith(fremd)).toBe(true);
    const r2 = setzeCodexMcpEintrag(r1.text, ENV);
    expect(r2).toEqual({ text: r1.text, changed: false });
  });

  it('ein Eintrag von `codex mcp add` (mit Untertabelle env) wird ersetzt, der Tisch danach bleibt', () => {
    const vorher = '[mcp_servers.cachly]\ncommand = "npx"\nargs = ["@cachly-dev/mcp-server"]\n\n[mcp_servers.cachly.env]\nCACHLY_JWT = "cky_live_alt"\n\n[projects.\'C:\\Users\\x\\proj\']\ntrust_level = "trusted"\n';
    const r = setzeCodexMcpEintrag(vorher, ENV);
    if ('grund' in r) throw new Error(r.grund);
    expect(r.text).not.toContain('cky_live_alt');
    expect(r.text).toContain("[projects.'C:\\Users\\x\\proj']\ntrust_level = \"trusted\"");
    expect(r.text.split('[mcp_servers.cachly]').length - 1).toBe(1);
  });

  it('Array ueber mehrere Zeilen in einer fremden Tabelle ist kein Tabellenkopf', () => {
    const vorher = '[mcp_servers.cachly]\ncommand = "x"\n\n[tools]\nliste = [\n  "a",\n  "b"]\n';
    expect(ohneCodexMcpEintrag(vorher).rest).toBe('[tools]\nliste = [\n  "a",\n  "b"]\n');
  });

  it('cachly als Inline-Tabelle: Datei bleibt, Grund wird genannt', () => {
    const r = setzeCodexMcpEintrag('[mcp_servers]\ncachly = { command = "npx" }\n', ENV);
    expect(r).toHaveProperty('grund');
  });

  it('installCodexMcp: neu, dann unveraendert; BOM ist kein Fehler', async () => {
    const p = projekt();
    expect((await installCodexMcp(p, ENV)).status).toBe('written');
    expect((await installCodexMcp(p, ENV)).status).toBe('unchanged');
    const q = projekt();
    mkdirSync(join(q, '.codex'));
    writeFileSync(join(q, '.codex', 'config.toml'), '\ufeffmodel = "o3"\n');
    expect((await installCodexMcp(q, ENV)).status).toBe('updated');
    expect(readFileSync(join(q, '.codex', 'config.toml'), 'utf8')).toMatch(/^model = "o3"\n\n\[mcp_servers\.cachly\]/);
  });
});

describe('Gemini CLI: .gemini/settings.json', () => {
  it('neben Hooks und fremden Servern; zweiter Lauf: unveraendert', async () => {
    const p = projekt();
    mkdirSync(join(p, '.gemini'));
    const fremd = { theme: 'dark', hooks: { SessionStart: [] }, mcpServers: { fremd: { command: 'node' } } };
    writeFileSync(join(p, '.gemini', 'settings.json'), JSON.stringify(fremd));
    expect((await installGeminiMcp(p, ENV)).status).toBe('updated');
    const d = JSON.parse(readFileSync(join(p, '.gemini', 'settings.json'), 'utf8'));
    expect(d.theme).toBe('dark');
    expect(d.hooks).toEqual({ SessionStart: [] });
    expect(d.mcpServers.fremd).toEqual({ command: 'node' });
    expect(d.mcpServers.cachly).toEqual({ command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'], env: ENV });
    expect((await installGeminiMcp(p, ENV)).status).toBe('unchanged');
  });

  it('Kommentare: Datei bleibt byte-gleich, Grund nennt sie', async () => {
    const p = projekt();
    mkdirSync(join(p, '.gemini'));
    const mitKommentar = '{\n  // mein Thema\n  "theme": "dark"\n}\n';
    writeFileSync(join(p, '.gemini', 'settings.json'), mitKommentar);
    const r = await installGeminiMcp(p, ENV);
    expect(r).toMatchObject({ status: 'skipped' });
    expect(r.grund).toContain('comments');
    expect(readFileSync(join(p, '.gemini', 'settings.json'), 'utf8')).toBe(mitKommentar);
  });

  it('ohne Datei: neu geschrieben, kein Schluessel darin', async () => {
    const p = projekt();
    expect((await installGeminiMcp(p, ENV)).status).toBe('written');
    expect(readFileSync(join(p, '.gemini', 'settings.json'), 'utf8')).not.toContain('CACHLY_JWT');
  });
});
