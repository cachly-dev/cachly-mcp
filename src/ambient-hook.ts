// Der eine Hook-Lauf — fuer das Plugin, fuer die Projekt-Hooks und fuer
// `cachly ambient-recall`.
//
// ── Warum (11.10.2026) ────────────────────────────────────────────────────
//
// Bis heute rief jeder Hook `npx @cachly-dev/mcp-server@latest ambient-recall`.
// Gemessen auf einem Windows-Laptop: npx allein 3,7 bis 4,1 s warm und 14 bis
// 16 s kalt, der ganze Prompt-Hook 7,7 s warm und 17,1 s kalt — bei einer
// Grenze von 10 s. `@latest` fragt die Registry bei jedem Prompt.
//
// Jetzt buendelt `scripts/plugin-hooks-schreiben.mjs` diese Datei (ueber
// ambient-hook-start.ts) zu EINER Datei ohne node_modules:
// hooks/cachly-ambient-einblendung.mjs. Das Plugin ruft sie direkt mit
// `node`, die Projekt-Hooks laden sie aus .claude/hooks/. Kein npx mehr.
// `cachly ambient-recall` (index.ts) ruft dieselbe Funktion; aeltere
// Projekt-Hooks, die noch npx nehmen, bekommen also dasselbe Verhalten.
//
// Was ein Lauf tut:
//   1. Plugin-Lauf (`--plugin`): Hat das Projekt fuer dieses Ereignis schon
//      einen cachly-ambient-Hook, tritt das Plugin zurueck (nie doppelt).
//   2. Stop: Schreibbeleg zuerst — er braucht keinen Schluessel.
//   3. Schluessel und Instanz suchen (hook-zugang.ts). Fehlt eins: nichts.
//   4. Stop: Auto-Lernen ueber REST. Sonst: Einblendung (einblendung.ts).
// Jeder Fehler endet still mit Exit 0 — ein Hook blockiert nie den Zug.
//
// Cursor (11.10.2026): Mit `--cursor` oder einer Nutzlast mit `cursor_version`
// laeuft derselbe Weg ueber cursor-hook.ts — Cursors Eingabe wird auf die
// Claude-Nutzlast abgebildet, die Antwort in Cursors Format zurueckgegeben.
//
// VS Code mit Copilot (`--copilot`), Codex CLI (`--codex`) und Gemini CLI
// (`--gemini`) gehen genauso: copilot-hook.ts, codex-hook.ts, gemini-hook.ts
// bilden nur Eingabe und Antwort ab; gerechnet wird hier.

import { readFileSync } from 'node:fs';
import { parseHookPayload, runEinblendung, stopLernanfrage, stopObservation } from './ambient-cli.js';
import { stopAntwort } from './schreibbeleg.js';
import { holeBestand } from './einblendung.js';
import { belohnungMelden } from './lernen.js';
import { appendLedgerEntry, reportLedgerEntry } from './ambient-ledger.js';
import {
  copilotHatHook,
  cursorHatHook,
  findeInstanz,
  findeSchluessel,
  hookUmfeld,
  projektHatHook,
  type HookUmfeld,
} from './hook-zugang.js';
import {
  CURSOR_FLAG,
  cursorEreignis,
  cursorHookAntwort,
  cursorLeer,
  istCursorNutzlast,
  type CursorNutzlast,
} from './cursor-hook.js';
import {
  COPILOT_FLAG,
  copilotEreignis,
  copilotHookAntwort,
  istFremdeLaufzeit,
  type CopilotNutzlast,
} from './copilot-hook.js';
import { CODEX_FLAG, codexHookAntwort, type CodexNutzlast } from './codex-hook.js';
import { GEMINI_FLAG, geminiEreignis, geminiHookAntwort, type GeminiNutzlast } from './gemini-hook.js';

export const STANDARD_API_URL = 'https://api.cachly.dev';

/** Unterbefehl, mit dem der Hook seinen Bestand im Hintergrund auffrischt. */
export const AUFFRISCHEN = 'ambient-auffrischen';

const EREIGNISSE = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);

