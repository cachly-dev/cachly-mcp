/**
 * Einblendung fuer VS Code mit Copilot, Codex CLI und Gemini CLI
 * (copilot-hook.ts, codex-hook.ts, gemini-hook.ts, installCopilotHooks,
 * installCodexHooks, installGeminiHooks).
 *
 * Grundlage ist der Rohtext der Doku (curl, 11.10.2026):
 *   VS Code Local   https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agents/reference/hooks-reference.md
 *                   https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agent-customization/hooks.md
 *   Copilot CLI     https://docs.github.com/en/copilot/reference/hooks-reference
 *   Codex CLI       https://developers.openai.com/codex/hooks.md
 *   Gemini CLI      https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md
 *                   https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/best-practices.md
 *   Claude Code     https://code.claude.com/docs/en/hooks.md (Gegenprobe: kein `timestamp`)
 *
 * Geprueft wird je Editor:
 *   1. Abbildung der Eingabe und Antwortformat (gueltiges JSON genau im dokumentierten Feld).
 *   2. Zusammenfuehren der Konfiguration: neu, fremde Eintraege, alter cachly-Eintrag, kaputte Datei.
 *   3. Installation.
 *   4. Das echte Buendel mit Beispiel-Eingaben aus der Doku, gestartet mit genau dem
 *      Befehl aus der geschriebenen Konfiguration; Frist bei haengendem Server.
 *   5. Ruecktritt der Claude-Hooks, die VS Code / Copilot CLI mitlaufen (nie doppelt).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  claudeNutzlast as copilotClaude,
  copilotAusgabe,
  copilotEreignis,
  copilotHookAntwort,
  copilotLaufzeit,
  istFremdeLaufzeit,
  COPILOT_HOOK_EVENTS,
} from '../copilot-hook.js';
import { claudeNutzlast as codexClaude, codexEreignis, codexHookAntwort, CODEX_HOOK_EVENTS, CODEX_KONTEXT_GRENZE_TOKEN } from '../codex-hook.js';
import { claudeNutzlast as geminiClaude, geminiAusgabe, geminiEreignis, geminiHookAntwort, GEMINI_HOOK_EVENTS } from '../gemini-hook.js';
import {
  buildCodexHooks,
  buildCopilotHook,
  buildCopilotHooks,
  buildCodexHook,
  buildGeminiHook,
  buildGeminiHooks,
  installAmbientHooks,
  installCodexHooks,
  installCopilotHooks,
  installGeminiHooks,
  mergeCodexHooks,
  mergeCopilotHooks,
  mergeGeminiHooks,
  CODEX_TIMEOUTS,
  COPILOT_SKRIPT,
  COPILOT_TIMEOUTS,
  GEMINI_TIMEOUTS_MS,
  HOOK_BUENDEL,
  PLUGIN_HOOK_DIR,
} from '../ambient-hooks.js';
import { copilotHatHook, hookUmfeld } from '../hook-zugang.js';
import { promptKontext, sitzungsKontext, type EinblendLektion } from '../einblendung.js';

const SDK = resolve(__dirname, '..', '..');
const BUENDEL = join(SDK, PLUGIN_HOOK_DIR, HOOK_BUENDEL);

/** Der Prompt aus dem VS-Code-Beispiel (hooks-reference.md, UserPromptSubmit "Input"), woertlich. */
const FRAGE = 'Add input validation to the sign-up form.';

/** Eine Lektion, die zu FRAGE passt (Tor: zwei verschiedene Frageworte). */
const LEKTION = {
  topic: 'web:signup-form-validation',
  what_worked: 'Sign-up form input validation runs on the server with zod; the client only mirrors the rules from one shared schema.',
  outcome: 'success',
  severity: 'major',
  recall_count: 3,
};

// ── Beispiel-Eingaben aus der Doku ───────────────────────────────────────────

/**
 * VS Code Local: "Common input" (timestamp, cwd, session_id, hook_event_name,
 * transcript_path) plus die Ereignisfelder, woertlich aus hooks-reference.md.
 */
function vscode(ereignis: string, extra: Record<string, unknown>, cwd = '/repo') {
  return {
    timestamp: '2026-10-11T09:00:00.000Z',
    cwd,
    session_id: 'vscode-sess-1',
    hook_event_name: ereignis,
    transcript_path: '/tmp/transcript.json',
    ...extra,
  };
}
const vsStart = (cwd?: string) => vscode('SessionStart', { source: 'new' }, cwd);
const vsPrompt = (cwd?: string) => vscode('UserPromptSubmit', { prompt: 'Add input validation to the sign-up form.' }, cwd);
const vsNachWerkzeug = (cwd?: string) => vscode('PostToolUse', {
  tool_name: '<local-tool-name>',
  tool_input: {},
  tool_use_id: 'tool-123',
  tool_response: '<tool-result>',
}, cwd);

/** Copilot CLI, "camelCase input" je Ereignis (GitHub-Referenz). */
const cliStart = (extra: Record<string, unknown> = {}) =>
  ({ sessionId: 'cli-sess-1', timestamp: 1704614400000, cwd: '/repo', source: 'new', ...extra });
const cliPrompt = (extra: Record<string, unknown> = {}) =>
  ({ sessionId: 'cli-sess-1', timestamp: 1704614400000, cwd: '/repo', prompt: FRAGE, ...extra });
const cliNachWerkzeug = (extra: Record<string, unknown> = {}) => ({
  sessionId: 'cli-sess-1',
  timestamp: 1704614400000,
  cwd: '/repo',
  toolName: 'bash',
  toolArgs: '{"command":"ls"}',
  toolResult: { resultType: 'success', textResultForLlm: 'ok' },
  ...extra,
});
/** Woertlich aus der Copilot-CLI-Anleitung ("Troubleshooting"), ohne sessionId. */
const CLI_ANLEITUNG = { timestamp: 1704614400000, cwd: '/tmp', toolName: 'bash', toolArgs: '{"command":"ls"}' };

/**
 * Codex: gemeinsame Felder woertlich aus dem SessionEnd-Beispiel der Doku,
 * dazu die Felder aus den Tabellen ("model", "turn_id", "permission_mode", "prompt", "source").
 */
function codex(ereignis: string, extra: Record<string, unknown>) {
  return {
    session_id: 'thr_123',
    transcript_path: '/workspace/.codex/rollout.jsonl',
    cwd: '/workspace',
    hook_event_name: ereignis,
    model: 'gpt-5-codex',
    permission_mode: 'default',
    ...extra,
  };
}
const codexStart = () => codex('SessionStart', { source: 'startup' });
const codexPrompt = () => codex('UserPromptSubmit', { turn_id: 'turn_1', prompt: FRAGE });

