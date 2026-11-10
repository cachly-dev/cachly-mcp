/**
 * Der Server-Starter des Claude-Code-Plugins (src/plugin-server-start.ts).
 *
 * Anlass 10.11.2026: `npx -y @cachly-dev/mcp-server` fragt npm bei jedem
 * Start; gemessen 4,4 s bis 34 s bis zur ersten Antwort, bei einer Grenze von
 * 30 s. Aus der Kopie: 0,7 s. Diese Tests halten fest:
 *   - geladen wird nur eine vollstaendige Kopie der Fassung aus stand.json,
 *   - der Nebenlauf fragt hoechstens einmal je Stunde und nur einer zur Zeit,
 *   - eine halbe Installation stellt den Zeiger nie um,
 *   - die bisherige Fassung bleibt liegen, aeltere werden geraeumt,
 *   - plugin.json startet den Starter mit node, nicht npx.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auffrischen, liesStand, PRUEF_ABSTAND_MS, pruefungDran, raeumeAuf, serverOrdner,
  SPERRE_VERFALL_MS, type Werkzeuge,
} from '../plugin-server-start.js';

const SDK = resolve(__dirname, '..', '..');
const STARTER = join(SDK, 'hooks', 'cachly-server-start.mjs');

let ordner: string;
beforeEach(() => { ordner = mkdtempSync(join(tmpdir(), 'cachly-starter-')); });
afterEach(() => { rmSync(ordner, { recursive: true, force: true }); });

/** Legt eine Fassung so an, wie npm install sie hinterlaesst. */
function legePaketAn(installOrdner: string, fassung: string, code = 'export {};\n'): string {
  const paket = join(installOrdner, 'node_modules', '@cachly-dev', 'mcp-server');
  mkdirSync(join(paket, 'dist', 'src'), { recursive: true });
  writeFileSync(join(paket, 'package.json'), JSON.stringify({
    name: '@cachly-dev/mcp-server', version: fassung, bin: { 'cachly-mcp': 'dist/src/index.js' },
  }));
  writeFileSync(join(paket, 'dist', 'src', 'index.js'), code);
  return join(paket, 'dist', 'src', 'index.js');
}

function setzeStand(fassung: string): void {
  writeFileSync(join(ordner, 'stand.json'), JSON.stringify({ fassung }));
}

function werkzeuge(neueste: string | null, protokoll: string[] = []): Werkzeuge {
  return {
    holeNeueste: async () => { protokoll.push('frage npm'); return neueste; },
    installiere: async (ziel, fassung) => {
      protokoll.push(`installiere ${fassung}`);
      // npm wuerde ohne package.json aufwaerts ein Projekt suchen und dort installieren.
      expect(existsSync(join(ziel, 'package.json')), 'package.json im Zielordner fehlt').toBe(true);
      legePaketAn(ziel, fassung);
    },
  };
}

describe('liesStand — geladen wird nur eine vollstaendige Kopie', () => {
  it('ohne stand.json: null (dann npx)', () => {
    expect(liesStand(ordner)).toBeNull();
  });

  it('stand.json nennt eine Fassung, deren Dateien fehlen: null', () => {
    setzeStand('0.10.238');
    expect(liesStand(ordner)).toBeNull();
  });

  it('Fassung im package.json passt nicht zu stand.json: null', () => {
    legePaketAn(join(ordner, 'fassungen', '0.10.238'), '0.10.237');
    setzeStand('0.10.238');
    expect(liesStand(ordner)).toBeNull();
  });

  it('keine Pfade aus stand.json: eine Nummer mit ../ wird verworfen', () => {
    writeFileSync(join(ordner, 'stand.json'), JSON.stringify({ fassung: '../../boese' }));
    expect(liesStand(ordner)).toBeNull();
  });

  it('vollstaendige Kopie: Startdatei aus dem bin-Eintrag', () => {
    const datei = legePaketAn(join(ordner, 'fassungen', '0.10.238'), '0.10.238');
    setzeStand('0.10.238');
    expect(liesStand(ordner)).toEqual({ fassung: '0.10.238', datei: resolve(datei) });
  });
});

