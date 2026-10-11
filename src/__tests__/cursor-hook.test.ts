/**
 * Cursor-Hook: dieselbe Einblendung in Cursor (cursor-hook.ts, installCursorHooks).
 *
 * Grundlage ist der Rohtext der Cursor-Doku (curl, 11.10.2026):
 *   https://cursor.com/docs/hooks.md                          Ereignisse, Felder, Antworten
 *   https://cursor.com/docs/reference/third-party-hooks.md    Claude-Hooks in Cursor
 *
 * Geprueft wird:
 *   1. Abbildung: Cursors Eingabe → Claude-Nutzlast, Claude-Antwort → Cursors Format.
 *   2. Ablage zwischen beforeSubmitPrompt und postToolUse: genau einmal je Generation.
 *   3. hooks.json zusammenfuehren: neu, fremde Hooks, alter cachly-Eintrag.
 *   4. Das echte Buendel mit Cursor-Beispiel-Eingaben: gueltiges JSON, still ohne
 *      Schluessel, Einblendung mit Schluessel, Ruecktritt der mitgelaufenen Claude-Hooks.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  abholen,
  ablagePfad,
  ablegen,
  claudeNutzlast,
  cursorAusgabe,
  cursorEreignis,
  cursorHookAntwort,
  istCursorNutzlast,
  kontextAus,
  CURSOR_HOOK_EVENTS,
} from '../cursor-hook.js';
import {
  buildCursorHook,
  buildCursorHooks,
  installAmbientHooks,
  installCursorHooks,
  mergeCursorHooks,
  CURSOR_SKRIPT,
  CURSOR_TIMEOUTS,
  HOOK_BUENDEL,
  PLUGIN_HOOK_DIR,
} from '../ambient-hooks.js';
import { hookAntwort } from '../ambient-hook.js';
import { hookUmfeld } from '../hook-zugang.js';

const SDK = resolve(__dirname, '..', '..');
const BUENDEL = join(SDK, PLUGIN_HOOK_DIR, HOOK_BUENDEL);

const FRAGE = 'Warum meldet der Deploy auf node-1 connection refused, obwohl fail2ban laeuft?';

/** Die gemeinsamen Felder jeder Cursor-Nutzlast (Doku, "Common schema"). */
function cursorBasis(ereignis: string, extra: Record<string, unknown> = {}) {
  return {
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    model: 'claude-sonnet',
    hook_event_name: ereignis,
    cursor_version: '1.7.2',
    workspace_roots: ['/repo'],
    user_email: null,
    transcript_path: null,
    ...extra,
  };
}
const vorPrompt = (extra: Record<string, unknown> = {}) =>
  cursorBasis('beforeSubmitPrompt', { prompt: FRAGE, attachments: [], ...extra });
const nachWerkzeug = (extra: Record<string, unknown> = {}) =>
  cursorBasis('postToolUse', {
    tool_name: 'Shell',
    tool_input: { command: 'npm test' },
    tool_output: '{"exitCode":0}',
    tool_use_id: 't1',
    cwd: '/repo',
    duration: 12,
    ...extra,
  });
const sitzung = (extra: Record<string, unknown> = {}) =>
  cursorBasis('sessionStart', { session_id: 'conv-1', is_background_agent: false, composer_mode: 'agent', ...extra });

// ── 1. Abbildung ─────────────────────────────────────────────────────────────

