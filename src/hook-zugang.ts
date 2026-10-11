// Woher ein Hook Schluessel und Instanz nimmt — und wann das Plugin zuruecktritt.
//
// Die Hooks laufen als nackte Prozesse. Sie sehen weder die Umgebung des
// MCP-Servers noch dessen Konfiguration. Diese Datei sucht beides an allen
// Stellen, an die cachly es ablegt, in fester Reihenfolge:
//
//   Schluessel: Plugin-Option -> CACHLY_JWT/CACHLY_API_KEY -> ~/.cachly/credentials.json
//               -> .mcp.json im Projekt -> mcpServers.cachly.env in ~/.claude/mcp.json,
//               Cursor, Windsurf (dort legt persistApiKeyToConfig ihn ab)
//   Instanz:    Plugin-Option -> CACHLY_BRAIN_INSTANCE_ID -> ~/.cachly/credentials.json
//               -> dieselben MCP-Konfigurationen (persistInstanceIdToConfig)
//
// Ein nicht ersetzter Platzhalter wie `${user_config.api_key}` zaehlt als nichts.
// Alles hier wirft nie: eine kaputte Datei ist eine leere Datei.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readInstanceId, resolveApiKey } from './credentials.js';
import { echterWert } from './zugang.js';

export interface HookUmfeld {
  env: Record<string, string | undefined>;
  /** Home des Nutzers (~). */
  heim: string;
  /** Wurzel des Projekts, in dem die Sitzung laeuft. */
  projekt: string;
}

export function hookUmfeld(env: Record<string, string | undefined> = process.env): HookUmfeld {
  return {
    env,
    heim: env.HOME || env.USERPROFILE || homedir(),
    projekt: env.CLAUDE_PROJECT_DIR || process.cwd(),
  };
}

function lies(pfad: string): unknown {
  try { return JSON.parse(readFileSync(pfad, 'utf8')); } catch { return null; }
}

/** `mcpServers.cachly.env` aus den MCP-Konfigurationen des Nutzers, in fester Reihenfolge. */
function mcpUmgebungen(u: HookUmfeld): Array<Record<string, unknown>> {
  return [
    join(u.heim, '.claude', 'mcp.json'),
    join(u.projekt, '.mcp.json'),
    join(u.heim, '.cursor', 'mcp.json'),
    join(u.heim, '.codeium', 'windsurf', 'mcp_config.json'),
  ].map((datei) => {
    const env = (lies(datei) as { mcpServers?: { cachly?: { env?: unknown } } } | null)?.mcpServers?.cachly?.env;
    return env && typeof env === 'object' ? (env as Record<string, unknown>) : {};
  });
}

function erster(...werte: unknown[]): string {
  for (const w of werte) {
    const e = echterWert(w);
    if (e) return e;
  }
  return '';
}

export function findeSchluessel(u: HookUmfeld): string {
  return erster(
    u.env.CLAUDE_PLUGIN_OPTION_API_KEY,
    resolveApiKey({ env: u.env, home: u.heim, cwd: u.projekt }),
    ...mcpUmgebungen(u).map((e) => e.CACHLY_JWT),
  );
}

export function findeInstanz(u: HookUmfeld): string {
  return erster(
    u.env.CLAUDE_PLUGIN_OPTION_INSTANCE_ID,
    u.env.CACHLY_BRAIN_INSTANCE_ID,
    readInstanceId({ home: u.heim }),
    ...mcpUmgebungen(u).map((e) => e.CACHLY_BRAIN_INSTANCE_ID),
  );
}

/** Jeder Hook, den init/setup/autopilot schreiben, traegt das im Befehl. */
export const PROJEKT_HOOK_MARKE = 'cachly-ambient-';

/**
 * Nie doppelt: true, wenn das Projekt oder der Nutzer fuer dieses Ereignis
 * schon einen cachly-ambient-Hook in den Einstellungen hat. Claude Code fuehrt
 * Plugin- und Einstellungs-Hooks getrennt aus und fasst sie nicht zusammen;
 * ohne diese Pruefung kaeme die Einblendung zweimal. Das Plugin tritt dann
 * zurueck — der Projekt-Hook traegt die Instanz, die der Nutzer dort gewaehlt hat.
 */
export function projektHatHook(ereignis: string, u: HookUmfeld): boolean {
  return [
    join(u.projekt, '.claude', 'settings.json'),
    join(u.projekt, '.claude', 'settings.local.json'),
    join(u.heim, '.claude', 'settings.json'),
  ].some((datei) => {
    const gruppen = (lies(datei) as { hooks?: Record<string, unknown> } | null)?.hooks?.[ereignis];
    return Array.isArray(gruppen) && gruppen.some((g: { hooks?: unknown }) =>
      Array.isArray(g?.hooks)
      && g.hooks.some((h: { command?: unknown }) => String(h?.command ?? '').includes(PROJEKT_HOOK_MARKE)));
  });
}
