// VS Code mit GitHub Copilot — dieselbe Einblendung, ueber den einen Hook-Lauf.
//
// ── Wer die Datei .github/hooks/cachly-ambient.json liest ──────────────────
//
// Rohtext der Doku, 11.10.2026:
//   https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agent-customization/hooks.md
//   https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agents/reference/hooks-reference.md
//   https://docs.github.com/en/copilot/reference/hooks-reference (als Markdown ueber /api/article/body)
//
// Zwei Laufzeiten lesen `.github/hooks/*.json`, mit verschiedener Eingabe:
//
//   • VS Code, Sitzungsziel "Local" (Preview). Die Datei darf im Copilot-Format
//     stehen ("Numeric `version` property and lower camel case events — Maps
//     Copilot event and command property names to the Local format. Runtime
//     payloads still use the Local schema."). Eingabe: snake_case mit
//     `hook_event_name` (PascalCase), `timestamp` (ISO), `session_id`.
//     Antwort mit Kontext: `hookSpecificOutput.additionalContext` bei
//     SessionStart und PostToolUse (Referenz). UserPromptSubmit nennt die
//     Referenz nur mit "common output" — der Quelltext liest dort aber
//     `hookSpecificOutput.additionalContext` und haengt ihn an die Anfrage
//     (microsoft/vscode extensions/copilot/src/extension/prompt/node/
//     defaultIntentRequestHandler.ts; eingefuehrt in vscode-copilot-chat
//     af9b589750 "Additional hook fixes", 11.02.2026).
//   • Copilot CLI — und VS Code mit Sitzungsziel "Copilot", das dieselbe
//     SDK-Umsetzung nutzt. Ihr Format verlangt `version: 1` und camelCase-
//     Ereignisse; dann kommt die Eingabe in camelCase (`sessionId`,
//     `timestamp` als Zahl) und OHNE `hook_event_name`. `sessionStart` und
//     `postToolUse` nehmen ein flaches `additionalContext` an; die Antwort auf
//     `userPromptSubmitted` wird bei Befehls-Hooks verworfen ("Command and HTTP
//     config-file userPromptSubmitted hooks have their output dropped").
//
// Darum steht die Datei im Copilot-Format (das einzige, das beide laut Doku
// lesen), und der Lauf unterscheidet an der Eingabe:
//
//   VS Code Local (`hook_event_name` da):
//     sessionStart        → Briefing in hookSpecificOutput
//     userPromptSubmitted → Lektionen in hookSpecificOutput, sofort
//     postToolUse         → {} (nichts — die Lektionen kamen schon)
//   Copilot CLI (kein `hook_event_name`):
//     sessionStart        → Briefing als flaches additionalContext
//     userPromptSubmitted → Lektionen rechnen, je Sitzung ablegen, {}
//     postToolUse         → erste Abholung im Zug liefert sie, einmal
//
// ── Warum in VS Code kein Rueckfall ueber postToolUse ────────────────────────
//
// Der Plan war: Lektionen bei UserPromptSubmit UND als Rueckfall beim ersten
// Werkzeugaufruf, falls sie dort nicht ankamen. Ob VS Code sie angenommen
// hat, sieht der Hook aber nicht — die Eingabe traegt weder eine Zug-Kennung
// noch eine Quittung. Ein Rueckfall liefe also in JEDEM Zug mit Werkzeug und
// braechte die Lektionen doppelt. Belegt ist: VS Code liest sie bei
// UserPromptSubmit (Quelltext, siehe oben). Der Rueckfall ueber postToolUse
// laeuft deshalb nur dort, wo die Doku das Verwerfen BELEGT: in Copilot CLI.
//
// ── Was ein "Zug" in Copilot CLI ist ────────────────────────────────────────
//
// Die camelCase-Eingabe hat keine Zug-Kennung (Cursor hat `generation_id`).
// Annahme: Ein Zug beginnt mit `userPromptSubmitted` ("The user submits a
// prompt") und endet mit dem naechsten. Darum loescht `userPromptSubmitted`
// zuerst die alte Ablage dieser Sitzung — auch wenn es danach an der Frist
// endet, kommt nie die Einblendung des vorigen Prompts an. Der erste
// `postToolUse` derselben Sitzung holt die neue genau einmal ab.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload } from './ambient-cli.js';
import { abholen, ablagePfad, ablegen, kontextAus } from './cursor-hook.js';

