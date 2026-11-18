import { describe, it, expect } from 'vitest';
import { join, resolve } from 'node:path';
import {
  MCPSERVERS_FORMAT,
  globaleMcpDatei,
  globalerEditorDa,
  mcpZiel,
  vsCodeNutzerOrdner,
  type Heim,
} from '../projektdateien.js';
import { mergeMcpConfig } from '../index.js';

/**
 * Windsurf und Cline lesen ihre MCP-Liste beim Nutzer, nicht im Projekt
 * (belegt am installierten Programm, 18.11.2026: Windsurf 1.11.3, Cline 4.1.26).
 * Bis 0.10.257 schrieb cachly .windsurf/mcp.json und .vscode/mcp.json und
 * meldete Erfolg — keines der beiden Programme las den Eintrag.
 */

const WIN: Heim = { heim: 'C:\\Users\\ada', plattform: 'win32', appData: 'C:\\Users\\ada\\AppData\\Roaming' };
// Mit join gebaut: so sehen die Pfade auf dem Rechner aus, auf dem der Test laeuft
// (unter Windows mit Rueckstrichen statt Schraegstrichen), wie im Betrieb homedir() + join.
const MAC: Heim = { heim: join('/Users', 'ada'), plattform: 'darwin' };
const LINUX: Heim = { heim: join('/home', 'ada'), plattform: 'linux' };

describe('globaleMcpDatei', () => {
  it('Windsurf: ~/.codeium/windsurf/mcp_config.json auf jedem System', () => {
    for (const h of [WIN, MAC, LINUX]) {
      expect(globaleMcpDatei('windsurf', h)).toBe(join(h.heim, '.codeium', 'windsurf', 'mcp_config.json'));
    }
  });

  it('Cline: cline_mcp_settings.json im globalStorage von VS Code', () => {
    const rest = ['globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'];
    expect(globaleMcpDatei('cline', WIN)).toBe(join(WIN.appData!, 'Code', 'User', ...rest));
    expect(globaleMcpDatei('cline', MAC)).toBe(join(MAC.heim, 'Library', 'Application Support', 'Code', 'User', ...rest));
    expect(globaleMcpDatei('cline', LINUX)).toBe(join(LINUX.heim, '.config', 'Code', 'User', ...rest));
  });

  it('ohne %APPDATA% nimmt Windows den Standardordner', () => {
    expect(vsCodeNutzerOrdner({ heim: 'C:\\Users\\ada', plattform: 'win32' })).toBe(
      join('C:\\Users\\ada', 'AppData', 'Roaming', 'Code', 'User'),
    );
  });

  it('Projekt-Editoren haben keine globale Datei', () => {
    for (const e of ['claude', 'cursor', 'copilot', 'continue', 'zed', 'codex', 'gemini']) {
      expect(globaleMcpDatei(e, LINUX), e).toBeNull();
    }
  });
});

describe('globalerEditorDa', () => {
  it('erkennt Windsurf und Cline an den Ordnern, die die Programme selbst anlegen', () => {
    const da = new Set([
      join(LINUX.heim, '.codeium', 'windsurf'),
      join(LINUX.heim, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    ]);
    const existiert = (p: string) => da.has(p);
    expect(globalerEditorDa('windsurf', LINUX, existiert)).toBe(true);
    expect(globalerEditorDa('cline', LINUX, existiert)).toBe(true);
  });

  it('ein VS-Code-Nutzer ohne Cline ist kein Cline-Nutzer (bis 0.10.257 reichte ~/.vscode/extensions)', () => {
    const da = new Set([join(LINUX.heim, '.vscode', 'extensions'), join(LINUX.heim, '.config', 'Code', 'User')]);
    expect(globalerEditorDa('cline', LINUX, (p) => da.has(p))).toBe(false);
    expect(globalerEditorDa('windsurf', LINUX, (p) => da.has(p))).toBe(false);
  });
});

describe('mcpZiel', () => {
  it('Windsurf und Cline schreiben global im mcpServers-Format, angezeigt mit ~', () => {
    for (const e of ['windsurf', 'cline']) {
      const z = mcpZiel(e, '/repo', LINUX);
      expect(z.pfad, e).toBe(globaleMcpDatei(e, LINUX));
      expect(z.format, e).toBe(MCPSERVERS_FORMAT);
      expect(z.anzeige.startsWith('~'), e).toBe(true);
    }
  });

  it('alle anderen bleiben im Projekt, mit ihrem eigenen Format', () => {
    const z = mcpZiel('cursor', '/repo', LINUX);
    expect(z.pfad).toBe(resolve('/repo', '.cursor', 'mcp.json'));
    expect(z.format).toBe('cursor');
    expect(z.anzeige).toBe('.cursor/mcp.json');
  });
});

describe('Cline bekommt mcpServers, nicht das VS-Code-Format', () => {
  it('fremde Server bleiben, cachly kommt unter mcpServers dazu', async () => {
    const pfad = '/heim/cline_mcp_settings.json';
    const vorher = JSON.stringify({ mcpServers: { github: { command: 'gh-mcp', disabled: false } } });
    const fs = { existsSync: (p: string) => p === pfad, readFile: () => Promise.resolve(vorher) };
    const z = mcpZiel('cline', '/repo', LINUX);
    const nachher = JSON.parse(
      await mergeMcpConfig(pfad, 'cky_live_x', '11111111-2222-3333-4444-555555555555', z.format, fs),
    );
    expect(nachher.mcpServers.github.command).toBe('gh-mcp');
    expect(nachher.mcpServers.cachly.command).toBe('npx');
    expect(nachher.servers).toBeUndefined();
    // Kein Schluessel in der Datei: der Server liest ~/.cachly/credentials.json.
    expect(JSON.stringify(nachher)).not.toContain('cky_live_x');
  });
});
