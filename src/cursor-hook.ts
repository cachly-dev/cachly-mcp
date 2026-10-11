// Cursor-Hooks — dieselbe Einblendung in Cursor, ueber den einen Hook-Lauf.
//
// ── Was Cursor kann (Rohtext https://cursor.com/docs/hooks.md, 11.10.2026) ──
//
// `beforeSubmitPrompt` laeuft "right after user hits send but before backend
// request" und bekommt den Prompt im Feld `prompt`. Seine Antwort kennt nur
// `continue` und `user_message`: Er kann den Prompt erlauben oder blockieren,
// aber ihm NICHTS anfuegen. Kontext einfuegen koennen laut Doku nur:
//   • `sessionStart` → `additional_context` ("added to the conversation's
//     initial system context"; laeuft "fire-and-forget"),
//   • `postToolUse`  → `additional_context` ("injected into the conversation
//     after the tool result").
//
// Darum zwei Schritte statt einem:
//   1. beforeSubmitPrompt: Die Einblendung wird auf den Prompt berechnet —
//      derselbe Kern wie in Claude Code (hookAntwort → runEinblendung) — und je
//      Gespraech (`conversation_id`) mit der `generation_id` abgelegt. Antwort
//      immer `{"continue":true}`: der Prompt wird nie blockiert.
//   2. postToolUse: Der erste Werkzeugaufruf DERSELBEN Generation holt die
//      Ablage ab und gibt sie als `additional_context` weiter. Genau einmal.
// Ein Zug ohne Werkzeugaufruf bekommt nichts. Die Ablage enthaelt nur den
// fertigen Einblendetext, nie den Prompt.
//
// ── Claude-Hooks, die Cursor mitlaeuft ──────────────────────────────────────
//
// Cursor laedt auch die Hooks aus .claude/settings.json (Rohtext
// https://cursor.com/docs/reference/third-party-hooks.md: "Include Third-Party
// Plugins, Skills, and Other Configs", Vorgabe an) und bildet UserPromptSubmit
// auf beforeSubmitPrompt ab. setup/autopilot schreibt diese Hooks immer. Ohne
// Gegenmittel wartete Cursor vor jedem Prompt auf eine Einblendung, die es nicht
// annehmen kann, und das Briefing kaeme doppelt. Erkennungszeichen: Cursor
// schickt jedem Hook `cursor_version` mit ("Common schema"), Claude Code nie.
// Die Umgebungsvariable CURSOR_VERSION taugt NICHT dafuer: Claude Code, im
// Terminal von Cursor gestartet, koennte sie erben.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookPayload } from './ambient-cli.js';

/** Argument, mit dem der Cursor-Hook das Buendel ruft. */
export const CURSOR_FLAG = '--cursor';

export type CursorEreignis = 'sessionStart' | 'beforeSubmitPrompt' | 'postToolUse';

/** Die Ereignisse, die setup/autopilot in .cursor/hooks.json verdrahtet. */
export const CURSOR_HOOK_EVENTS: readonly CursorEreignis[] = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse'];

/** Die Felder der Cursor-Nutzlast, die wir brauchen (Rohtext, "Common schema" und je Ereignis). */
export interface CursorNutzlast {
  hook_event_name?: string;
  conversation_id?: string;
  generation_id?: string;
  cursor_version?: string;
  workspace_roots?: string[];
  /** beforeSubmitPrompt */
  prompt?: string;
  /** sessionStart ("same as conversation_id") */
  session_id?: string;
}

/**
 * Cursors eigener Name — oder der Claude-Name, aus dem Cursor ihn abbildet
 * (Third Party Hooks, "Hook Step Mapping"). Welchen Namen Cursor einem
 * mitgelaufenen Claude-Hook schickt, sagt die Doku nicht; beide gelten.
 */
const NAMEN: Record<string, CursorEreignis> = {
  sessionStart: 'sessionStart',
  SessionStart: 'sessionStart',
  beforeSubmitPrompt: 'beforeSubmitPrompt',
  UserPromptSubmit: 'beforeSubmitPrompt',
  postToolUse: 'postToolUse',
  PostToolUse: 'postToolUse',
};

/** true, wenn die Nutzlast von Cursor kommt (Feld `cursor_version`). */
export function istCursorNutzlast(p: unknown): boolean {
  const v = (p as CursorNutzlast | null)?.cursor_version;
  return typeof v === 'string' && v.trim() !== '';
}

/** Das Ereignis dieses Laufs: aus der Nutzlast, sonst aus den Argumenten. null = keines, das wir bedienen. */
export function cursorEreignis(p: CursorNutzlast | null, args: string[]): CursorEreignis | null {
  const name = p?.hook_event_name ?? args.find((a) => Object.hasOwn(NAMEN, a));
  return name && Object.hasOwn(NAMEN, name) ? NAMEN[name] : null;
}

/** Bildet die Cursor-Nutzlast auf die Claude-Nutzlast ab, die der bestehende Hook-Lauf versteht. */
export function claudeNutzlast(e: 'sessionStart' | 'beforeSubmitPrompt', p: CursorNutzlast): HookPayload {
  const session_id = p.conversation_id ?? p.session_id;
  const cwd = p.workspace_roots?.[0];
  return e === 'sessionStart'
    ? { hook_event_name: 'SessionStart', source: 'startup', session_id, cwd }
    : { hook_event_name: 'UserPromptSubmit', prompt: p.prompt ?? '', session_id, cwd };
}

