// Abnahme GROW-015 (Fassung 2, 13.08.2026) — kein Geheimnis in Projektdateien,
// UND kein stiller Ausfall.
//
// Warum es diese zweite Fassung gibt: Fassung 1 verlangte nur, dass der
// Schluessel aus den erzeugten Hook-Skripten verschwindet. Beim Nachmessen vor
// dem Merge zeigte sich: Danach kaeme der Schluessel NIRGENDWO mehr her.
// Claude-Code-Hooks erben die Shell-Umgebung, nicht die Konfiguration des
// MCP-Servers — und das Setup exportiert den Schluessel nie in die Shell.
// Ambient-Recall haette bei jedem Bestandsnutzer aufgehoert zu arbeiten, ohne
// eine einzige Fehlermeldung. Eine Sicherheitskorrektur, die das Kernfeature
// still abschaltet, ist keine Korrektur.
//
// Diese Fassung friert deshalb BEIDES ein:
//   A. Kein Schluessel im erzeugten Skripttext (das urspruengliche Ziel).
//   B. Eine belegte Ersatzquelle: Umgebung -> Zugangsdaten-Datei im
//      Nutzer-Home -> Altbestand aus der Projektkonfiguration. Und wenn gar
//      nichts gefunden wird, sagt der Code das, statt stumm nichts zu tun.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AMBIENT_HOOK_VERSION,
  buildSessionStartHook,
  buildUserPromptSubmitHook,
  buildPreToolUseHook,
  buildStopHook,
  type AmbientHookOptions,
} from '../ambient-hooks.js';
import { resolveApiKey, saveApiKey, credentialsPath } from '../credentials.js';

const GEHEIM = 'cky_live_GEHEIM_niemals_im_skript_123';
const opts = { instanceId: 'inst-abnahme-015', apiKey: GEHEIM } as AmbientHookOptions;

const builders: Array<[string, (o: AmbientHookOptions) => string]> = [
  ['SessionStart', buildSessionStartHook],
  ['UserPromptSubmit', buildUserPromptSubmitHook],
  ['PreToolUse', buildPreToolUseHook],
  ['Stop', buildStopHook],
];

describe('GROW-015 A — die erzeugten Hook-Skripte tragen kein Geheimnis', () => {
  for (const [name, build] of builders) {
    it(`${name}: der uebergebene Schluessel steht NICHT im Skripttext`, () => {
      const script = build(opts);
      expect(script).not.toContain(GEHEIM);
      expect(script).not.toContain('cky_live_');
    });
  }

  it('die Instanz-Kennung darf weiter im Skript stehen (sie ist kein Geheimnis)', () => {
    expect(buildSessionStartHook(opts)).toContain('inst-abnahme-015');
  });

  it('die Hook-Fassung ist ueber v3 — alte Klartext-Skripte werden beim naechsten Setup ersetzt', () => {
    expect(AMBIENT_HOOK_VERSION).not.toBe('v3');
  });
});

describe('GROW-015 B — der Schluessel hat eine belegte Ersatzquelle', () => {
  let heim: string;
  let projekt: string;

  beforeEach(() => {
    heim = mkdtempSync(join(tmpdir(), 'cachly-heim-'));
    projekt = mkdtempSync(join(tmpdir(), 'cachly-projekt-'));
  });
  afterEach(() => {
    rmSync(heim, { recursive: true, force: true });
    rmSync(projekt, { recursive: true, force: true });
  });

  it('die Umgebung hat Vorrang vor allem anderen', () => {
    saveApiKey('aus-der-datei', { home: heim });
    expect(resolveApiKey({ home: heim, cwd: projekt, env: { CACHLY_JWT: 'aus-der-umgebung' } }))
      .toBe('aus-der-umgebung');
  });

  it('CACHLY_API_KEY wird ebenso akzeptiert wie CACHLY_JWT', () => {
    expect(resolveApiKey({ home: heim, cwd: projekt, env: { CACHLY_API_KEY: 'zweiter-name' } }))
      .toBe('zweiter-name');
  });

  it('ohne Umgebung kommt der Schluessel aus der Datei im Nutzer-Home', () => {
    saveApiKey('aus-der-datei', { home: heim });
    expect(resolveApiKey({ home: heim, cwd: projekt, env: {} })).toBe('aus-der-datei');
  });

  it('die Zugangsdaten-Datei liegt im Home, NICHT im Projekt', () => {
    saveApiKey('irgendwas', { home: heim });
    const pfad = credentialsPath({ home: heim });
    expect(pfad.startsWith(heim)).toBe(true);
    expect(pfad.startsWith(projekt)).toBe(false);
    expect(readFileSync(pfad, 'utf8')).toContain('irgendwas');
  });

  it('die Zugangsdaten-Datei ist fuer Fremde nicht lesbar (nur auf Unix pruefbar)', () => {
    saveApiKey('geheim', { home: heim });
    if (process.platform === 'win32') return;
    const modus = statSync(credentialsPath({ home: heim })).mode & 0o077;
    expect(modus).toBe(0);
  });

  it('BESTANDSSCHUTZ: ohne Umgebung und ohne Datei zaehlt der Altbestand aus der Projektkonfiguration', () => {
    writeFileSync(
      join(projekt, '.mcp.json'),
      JSON.stringify({ mcpServers: { cachly: { env: { CACHLY_JWT: 'altbestand' } } } }),
      'utf8',
    );
    expect(resolveApiKey({ home: heim, cwd: projekt, env: {} })).toBe('altbestand');
  });

  it('eine kaputte Zugangsdaten-Datei wirft nicht, sie gilt als leer', () => {
    mkdirSync(join(heim, '.cachly'), { recursive: true });
    writeFileSync(credentialsPath({ home: heim }), '{kaputt', 'utf8');
    expect(() => resolveApiKey({ home: heim, cwd: projekt, env: {} })).not.toThrow();
  });

  it('findet sich nirgends ein Schluessel, ist das Ergebnis leer — und NICHT etwa ein leerer String, der wie ein Schluessel aussieht', () => {
    const ergebnis = resolveApiKey({ home: heim, cwd: projekt, env: {} });
    expect(ergebnis === undefined || ergebnis === null).toBe(true);
  });
});