/** Argument, mit dem das kleine Skript in .github/hooks/ das Buendel ruft. */
export const COPILOT_FLAG = '--copilot';

export type CopilotEreignis = 'sessionStart' | 'userPromptSubmitted' | 'postToolUse';

/** Die Ereignisse, die setup/autopilot in .github/hooks/cachly-ambient.json verdrahtet (Copilot-Namen). */
export const COPILOT_HOOK_EVENTS: readonly CopilotEreignis[] = ['sessionStart', 'userPromptSubmitted', 'postToolUse'];

/** VS Code Local oder Copilot CLI (samt VS Code mit Sitzungsziel "Copilot"). */
export type CopilotLaufzeit = 'vscode' | 'cli';

/** Die Felder beider Eingaben, die wir brauchen. */
export interface CopilotNutzlast {
  /** VS Code Local: immer da (PascalCase). Copilot CLI camelCase: nie. */
  hook_event_name?: string;
  /** VS Code Local */
  session_id?: string;
  /** Copilot CLI */
  sessionId?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  timestamp?: string | number;
}

/** Copilot-Name (Argument, camelCase-Datei) oder VS-Code-Name (hook_event_name). */
const NAMEN: Record<string, CopilotEreignis> = {
  sessionStart: 'sessionStart',
  SessionStart: 'sessionStart',
  userPromptSubmitted: 'userPromptSubmitted',
  UserPromptSubmit: 'userPromptSubmitted',
  postToolUse: 'postToolUse',
  PostToolUse: 'postToolUse',
};

/** Das Ereignis dieses Laufs: aus der Eingabe, sonst aus den Argumenten. null = keines, das wir bedienen. */
export function copilotEreignis(p: CopilotNutzlast | null, args: string[]): CopilotEreignis | null {
  const name = p?.hook_event_name ?? args.find((a) => Object.hasOwn(NAMEN, a));
  return name && Object.hasOwn(NAMEN, name) ? NAMEN[name] : null;
}

/**
 * VS Code Local schickt jedem Hook `hook_event_name` (Referenz "Common input";
 * Quelltext chatHookService.ts baut es immer ein). Die camelCase-Eingabe von
 * Copilot CLI hat das Feld nicht (Referenz, "camelCase input").
 */
export function copilotLaufzeit(p: CopilotNutzlast | null): CopilotLaufzeit {
  return typeof p?.hook_event_name === 'string' && p.hook_event_name !== '' ? 'vscode' : 'cli';
}

/** Die Sitzung: `session_id` (VS Code) oder `sessionId` (Copilot CLI). */
function sitzungVon(p: CopilotNutzlast): string | undefined {
  const s = p.session_id ?? p.sessionId;
  return typeof s === 'string' && s !== '' ? s : undefined;
}

/** Bildet die Eingabe auf die Claude-Nutzlast ab, die der bestehende Hook-Lauf versteht. */
export function claudeNutzlast(e: 'sessionStart' | 'userPromptSubmitted', p: CopilotNutzlast): HookPayload {
  const session_id = sitzungVon(p);
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  return e === 'sessionStart'
    ? { hook_event_name: 'SessionStart', source: typeof p.source === 'string' ? p.source : 'startup', session_id, cwd }
    : { hook_event_name: 'UserPromptSubmit', prompt: typeof p.prompt === 'string' ? p.prompt : '', session_id, cwd };
}

/** Der Name, den VS Code in `hookSpecificOutput.hookEventName` erwartet. */
const VSCODE_NAME: Record<CopilotEreignis, string> = {
  sessionStart: 'SessionStart',
  userPromptSubmitted: 'UserPromptSubmit',
  postToolUse: 'PostToolUse',
};

/**
 * Die Antwort im Format der Laufzeit. Immer eine JSON-Zeile — Copilot CLI
 * verlangt eine Zeile ("Ensure the output is on a single line"), `{}` heisst
 * dort wie in VS Code "nichts". Copilot CLI verwirft die Antwort auf
 * userPromptSubmitted; dort kommt nie Kontext hin.
 */