export interface HookAufruf {
  /** Argumente nach dem Skript: `[<Ereignis>] [--plugin]`. */
  args: string[];
  /** Die Hook-Nutzlast von stdin. */
  raw: string;
  umfeld: HookUmfeld;
  apiUrl: string;
  /** Skript, das `node <selbst> ambient-auffrischen` startet (Bestand im Hintergrund). */
  selbst?: string;
  fetchFn?: typeof fetch;
  /**
   * Welcher Editor den Hook startet. Wird beim ersten Aufruf aus Schalter und
   * Nutzlast bestimmt und reist mit, wenn ein Editor-Lauf mit einer
   * Claude-Nutzlast zurueckkehrt (dort fehlt der Schalter).
   */
  editor?: string;
  /** Nur Tests. */
  einblenden?: typeof runEinblendung;
  /** Nur Tests: Ordner der Cursor-Ablage (cursor-hook.ts). */
  cursorAblage?: string;
  /** Nur Tests: Ordner der Copilot-CLI-Ablage (copilot-hook.ts). */
  copilotAblage?: string;
}

/**
 * Cursor-Lauf. Zwei Wege hierher:
 *   • `--cursor`: der Hook aus .cursor/hooks.json — er bedient sessionStart,
 *     beforeSubmitPrompt und postToolUse.
 *   • Nutzlast mit `cursor_version` ohne `--cursor`: ein Claude-Hook, den
 *     Cursor aus .claude/settings.json mitlaeuft. Hat das Projekt den
 *     Cursor-Hook, tritt er ganz zurueck (nie doppelt). Sonst bedient er nur
 *     das Briefing: ohne postToolUse kaeme eine Prompt-Einblendung nie an, und
 *     Cursor wartete vor jedem Prompt umsonst.
 */
async function cursorLauf(a: HookAufruf, payload: CursorNutzlast | null): Promise<string> {
  const eigenerHook = a.args.includes(CURSOR_FLAG);
  if (!eigenerHook) {
    if (cursorEreignis(payload, a.args) !== 'sessionStart' || cursorHatHook(a.umfeld)) return '';
  }
  const plugin = a.args.filter((x) => x === '--plugin');
  return cursorHookAntwort({
    payload,
    args: a.args,
    claudeLauf: (raw, claudeEreignis) => hookAntwort({ ...a, raw, args: [claudeEreignis, ...plugin] }),
    ablageOrdner: a.cursorAblage,
  });
}

/**
 * Die Laeufe der Editoren mit eigenem Hook-Format (`--copilot`, `--codex`,
 * `--gemini`). Jeder bildet nur Eingabe und Antwort ab und rechnet ueber
 * `hookAntwort` mit einer Claude-Nutzlast. null = kein solcher Lauf.
 */
function editorLauf(a: HookAufruf, payload: unknown): Promise<string> | null {
  const claudeLauf = (raw: string, claudeEreignis: string) => hookAntwort({ ...a, raw, args: [claudeEreignis] });
  if (a.args.includes(COPILOT_FLAG)) {
    return copilotHookAntwort({ payload: payload as CopilotNutzlast | null, args: a.args, claudeLauf, ablageOrdner: a.copilotAblage });
  }
  if (a.args.includes(CODEX_FLAG)) return codexHookAntwort({ payload: payload as CodexNutzlast | null, args: a.args, claudeLauf });
  if (a.args.includes(GEMINI_FLAG)) return geminiHookAntwort({ payload: payload as GeminiNutzlast | null, args: a.args, claudeLauf });
  return null;
}

/** Der Editor aus Schalter und Nutzlast — fuer das Protokoll des Lernens (lernen.ts). */
export function editorVon(args: string[], payload: unknown): string {
  if (args.includes(CURSOR_FLAG) || istCursorNutzlast(payload)) return 'cursor';
  if (args.includes(COPILOT_FLAG)) return 'copilot';
  if (args.includes(CODEX_FLAG)) return 'codex';
  if (args.includes(GEMINI_FLAG)) return 'gemini';
  if (istFremdeLaufzeit(payload)) return 'vscode';
  return 'claude';
}

