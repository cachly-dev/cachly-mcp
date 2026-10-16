import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installAmbientHooks, mergeAmbientSettings } from '../ambient-hooks.js';

/**
 * Einrichten fasst eine .claude/settings.json, die es nicht lesen kann, nicht an (16.10.2026).
 *
 * Bis 0.10.204 wurde eine Datei mit Parsefehler zu `{}` und dann mit unseren
 * Hooks neu geschrieben: Rechte (permissions) und eigene Hooks des Nutzers waren
 * weg, ohne Sicherung. Ein BOM (PowerShell 5) reichte dafuer schon. Und ein
 * Windows-Eintrag aus einem anderen Ordner (`C:\alt\.claude\hooks\cachly-ambient-…`)
 * wurde nicht als unserer erkannt — jeder Lauf haengte einen weiteren an.
 *
 * Gegenprobe: in ambient-hooks.ts das `.replace(/\\/g, '/')` in isAmbientGroup
 * entfernen -> der Windows-Fall wird rot; den Abbruch mit 'skipped' durch
 * `existingSettings = {}` ersetzen -> die Faelle "kaputt" werden rot.
 */

let ordner: string[] = [];
afterEach(() => { for (const o of ordner) rmSync(o, { recursive: true, force: true }); ordner = []; });

function projekt(settings?: string): { p: string; datei: string } {
  const p = mkdtempSync(join(tmpdir(), 'cachly-claude-settings-'));
  ordner.push(p);
  const datei = join(p, '.claude', 'settings.json');
  if (settings !== undefined) {
    mkdirSync(join(p, '.claude'), { recursive: true });
    writeFileSync(datei, settings);
  }
  return { p, datei };
}

const RECHTE = '{\n  "permissions": { "allow": ["Bash(npm test)"] }';

describe('installAmbientHooks laesst eine unlesbare settings.json stehen', () => {
  it('abgeschnittenes JSON: Datei byte-gleich, keine Skripte, Grund genannt', async () => {
    const kaputt = RECHTE + ',\n  "hooks": {';
    const { p, datei } = projekt(kaputt);
    const a = await installAmbientHooks(p, 'i1');
    expect(a.settings).toBe('skipped');
    expect(a.grund).toBe('is not valid JSON');
    expect(readFileSync(datei, 'utf8')).toBe(kaputt);
    expect(existsSync(join(p, '.claude', 'hooks'))).toBe(false);
  });

  it('Kommentare: bleibt stehen, Grund nennt die Kommentare', async () => {
    const mitKommentar = '// meine Rechte\n' + RECHTE + '\n}\n';
    const { p, datei } = projekt(mitKommentar);
    const a = await installAmbientHooks(p, 'i1');
    expect(a.settings).toBe('skipped');
    expect(a.grund).toContain('comments');
    expect(readFileSync(datei, 'utf8')).toBe(mitKommentar);
  });

  it('"hooks" ist kein Objekt: bleibt stehen', async () => {
    const komisch = '{ "hooks": [] }\n';
    const { p, datei } = projekt(komisch);
    const a = await installAmbientHooks(p, 'i1');
    expect(a.settings).toBe('skipped');
    expect(readFileSync(datei, 'utf8')).toBe(komisch);
  });

  it('BOM aus PowerShell 5 ist kein Fehler: Rechte bleiben, Hooks kommen dazu', async () => {
    const { p, datei } = projekt('\ufeff' + RECHTE + '\n}\n');
    const a = await installAmbientHooks(p, 'i1');
    expect(a.settings).toBe('merged');
    const s = JSON.parse(readFileSync(datei, 'utf8'));
    expect(s.permissions.allow).toEqual(['Bash(npm test)']);
    expect(s.hooks.SessionStart).toHaveLength(1);
  });

  it('leere Datei zaehlt als leeres Objekt', async () => {
    const { p, datei } = projekt('');
    const a = await installAmbientHooks(p, 'i1');
    expect(a.settings).toBe('merged');
    expect(JSON.parse(readFileSync(datei, 'utf8')).hooks.UserPromptSubmit).toHaveLength(1);
  });
});

describe('mergeAmbientSettings erkennt Windows-Eintraege aus einem anderen Ordner', () => {
  it('alter Eintrag mit Rueckstrichen wird ersetzt, nicht verdoppelt', () => {
    const alt = 'node "C:\\Users\\x\\alt\\proj\\.claude\\hooks\\cachly-ambient-session-start.mjs"';
    const fremd = 'node "C:\\Users\\x\\mein-hook.mjs"';
    const { settings } = mergeAmbientSettings(
      { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: fremd }] }, { hooks: [{ type: 'command', command: alt }] }] } },
      { sessionStart: 'C:\\Users\\x\\neu\\proj\\.claude\\hooks\\cachly-ambient-session-start.mjs', userPromptSubmit: 'C:\\p.mjs' },
    );
    const befehle = settings.hooks!.SessionStart.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    expect(befehle).not.toContain(alt);
    expect(befehle).toContain(fremd);
    expect(befehle).toHaveLength(2);
  });
});