describe('Abbildung Cursor ↔ Claude', () => {
  it('erkennt Cursor an cursor_version — Claude-Nutzlasten haben das Feld nie', () => {
    expect(istCursorNutzlast(vorPrompt())).toBe(true);
    expect(istCursorNutzlast({ hook_event_name: 'UserPromptSubmit', prompt: FRAGE, session_id: 's' })).toBe(false);
    expect(istCursorNutzlast({ cursor_version: '' })).toBe(false);
    expect(istCursorNutzlast(null)).toBe(false);
  });

  it('Ereignis: Cursors Name, der Claude-Name aus dem Third-Party-Mapping, sonst das Argument', () => {
    expect(cursorEreignis(vorPrompt(), [])).toBe('beforeSubmitPrompt');
    expect(cursorEreignis({ hook_event_name: 'UserPromptSubmit' }, [])).toBe('beforeSubmitPrompt');
    expect(cursorEreignis({ hook_event_name: 'SessionStart' }, [])).toBe('sessionStart');
    expect(cursorEreignis({}, ['postToolUse', '--cursor'])).toBe('postToolUse');
    expect(cursorEreignis(null, ['sessionStart'])).toBe('sessionStart');
    // Ereignisse ohne Kontext-Weg bedienen wir nicht.
    expect(cursorEreignis({ hook_event_name: 'preToolUse' }, [])).toBeNull();
    expect(cursorEreignis({ hook_event_name: 'stop' }, [])).toBeNull();
    expect(cursorEreignis({ hook_event_name: 'constructor' }, [])).toBeNull();
  });

  it('beforeSubmitPrompt → UserPromptSubmit mit prompt, Gespraech als Sitzung, erste Wurzel als cwd', () => {
    expect(claudeNutzlast('beforeSubmitPrompt', vorPrompt())).toEqual({
      hook_event_name: 'UserPromptSubmit',
      prompt: FRAGE,
      session_id: 'conv-1',
      cwd: '/repo',
    });
    expect(claudeNutzlast('sessionStart', sitzung())).toEqual({
      hook_event_name: 'SessionStart',
      source: 'startup',
      session_id: 'conv-1',
      cwd: '/repo',
    });
  });

  it('liest additionalContext aus der Claude-Antwort; alles andere ist leer', () => {
    expect(kontextAus(JSON.stringify({ hookSpecificOutput: { hookEventName: 'X', additionalContext: 'L1' } }))).toBe('L1');
    expect(kontextAus('')).toBe('');
    expect(kontextAus('kein json')).toBe('');
    expect(kontextAus('{"hookSpecificOutput":{"additionalContext":3}}')).toBe('');
    expect(kontextAus('{"decision":"block","reason":"r"}')).toBe('');
  });

  it('Antwortformat: beforeSubmitPrompt laesst immer durch, die anderen tragen additional_context oder {}', () => {
    expect(JSON.parse(cursorAusgabe('beforeSubmitPrompt', 'egal'))).toEqual({ continue: true });
    expect(JSON.parse(cursorAusgabe('beforeSubmitPrompt', ''))).toEqual({ continue: true });
    expect(JSON.parse(cursorAusgabe('sessionStart', 'L1'))).toEqual({ additional_context: 'L1' });
    expect(JSON.parse(cursorAusgabe('postToolUse', 'L1'))).toEqual({ additional_context: 'L1' });
    expect(JSON.parse(cursorAusgabe('sessionStart', ''))).toEqual({});
    expect(JSON.parse(cursorAusgabe('postToolUse', ''))).toEqual({});
    // Nie Claudes verschachtelte Form an Cursor.
    expect(cursorAusgabe('postToolUse', 'L1')).not.toContain('hookSpecificOutput');
  });
});

// ── 2. Ablage ────────────────────────────────────────────────────────────────