describe('pruefungDran — hoechstens eine Frage an npm je Stunde', () => {
  it('ohne pruefung.json dran, danach eine Stunde nicht', () => {
    const jetzt = 1_800_000_000_000;
    expect(pruefungDran(ordner, jetzt)).toBe(true);
    writeFileSync(join(ordner, 'pruefung.json'), JSON.stringify({ at: jetzt }));
    expect(pruefungDran(ordner, jetzt + PRUEF_ABSTAND_MS - 1)).toBe(false);
    expect(pruefungDran(ordner, jetzt + PRUEF_ABSTAND_MS)).toBe(true);
  });

  it('ein Zeitpunkt in der Zukunft (verstellte Uhr) sperrt nicht fuer immer', () => {
    writeFileSync(join(ordner, 'pruefung.json'), JSON.stringify({ at: 9_999_999_999_999 }));
    expect(pruefungDran(ordner, 1_800_000_000_000)).toBe(true);
  });
});

describe('auffrischen — der Nebenlauf', () => {
  it('erster Lauf: holt die neueste Fassung und stellt den Zeiger um', async () => {
    const protokoll: string[] = [];
    expect(await auffrischen(ordner, werkzeuge('0.10.239', protokoll))).toBe('geholt (keine -> 0.10.239)');
    expect(protokoll).toEqual(['frage npm', 'installiere 0.10.239']);
    expect(liesStand(ordner)?.fassung).toBe('0.10.239');
    expect(existsSync(join(ordner, 'holt.sperre'))).toBe(false);
  });

  it('gleich nach einem Lauf: fragt npm nicht noch einmal', async () => {
    await auffrischen(ordner, werkzeuge('0.10.239'));
    const protokoll: string[] = [];
    expect(await auffrischen(ordner, werkzeuge('0.10.240', protokoll))).toBe('nicht dran');
    expect(protokoll).toEqual([]);
  });

  it('schon aktuell: installiert nichts', async () => {
    legePaketAn(join(ordner, 'fassungen', '0.10.239'), '0.10.239');
    setzeStand('0.10.239');
    const protokoll: string[] = [];
    expect(await auffrischen(ordner, werkzeuge('0.10.239', protokoll))).toBe('aktuell (0.10.239)');
    expect(protokoll).toEqual(['frage npm']);
  });

  it('npm antwortet nicht: Zeiger bleibt, der Versuch zaehlt trotzdem', async () => {
    legePaketAn(join(ordner, 'fassungen', '0.10.238'), '0.10.238');
    setzeStand('0.10.238');
    expect(await auffrischen(ordner, werkzeuge(null))).toBe('npm gab keine Fassung');
    expect(liesStand(ordner)?.fassung).toBe('0.10.238');
    expect(pruefungDran(ordner)).toBe(false);
  });

  it('halbe Installation: Zeiger bleibt auf der alten Fassung, kein Rest', async () => {
    legePaketAn(join(ordner, 'fassungen', '0.10.238'), '0.10.238');
    setzeStand('0.10.238');
    const w: Werkzeuge = {
      holeNeueste: async () => '0.10.239',
      installiere: async (ziel) => { mkdirSync(join(ziel, 'node_modules'), { recursive: true }); },
    };
    expect(await auffrischen(ordner, w)).toBe('Installation von 0.10.239 unvollstaendig');
    expect(liesStand(ordner)?.fassung).toBe('0.10.238');
    expect(readdirSync(join(ordner, 'fassungen'))).toEqual(['0.10.238']);
  });

  it('npm install bricht ab: Fehler wird gemeldet, Zeiger bleibt', async () => {
    legePaketAn(join(ordner, 'fassungen', '0.10.238'), '0.10.238');
    setzeStand('0.10.238');
    const w: Werkzeuge = {
      holeNeueste: async () => '0.10.239',
      installiere: async () => { throw new Error('npm install: Ende mit 1'); },
    };
    expect(await auffrischen(ordner, w)).toBe('Fehler: npm install: Ende mit 1');
    expect(liesStand(ordner)?.fassung).toBe('0.10.238');
    expect(existsSync(join(ordner, 'holt.sperre'))).toBe(false);
  });

  it('die bisherige Fassung bleibt liegen, aeltere werden geraeumt', async () => {
    legePaketAn(join(ordner, 'fassungen', '0.10.236'), '0.10.236');
    legePaketAn(join(ordner, 'fassungen', '0.10.238'), '0.10.238');
    setzeStand('0.10.238');
    await auffrischen(ordner, werkzeuge('0.10.239'));
    expect(readdirSync(join(ordner, 'fassungen')).sort()).toEqual(['0.10.238', '0.10.239']);
  });

  it('nur einer zur Zeit: eine frische Sperre haelt den zweiten Lauf ab', async () => {
    writeFileSync(join(ordner, 'holt.sperre'), '4711');
    const protokoll: string[] = [];
    expect(await auffrischen(ordner, werkzeuge('0.10.239', protokoll))).toBe('ein anderer Nebenlauf holt gerade');
    expect(protokoll).toEqual([]);
  });

  it('eine verwaiste Sperre (aelter als 10 min) wird uebernommen', async () => {
    const sperre = join(ordner, 'holt.sperre');
    writeFileSync(sperre, '4711');
    const alt = (Date.now() - SPERRE_VERFALL_MS - 60_000) / 1000;
    utimesSync(sperre, alt, alt);
    expect(await auffrischen(ordner, werkzeuge('0.10.239'))).toBe('geholt (keine -> 0.10.239)');
  });
});

