import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { handleTeamTool } from '../handlers/team.js';
import { CLAUDE_MD_MARKER_START } from '../projektdateien.js';

/**
 * setup_ai_memory laesst fremde Inhalte stehen (16.10.2026).
 *
 * Bis 0.10.203 schrieb das Werkzeug CLAUDE.md, .github/copilot-instructions.md und
 * .windsurfrules NEU (eine vorhandene CLAUDE.md war weg), ersetzte in
 * .claude/settings.json den GANZEN hooks-Schluessel und trug einen Stop-Hook
 * "npx … checkpoint" ein — einen Befehl, den es nicht gibt. `.cursor/rules` schrieb
 * es als Datei, obwohl Cursor dort einen Ordner fuehrt.
 *
 * Gegenprobe: in handlers/team.ts setzeAnweisungsblock(...) durch ein schlichtes
 * writeFile(target.path, block) ersetzen -> der erste Fall wird rot.
 */

const getConn = async () => ({}) as unknown as Redis;
const apiFetch = (async () => ({ tier: 'free', vector_token: null })) as unknown as Parameters<typeof handleTeamTool>[3];

let ordner: string[] = [];
afterEach(() => { for (const o of ordner) rmSync(o, { recursive: true, force: true }); ordner = []; });

function projekt(): string {
  const p = mkdtempSync(join(tmpdir(), 'cachly-setupmem-'));
  ordner.push(p);
  return p;
}

const aufruf = (p: string) => handleTeamTool('setup_ai_memory', { instance_id: 'i1', project_dir: p }, getConn, apiFetch);

const EIGENE_CLAUDE_MD = '# Mein Projekt\n\nEigene Regeln, die bleiben muessen.\n';
const EIGENE_SETTINGS = JSON.stringify({
  permissions: { allow: ['Bash(npm test)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node mein-hook.mjs' }] }] },
}, null, 2);

describe('setup_ai_memory schreibt schonend', () => {
  it('eigene CLAUDE.md bleibt, Block wird angehaengt; settings.json bleibt byte-gleich; kein checkpoint-Hook', async () => {
    const p = projekt();
    writeFileSync(join(p, 'CLAUDE.md'), EIGENE_CLAUDE_MD);
    mkdirSync(join(p, '.claude'));
    writeFileSync(join(p, '.claude', 'settings.json'), EIGENE_SETTINGS);

    await aufruf(p);

    const claudeMd = readFileSync(join(p, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.startsWith(EIGENE_CLAUDE_MD)).toBe(true);
    expect(claudeMd).toContain(CLAUDE_MD_MARKER_START);
    expect(readFileSync(join(p, '.claude', 'settings.json'), 'utf8')).toBe(EIGENE_SETTINGS);
    expect(readFileSync(join(p, '.github', 'copilot-instructions.md'), 'utf8')).not.toContain('checkpoint --instance-id');
  });

  it('ein zweiter Aufruf ersetzt den Block statt einen zweiten anzuhaengen', async () => {
    const p = projekt();
    writeFileSync(join(p, 'CLAUDE.md'), EIGENE_CLAUDE_MD);
    await aufruf(p);
    const nachErstem = readFileSync(join(p, 'CLAUDE.md'), 'utf8');
    await aufruf(p);
    const nachZweitem = readFileSync(join(p, 'CLAUDE.md'), 'utf8');
    expect(nachZweitem).toBe(nachErstem);
    expect(nachZweitem.split(CLAUDE_MD_MARKER_START).length - 1).toBe(1);
  });

  it('ein vorhandener Ordner .cursor/rules bekommt cachly.mdc, statt den Aufruf scheitern zu lassen', async () => {
    const p = projekt();
    mkdirSync(join(p, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(p, '.cursor', 'rules', 'eigene.mdc'), 'meine Regel\n');

    const ausgabe = String(await aufruf(p));

    expect(readFileSync(join(p, '.cursor', 'rules', 'cachly.mdc'), 'utf8')).toMatch(/^---\n[\s\S]*alwaysApply: true[\s\S]*cachly-brain-start/);
    expect(readFileSync(join(p, '.cursor', 'rules', 'eigene.mdc'), 'utf8')).toBe('meine Regel\n');
    expect(ausgabe).toContain('[Cursor]');
  });

  it('ohne .claude-Ordner entsteht keine settings.json', async () => {
    const p = projekt();
    writeFileSync(join(p, 'CLAUDE.md'), EIGENE_CLAUDE_MD);
    await aufruf(p);
    expect(existsSync(join(p, '.claude', 'settings.json'))).toBe(false);
  });
});
