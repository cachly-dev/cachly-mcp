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

import { readFileSync } from 'node:fs';
import { parseHookPayload, runEinblendung, stopLernanfrage, stopObservation } from './ambient-cli.js';
import { stopAntwort } from './schreibbeleg.js';
import { holeBestand } from './einblendung.js';
import { appendLedgerEntry, reportLedgerEntry } from './ambient-ledger.js';
import { findeInstanz, findeSchluessel, hookUmfeld, projektHatHook, type HookUmfeld } from './hook-zugang.js';

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
  /** Nur Tests. */
  einblenden?: typeof runEinblendung;
}

/** Was der Hook auf stdout schreibt — oder '' (nichts). Wirft nie. */
export async function hookAntwort(a: HookAufruf): Promise<string> {
  try {
    const payload = parseHookPayload(a.raw);
    const ereignis = payload?.hook_event_name
      ?? a.args.find((x) => EREIGNISSE.has(x))
      ?? a.umfeld.env.CACHLY_HOOK_EVENT
      ?? '';
    if (a.args.includes('--plugin') && ereignis && projektHatHook(ereignis, a.umfeld)) return '';

    // Schreibbeleg (07.10.2026): braucht keinen Schluessel, nur das Protokoll
    // des Zugs. Behauptet die Antwort eine Speicherung ohne erfolgreichen
    // Schreibaufruf, geht sie einmal zurueck — und es wird nichts gelernt.
    if (ereignis === 'Stop' && payload?.transcript_path) {
      try {
        const zeilen = readFileSync(payload.transcript_path, 'utf-8').split('\n');
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
      if (obs) {
        await (a.fetchFn ?? fetch)(`${cfg.apiUrl}/api/v1/instances/${cfg.instanceId}/learn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.jwt}` },
          body: JSON.stringify(stopLernanfrage(obs)),
          signal: AbortSignal.timeout(8000),
        }).catch(() => undefined);
      }
      return '';
    }

    let gemeldet: Promise<void> | undefined;
    const out = await (a.einblenden ?? runEinblendung)(a.raw, {
      cfg,
      nebenlauf: a.selbst ? [a.selbst, AUFFRISCHEN] : undefined,
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
};

/** Ganzer Hook-Lauf als Prozess: stdin lesen, antworten, Exit 0. */
export async function hookHauptlauf(args: string[], selbst: string | undefined): Promise<never> {
  try {
    const raw = await leseStdin();
    const ereignis = parseHookPayload(raw)?.hook_event_name ?? args.find((x) => EREIGNISSE.has(x)) ?? '';
    const frist = Number(process.env.CACHLY_HOOK_FRIST_MS) || HOOK_FRIST_MS[ereignis] || HOOK_FRIST_MS.UserPromptSubmit;
    const out = await Promise.race([
      hookAntwort({ args, raw, umfeld: hookUmfeld(), apiUrl: apiUrl(), selbst }),
      new Promise<string>((r) => setTimeout(() => r(''), frist)),
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
    if (jwt && instanceId) await holeBestand({ apiUrl: apiUrl(), jwt, instanceId }, { force: true });
  } catch {
    // ein gescheiterter Abruf behaelt den alten Bestand; der naechste Prompt versucht es erneut
  }
  process.exit(0);
}