describe('raeumeAuf', () => {
  it('ein frischer Zwischenordner gehoert einem laufenden Nebenlauf und bleibt', () => {
    const zwischen = join(ordner, 'fassungen', '.neu-0.10.239-4711');
    mkdirSync(zwischen, { recursive: true });
    raeumeAuf(ordner, ['0.10.238']);
    expect(existsSync(zwischen)).toBe(true);
    raeumeAuf(ordner, ['0.10.238'], Date.now() + SPERRE_VERFALL_MS + 1000);
    expect(existsSync(zwischen)).toBe(false);
  });
});

describe('serverOrdner', () => {
  it('liegt unter ~/.cachly/server, ausser CACHLY_SERVER_ORDNER sagt anderes', () => {
    expect(serverOrdner({ HOME: '/h' })).toBe(join('/h', '.cachly', 'server'));
    expect(serverOrdner({ HOME: '/h', CACHLY_SERVER_ORDNER: '/x' })).toBe('/x');
  });
});

describe('der Starter als Prozess', () => {
  const lauf = (env: Record<string, string>) => spawnSync(process.execPath, [STARTER], {
    env: { ...process.env, CACHLY_SERVER_ORDNER: ordner, ...env },
    input: '', encoding: 'utf8', timeout: 20_000,
  });

  it('laedt die Kopie in DIESEN Prozess — ohne npm, ohne Nebenlauf, wenn nicht dran', () => {
    legePaketAn(join(ordner, 'fassungen', '0.10.239'), '0.10.239',
      'process.stdout.write(JSON.stringify({ geladen: true, pid: process.pid, argv1: process.argv[1] }) + "\\n");\n');
    setzeStand('0.10.239');
    writeFileSync(join(ordner, 'pruefung.json'), JSON.stringify({ at: Date.now() }));
    const r = lauf({});
    expect(r.status, r.stderr).toBe(0);
    const aus = JSON.parse(r.stdout.trim());
    expect(aus.geladen).toBe(true);
    expect(resolve(aus.argv1)).toBe(resolve(STARTER));
    // Kein Nebenlauf: pruefung.json unveraendert, keine Sperre.
    expect(existsSync(join(ordner, 'holt.sperre'))).toBe(false);
  });
});

describe('plugin.json startet den Starter', () => {
  it('command node, Argument hooks/cachly-server-start.mjs an der Plugin-Wurzel — kein npx', () => {
    const manifest = JSON.parse(readFileSync(join(SDK, '.claude-plugin', 'plugin.json'), 'utf8'));
    const server = manifest.mcpServers.cachly;
    expect(server.command).toBe('node');
    expect(server.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/hooks/cachly-server-start.mjs']);
    expect(JSON.stringify(server)).not.toContain('npx');
    expect(existsSync(STARTER)).toBe(true);
    expect(server.env.CACHLY_QUELLE).toBe('claude-code-plugin');
  });
});