/**
 * Gemini: session_id, cwd, hook_event_name woertlich aus best-practices.md
 * ("Test hooks independently"), transcript_path und timestamp aus dem
 * "Base input schema", prompt und source aus BeforeAgent / SessionStart.
 */
function gemini(ereignis: string, extra: Record<string, unknown>) {
  return {
    session_id: 'test-123',
    cwd: '/tmp/test',
    hook_event_name: ereignis,
    transcript_path: '/tmp/test/transcript.json',
    timestamp: '2026-10-11T09:00:00.000Z',
    ...extra,
  };
}
const geminiStart = () => gemini('SessionStart', { source: 'startup' });
const geminiPrompt = () => gemini('BeforeAgent', { prompt: FRAGE });

/** Claude Code, Beispiel "UserPromptSubmit input" (Feldnamen woertlich, Prompt ersetzt) — ohne timestamp. */
const claudePrompt = (cwd: string) => ({
  session_id: 'abc123',
  transcript_path: '/Users/.../.claude/projects/.../00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl',
  cwd,
  permission_mode: 'default',
  hook_event_name: 'UserPromptSubmit',
  prompt: FRAGE,
});

const claudeAntwort = (ereignis: string, text: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: ereignis, additionalContext: text } });

// ── 1. Abbildung und Antwortformat ───────────────────────────────────────────

describe('VS Code / Copilot — Abbildung', () => {
  it('Ereignis aus hook_event_name (VS Code), sonst aus dem Argument (Copilot CLI)', () => {
    expect(copilotEreignis(vsPrompt(), [])).toBe('userPromptSubmitted');
    expect(copilotEreignis(vsStart(), [])).toBe('sessionStart');
    expect(copilotEreignis(vsNachWerkzeug(), [])).toBe('postToolUse');
    expect(copilotEreignis(cliPrompt(), ['userPromptSubmitted', '--copilot'])).toBe('userPromptSubmitted');
    expect(copilotEreignis(null, ['postToolUse'])).toBe('postToolUse');
    expect(copilotEreignis(vscode('Stop', {}), [])).toBeNull();
    expect(copilotEreignis({ hook_event_name: 'constructor' }, [])).toBeNull();
  });

  it('Laufzeit: VS Code hat hook_event_name, die camelCase-Eingabe von Copilot CLI nicht', () => {
    expect(copilotLaufzeit(vsPrompt())).toBe('vscode');
    expect(copilotLaufzeit(cliPrompt())).toBe('cli');
    expect(copilotLaufzeit(CLI_ANLEITUNG)).toBe('cli');
    expect(copilotLaufzeit(null)).toBe('cli');
  });

  it('Eingabe → Claude-Nutzlast: session_id oder sessionId, prompt, cwd', () => {
    expect(copilotClaude('userPromptSubmitted', vsPrompt())).toEqual({
      hook_event_name: 'UserPromptSubmit', prompt: FRAGE, session_id: 'vscode-sess-1', cwd: '/repo',
    });
    expect(copilotClaude('userPromptSubmitted', cliPrompt())).toEqual({
      hook_event_name: 'UserPromptSubmit', prompt: FRAGE, session_id: 'cli-sess-1', cwd: '/repo',
    });
    expect(copilotClaude('sessionStart', vsStart())).toEqual({
      hook_event_name: 'SessionStart', source: 'new', session_id: 'vscode-sess-1', cwd: '/repo',
    });
  });

  it('Antwort VS Code: hookSpecificOutput mit dem PascalCase-Namen, nie flach', () => {
    expect(JSON.parse(copilotAusgabe('sessionStart', 'vscode', 'L'))).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'L' },
    });
    expect(JSON.parse(copilotAusgabe('userPromptSubmitted', 'vscode', 'L'))).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'L' },
    });
    expect(JSON.parse(copilotAusgabe('postToolUse', 'vscode', 'L'))).toEqual({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'L' },
    });
  });

  it('Antwort Copilot CLI: flaches additionalContext; userPromptSubmitted nie (die CLI verwirft es)', () => {
    expect(JSON.parse(copilotAusgabe('sessionStart', 'cli', 'L'))).toEqual({ additionalContext: 'L' });
    expect(JSON.parse(copilotAusgabe('postToolUse', 'cli', 'L'))).toEqual({ additionalContext: 'L' });
    expect(JSON.parse(copilotAusgabe('userPromptSubmitted', 'cli', 'L'))).toEqual({});
    expect(copilotAusgabe('postToolUse', 'cli', 'L')).not.toContain('hookSpecificOutput');
  });

  it('nichts beizutragen: immer {} — eine JSON-Zeile', () => {
    for (const e of COPILOT_HOOK_EVENTS) {
      expect(copilotAusgabe(e, 'vscode', '')).toBe('{}');
      expect(copilotAusgabe(e, 'cli', '')).toBe('{}');
    }
    expect(copilotAusgabe('sessionStart', 'cli', 'zeile 1\nzeile 2')).not.toMatch(/\n/);
  });

  it('timestamp verraet VS Code und Copilot CLI; das Claude-Code-Beispiel hat es nicht', () => {
    expect(istFremdeLaufzeit(vsPrompt())).toBe(true);
    expect(istFremdeLaufzeit(cliPrompt())).toBe(true);
    expect(istFremdeLaufzeit(claudePrompt('/x'))).toBe(false);
    expect(istFremdeLaufzeit(null)).toBe(false);
  });
});