/** Der Einblendetext aus der Claude-Antwort (`hookSpecificOutput.additionalContext`) oder ''. */
export function kontextAus(claudeAusgabe: string): string {
  if (!claudeAusgabe) return '';
  try {
    const k = (JSON.parse(claudeAusgabe) as { hookSpecificOutput?: { additionalContext?: unknown } })
      ?.hookSpecificOutput?.additionalContext;
    return typeof k === 'string' ? k : '';
  } catch {
    return '';
  }
}

/**
 * Die Antwort in Cursors Format. Immer gueltiges JSON nach dem Schema des
 * Ereignisses: beforeSubmitPrompt laesst den Prompt immer durch, die anderen
 * liefern `additional_context` oder ein leeres Objekt (alle Felder optional).
 */
export function cursorAusgabe(e: CursorEreignis, kontext: string): string {
  if (e === 'beforeSubmitPrompt') return JSON.stringify({ continue: true });
  return kontext ? JSON.stringify({ additional_context: kontext }) : '{}';
}

/** Was ein Lauf ohne Ergebnis ausgibt (auch an der Gesamtfrist). '' = kein Ereignis von uns. */
export function cursorLeer(e: CursorEreignis | null): string {
  return e ? cursorAusgabe(e, '') : '';
}

// ── Ablage zwischen beforeSubmitPrompt und postToolUse ──────────────────────

export const CURSOR_ABLAGE_ORDNER = join(tmpdir(), 'cachly-cursor-einblendung');

/** Eine Datei je Gespraech; der Name ist ein Hash, nie die rohe Kennung. */
export function ablagePfad(conversationId: string, ordner: string = CURSOR_ABLAGE_ORDNER): string {
  return join(ordner, `${createHash('sha256').update(conversationId).digest('hex').slice(0, 32)}.json`);
}

interface Ablage {
  generation_id: string | null;
  kontext: string;
  at: number;
}

/** Legt die Einblendung fuer diese Generation ab. Leerer Text loescht eine alte Ablage. */
export function ablegen(pfad: string, generationId: string | undefined, kontext: string): void {
  if (!kontext) {
    rmSync(pfad, { force: true });
    return;
  }
  mkdirSync(join(pfad, '..'), { recursive: true });
  const ablage: Ablage = { generation_id: generationId ?? null, kontext, at: Date.now() };
  writeFileSync(pfad, JSON.stringify(ablage), 'utf8');
}

function lies(pfad: string): Ablage | null {
  try {
    const a = JSON.parse(readFileSync(pfad, 'utf8')) as Ablage;
    return a && typeof a.kontext === 'string' ? a : null;
  } catch {
    return null;
  }
}

/**
 * Holt die Einblendung fuer diese Generation ab — genau einmal. Eine Ablage
 * einer anderen Generation bleibt liegen (der naechste Prompt ueberschreibt
 * sie). Parallele Werkzeugaufrufe: nur wer die Datei umbenennen kann, liefert.
 */
export function abholen(pfad: string, generationId: string | undefined): string {
  const gen = generationId ?? null;
  const vorher = lies(pfad);
  if (!vorher || vorher.generation_id !== gen) return '';
  const geholt = `${pfad}.${process.pid}.${Date.now()}`;
  try {
    renameSync(pfad, geholt);
  } catch {
    return ''; // ein anderer Aufruf war schneller
  }
  const a = lies(geholt);
  rmSync(geholt, { force: true });
  return a && a.generation_id === gen ? a.kontext : '';
}

// ── Der Lauf ────────────────────────────────────────────────────────────────

export interface CursorAufruf {
  payload: CursorNutzlast | null;
  args: string[];
  /** Der bestehende Hook-Lauf fuer eine Claude-Nutzlast (ambient-hook.ts hookAntwort). */
  claudeLauf: (raw: string, claudeEreignis: string) => Promise<string>;
  /** Nur Tests. */
  ablageOrdner?: string;
}

/** Was der Cursor-Hook auf stdout schreibt. Wirft nie. */
export async function cursorHookAntwort(c: CursorAufruf): Promise<string> {
  const e = cursorEreignis(c.payload, c.args);
  if (!e) return '';
  try {
    const p = c.payload ?? {};
    if (e === 'postToolUse') {
      if (!p.conversation_id) return cursorLeer(e);
      return cursorAusgabe(e, abholen(ablagePfad(p.conversation_id, c.ablageOrdner), p.generation_id));
    }
    // Ohne Gespraechskennung kaeme die Ablage nie an: dann gar nicht erst rechnen.
    if (e === 'beforeSubmitPrompt' && !p.conversation_id) return cursorLeer(e);
    const claude = claudeNutzlast(e, p);
    const kontext = kontextAus(await c.claudeLauf(JSON.stringify(claude), claude.hook_event_name!));
    if (e === 'beforeSubmitPrompt') ablegen(ablagePfad(p.conversation_id!, c.ablageOrdner), p.generation_id, kontext);
    return cursorAusgabe(e, kontext);
  } catch {
    return cursorLeer(e);
  }
}
