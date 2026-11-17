import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * ABNAHME: das Docker-Abbild startet im stdio-Modus.
 *
 * Befund 17.11.2026 (lokaler Test fuer den Docker MCP Catalog): Das Dockerfile
 * setzte ENV PORT=3000. PORT schaltet in src/index.ts den HTTP-Modus ein. Das
 * Abbild meldete "HTTP server listening on :3000" und sprach kein stdio. Docker
 * MCP, Smithery (startCommand type stdio) und Glama starten den Server aber
 * ueber stdio. mcp.cachly.dev braucht den HTTP-Modus und setzt PORT deshalb
 * selbst in docker-compose.yml.
 */
const lies = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('Docker-Abbild', () => {
  it('setzt kein PORT, damit es stdio spricht', () => {
    expect(lies('../../Dockerfile')).not.toMatch(/^\s*ENV\s+PORT\b/m);
  });

  it('PORT schaltet weiterhin den HTTP-Modus (sonst waere die Probe oben sinnlos)', () => {
    expect(lies('../index.ts')).toMatch(/const httpPort = process\.env\.PORT/);
  });

  it('mcp.cachly.dev setzt PORT selbst', () => {
    const compose = lies('../../../../docker-compose.yml');
    const block = compose.slice(compose.indexOf('\n  mcp-http:'));
    expect(block.slice(0, 600)).toMatch(/PORT:\s*"3000"/);
  });
});