describe('Codex — Abbildung', () => {
  it('nur SessionStart und UserPromptSubmit', () => {
    expect(codexEreignis(codexPrompt(), [])).toBe('UserPromptSubmit');
    expect(codexEreignis(codexStart(), [])).toBe('SessionStart');
    expect(codexEreignis(codex('Stop', {}), [])).toBeNull();
    expect(codexEreignis(codex('PostToolUse', {}), [])).toBeNull();
    expect(codexEreignis(null, ['UserPromptSubmit', '--codex'])).toBe('UserPromptSubmit');
  });

  it('Eingabe → Claude-Nutzlast: nur die Felder, die der Lauf braucht', () => {
    expect(codexClaude('UserPromptSubmit', codexPrompt())).toEqual({
      hook_event_name: 'UserPromptSubmit', prompt: FRAGE, session_id: 'thr_123', cwd: '/workspace',
    });
  });

  it('Antwort: Claudes Form, neu gebaut — nie eine Block- oder Stop-Antwort an Codex', async () => {
    const out = await codexHookAntwort({ payload: codexPrompt(), args: [], claudeLauf: async (_r, e) => claudeAntwort(e, 'L') });
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'L' } });
    const block = await codexHookAntwort({
      payload: codexPrompt(), args: [], claudeLauf: async () => JSON.stringify({ decision: 'block', reason: 'x' }),
    });
    expect(block).toBe('');
    expect(await codexHookAntwort({ payload: codex('Stop', {}), args: [], claudeLauf: async () => 'X' })).toBe('');
  });

  it('Grenze: selbst bei einem Token je ZEICHEN bleibt die Einblendung unter 2500 Token', () => {
    // Schlimmster Fall: lange Themen (200 Zeichen; das laengste im echten Bestand hat 80),
    // lange Texte (werden auf 120 Zeichen gekuerzt), fuenf Lektionen im Briefing.
    const lang: EinblendLektion[] = Array.from({ length: 5 }, (_, i) => ({
      topic: `t${i}:${'x'.repeat(196)}`,
      what_worked: 'w'.repeat(2000),
      severity: 'critical',
      recall_count: 9,
    }) as EinblendLektion);
    const briefing = sitzungsKontext(lang);
    const prompt = promptKontext({ lessons: lang.slice(0, 3), tokens: 600, topScore: 1, belege: 3 });
    expect(briefing.length, `Briefing ${briefing.length} Zeichen`).toBeLessThan(CODEX_KONTEXT_GRENZE_TOKEN);
    expect(prompt.length, `Prompt ${prompt.length} Zeichen`).toBeLessThan(CODEX_KONTEXT_GRENZE_TOKEN);
  });
});

describe('Gemini — Abbildung', () => {
  it('BeforeAgent ist Claudes UserPromptSubmit', () => {
    expect(geminiEreignis(geminiPrompt(), [])).toBe('BeforeAgent');
    expect(geminiEreignis(geminiStart(), [])).toBe('SessionStart');
    expect(geminiEreignis(gemini('BeforeTool', {}), [])).toBeNull();
    expect(geminiEreignis(gemini('UserPromptSubmit', {}), [])).toBeNull();
    expect(geminiClaude('BeforeAgent', geminiPrompt())).toEqual({
      hook_event_name: 'UserPromptSubmit', prompt: FRAGE, session_id: 'test-123', cwd: '/tmp/test',
    });
  });

  it('Antwort: hookSpecificOutput.additionalContext; ohne Beitrag {} — nie leer (Gemini liest sonst stderr)', async () => {
    expect(JSON.parse(geminiAusgabe('BeforeAgent', 'L'))).toEqual({
      hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: 'L' },
    });
    expect(geminiAusgabe('SessionStart', '')).toBe('{}');
    const out = await geminiHookAntwort({ payload: geminiPrompt(), args: [], claudeLauf: async () => '' });
    expect(out).toBe('{}');
    const kaputt = await geminiHookAntwort({ payload: geminiPrompt(), args: [], claudeLauf: async () => { throw new Error('x'); } });
    expect(kaputt).toBe('{}');
  });
});

// ── 2. Ablauf VS Code / Copilot CLI ──────────────────────────────────────────

