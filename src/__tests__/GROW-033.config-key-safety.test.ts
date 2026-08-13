// Abnahme GROW-033 — die vom Setup geschriebenen MCP-Konfigurationen im
// PROJEKT tragen keinen Schluessel mehr im Klartext.
//
// Vorher landete der Schluessel ueber buildServerEnv in jeder Editor-Datei
// (.mcp.json, .cursor/mcp.json, .vscode/mcp.json, ...) — genau die Dateien,
// die ein Team als gemeinsame Einstellung committet. Dieser Test friert zwei
// Dinge ein:
//   A. Die erzeugte Konfiguration (buildMcpConfig UND mergeMcpConfig) enthaelt
//      kein cky_-Muster und kein CACHLY_JWT mit Wert — die Instanz-Kennung
//      bleibt, sie ist kein Geheimnis.
//   B. BESTANDSSCHUTZ: ein Schluessel, der schon in einer vorhandenen
//      Projekt-Datei lag (Altbestand aus der Zeit vor GROW-033), geht beim
//      Zusammenfuehren NICHT verloren. Er wird in den Home-Speicher
//      uebernommen (saveApiKey) und aus der Projektdatei entfernt —
//      resolveApiKey findet ihn danach wieder, ohne dass irgendjemand den
//      Zugang verliert.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpConfig, mergeMcpConfig, buildServerEnv } from '../index.js';
import { resolveApiKey, credentialsPath } from '../credentials.js';

const GEHEIM = 'cky_live_GEHEIM_niemals_im_projekt_045';
const IID = 'inst-abnahme-033';

// mergeMcpConfig nimmt injizierte fsOps entgegen, wie in setup-config.test.ts —
// so laesst sich eine vorhandene Projektdatei simulieren, ohne die echte
// Festplatte anzufassen.
function fsOpsFrom(files: Record<string, string>) {
  return {
    existsSync: (p: string) => p in files,
    readFile: (p: string) => Promise.resolve(files[p] ?? ''),
  };
}

describe('GROW-033 A — frisch erzeugte Projekt-Konfigurationen tragen kein Geheimnis', () => {
  const editoren = ['claude', 'cursor', 'windsurf', 'copilot', 'continue', 'cline', 'zed'];

  for (const editor of editoren) {
    it(`buildMcpConfig(${editor}): kein cky_-Muster, kein Schluessel-Wert im Text`, () => {
      const text = buildMcpConfig(GEHEIM, IID, editor);
      expect(text).not.toContain(GEHEIM);
      expect(text).not.toMatch(/cky_/);
      expect(text).toContain(IID);
    });
  }

  it('mergeMcpConfig ohne vorhandene Datei: kein cky_-Muster im Ergebnis, Instanz-Kennung bleibt', async () => {
    const out = await mergeMcpConfig('/proj/.mcp.json', GEHEIM, IID, 'claude', fsOpsFrom({}));
    expect(out).not.toContain(GEHEIM);
    expect(out).not.toMatch(/cky_/);
    expect(out).toContain(IID);
  });

  it('buildServerEnv laesst CACHLY_JWT standardmaessig weg — nur die Instanz-Kennung bleibt', () => {
    const env = buildServerEnv(GEHEIM, IID);
    expect(env.CACHLY_JWT).toBeUndefined();
    expect(env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });
});

describe('GROW-033 B — BESTANDSSCHUTZ: ein Altbestand-Schluessel geht beim Zusammenfuehren nicht verloren', () => {
  let heim: string;

  beforeEach(() => {
    heim = mkdtempSync(join(tmpdir(), 'cachly-grow033-heim-'));
  });
  afterEach(() => {
    rmSync(heim, { recursive: true, force: true });
  });

  it('ein Schluessel aus einer vorhandenen .mcp.json wandert in den Home-Speicher und verschwindet aus der Projektdatei', async () => {
    const projektDatei = '/proj/.mcp.json';
    const vorherigeDatei = JSON.stringify({
      mcpServers: { cachly: { command: 'npx', args: ['old'], env: { CACHLY_JWT: GEHEIM, CACHLY_BRAIN_INSTANCE_ID: 'alte-instanz' } } },
    });
    const out = await mergeMcpConfig(
      projektDatei, 'frisch-vom-login', IID, 'claude',
      fsOpsFrom({ [projektDatei]: vorherigeDatei }),
      { home: heim },
    );

    expect(out).not.toContain(GEHEIM);
    expect(JSON.parse(out).mcpServers.cachly.env.CACHLY_JWT).toBeUndefined();
    expect(readFileSync(credentialsPath({ home: heim }), 'utf-8')).toContain(GEHEIM);
  });

  it('resolveApiKey findet den uebernommenen Schluessel danach wieder — niemand steht ohne Zugang da', async () => {
    const projektDatei = '/proj/.mcp.json';
    const vorherigeDatei = JSON.stringify({
      mcpServers: { cachly: { command: 'npx', args: ['old'], env: { CACHLY_JWT: GEHEIM } } },
    });
    await mergeMcpConfig(
      projektDatei, 'frisch-vom-login', IID, 'claude',
      fsOpsFrom({ [projektDatei]: vorherigeDatei }),
      { home: heim },
    );

    const gefunden = resolveApiKey({ home: heim, cwd: '/nirgendwo-in-diesem-test', env: {} });
    expect(gefunden).toBe(GEHEIM);
  });

  it('ohne Altbestand in der Datei bleibt der Home-Speicher unangetastet', async () => {
    const projektDatei = '/proj/.mcp.json';
    const vorherigeDatei = JSON.stringify({ mcpServers: { filesystem: { command: 'npx' } } });
    await mergeMcpConfig(
      projektDatei, 'frisch-vom-login', IID, 'claude',
      fsOpsFrom({ [projektDatei]: vorherigeDatei }),
      { home: heim },
    );
    expect(resolveApiKey({ home: heim, cwd: '/nirgendwo-in-diesem-test', env: {} })).toBeUndefined();
  });
});