/** Was der Hook auf stdout schreibt — oder '' (nichts). Wirft nie. */
export async function hookAntwort(aufruf: HookAufruf): Promise<string> {
  try {
    const payload = parseHookPayload(aufruf.raw);
    const a: HookAufruf = { ...aufruf, editor: aufruf.editor ?? editorVon(aufruf.args, payload) };
    if (a.args.includes(CURSOR_FLAG) || istCursorNutzlast(payload)) {
      return await cursorLauf(a, payload as CursorNutzlast | null);
    }
    const editor = editorLauf(a, payload);
    if (editor) return await editor;
    const ereignis = payload?.hook_event_name
      ?? a.args.find((x) => EREIGNISSE.has(x))
      ?? a.umfeld.env.CACHLY_HOOK_EVENT
      ?? '';
    // Ein Claude-Hook, den VS Code oder Copilot CLI aus .claude/settings.json
    // mitlaeuft (erkennbar an `timestamp`, copilot-hook.ts): vor Werkzeugen und
    // am Ende nie (VS Code achtet dort nicht auf den Matcher, das Protokoll hat
    // ein anderes Format); Briefing und Prompt nur, solange das Projekt den
    // eigenen Hook in .github/hooks/ nicht hat — sonst kaeme alles doppelt.
    if (istFremdeLaufzeit(payload)) {
      if (ereignis !== 'SessionStart' && ereignis !== 'UserPromptSubmit') return '';
      if (copilotHatHook(a.umfeld)) return '';
    }
    if (a.args.includes('--plugin') && ereignis && projektHatHook(ereignis, a.umfeld)) return '';

    // Schreibbeleg (07.10.2026): braucht keinen Schluessel, nur das Protokoll
    // des Zugs. Behauptet die Antwort eine Speicherung ohne erfolgreichen
    // Schreibaufruf, geht sie einmal zurueck — und es wird nichts gelernt.
    let zeilen: string[] | null = null;
    if (ereignis === 'Stop' && payload?.transcript_path) {
      try {
        zeilen = readFileSync(payload.transcript_path, 'utf-8').split('\n');
        const block = stopAntwort(zeilen, payload.stop_hook_active === true);
        if (block) return block;
      } catch {
        // Protokoll nicht lesbar → keine Pruefung, nie den Zug blockieren
      }
    }

    const jwt = findeSchluessel(a.umfeld);
    const instanceId = findeInstanz(a.umfeld);
    if (!jwt || !instanceId) return '';
    const cfg = { apiUrl: a.apiUrl, jwt, instanceId };

    if (ereignis === 'Stop') {
      const obs = payload ? stopObservation(payload) : null;
      const lernen = obs
        ? (a.fetchFn ?? fetch)(`${cfg.apiUrl}/api/v1/instances/${cfg.instanceId}/learn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.jwt}` },
          body: JSON.stringify(stopLernanfrage(obs)),
          signal: AbortSignal.timeout(8000),
        }).catch(() => undefined)
        : undefined;
      // Lernen aus Nutzung (lernen.ts): hat der Agent eine eingeblendete
      // Lektion in diesem Zug aufgegriffen? Bewerten und melden.
      const belohnung = belohnungMelden(cfg, payload?.session_id ?? null, zeilen, { fetchFn: a.fetchFn });
      await Promise.all([lernen, belohnung]);
      return '';
    }

    let gemeldet: Promise<void> | undefined;
    const out = await (a.einblenden ?? runEinblendung)(a.raw, {
      cfg,
      nebenlauf: a.selbst ? [a.selbst, AUFFRISCHEN] : undefined,
      editor: a.editor,
      fetchFn: a.fetchFn,
      onInject: (tokens, event) => {
        const entry = { ts: new Date().toISOString(), event, injected: tokens, prevented: 0 };
        void appendLedgerEntry(entry);
        gemeldet = reportLedgerEntry(cfg, entry, a.fetchFn); // Spiegel fuer das Team-Dashboard
      },
    });
    // Begrenzt warten, damit die Meldung process.exit ueberlebt — nie mehr als 500 ms.
    if (gemeldet) await Promise.race([gemeldet, new Promise((r) => setTimeout(r, 500))]);
    return out;
  } catch {
    return '';
  }
}

async function leseStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const teile: Buffer[] = [];
  for await (const teil of process.stdin) teile.push(teil as Buffer);
  return Buffer.concat(teile).toString('utf-8');
}

function apiUrl(): string {
  return process.env.CACHLY_API_URL || STANDARD_API_URL;
}