export function copilotAusgabe(e: CopilotEreignis, laufzeit: CopilotLaufzeit, kontext: string): string {
  if (!kontext) return '{}';
  if (laufzeit === 'cli') {
    return e === 'userPromptSubmitted' ? '{}' : JSON.stringify({ additionalContext: kontext });
  }
  return JSON.stringify({ hookSpecificOutput: { hookEventName: VSCODE_NAME[e], additionalContext: kontext } });
}

// ── Claude-Hooks, die VS Code oder Copilot CLI mitlaufen ─────────────────────
//
// Beide lesen auch .claude/settings.json: VS Code Local mit dem Schalter
// `chat.useClaudeHooks` (Vorgabe aus; "Local parses nested commands but
// ignores matcher values, so every command for the event runs"), Copilot CLI
// immer ("Cross-tool .claude/settings.json and .claude/settings.local.json
// files in the repository are also read"). setup/autopilot schreibt diese
// Hooks immer. Erkennungszeichen: `timestamp` — VS Code Local ("Common
// input", ISO 8601) und Copilot CLI (beide Formate) schicken es jedem Hook,
// Claude Code nie (Rohtext https://code.claude.com/docs/en/hooks.md,
// "Common input fields": session_id, prompt_id, transcript_path, cwd,
// scratchpad_dir, permission_mode, effort, hook_event_name).

/** true, wenn ein Claude-Hook nicht in Claude Code laeuft, sondern in VS Code oder Copilot CLI. */
export function istFremdeLaufzeit(p: unknown): boolean {
  const t = (p as { timestamp?: unknown } | null)?.timestamp;
  return (typeof t === 'string' && t !== '') || typeof t === 'number';
}

// ── Ablage zwischen userPromptSubmitted und postToolUse (nur Copilot CLI) ────

export const COPILOT_ABLAGE_ORDNER = join(tmpdir(), 'cachly-copilot-einblendung');

// ── Der Lauf ────────────────────────────────────────────────────────────────

export interface CopilotAufruf {
  payload: CopilotNutzlast | null;
  args: string[];
  /** Der bestehende Hook-Lauf fuer eine Claude-Nutzlast (ambient-hook.ts hookAntwort). */
  claudeLauf: (raw: string, claudeEreignis: string) => Promise<string>;
  /** Nur Tests. */
  ablageOrdner?: string;
}

/** Was der Copilot-Hook auf stdout schreibt. Wirft nie. '' nur fuer Ereignisse, die wir nicht bedienen. */
export async function copilotHookAntwort(c: CopilotAufruf): Promise<string> {
  const e = copilotEreignis(c.payload, c.args);
  if (!e) return '';
  try {
    const p = c.payload ?? {};
    const laufzeit = copilotLaufzeit(p);
    const sitzung = sitzungVon(p);
    const ordner = c.ablageOrdner ?? COPILOT_ABLAGE_ORDNER;

    if (e === 'postToolUse') {
      // VS Code bekam die Lektionen schon bei UserPromptSubmit (siehe Kopf).
      if (laufzeit === 'vscode' || !sitzung) return '{}';
      return copilotAusgabe(e, laufzeit, abholen(ablagePfad(sitzung, ordner), undefined));
    }

    const ablegenNoetig = e === 'userPromptSubmitted' && laufzeit === 'cli';
    if (ablegenNoetig) {
      // Ohne Sitzung kaeme die Ablage nie an: dann gar nicht erst rechnen.
      if (!sitzung) return '{}';
      // Neuer Zug: die Ablage des vorigen Prompts sofort weg.
      ablegen(ablagePfad(sitzung, ordner), undefined, '');
    }
    const claude = claudeNutzlast(e, p);
    const kontext = kontextAus(await c.claudeLauf(JSON.stringify(claude), claude.hook_event_name!));
    if (ablegenNoetig) ablegen(ablagePfad(sitzung!, ordner), undefined, kontext);
    return copilotAusgabe(e, laufzeit, kontext);
  } catch {
    return '{}';
  }
}