describe('Ablage zwischen beforeSubmitPrompt und postToolUse', () => {
  let ordner: string;
  beforeEach(() => { ordner = mkdtempSync(join(tmpdir(), 'cachly-cursor-ablage-')); });
  afterEach(() => { rmSync(ordner, { recursive: true, force: true }); });

  it('dieselbe Generation holt genau einmal ab', () => {
    const p = ablagePfad('conv-1', ordner);
    ablegen(p, 'gen-1', 'LEKTION');
    expect(abholen(p, 'gen-1')).toBe('LEKTION');
    expect(abholen(p, 'gen-1')).toBe('');
    expect(existsSync(p)).toBe(false);
  });

  it('eine andere Generation bekommt nichts, und die Ablage bleibt fuer die richtige liegen', () => {
    const p = ablagePfad('conv-1', ordner);
    ablegen(p, 'gen-2', 'NEU');
    expect(abholen(p, 'gen-1')).toBe('');
    expect(abholen(p, 'gen-2')).toBe('NEU');
  });

  it('leerer Text loescht eine alte Ablage — sonst kaeme die Einblendung des letzten Prompts', () => {
    const p = ablagePfad('conv-1', ordner);
    ablegen(p, 'gen-1', 'ALT');
    ablegen(p, 'gen-2', '');
    expect(existsSync(p)).toBe(false);
  });

  it('ohne generation_id auf beiden Seiten: einmal', () => {
    const p = ablagePfad('conv-1', ordner);
    ablegen(p, undefined, 'L');
    expect(abholen(p, undefined)).toBe('L');
    expect(abholen(p, undefined)).toBe('');
  });

  it('der Dateiname ist ein Hash — eine Kennung mit ../ verlaesst den Ordner nicht', () => {
    const p = ablagePfad('../../etc/passwd', ordner);
    expect(resolve(p).startsWith(resolve(ordner))).toBe(true);
    expect(p).toMatch(/[0-9a-f]{32}\.json$/);
  });

  it('cursorHookAntwort: beforeSubmitPrompt legt ab, postToolUse derselben Generation liefert', async () => {
    const laeufe: Array<{ raw: string; ereignis: string }> = [];
    const claudeLauf = async (raw: string, ereignis: string) => {
      laeufe.push({ raw, ereignis });
      return JSON.stringify({ hookSpecificOutput: { hookEventName: ereignis, additionalContext: 'LEKTION' } });
    };
    const vor = await cursorHookAntwort({ payload: vorPrompt(), args: [], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(vor)).toEqual({ continue: true });
    expect(laeufe).toHaveLength(1);
    expect(laeufe[0].ereignis).toBe('UserPromptSubmit');
    expect(JSON.parse(laeufe[0].raw).prompt).toBe(FRAGE);

    const nach = await cursorHookAntwort({ payload: nachWerkzeug(), args: [], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(nach)).toEqual({ additional_context: 'LEKTION' });
    // postToolUse rechnet nie selbst — es liest nur die Ablage.
    expect(laeufe).toHaveLength(1);
    expect(JSON.parse(await cursorHookAntwort({ payload: nachWerkzeug(), args: [], claudeLauf, ablageOrdner: ordner }))).toEqual({});
  });

  it('cursorHookAntwort: wirft der Lauf, laesst beforeSubmitPrompt trotzdem durch', async () => {
    const claudeLauf = async () => { throw new Error('kaputt'); };
    expect(JSON.parse(await cursorHookAntwort({ payload: vorPrompt(), args: [], claudeLauf, ablageOrdner: ordner }))).toEqual({ continue: true });
    expect(JSON.parse(await cursorHookAntwort({ payload: sitzung(), args: [], claudeLauf, ablageOrdner: ordner }))).toEqual({});
  });

  it('cursorHookAntwort: ohne conversation_id wird gar nicht erst gerechnet', async () => {
    let gerufen = 0;
    const claudeLauf = async () => { gerufen++; return ''; };
    const p = vorPrompt();
    delete (p as Record<string, unknown>).conversation_id;
    expect(JSON.parse(await cursorHookAntwort({ payload: p, args: [], claudeLauf, ablageOrdner: ordner }))).toEqual({ continue: true });
    expect(gerufen).toBe(0);
  });
});

// ── 3. hooks.json ────────────────────────────────────────────────────────────

describe('mergeCursorHooks', () => {
  it('neu: version 1 und genau sessionStart, beforeSubmitPrompt, postToolUse', () => {
    const { datei, changed } = mergeCursorHooks({});
    expect(changed).toBe(true);
    expect(datei.version).toBe(1);
    expect(Object.keys(datei.hooks!).sort()).toEqual([...CURSOR_HOOK_EVENTS].sort());
    for (const e of CURSOR_HOOK_EVENTS) {
      expect(datei.hooks![e]).toEqual([{ command: `node .cursor/hooks/${CURSOR_SKRIPT} ${e}`, timeout: CURSOR_TIMEOUTS[e] }]);
    }
  });

  it('fremde Hooks, fremde Ereignisse und andere Felder bleiben stehen', () => {
    const vorher = {
      version: 1,
      eigenes: { x: 1 },
      hooks: {
        afterFileEdit: [{ command: '.cursor/hooks/format.sh' }],
        beforeSubmitPrompt: [{ command: '.cursor/hooks/audit.sh', timeout: 3 }],
      },
    };
    const { datei } = mergeCursorHooks(vorher);
    expect(datei.eigenes).toEqual({ x: 1 });
    expect(datei.hooks!.afterFileEdit).toEqual([{ command: '.cursor/hooks/format.sh' }]);
    expect(datei.hooks!.beforeSubmitPrompt).toEqual([
      { command: '.cursor/hooks/audit.sh', timeout: 3 },
      ...buildCursorHooks().beforeSubmitPrompt,
    ]);
  });

  it('das Beispiel auf /docs/claude-code-hooks ist byte-gleich mit der Datei, die setup schreibt', () => {
    const seite = readFileSync(join(SDK, '..', '..', 'web', 'app', 'docs', 'claude-code-hooks', 'page.tsx'), 'utf8');
    const beispiel = /const CURSOR_HOOKS_EXAMPLE = `([\s\S]*?)`;/.exec(seite);
    expect(beispiel, 'CURSOR_HOOKS_EXAMPLE fehlt auf der Doku-Seite').not.toBeNull();
    expect(beispiel![1]).toBe(JSON.stringify(mergeCursorHooks({}).datei, null, 2));
  });

  it('ein alter cachly-Eintrag wird ersetzt, nicht verdoppelt; danach unveraendert', () => {
    const vorher = {
      version: 1,
      hooks: { sessionStart: [{ command: 'node /alt/.cursor/hooks/cachly-ambient-cursor.mjs', timeout: 99 }] },
    };
    const erst = mergeCursorHooks(vorher);
    expect(erst.datei.hooks!.sessionStart).toEqual(buildCursorHooks().sessionStart);
    const zweit = mergeCursorHooks(erst.datei);
    expect(zweit.changed).toBe(false);
    expect(zweit.datei).toEqual(erst.datei);
  });
});

describe('buildCursorHook', () => {
  it('traegt die Instanz, ruft das Buendel daneben mit --cursor, endet bei Fehler mit Exit 0', () => {
    const s = buildCursorHook({ instanceId: "in'st" });
    expect(s.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(s).toContain("process.env.CACHLY_BRAIN_INSTANCE_ID = 'in\\'st';");
    expect(s).toContain("process.argv.push('--cursor');");
    expect(s).toContain(`await import('./${HOOK_BUENDEL}');`);
    expect(s).toContain('process.exit(0);');
    expect(s).not.toContain('npx');
  });

  it('kein Schluessel im Skript, auch wenn einer uebergeben wird (GROW-015)', () => {
    expect(buildCursorHook({ instanceId: 'i', apiKey: 'cky_geheim' })).not.toContain('cky_geheim');
  });
});

// ── 4. Laufzeit: das echte Buendel ───────────────────────────────────────────

interface Anfrage { pfad: string; auth: string }
let server: Server;
let apiUrl: string;
let anfragen: Anfrage[] = [];

const LEKTION = {
  topic: 'betrieb:fail2ban-bannt-deploy-kanal',
  what_worked: 'fail2ban auf node-1 bannte 10.8.0.6 und der Deploy meldete connection refused. '
    + 'Abhilfe: ignoreip 10.8.0.0/24 in jail.local eintragen und fail2ban neu starten.',
  outcome: 'success',
  severity: 'critical',
  recall_count: 3,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      anfragen.push({ pfad: req.url ?? '', auth: String(req.headers.authorization ?? '') });
      if (req.url?.endsWith('/export')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lessons: [JSON.stringify(LEKTION)] }));
        return;
      }
      if (req.url?.endsWith('/ambient-events')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(503); // Leser aus: lokale Reihenfolge
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

let tmp: string;
let heim: string;
let projekt: string;
let temp: string;
let instanz: string;

beforeEach(() => {
  anfragen = [];
  tmp = mkdtempSync(join(tmpdir(), 'cachly-cursor-hook-'));
  heim = join(tmp, 'heim');
  projekt = join(tmp, 'projekt');
  temp = join(tmp, 'temp');
  for (const d of [heim, projekt, temp]) mkdirSync(d, { recursive: true });
  instanz = `inst-cursor-${Math.random().toString(36).slice(2, 10)}`;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function umfeld(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  // Nur was das Betriebssystem zum Starten braucht — nie die echte Umgebung mit echtem Schluessel.
  for (const k of ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  // Eigener Temp-Ordner je Test: dort liegen Bestand und Cursor-Ablage.
  return {
    ...env,
    TEMP: temp, TMP: temp, TMPDIR: temp,
    HOME: heim, USERPROFILE: heim,
    // Cursor setzt beide (Doku, "Environment Variables").
    CURSOR_PROJECT_DIR: projekt, CLAUDE_PROJECT_DIR: projekt, CURSOR_VERSION: '1.7.2',
    CACHLY_API_URL: apiUrl,
    ...extra,
  };
}

function lauf(skript: string, args: string[], payload: object, extra: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; ms: number }>((fertig) => {
    const start = Date.now();
    const kind = spawn(process.execPath, [skript, ...args], { env: umfeld(extra), cwd: projekt });
    let stdout = '';
    kind.stdout.on('data', (d) => { stdout += d; });
    kind.on('close', (status) => fertig({ status, stdout, ms: Date.now() - start }));
    kind.stdin.end(JSON.stringify(payload));
  });
}

function schreibeJson(pfad: string, inhalt: unknown) {
  mkdirSync(resolve(pfad, '..'), { recursive: true });
  writeFileSync(pfad, JSON.stringify(inhalt, null, 2), 'utf8');
}

describe('Cursor-Lauf — das echte Buendel mit Cursor-Beispiel-Eingaben', () => {
  it('ohne Schluessel: Exit 0, gueltiges JSON nach Cursors Schema, keine Anfrage, schnell', async () => {
    const erwartet: Record<string, unknown> = { sessionStart: {}, beforeSubmitPrompt: { continue: true }, postToolUse: {} };
    const nutzlast: Record<string, object> = { sessionStart: sitzung(), beforeSubmitPrompt: vorPrompt(), postToolUse: nachWerkzeug() };
    for (const e of CURSOR_HOOK_EVENTS) {
      const r = await lauf(BUENDEL, [e, '--cursor'], nutzlast[e]);
      expect(r.status, e).toBe(0);
      expect(JSON.parse(r.stdout), e).toEqual(erwartet[e]);
      expect(r.ms, `${e}: ${r.ms} ms`).toBeLessThan(5000);
    }
    expect(anfragen).toEqual([]);
  });

  it('installiert: sessionStart briefed, beforeSubmitPrompt laesst durch, der erste postToolUse blendet ein', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k' });
    const a = await installCursorHooks(projekt, instanz);
    expect(readFileSync(a.bundlePath, 'utf8')).toBe(readFileSync(BUENDEL, 'utf8'));

    // Der Befehl aus hooks.json: relativ zur Projektwurzel, wie Cursor ihn dort ausfuehrt.
    const hooks = JSON.parse(readFileSync(a.hooksPath, 'utf8'));
    const befehl = (e: string): string[] => String(hooks.hooks[e][0].command).split(' ');
    for (const e of CURSOR_HOOK_EVENTS) {
      const [prog, skript, ...rest] = befehl(e);
      expect(prog).toBe('node');
      expect(existsSync(join(projekt, skript)), skript).toBe(true);
      expect(rest).toEqual([e]);
    }
    const skript = join(projekt, befehl('sessionStart')[1]);

    const start = await lauf(skript, ['sessionStart'], sitzung());
    expect(start.status).toBe(0);
    expect(JSON.parse(start.stdout).additional_context).toContain('fail2ban');
    // Die Instanz kommt aus dem Skript (fuer dieses Projekt gewaehlt).
    expect(anfragen.find((x) => x.pfad.endsWith('/export'))!.pfad).toBe(`/api/v1/instances/${instanz}/export`);
    expect(anfragen.find((x) => x.pfad.endsWith('/export'))!.auth).toBe('Bearer cky_k');

    const vor = await lauf(skript, ['beforeSubmitPrompt'], vorPrompt());
    expect(vor.status).toBe(0);
    expect(JSON.parse(vor.stdout)).toEqual({ continue: true });

    // Eine andere Generation (ein spaeter Werkzeugaufruf des alten Zugs) bekommt nichts.
    expect(JSON.parse((await lauf(skript, ['postToolUse'], nachWerkzeug({ generation_id: 'gen-0' }))).stdout)).toEqual({});

    const nach = await lauf(skript, ['postToolUse'], nachWerkzeug());
    expect(nach.status).toBe(0);
    const ctx: string = JSON.parse(nach.stdout).additional_context;
    expect(ctx).toContain('fail2ban');

    // Genau einmal je Generation.
    const wieder = await lauf(skript, ['postToolUse'], nachWerkzeug());
    expect(JSON.parse(wieder.stdout)).toEqual({});
    expect(wieder.ms, `postToolUse: ${wieder.ms} ms`).toBeLessThan(3000);
  });

  it('haengt der Server, endet beforeSubmitPrompt an der Frist mit {"continue":true}, Exit 0', async () => {
    const stumm = createServer(() => { /* nie antworten */ });
    await new Promise<void>((r) => stumm.listen(0, '127.0.0.1', () => r()));
    try {
      schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
      const r = await lauf(BUENDEL, ['beforeSubmitPrompt', '--cursor'], vorPrompt(), {
        CACHLY_API_URL: `http://127.0.0.1:${(stumm.address() as AddressInfo).port}`,
        CACHLY_HOOK_FRIST_MS: '1500',
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ continue: true });
      expect(r.ms, `${r.ms} ms`).toBeLessThan(4000);
    } finally {
      stumm.closeAllConnections();
      await new Promise<void>((r) => stumm.close(() => r()));
    }
  });
});

describe('Claude-Hooks, die Cursor aus .claude/settings.json mitlaeuft', () => {
  it('vor dem Prompt: kein Lauf, keine Anfrage — Cursor kann die Einblendung dort nicht annehmen', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k' });
    const a = await installAmbientHooks(projekt, instanz);
    for (const name of ['beforeSubmitPrompt', 'UserPromptSubmit']) {
      const r = await lauf(a.promptSubmitPath, [], vorPrompt({ hook_event_name: name }));
      expect(r.status, name).toBe(0);
      expect(r.stdout, name).toBe('');
    }
    // Auch vor Werkzeugen und am Ende: nichts (preToolUse ist in Cursor ein Erlaubnis-Hook).
    expect((await lauf(a.preToolUsePath, [], cursorBasis('preToolUse', { tool_name: 'Write', tool_input: { file_path: '/repo/a.ts' } }))).stdout).toBe('');
    expect((await lauf(a.stopPath, [], cursorBasis('stop', { status: 'completed', loop_count: 0 }))).stdout).toBe('');
    expect(anfragen).toEqual([]);
  });

  it('Briefing: ohne Cursor-Hook antwortet der Claude-Hook in Cursors Format', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k' });
    const a = await installAmbientHooks(projekt, instanz);
    const r = await lauf(a.sessionStartPath, [], sitzung());
    expect(JSON.parse(r.stdout).additional_context).toContain('fail2ban');
  });

  it('nie doppelt: hat das Projekt den Cursor-Hook, tritt der Claude-Hook auch beim Briefing zurueck', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k' });
    const a = await installAmbientHooks(projekt, instanz);
    await installCursorHooks(projekt, instanz);
    const r = await lauf(a.sessionStartPath, [], sitzung());
    expect(r.stdout).toBe('');
    expect(anfragen).toEqual([]);
  });

  it('Gegenprobe Claude Code: ohne cursor_version laeuft alles wie bisher', async () => {
    schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k' });
    const a = await installAmbientHooks(projekt, instanz);
    await installCursorHooks(projekt, instanz);
    const r = await lauf(a.promptSubmitPath, [], { hook_event_name: 'UserPromptSubmit', prompt: FRAGE, session_id: 's1', cwd: projekt });
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('fail2ban');
  });
});

