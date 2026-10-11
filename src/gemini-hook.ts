// Gemini CLI — dieselbe Einblendung, ueber den einen Hook-Lauf.
//
// ── Was Gemini CLI kann (Rohtext, 11.10.2026) ───────────────────────────────
//
//   https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/reference.md
//   https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/hooks/index.md
//
//   • `BeforeAgent` "Fires after a user submits a prompt, but before the agent
//     begins planning", Eingabe `prompt`. Antwort
//     `hookSpecificOutput.additionalContext`: "Text that is appended to the
//     prompt for this turn only." Das ist Claudes UserPromptSubmit.
//   • `SessionStart` (startup, resume, clear): `hookSpecificOutput.additionalContext`
//     wird "Injected as the first turn in history".
//   • Gemeinsame Eingabe: `session_id`, `transcript_path`, `cwd`,
//     `hook_event_name`, `timestamp`.
//   • "Silence is Mandatory": stdout darf nur das JSON tragen. Ist stdout leer,
//     liest Gemini stderr als Antwort (packages/core/src/hooks/hookRunner.ts:
//     `stdout.trim() || stderr.trim()`). Darum antwortet dieser Hook IMMER mit
//     einer JSON-Zeile, auch wenn er nichts beizutragen hat: `{}`.
//   • `timeout` steht in Millisekunden (Vorgabe 60000), anders als bei allen
//     anderen Editoren.
//
// Gemini maskiert `<` und `>` im Kontext (hooks/types.ts getAdditionalContext:
// "escaping < and > to prevent tag injection"). Der Rahmen `<cachly-memory>`
// kommt dort als `&lt;cachly-memory&gt;` an; der Hinweistext darin bleibt
// lesbar.

import type { HookPayload } from './ambient-cli.js';
import { kontextAus } from './cursor-hook.js';

/** Argument, mit dem das kleine Skript in .gemini/hooks/ das Buendel ruft. */
export const GEMINI_FLAG = '--gemini';

export type GeminiEreignis = 'SessionStart' | 'BeforeAgent';

/** Die Ereignisse, die setup/autopilot in .gemini/settings.json verdrahtet. */
export const GEMINI_HOOK_EVENTS: readonly GeminiEreignis[] = ['SessionStart', 'BeforeAgent'];

export interface GeminiNutzlast {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
  timestamp?: string;
}

const NAMEN = new Set<string>(GEMINI_HOOK_EVENTS);

/** Das Ereignis dieses Laufs: aus der Eingabe, sonst aus den Argumenten. null = keines, das wir bedienen. */
export function geminiEreignis(p: GeminiNutzlast | null, args: string[]): GeminiEreignis | null {
  const name = p?.hook_event_name ?? args.find((a) => NAMEN.has(a));
  return name && NAMEN.has(name) ? (name as GeminiEreignis) : null;
}

/** Bildet die Gemini-Eingabe auf die Claude-Nutzlast ab. BeforeAgent → UserPromptSubmit. */
export function claudeNutzlast(e: GeminiEreignis, p: GeminiNutzlast): HookPayload {
  const session_id = typeof p.session_id === 'string' ? p.session_id : undefined;
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  return e === 'SessionStart'
    ? { hook_event_name: 'SessionStart', source: typeof p.source === 'string' ? p.source : 'startup', session_id, cwd }
    : { hook_event_name: 'UserPromptSubmit', prompt: typeof p.prompt === 'string' ? p.prompt : '', session_id, cwd };
}

/** Die Antwort in Geminis Format — immer eine JSON-Zeile (siehe Kopf). */
export function geminiAusgabe(e: GeminiEreignis, kontext: string): string {
  return kontext ? JSON.stringify({ hookSpecificOutput: { hookEventName: e, additionalContext: kontext } }) : '{}';
}

export interface GeminiAufruf {
  payload: GeminiNutzlast | null;
  args: string[];
  /** Der bestehende Hook-Lauf fuer eine Claude-Nutzlast (ambient-hook.ts hookAntwort). */
  claudeLauf: (raw: string, claudeEreignis: string) => Promise<string>;
}

/** Was der Gemini-Hook auf stdout schreibt. Wirft nie. '' nur fuer Ereignisse, die wir nicht bedienen. */
export async function geminiHookAntwort(c: GeminiAufruf): Promise<string> {
  const e = geminiEreignis(c.payload, c.args);
  if (!e) return '';
  try {
    const claude = claudeNutzlast(e, c.payload ?? {});
    return geminiAusgabe(e, kontextAus(await c.claudeLauf(JSON.stringify(claude), claude.hook_event_name!)));
  } catch {
    return '{}';
  }
}