/**
 * Harte Gesamtfrist je Ereignis, knapp unter dem Zeitlimit in den Einstellungen
 * (EVENT_TIMEOUTS in ambient-hooks.ts: 30 / 10 / 10 / 60 s).
 *
 * Warum (11.10.2026): Die Einzelfristen (Abruf 5 s, Leser 2,5 s) halten nicht
 * immer. Gemessen: ein kalter Abruf brauchte 10,3 s bis `server-nicht-erreichbar`,
 * statt nach 5 s abzubrechen — ein haengender Verbindungsaufbau, der erst am
 * Verbindungslimit von 10 s endet. Der Lauf dauerte 11,3 s, ueber der Grenze.
 * Claude Code bricht dann ab, der Prompt hat 10 s gewartet. Diese Frist endet
 * vorher still. `CACHLY_HOOK_FRIST_MS` ueberschreibt sie (Tests).
 */
export const HOOK_FRIST_MS: Record<string, number> = {
  SessionStart: 25_000,
  UserPromptSubmit: 8_000,
  PreToolUse: 8_000,
  Stop: 50_000,
  // Cursor (CURSOR_TIMEOUTS in ambient-hooks.ts: 30 / 10 / 5 s). postToolUse
  // liest nur die Ablage — es laeuft nach JEDEM Werkzeugaufruf.
  sessionStart: 25_000,
  beforeSubmitPrompt: 8_000,
  postToolUse: 3_000,
  // VS Code / Copilot CLI (COPILOT_TIMEOUTS: 30 / 10 / 5 s), Gemini
  // (GEMINI_TIMEOUTS_MS: 30 / 10 s). Codex nutzt die Claude-Namen.
  userPromptSubmitted: 8_000,
  PostToolUse: 3_000,
  BeforeAgent: 8_000,
};

/**
 * Was ein Lauf an der Gesamtfrist ausgibt. Claude Code und Codex: nichts.
 * Cursor, VS Code / Copilot CLI und Gemini: eine gueltige Leer-Antwort in
 * ihrem Format (Gemini liest sonst stderr als Antwort, gemini-hook.ts).
 */
function leereAntwort(args: string[], payload: unknown): string {
  if (args.includes(CURSOR_FLAG)) return cursorLeer(cursorEreignis(payload as CursorNutzlast | null, args));
  if (args.includes(COPILOT_FLAG)) return copilotEreignis(payload as CopilotNutzlast | null, args) ? '{}' : '';
  if (args.includes(GEMINI_FLAG)) return geminiEreignis(payload as GeminiNutzlast | null, args) ? '{}' : '';
  return '';
}

/** Ganzer Hook-Lauf als Prozess: stdin lesen, antworten, Exit 0. */
export async function hookHauptlauf(args: string[], selbst: string | undefined): Promise<never> {
  try {
    const raw = await leseStdin();
    const payload = parseHookPayload(raw);
    const ereignis = payload?.hook_event_name
      ?? args.find((x) => EREIGNISSE.has(x) || Object.hasOwn(HOOK_FRIST_MS, x))
      ?? '';
    const frist = Number(process.env.CACHLY_HOOK_FRIST_MS) || HOOK_FRIST_MS[ereignis] || HOOK_FRIST_MS.UserPromptSubmit;
    const leer = leereAntwort(args, payload);
    const out = await Promise.race([
      hookAntwort({ args, raw, umfeld: hookUmfeld(), apiUrl: apiUrl(), selbst }),
      new Promise<string>((r) => setTimeout(() => r(leer), frist)),
    ]);
    if (out) await new Promise<void>((r) => process.stdout.write(out, () => r()));
  } catch {
    // Ein Hook darf den Zug nie brechen.
  }
  process.exit(0);
}

/**
 * Frischt den Bestand auf der Platte auf. Gestartet von einem Hook-Lauf, wenn
 * der Bestand aelter als zehn Minuten ist; der Prompt wartet nie darauf.
 */
export async function auffrischenHauptlauf(): Promise<never> {
  try {
    const u = hookUmfeld();
    const jwt = findeSchluessel(u);
    const instanceId = findeInstanz(u);
    // lernen: Zaehlungen je Arm holen, ruhende Entscheidungen melden (lernen.ts).
    if (jwt && instanceId) await holeBestand({ apiUrl: apiUrl(), jwt, instanceId }, { force: true, lernen: true });
  } catch {
    // ein gescheiterter Abruf behaelt den alten Bestand; der naechste Prompt versucht es erneut
  }
  process.exit(0);
}