describe('installCursorHooks', () => {
  it('schreibt, ist danach unveraendert und erneuert ein veraltetes Buendel', async () => {
    const erst = await installCursorHooks(projekt, instanz);
    expect(erst.scripts).toBe('written');
    expect(erst.hooks).toBe('written');
    const zweit = await installCursorHooks(projekt, instanz);
    expect(zweit.scripts).toBe('unchanged');
    expect(zweit.hooks).toBe('unchanged');
    writeFileSync(erst.bundlePath, '// alt\n');
    expect((await installCursorHooks(projekt, instanz)).scripts).toBe('upgraded');
  });

  it('fremde Eintraege in vorhandener hooks.json bleiben auf der Platte stehen', async () => {
    schreibeJson(join(projekt, '.cursor', 'hooks.json'), {
      version: 1,
      hooks: { afterFileEdit: [{ command: '.cursor/hooks/format.sh' }], beforeSubmitPrompt: [{ command: '.cursor/hooks/audit.sh' }] },
    });
    const r = await installCursorHooks(projekt, instanz);
    expect(r.hooks).toBe('merged');
    const d = JSON.parse(readFileSync(r.hooksPath, 'utf8'));
    expect(d.hooks.afterFileEdit).toEqual([{ command: '.cursor/hooks/format.sh' }]);
    expect(d.hooks.beforeSubmitPrompt[0]).toEqual({ command: '.cursor/hooks/audit.sh' });
    expect(d.hooks.beforeSubmitPrompt).toHaveLength(2);
  });

  it('eine kaputte hooks.json wird nicht ueberschrieben', async () => {
    const pfad = join(projekt, '.cursor', 'hooks.json');
    mkdirSync(join(projekt, '.cursor'), { recursive: true });
    writeFileSync(pfad, '{ "version": 1, "hooks": { ');
    const r = await installCursorHooks(projekt, instanz);
    expect(r.hooks).toBe('skipped');
    expect(readFileSync(pfad, 'utf8')).toBe('{ "version": 1, "hooks": { ');
  });
});

describe('hookAntwort ohne Prozess', () => {
  it('Cursor ohne Schluessel: beforeSubmitPrompt laesst durch, kein Abruf', async () => {
    let abrufe = 0;
    const out = await hookAntwort({
      args: ['beforeSubmitPrompt', '--cursor'],
      raw: JSON.stringify(vorPrompt()),
      umfeld: hookUmfeld({ HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: projekt }),
      apiUrl,
      fetchFn: (async () => { abrufe++; throw new Error('kein Netz'); }) as unknown as typeof fetch,
      cursorAblage: temp,
    });
    expect(JSON.parse(out)).toEqual({ continue: true });
    expect(abrufe).toBe(0);
  });
});