describe('VS Code / Copilot — Ablauf je Zug', () => {
  let ordner: string;
  beforeEach(() => { ordner = mkdtempSync(join(tmpdir(), 'cachly-copilot-ablage-')); });
  afterEach(() => { rmSync(ordner, { recursive: true, force: true }); });

  function lauf() {
    const aufrufe: string[] = [];
    const claudeLauf = async (raw: string, e: string) => {
      aufrufe.push(e);
      expect(JSON.parse(raw).hook_event_name).toBe(e);
      return claudeAntwort(e, 'LEKTION');
    };
    return { aufrufe, claudeLauf };
  }

  it('VS Code: Lektionen sofort bei UserPromptSubmit, postToolUse rechnet nicht und liefert nichts', async () => {
    const { aufrufe, claudeLauf } = lauf();
    const vor = await copilotHookAntwort({ payload: vsPrompt(), args: [], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(vor).hookSpecificOutput.additionalContext).toBe('LEKTION');
    const nach = await copilotHookAntwort({ payload: vsNachWerkzeug(), args: [], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(nach)).toEqual({});
    expect(aufrufe).toEqual(['UserPromptSubmit']);
    // Keine Ablage: der Rueckfall liefe sonst in jedem Zug doppelt.
    expect(readdirSync(ordner)).toEqual([]);
  });

  it('Copilot CLI: userPromptSubmitted legt ab, der erste postToolUse liefert genau einmal', async () => {
    const { aufrufe, claudeLauf } = lauf();
    const vor = await copilotHookAntwort({ payload: cliPrompt(), args: ['userPromptSubmitted'], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(vor)).toEqual({});
    const nach = await copilotHookAntwort({ payload: cliNachWerkzeug(), args: ['postToolUse'], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(nach)).toEqual({ additionalContext: 'LEKTION' });
    const wieder = await copilotHookAntwort({ payload: cliNachWerkzeug(), args: ['postToolUse'], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(wieder)).toEqual({});
    expect(aufrufe).toEqual(['UserPromptSubmit']);
  });

  it('Copilot CLI: eine andere Sitzung bekommt nichts', async () => {
    const { claudeLauf } = lauf();
    await copilotHookAntwort({ payload: cliPrompt(), args: ['userPromptSubmitted'], claudeLauf, ablageOrdner: ordner });
    const fremd = await copilotHookAntwort({ payload: cliNachWerkzeug({ sessionId: 'andere' }), args: ['postToolUse'], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(fremd)).toEqual({});
  });

  it('Copilot CLI: ein neuer Prompt loescht die alte Ablage zuerst — auch wenn er danach scheitert', async () => {
    const { claudeLauf } = lauf();
    await copilotHookAntwort({ payload: cliPrompt(), args: ['userPromptSubmitted'], claudeLauf, ablageOrdner: ordner });
    // Zug ohne Werkzeug; der naechste Prompt bricht beim Rechnen ab.
    const kaputt = async () => { throw new Error('Frist'); };
    expect(JSON.parse(await copilotHookAntwort({ payload: cliPrompt(), args: ['userPromptSubmitted'], claudeLauf: kaputt, ablageOrdner: ordner }))).toEqual({});
    const nach = await copilotHookAntwort({ payload: cliNachWerkzeug(), args: ['postToolUse'], claudeLauf, ablageOrdner: ordner });
    expect(JSON.parse(nach)).toEqual({});
  });

  it('Copilot CLI ohne sessionId (Beispiel der Anleitung): kein Lauf, {}', async () => {
    const { aufrufe, claudeLauf } = lauf();
    expect(JSON.parse(await copilotHookAntwort({ payload: CLI_ANLEITUNG, args: ['postToolUse'], claudeLauf, ablageOrdner: ordner }))).toEqual({});
    const ohne = { ...cliPrompt() } as Record<string, unknown>;
    delete ohne.sessionId;
    expect(JSON.parse(await copilotHookAntwort({ payload: ohne, args: ['userPromptSubmitted'], claudeLauf, ablageOrdner: ordner }))).toEqual({});
    expect(aufrufe).toEqual([]);
  });
});

// ── 3. Konfiguration zusammenfuehren ─────────────────────────────────────────

describe('mergeCopilotHooks (.github/hooks/cachly-ambient.json)', () => {
  it('neu: version 1, camelCase, type/command/cwd/timeoutSec', () => {
    const { datei, changed } = mergeCopilotHooks({});
    expect(changed).toBe(true);
    expect(datei.version).toBe(1);
    expect(Object.keys(datei.hooks!).sort()).toEqual([...COPILOT_HOOK_EVENTS].sort());
    for (const e of COPILOT_HOOK_EVENTS) {
      expect(datei.hooks![e]).toEqual([{
        type: 'command', command: `node .github/hooks/${COPILOT_SKRIPT} ${e}`, cwd: '.', timeoutSec: COPILOT_TIMEOUTS[e],
      }]);
    }
  });

  it('fremde Eintraege bleiben, ein alter cachly-Eintrag (auch unter bash/powershell) wird ersetzt', () => {
    const vorher = {
      version: 1,
      eigenes: true,
      hooks: {
        preToolUse: [{ type: 'command', bash: './scripts/audit.sh' }],
        sessionStart: [
          { type: 'command', bash: './scripts/start.sh', powershell: './scripts/start.ps1' },
          { type: 'command', powershell: 'node .github/hooks/cachly-ambient-copilot.mjs sessionStart' },
        ],
      },
    };
    const { datei } = mergeCopilotHooks(vorher);
    expect(datei.eigenes).toBe(true);
    expect(datei.hooks!.preToolUse).toEqual([{ type: 'command', bash: './scripts/audit.sh' }]);
    expect(datei.hooks!.sessionStart).toEqual([
      { type: 'command', bash: './scripts/start.sh', powershell: './scripts/start.ps1' },
      ...buildCopilotHooks().sessionStart,
    ]);
    expect(mergeCopilotHooks(datei).changed).toBe(false);
  });
});

describe('mergeCodexHooks (.codex/hooks.json)', () => {
  const skript = '/home/u/projekt/.codex/hooks/cachly-ambient-codex.mjs';

  it('neu: je Ereignis eine Gruppe mit absolutem Pfad in Anfuehrungszeichen, timeout in Sekunden', () => {
    const { datei } = mergeCodexHooks({}, skript);
    expect(datei.hooks).toEqual({
      SessionStart: [{ hooks: [{ type: 'command', command: `node "${skript}" SessionStart`, timeout: CODEX_TIMEOUTS.SessionStart }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${skript}" UserPromptSubmit`, timeout: CODEX_TIMEOUTS.UserPromptSubmit }] }],
    });
  });

  it('description und fremde Gruppen bleiben; in einer gemischten Gruppe faellt nur unser Eintrag', () => {
    const vorher = {
      description: 'Optional lifecycle hooks for this workspace.',
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 policy.py' }] }],
        UserPromptSubmit: [{
          hooks: [
            { type: 'command', command: 'python3 flywheel.py' },
            { type: 'command', command: 'node "/alt/.codex/hooks/cachly-ambient-codex.mjs" UserPromptSubmit' },
          ],
        }],
        SessionStart: [{ hooks: [{ type: 'command', command: 'node "/alt/.codex/hooks/cachly-ambient-codex.mjs" SessionStart' }] }],
      },
    };
    const { datei } = mergeCodexHooks(vorher, skript);
    expect(datei.description).toBe('Optional lifecycle hooks for this workspace.');
    expect(datei.hooks!.PreToolUse).toEqual(vorher.hooks.PreToolUse);
    expect(datei.hooks!.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'python3 flywheel.py' }] },
      ...buildCodexHooks(skript).UserPromptSubmit,
    ]);
    // Die alte, rein cachly-eigene Gruppe faellt ganz weg — nie doppelt.
    expect(datei.hooks!.SessionStart).toEqual(buildCodexHooks(skript).SessionStart);
    expect(mergeCodexHooks(datei, skript).changed).toBe(false);
  });
});

describe('mergeGeminiHooks (.gemini/settings.json)', () => {
  it('neu: Name, relativer Pfad wie in der Doku, timeout in MILLISEKUNDEN', () => {
    const { datei } = mergeGeminiHooks({});
    expect(datei.hooks!.BeforeAgent).toEqual([{
      hooks: [{ name: 'cachly-recall', type: 'command', command: 'node .gemini/hooks/cachly-ambient-gemini.mjs BeforeAgent', timeout: 10_000 }],
    }]);
    expect(datei.hooks!.SessionStart![0].hooks![0].timeout).toBe(GEMINI_TIMEOUTS_MS.SessionStart);
    expect(Object.keys(datei.hooks!).sort()).toEqual([...GEMINI_HOOK_EVENTS].sort());
  });

  it('alle anderen Einstellungen und fremde Hooks bleiben; alter cachly-Eintrag wird ersetzt', () => {
    const vorher = {
      general: { vimMode: true },
      mcpServers: { andere: { command: 'x' } },
      hooksConfig: { enabled: true },
      hooks: {
        BeforeTool: [{ matcher: 'write_file|replace', hooks: [{ name: 'security-check', type: 'command', command: '$GEMINI_PROJECT_DIR/.gemini/hooks/security.sh', timeout: 5000 }] }],
        BeforeAgent: [{ matcher: '*', hooks: [{ name: 'memory', type: 'command', command: 'node .gemini/hooks/inject-memories.js' }] }],
        SessionStart: [{ hooks: [{ name: 'alt', type: 'command', command: 'node .gemini/hooks/cachly-ambient-gemini.mjs SessionStart', timeout: 1 }] }],
      },
    };
    const { datei } = mergeGeminiHooks(vorher);
    expect(datei.general).toEqual({ vimMode: true });
    expect(datei.mcpServers).toEqual({ andere: { command: 'x' } });
    expect(datei.hooksConfig).toEqual({ enabled: true });
    expect(datei.hooks!.BeforeTool).toEqual(vorher.hooks.BeforeTool);
    expect(datei.hooks!.BeforeAgent).toEqual([vorher.hooks.BeforeAgent[0], ...buildGeminiHooks().BeforeAgent]);
    expect(datei.hooks!.SessionStart).toEqual(buildGeminiHooks().SessionStart);
    expect(mergeGeminiHooks(datei).changed).toBe(false);
  });
});

describe('die kleinen Skripte', () => {
  it('tragen die Instanz und das Kennzeichen, nie einen Schluessel, enden bei Fehler mit Exit 0', () => {
    for (const [bau, flag] of [[buildCopilotHook, '--copilot'], [buildCodexHook, '--codex'], [buildGeminiHook, '--gemini']] as const) {
      const s = bau({ instanceId: "in'st", apiKey: 'cky_geheim' });
      expect(s.startsWith('#!/usr/bin/env node')).toBe(true);
      expect(s).toContain("process.env.CACHLY_BRAIN_INSTANCE_ID = 'in\\'st';");
      expect(s).toContain(`process.argv.push('${flag}');`);
      expect(s).toContain(`await import('./${HOOK_BUENDEL}');`);
      expect(s).toContain('process.exit(0);');
      expect(s).not.toContain('cky_geheim');
      expect(s).not.toContain('npx');
    }
  });
});

// ── 4. Laufzeit: das echte Buendel ───────────────────────────────────────────

interface Anfrage { pfad: string; auth: string }
let server: Server;
let apiUrl: string;
let anfragen: Anfrage[] = [];

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
  tmp = mkdtempSync(join(tmpdir(), 'cachly-editor-hook-'));
  heim = join(tmp, 'heim');
  projekt = join(tmp, 'projekt');
  temp = join(tmp, 'temp');
  for (const d of [heim, projekt, temp]) mkdirSync(d, { recursive: true });
  instanz = `inst-editor-${Math.random().toString(36).slice(2, 10)}`;
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function umfeld(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  // Nur was das Betriebssystem zum Starten braucht — nie die echte Umgebung mit echtem Schluessel.
  for (const k of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'WINDIR']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return { ...env, TEMP: temp, TMP: temp, TMPDIR: temp, HOME: heim, USERPROFILE: heim, CACHLY_API_URL: apiUrl, ...extra };
}

/** Gemini setzt diese Variablen (docs/hooks/index.md, "Environment variables"). */
const geminiEnv = () => ({ GEMINI_PROJECT_DIR: projekt, GEMINI_CWD: projekt, GEMINI_SESSION_ID: 'test-123', CLAUDE_PROJECT_DIR: projekt });

interface Ergebnis { status: number | null; stdout: string; ms: number }

function warte(kind: ReturnType<typeof spawn>, payload: object): Promise<Ergebnis> {
  return new Promise((fertig) => {
    const start = Date.now();
    let stdout = '';
    kind.stdout!.on('data', (d) => { stdout += d; });
    kind.on('close', (status) => fertig({ status, stdout, ms: Date.now() - start }));
    kind.stdin!.end(JSON.stringify(payload));
  });
}

/** Ein Lauf des Buendels oder Skripts mit `node`. */
function lauf(skript: string, args: string[], payload: object, extra: Record<string, string> = {}): Promise<Ergebnis> {
  return warte(spawn(process.execPath, [skript, ...args], { env: umfeld(extra), cwd: projekt }), payload);
}

/**
 * Genau der Befehl aus der geschriebenen Konfiguration, durch die Shell — wie
 * die Editoren ihn starten (Codex: `cmd.exe /C` bzw. `$SHELL -lc`; VS Code und
 * Gemini: Shell der Plattform). Arbeitsordner: die Projektwurzel.
 */
function befehl(kommando: string, payload: object, extra: Record<string, string> = {}): Promise<Ergebnis> {
  return warte(spawn(kommando, { shell: true, env: umfeld(extra), cwd: projekt }), payload);
}

function schreibeJson(pfad: string, inhalt: unknown) {
  mkdirSync(resolve(pfad, '..'), { recursive: true });
  writeFileSync(pfad, JSON.stringify(inhalt, null, 2), 'utf8');
}

const schluessel = () => schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k' });

/** Haengender Server: nimmt an, antwortet nie. */
async function mitStummemServer(fn: (url: string) => Promise<void>) {
  const stumm = createServer(() => { /* nie antworten */ });
  await new Promise<void>((r) => stumm.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`http://127.0.0.1:${(stumm.address() as AddressInfo).port}`);
  } finally {
    stumm.closeAllConnections();
    await new Promise<void>((r) => stumm.close(() => r()));
  }
}

describe('VS Code / Copilot — das echte Buendel mit Doku-Eingaben', () => {
  it('ohne Schluessel: Exit 0, {} fuer jedes Ereignis, keine Anfrage', async () => {
    const eingaben = [vsStart(projekt), vsPrompt(projekt), vsNachWerkzeug(projekt), cliStart(), cliPrompt(), cliNachWerkzeug(), CLI_ANLEITUNG];
    const args: Record<number, string> = { 0: 'sessionStart', 1: 'userPromptSubmitted', 2: 'postToolUse', 3: 'sessionStart', 4: 'userPromptSubmitted', 5: 'postToolUse', 6: 'postToolUse' };
    for (const [i, e] of eingaben.entries()) {
      const r = await lauf(BUENDEL, [args[i], '--copilot'], e);
      expect(r.status, String(i)).toBe(0);
      expect(JSON.parse(r.stdout), String(i)).toEqual({});
    }
    expect(anfragen).toEqual([]);
  });

  it('VS Code Local, installiert: Briefing und Lektionen in hookSpecificOutput, postToolUse {}', async () => {
    schluessel();
    const a = await installCopilotHooks(projekt, instanz);
    const conf = JSON.parse(readFileSync(a.hooksPath, 'utf8'));
    const kommando = (e: string): string => conf.hooks[e][0].command;

    const start = await befehl(kommando('sessionStart'), vsStart(projekt));
    expect(start.status).toBe(0);
    const s = JSON.parse(start.stdout);
    expect(s.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(s.hookSpecificOutput.additionalContext).toContain('signup-form-validation');
    // Die Instanz kommt aus dem Skript (fuer dieses Projekt gewaehlt), der Schluessel aus ~/.cachly.
    const exportAnfrage = anfragen.find((x) => x.pfad.endsWith('/export'))!;
    expect(exportAnfrage.pfad).toBe(`/api/v1/instances/${instanz}/export`);
    expect(exportAnfrage.auth).toBe('Bearer cky_k');

    const prompt = await befehl(kommando('userPromptSubmitted'), vsPrompt(projekt));
    expect(prompt.status).toBe(0);
    const p = JSON.parse(prompt.stdout);
    expect(p.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(p.hookSpecificOutput.additionalContext).toContain('signup-form-validation');
    expect(p.additionalContext).toBeUndefined();

    const nach = await befehl(kommando('postToolUse'), vsNachWerkzeug(projekt));
    expect(nach.status).toBe(0);
    expect(JSON.parse(nach.stdout)).toEqual({});
    expect(nach.ms, `postToolUse: ${nach.ms} ms`).toBeLessThan(3000);
  });

  it('Copilot CLI, installiert: flaches Briefing; Lektionen beim ersten postToolUse, einmal', async () => {
    schluessel();
    const a = await installCopilotHooks(projekt, instanz);
    const conf = JSON.parse(readFileSync(a.hooksPath, 'utf8'));
    const kommando = (e: string): string => conf.hooks[e][0].command;

    const start = JSON.parse((await befehl(kommando('sessionStart'), cliStart())).stdout);
    expect(start.additionalContext).toContain('signup-form-validation');
    expect(start.hookSpecificOutput).toBeUndefined();

    expect(JSON.parse((await befehl(kommando('userPromptSubmitted'), cliPrompt())).stdout)).toEqual({});
    const nach = JSON.parse((await befehl(kommando('postToolUse'), cliNachWerkzeug())).stdout);
    expect(nach.additionalContext).toContain('signup-form-validation');
    expect(JSON.parse((await befehl(kommando('postToolUse'), cliNachWerkzeug())).stdout)).toEqual({});
  });

  it('haengt der Server, endet userPromptSubmitted an der Frist mit {}, Exit 0', async () => {
    await mitStummemServer(async (url) => {
      schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
      const r = await lauf(BUENDEL, ['userPromptSubmitted', '--copilot'], vsPrompt(projekt), {
        CACHLY_API_URL: url,
        CACHLY_HOOK_FRIST_MS: '1500',
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({});
      expect(r.ms, `${r.ms} ms`).toBeLessThan(4000);
    });
  });
});

describe('Codex — das echte Buendel mit Doku-Eingaben', () => {
  it('ohne Schluessel: Exit 0, keine Ausgabe ("Exit 0 with no output is treated as success"), keine Anfrage', async () => {
    for (const [e, p] of [['SessionStart', codexStart()], ['UserPromptSubmit', codexPrompt()]] as const) {
      const r = await lauf(BUENDEL, [e, '--codex'], p);
      expect(r.status, e).toBe(0);
      expect(r.stdout, e).toBe('');
    }
    expect(anfragen).toEqual([]);
  });

  it('installiert: der Befehl aus hooks.json laeuft durch die Shell, Briefing und Lektionen in Claudes Form', async () => {
    schluessel();
    const a = await installCodexHooks(projekt, instanz);
    const conf = JSON.parse(readFileSync(a.hooksPath, 'utf8'));
    const kommando = (e: string): string => conf.hooks[e][0].hooks[0].command;
    expect(kommando('UserPromptSubmit')).toBe(`node "${a.scriptPath}" UserPromptSubmit`);

    const start = await befehl(kommando('SessionStart'), codexStart());
    expect(start.status).toBe(0);
    expect(JSON.parse(start.stdout).hookSpecificOutput).toMatchObject({ hookEventName: 'SessionStart' });

    const prompt = await befehl(kommando('UserPromptSubmit'), codexPrompt());
    expect(prompt.status).toBe(0);
    const p = JSON.parse(prompt.stdout);
    expect(p.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(p.hookSpecificOutput.additionalContext).toContain('signup-form-validation');
    expect(anfragen.find((x) => x.pfad.endsWith('/export'))!.pfad).toBe(`/api/v1/instances/${instanz}/export`);
  });

  it('absoluter Pfad: laeuft auch aus einem Unterordner (Codex nimmt die Sitzungs-cwd)', async () => {
    schluessel();
    const a = await installCodexHooks(projekt, instanz);
    const conf = JSON.parse(readFileSync(a.hooksPath, 'utf8'));
    const unter = join(projekt, 'src', 'tief');
    mkdirSync(unter, { recursive: true });
    const r = await warte(spawn(conf.hooks.UserPromptSubmit[0].hooks[0].command, { shell: true, env: umfeld(), cwd: unter }), codexPrompt());
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('signup-form-validation');
  });

  it('haengt der Server, endet UserPromptSubmit an der Frist ohne Ausgabe, Exit 0', async () => {
    await mitStummemServer(async (url) => {
      schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
      const r = await lauf(BUENDEL, ['UserPromptSubmit', '--codex'], codexPrompt(), { CACHLY_API_URL: url, CACHLY_HOOK_FRIST_MS: '1500' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.ms, `${r.ms} ms`).toBeLessThan(4000);
    });
  });
});

describe('Gemini — das echte Buendel mit Doku-Eingaben', () => {
  it('ohne Schluessel: Exit 0 und {} — nie leeres stdout', async () => {
    for (const [e, p] of [['SessionStart', geminiStart()], ['BeforeAgent', geminiPrompt()]] as const) {
      const r = await lauf(BUENDEL, [e, '--gemini'], p, geminiEnv());
      expect(r.status, e).toBe(0);
      expect(r.stdout, e).toBe('{}');
    }
    expect(anfragen).toEqual([]);
  });

  it('installiert: Befehle aus settings.json im Projekt, Briefing und Lektionen in hookSpecificOutput', async () => {
    schluessel();
    const a = await installGeminiHooks(projekt, instanz);
    const conf = JSON.parse(readFileSync(a.hooksPath, 'utf8'));
    const kommando = (e: string): string => conf.hooks[e][0].hooks[0].command;

    const start = JSON.parse((await befehl(kommando('SessionStart'), geminiStart(), geminiEnv())).stdout);
    expect(start.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(start.hookSpecificOutput.additionalContext).toContain('signup-form-validation');

    const prompt = await befehl(kommando('BeforeAgent'), geminiPrompt(), geminiEnv());
    expect(prompt.status).toBe(0);
    const p = JSON.parse(prompt.stdout);
    expect(p.hookSpecificOutput.hookEventName).toBe('BeforeAgent');
    expect(p.hookSpecificOutput.additionalContext).toContain('signup-form-validation');
  });

  it('haengt der Server, endet BeforeAgent an der Frist mit {}, Exit 0', async () => {
    await mitStummemServer(async (url) => {
      schreibeJson(join(heim, '.cachly', 'credentials.json'), { apiKey: 'cky_k', instanceId: instanz });
      const r = await lauf(BUENDEL, ['BeforeAgent', '--gemini'], geminiPrompt(), { ...geminiEnv(), CACHLY_API_URL: url, CACHLY_HOOK_FRIST_MS: '1500' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('{}');
      expect(r.ms, `${r.ms} ms`).toBeLessThan(4000);
    });
  });
});

// ── 5. Claude-Hooks, die VS Code / Copilot CLI mitlaufen ─────────────────────

describe('Claude-Hooks in VS Code / Copilot CLI (.claude/settings.json)', () => {
  it('vor Werkzeugen und am Ende: nie — VS Code achtet nicht auf den Matcher', async () => {
    schluessel();
    const a = await installAmbientHooks(projekt, instanz);
    const vor = await lauf(a.preToolUsePath, [], vscode('PreToolUse', { tool_name: 'editFiles', tool_input: { file_path: join(projekt, 'a.ts') }, tool_use_id: 't' }, projekt));
    expect(vor.stdout).toBe('');
    const stopp = await lauf(a.stopPath, [], vscode('Stop', { stop_hook_active: false }, projekt));
    expect(stopp.stdout).toBe('');
    expect(anfragen).toEqual([]);
  });

  it('ohne eigenen VS-Code-Hook: Prompt wie bisher in Claudes Form (VS Code liest sie)', async () => {
    schluessel();
    const a = await installAmbientHooks(projekt, instanz);
    const r = await lauf(a.promptSubmitPath, [], vsPrompt(projekt));
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('signup-form-validation');
  });

  it('nie doppelt: mit .github/hooks/cachly-ambient.json treten Briefing und Prompt zurueck', async () => {
    schluessel();
    const a = await installAmbientHooks(projekt, instanz);
    await installCopilotHooks(projekt, instanz);
    expect((await lauf(a.promptSubmitPath, [], vsPrompt(projekt))).stdout).toBe('');
    expect((await lauf(a.sessionStartPath, [], vsStart(projekt))).stdout).toBe('');
    // Copilot CLI liest .claude/settings.json im VS-Code-kompatiblen Format (PascalCase, ISO-timestamp).
    const cliVsFormat = { hook_event_name: 'UserPromptSubmit', session_id: 's', timestamp: '2026-10-11T09:00:00.000Z', cwd: projekt, prompt: FRAGE };
    expect((await lauf(a.promptSubmitPath, [], cliVsFormat)).stdout).toBe('');
    expect(anfragen).toEqual([]);
  });

  it('Gegenprobe Claude Code: das Doku-Beispiel ohne timestamp laeuft wie bisher, auch mit VS-Code-Hook', async () => {
    schluessel();
    const a = await installAmbientHooks(projekt, instanz);
    await installCopilotHooks(projekt, instanz);
    const r = await lauf(a.promptSubmitPath, [], claudePrompt(projekt));
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('signup-form-validation');
  });

  it('copilotHatHook: Projekt, Nutzer (~/.copilot/hooks) und $COPILOT_HOME', () => {
    const u = (env: Record<string, string> = {}) => hookUmfeld({ HOME: heim, USERPROFILE: heim, CLAUDE_PROJECT_DIR: projekt, ...env });
    expect(copilotHatHook(u())).toBe(false);
    schreibeJson(join(projekt, '.github', 'hooks', 'fremd.json'), { version: 1, hooks: { sessionStart: [{ type: 'command', bash: './x.sh' }] } });
    expect(copilotHatHook(u())).toBe(false);
    schreibeJson(join(heim, '.copilot', 'hooks', 'c.json'), { version: 1, hooks: buildCopilotHooks() });
    expect(copilotHatHook(u())).toBe(true);
    const anders = join(tmp, 'copilot-home');
    expect(copilotHatHook(u({ COPILOT_HOME: anders }))).toBe(false);
    schreibeJson(join(anders, 'hooks', 'c.json'), { version: 1, hooks: buildCopilotHooks() });
    expect(copilotHatHook(u({ COPILOT_HOME: anders }))).toBe(true);
  });
});

// ── 3b. Installation ─────────────────────────────────────────────────────────

describe('Installation je Editor', () => {
  const installer = { copilot: installCopilotHooks, codex: installCodexHooks, gemini: installGeminiHooks } as const;
  const dateien = { copilot: '.github/hooks/cachly-ambient.json', codex: '.codex/hooks.json', gemini: '.gemini/settings.json' } as const;
  const eigeneEreignisse = { copilot: buildCopilotHooks(), codex: buildCodexHooks('/x.mjs'), gemini: buildGeminiHooks() } as const;

  for (const editor of ['copilot', 'codex', 'gemini'] as const) {
    it(`${editor}: schreibt, ist danach unveraendert, erneuert ein veraltetes Buendel`, async () => {
      const erst = await installer[editor](projekt, instanz);
      expect(erst.scripts).toBe('written');
      expect(erst.hooks).toBe('written');
      expect(erst.hooksPath).toBe(resolve(projekt, dateien[editor]));
      expect(readFileSync(erst.bundlePath, 'utf8')).toBe(readFileSync(BUENDEL, 'utf8'));
      const zweit = await installer[editor](projekt, instanz);
      expect(zweit.scripts).toBe('unchanged');
      expect(zweit.hooks).toBe('unchanged');
      writeFileSync(erst.bundlePath, '// alt\n');
      expect((await installer[editor](projekt, instanz)).scripts).toBe('upgraded');
    });

    it(`${editor}: eine kaputte Datei wird nicht ueberschrieben, und es landen keine Skripte ohne Verdrahtung`, async () => {
      const pfad = join(projekt, dateien[editor]);
      mkdirSync(resolve(pfad, '..'), { recursive: true });
      const kaputt = '{ "hooks": { ';
      writeFileSync(pfad, kaputt);
      const r = await installer[editor](projekt, instanz);
      expect(r.hooks).toBe('skipped');
      expect(r.grund).toBe('is not valid JSON');
      expect(readFileSync(pfad, 'utf8')).toBe(kaputt);
      expect(existsSync(r.scriptPath)).toBe(false);
      expect(existsSync(r.bundlePath)).toBe(false);
    });

    it(`${editor}: eine Datei mit Kommentaren bleibt stehen und sagt warum`, async () => {
      // Gemini liest settings.json mit strip-json-comments; JSON.parse kann das nicht.
      const pfad = join(projekt, dateien[editor]);
      mkdirSync(resolve(pfad, '..'), { recursive: true });
      const mitKommentar = '{\n  // eigene Einstellung\n  "general": { "vimMode": true }\n}\n';
      writeFileSync(pfad, mitKommentar);
      const r = await installer[editor](projekt, instanz);
      expect(r.hooks).toBe('skipped');
      expect(r.grund).toMatch(/comments/);
      expect(readFileSync(pfad, 'utf8')).toBe(mitKommentar);
      expect(existsSync(r.scriptPath)).toBe(false);
    });

    it(`${editor}: ein BOM am Anfang ist kein Fehler`, async () => {
      const pfad = join(projekt, dateien[editor]);
      mkdirSync(resolve(pfad, '..'), { recursive: true });
      writeFileSync(pfad, String.fromCharCode(0xfeff) + '{ "hooks": {} }\n');
      const r = await installer[editor](projekt, instanz);
      expect(r.hooks).toBe('merged');
      expect(existsSync(r.scriptPath)).toBe(true);
    });

    it(`${editor}: "hooks" ist kein Objekt — Datei bleibt stehen`, async () => {
      const pfad = join(projekt, dateien[editor]);
      schreibeJson(pfad, { hooks: ['falsch'] });
      const vorher = readFileSync(pfad, 'utf8');
      expect((await installer[editor](projekt, instanz)).hooks).toBe('skipped');
      expect(readFileSync(pfad, 'utf8')).toBe(vorher);
    });

    it(`${editor}: ein Ereignis, das keine Liste ist, geht nicht still verloren`, async () => {
      const pfad = join(projekt, dateien[editor]);
      const ereignis = Object.keys(eigeneEreignisse[editor])[0];
      schreibeJson(pfad, { hooks: { [ereignis]: { eigen: true } } });
      const vorher = readFileSync(pfad, 'utf8');
      const r = await installer[editor](projekt, instanz);
      expect(r.hooks).toBe('skipped');
      expect(r.grund).toContain(`hooks.${ereignis}`);
      expect(readFileSync(pfad, 'utf8')).toBe(vorher);
    });

    it(`${editor}: der Einzug des Nutzers bleibt`, async () => {
      const pfad = join(projekt, dateien[editor]);
      mkdirSync(resolve(pfad, '..'), { recursive: true });
      writeFileSync(pfad, JSON.stringify({ eigen: { a: 1 } }, null, 4) + '\n');
      const r = await installer[editor](projekt, instanz);
      expect(r.hooks).toBe('merged');
      expect(readFileSync(pfad, 'utf8')).toMatch(/^ {4}"eigen"/m);
      expect(readFileSync(pfad, 'utf8')).not.toMatch(/^ {2}"eigen"/m);
    });
  }

  it('gemini: vorhandene settings.json wird zusammengefuehrt, andere Einstellungen bleiben auf der Platte', async () => {
    schreibeJson(join(projekt, '.gemini', 'settings.json'), { general: { vimMode: true }, hooks: { BeforeTool: [{ matcher: 'x', hooks: [{ type: 'command', command: './a.sh' }] }] } });
    const r = await installGeminiHooks(projekt, instanz);
    expect(r.hooks).toBe('merged');
    const d = JSON.parse(readFileSync(r.hooksPath, 'utf8'));
    expect(d.general).toEqual({ vimMode: true });
    expect(d.hooks.BeforeTool).toHaveLength(1);
    expect(d.hooks.BeforeAgent).toHaveLength(1);
  });

  it('codex: Skript und Buendel liegen unter .codex/hooks/, kein Schluessel in einer Projektdatei', async () => {
    schluessel();
    const r = await installCodexHooks(projekt, instanz);
    expect(existsSync(join(projekt, '.codex', 'hooks', HOOK_BUENDEL))).toBe(true);
    for (const datei of [r.scriptPath, r.hooksPath]) expect(readFileSync(datei, 'utf8')).not.toContain('cky_k');
  });
});

describe('Doku /docs/claude-code-hooks', () => {
  const seite = () => readFileSync(join(SDK, '..', '..', 'web', 'app', 'docs', 'claude-code-hooks', 'page.tsx'), 'utf8');

  it('VS Code: das Beispiel ist byte-gleich mit der Datei, die setup schreibt', () => {
    const beispiel = /const COPILOT_HOOKS_EXAMPLE = `([\s\S]*?)`;/.exec(seite());
    expect(beispiel, 'COPILOT_HOOKS_EXAMPLE fehlt auf der Doku-Seite').not.toBeNull();
    expect(beispiel![1]).toBe(JSON.stringify(mergeCopilotHooks({}).datei, null, 2));
  });

  it('Codex: das Beispiel ist byte-gleich, mit Platzhalter statt Projektpfad', () => {
    const beispiel = /const CODEX_HOOKS_EXAMPLE = String\.raw`([\s\S]*?)`;/.exec(seite());
    expect(beispiel, 'CODEX_HOOKS_EXAMPLE fehlt auf der Doku-Seite').not.toBeNull();
    const pfad = '/path/to/project/.codex/hooks/cachly-ambient-codex.mjs';
    expect(beispiel![1]).toBe(JSON.stringify(mergeCodexHooks({}, pfad).datei, null, 2));
  });

  it('Gemini: das Beispiel ist byte-gleich mit dem hooks-Teil, den setup schreibt', () => {
    const beispiel = /const GEMINI_HOOKS_EXAMPLE = `([\s\S]*?)`;/.exec(seite());
    expect(beispiel, 'GEMINI_HOOKS_EXAMPLE fehlt auf der Doku-Seite').not.toBeNull();
    expect(beispiel![1]).toBe(JSON.stringify(mergeGeminiHooks({}).datei, null, 2));
  });
});

describe('Ereignislisten', () => {
  it('jedes Ereignis hat ein Zeitlimit', () => {
    for (const e of COPILOT_HOOK_EVENTS) expect(COPILOT_TIMEOUTS[e]).toBeGreaterThan(0);
    for (const e of CODEX_HOOK_EVENTS) expect(CODEX_TIMEOUTS[e]).toBeGreaterThan(0);
    for (const e of GEMINI_HOOK_EVENTS) expect(GEMINI_TIMEOUTS_MS[e]).toBeGreaterThanOrEqual(1000);
  });
});
