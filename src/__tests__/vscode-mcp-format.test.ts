/**
 * `.vscode/mcp.json` braucht `servers` mit `type: "stdio"`, nicht `mcpServers`.
 *
 * Bis 0.10.176 schrieb `setup` fuer Copilot und Cline `mcpServers` in diese Datei.
 * VS Code liest dort nur `servers` (code.visualstudio.com/docs/copilot/reference/
 * mcp-configuration) — der Eintrag wurde nie geladen. Gefunden am 11.10.2026.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMcpConfig, mergeMcpConfig } from '../index.js';

const IID = 'inst-vscode-format';
const PFAD = '/proj/.vscode/mcp.json';

function fsOpsFrom(files: Record<string, string>) {
  return {
    existsSync: (p: string) => p in files,
    readFile: (p: string) => Promise.resolve(files[p] ?? ''),
  };
}

function heim() {
  const dir = mkdtempSync(join(tmpdir(), 'cachly-vscode-format-'));
  return { dir, opts: { home: dir }, weg: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('.vscode/mcp.json im VS-Code-Format', () => {
  for (const editor of ['copilot', 'cline']) {
    it(`buildMcpConfig(${editor}) schreibt servers.cachly mit type stdio`, () => {
      const cfg = JSON.parse(buildMcpConfig('cky_x', IID, editor));
      expect(cfg.mcpServers).toBeUndefined();
      expect(cfg.servers.cachly.type).toBe('stdio');
      expect(cfg.servers.cachly.command).toBe('npx');
      expect(cfg.servers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
    });
  }

  it('andere Editoren bleiben bei mcpServers', () => {
    for (const editor of ['claude', 'cursor', 'windsurf']) {
      const cfg = JSON.parse(buildMcpConfig('cky_x', IID, editor));
      expect(cfg.mcpServers.cachly.command).toBe('npx');
      expect(cfg.servers).toBeUndefined();
    }
  });

  it('mergeMcpConfig ergaenzt servers und laesst fremde Server stehen', async () => {
    const h = heim();
    try {
      const vorher = JSON.stringify({ servers: { github: { type: 'http', url: 'https://example.test/mcp' } } });
      const out = JSON.parse(await mergeMcpConfig(PFAD, 'cky_x', IID, 'copilot', fsOpsFrom({ [PFAD]: vorher }), h.opts));
      expect(out.servers.github.url).toBe('https://example.test/mcp');
      expect(out.servers.cachly.type).toBe('stdio');
    } finally { h.weg(); }
  });

  it('ein alter cachly-Eintrag unter mcpServers wird nach servers uebernommen und entfernt', async () => {
    const h = heim();
    try {
      const vorher = JSON.stringify({ mcpServers: { cachly: { command: 'npx', args: [], env: { CACHLY_BRAIN_INSTANCE_ID: 'alt' } } } });
      const out = JSON.parse(await mergeMcpConfig(PFAD, 'cky_x', IID, 'copilot', fsOpsFrom({ [PFAD]: vorher }), h.opts));
      expect(out.mcpServers).toBeUndefined();
      expect(out.servers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
    } finally { h.weg(); }
  });

  it('fremde Eintraege unter mcpServers bleiben, nur cachly wandert', async () => {
    const h = heim();
    try {
      const vorher = JSON.stringify({ mcpServers: { cachly: { command: 'npx' }, anderer: { command: 'x' } } });
      const out = JSON.parse(await mergeMcpConfig(PFAD, 'cky_x', IID, 'cline', fsOpsFrom({ [PFAD]: vorher }), h.opts));
      expect(out.mcpServers.anderer.command).toBe('x');
      expect(out.mcpServers.cachly).toBeUndefined();
      expect(out.servers.cachly.type).toBe('stdio');
    } finally { h.weg(); }
  });

  it('ein envFile der VS-Code-Erweiterung bleibt erhalten', async () => {
    const h = heim();
    try {
      const vorher = JSON.stringify({ servers: { cachly: { type: 'stdio', command: 'npx', envFile: '${userHome}/.cachly/vscode-mcp.env' } } });
      const out = JSON.parse(await mergeMcpConfig(PFAD, 'cky_x', IID, 'copilot', fsOpsFrom({ [PFAD]: vorher }), h.opts));
      expect(out.servers.cachly.envFile).toBe('${userHome}/.cachly/vscode-mcp.env');
      expect(out.servers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
    } finally { h.weg(); }
  });

  it('kein Schluessel im Klartext in der Projektdatei', () => {
    const text = buildMcpConfig('cky_live_geheim', IID, 'copilot');
    expect(text).not.toContain('cky_live_geheim');
  });
});
