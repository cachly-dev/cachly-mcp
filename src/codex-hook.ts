// OpenAI Codex CLI — dieselbe Einblendung, ueber den einen Hook-Lauf.
//
// ── Was Codex kann (Rohtext https://developers.openai.com/codex/hooks.md, 11.10.2026) ──
//
//   • `UserPromptSubmit`, Eingabe `prompt`. Antwort
//     `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}`
//     — "That additionalContext text is added as extra developer context."
//   • `SessionStart` (startup, resume, clear, compact): dieselbe Form.
//   • Gemeinsame Eingabe: `session_id`, `transcript_path`, `cwd`,
//     `hook_event_name`, `model`; zugbezogene Ereignisse dazu `turn_id`.
//
// Das ist Claudes Format, Feld fuer Feld. Der Codex-Lauf bildet darum nichts
// um; er laesst nur die zwei Ereignisse durch, die Kontext tragen, und baut
// die Antwort aus dem Text neu (nie eine Stop- oder Block-Antwort an Codex).
//
// Grenze: Codex gibt dem Modell je Hook-Ausgabe "roughly 2,500 tokens"
// (`additionalContextLimit`, Vorgabe 2500); was darueber liegt, landet auf der
// Platte, das Modell sieht nur Anfang und Ende. Die Einblendung bleibt weit
// darunter: hoechstens drei Lektionen je Prompt (Budget 600 Token,
// einblendung.ts) und fuenf im Briefing, je Lektion 120 Zeichen. Gemessen am
// echten Bestand: siehe codex-hook.test.ts.

import type { HookPayload } from './ambient-cli.js';
import { kontextAus } from './cursor-hook.js';
import { hookAusgabe } from './einblendung.js';

/** Argument, mit dem das kleine Skript in .codex/hooks/ das Buendel ruft. */
export const CODEX_FLAG = '--codex';

export type CodexEreignis = 'SessionStart' | 'UserPromptSubmit';

/** Die Ereignisse, die setup/autopilot in .codex/hooks.json verdrahtet. */
export const CODEX_HOOK_EVENTS: readonly CodexEreignis[] = ['SessionStart', 'UserPromptSubmit'];

/** Codex' Grenze je Hook-Ausgabe in Token (Doku, "Large hook output"). */
export const CODEX_KONTEXT_GRENZE_TOKEN = 2500;

export interface CodexNutzlast {
  hook_event_name?: string;
  session_id?: string;
  turn_id?: string;
  cwd?: string;
  prompt?: string;
  source?: string;
}

const NAMEN = new Set<string>(CODEX_HOOK_EVENTS);

/** Das Ereignis dieses Laufs: aus der Eingabe, sonst aus den Argumenten. null = keines, das wir bedienen. */
export function codexEreignis(p: CodexNutzlast | null, args: string[]): CodexEreignis | null {
  const name = p?.hook_event_name ?? args.find((a) => NAMEN.has(a));
  return name && NAMEN.has(name) ? (name as CodexEreignis) : null;
}

/** Nur die Felder, die der Hook-Lauf braucht — dieselben Namen wie bei Claude. */
export function claudeNutzlast(e: CodexEreignis, p: CodexNutzlast): HookPayload {
  const session_id = typeof p.session_id === 'string' ? p.session_id : undefined;
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined;
  return e === 'SessionStart'
    ? { hook_event_name: 'SessionStart', source: typeof p.source === 'string' ? p.source : 'startup', session_id, cwd }
    : { hook_event_name: 'UserPromptSubmit', prompt: typeof p.prompt === 'string' ? p.prompt : '', session_id, cwd };
}

export interface CodexAufruf {
  payload: CodexNutzlast | null;
  args: string[];
  /** Der bestehende Hook-Lauf fuer eine Claude-Nutzlast (ambient-hook.ts hookAntwort). */
  claudeLauf: (raw: string, claudeEreignis: string) => Promise<string>;
}

/** Was der Codex-Hook auf stdout schreibt — oder '' ("Exit 0 with no output is treated as success"). Wirft nie. */
export async function codexHookAntwort(c: CodexAufruf): Promise<string> {
  const e = codexEreignis(c.payload, c.args);
  if (!e) return '';
  try {
    const claude = claudeNutzlast(e, c.payload ?? {});
    return hookAusgabe(e, kontextAus(await c.claudeLauf(JSON.stringify(claude), e)));
  } catch {
    return '';
  }
}
