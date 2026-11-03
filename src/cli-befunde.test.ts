// Tests zu den CLI-Befunden cli-1, cli-2, cli-5, cli-6, cli-7, cli-8 (03.11.2026).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { klassiereArgument, leseFlag, flagsOhneWert, pruefeInitEingaben } from './cli-argumente.js';
import { inspectAmbientHooks, checkHooks } from './doctor.js';
import { setzeAnweisungsblock, CLAUDE_MD_MARKER_START, CLAUDE_MD_MARKER_END } from './projektdateien.js';
import { vonRohLektion } from './brain-export.js';

const ID = '8e03addd-a2d9-406e-bcbb-d6d8c938a3d0';
const EDITOREN = ['claude', 'cursor', 'codex'];

describe('cli-5: Hilfe, Version, unbekannter Befehl', () => {
  it('--help, -h und --version werden erkannt, auch ohne Terminal', () => {
    expect(klassiereArgument('--help', false)).toBe('hilfe');
    expect(klassiereArgument('-h', true)).toBe('hilfe');
    expect(klassiereArgument('--version', false)).toBe('version');
    expect(klassiereArgument('-v', true)).toBe('version');
  });
  it('Tippfehler am Terminal ist unbekannt, mit Pipes startet der Server', () => {
    expect(klassiereArgument('inti', true)).toBe('unbekannt');
    expect(klassiereArgument('inti', false)).toBe('server');
  });
  it('kein Argument und bekannte Befehle starten wie bisher', () => {
    expect(klassiereArgument(undefined, true)).toBe('server');
    expect(klassiereArgument(undefined, false)).toBe('server');
    expect(klassiereArgument('init', true)).toBe('server');
    expect(klassiereArgument('doctor', true)).toBe('server');
  });
});

describe('cli-1: Flags und Eingaben', () => {
  it('ein folgendes --flag ist kein Wert', () => {
    const argv = ['--instance-id', '--api-key', 'abc'];
    expect(leseFlag(argv, 'instance-id')).toBeUndefined();
    expect(leseFlag(argv, 'api-key')).toBe('abc');
    expect(flagsOhneWert(argv, ['instance-id', 'api-key'])).toEqual(['instance-id']);
  });
  it('Muell-Schluessel und Muell-Instanz werden abgelehnt', () => {
    const f = pruefeInitEingaben({ instanceId: 'not-a-uuid', apiKey: 'garbage', editor: 'claude' }, EDITOREN);
    expect(f.length).toBe(2);
  });
  it('gueltige Werte, auch ein JWT, bestehen', () => {
    expect(pruefeInitEingaben({ instanceId: ID, apiKey: 'cky_live_abc', editor: 'claude' }, EDITOREN)).toEqual([]);
    expect(pruefeInitEingaben({ instanceId: ID, apiKey: 'a.b.c', editor: 'codex' }, EDITOREN)).toEqual([]);
  });
  it('cli-6: unbekannter Editor wird mit Liste abgelehnt', () => {
    const f = pruefeInitEingaben({ instanceId: ID, apiKey: 'cky_x', editor: 'vscode' }, EDITOREN);
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('claude, cursor, codex');
  });
});

describe('cli-2: doctor erkennt die Hooks anderer Editoren', () => {
  it('Codex-Hooks gelten als verdrahtet, ohne .claude/settings.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cachly-doctor-'));
    try {
      expect(checkHooks(inspectAmbientHooks(dir)).status).toBe('warn');
      mkdirSync(join(dir, '.codex', 'hooks'), { recursive: true });
      writeFileSync(join(dir, '.codex', 'hooks.json'), '{"hooks":{"x":"cachly-ambient-codex.mjs"}}');
      writeFileSync(join(dir, '.codex', 'hooks', 'cachly-ambient-einblendung.mjs'), '//');
      const c = checkHooks(inspectAmbientHooks(dir));
      expect(c.status).toBe('ok');
      expect(c.detail).toContain('codex');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('cli-7: setzeAnweisungsblock schreibt nur bei Aenderung', () => {
  it('zweiter Lauf: unchanged und gleiche Dateizeit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cachly-block-'));
    const datei = join(dir, 'CLAUDE.md');
    const block = `${CLAUDE_MD_MARKER_START}\nA\n${CLAUDE_MD_MARKER_END}`;
    try {
      expect(await setzeAnweisungsblock(datei, block)).toBe('written');
      const t1 = statSync(datei).mtimeMs;
      await new Promise((r) => setTimeout(r, 30));
      expect(await setzeAnweisungsblock(datei, block)).toBe('unchanged');
      expect(statSync(datei).mtimeMs).toBe(t1);
      const neu = `${CLAUDE_MD_MARKER_START}\nB\n${CLAUDE_MD_MARKER_END}`;
      expect(await setzeAnweisungsblock(datei, neu)).toBe('updated');
      expect(readFileSync(datei, 'utf-8')).toContain('B');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('cli-8: Lektion ohne Thema bleibt im Export', () => {
  it('leeres Thema bekommt einen Platzhalter statt null', () => {
    expect(vonRohLektion({ topic: '', what_worked: 'x' })?.topic).toBe('(no topic)');
    expect(vonRohLektion({ what_worked: 'x' })?.topic).toBe('(no topic)');
  });
  it('Nicht-Objekte sind weiter keine Lektion', () => {
    expect(vonRohLektion(null)).toBeNull();
    expect(vonRohLektion('text')).toBeNull();
  });
});
