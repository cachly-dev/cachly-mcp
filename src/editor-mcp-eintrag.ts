/**
 * Der MCP-Eintrag `cachly` fuer Codex und Gemini CLI (GROW-018, 16.10.2026).
 *
 * Beide lesen kein .mcp.json. Bis 0.10.207 bekamen sie beim Einrichten nur
 * Hooks; den MCP-Server musste jeder selbst mit `codex mcp add` bzw.
 * `gemini mcp add` eintragen — `setup` und `autopilot` nannten die Zeile nicht
 * einmal. Jetzt schreibt cachly den Eintrag ins PROJEKT, wie bei den anderen
 * Editoren:
 *
 *   Codex       .codex/config.toml    [mcp_servers.cachly]
 *   Gemini CLI  .gemini/settings.json mcpServers.cachly
 *
 * Gemessen am 16.10.2026 mit codex-cli 0.163.0 und gemini 0.64.0: beide lesen
 * die Projektdatei, schalten sie aber erst ein, wenn der Ordner als vertraut
 * gilt (beide fragen danach beim ersten Start). `gemini mcp list` verband sich
 * mit dem `npx`-Eintrag unter Windows; `cmd /c npx` verband sich nicht.
 *
 * Kein Schluessel im Eintrag: der Server holt ihn beim Start aus der Umgebung
 * oder ~/.cachly/credentials.json (buildServerEnv ohne includeApiKey).
 * `uninstall` nimmt beide Eintraege wieder heraus (uninstall.ts).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { GEMINI_SETTINGS_DATEI } from './ambient-hooks.js';

export const CODEX_CONFIG_DATEI = '.codex/config.toml';

const SERVER_BEFEHL = 'npx';
const SERVER_ARGS = ['-y', '@cachly-dev/mcp-server@latest'] as const;

export type McpEintragStatus = 'written' | 'updated' | 'unchanged' | 'skipped';

export interface McpEintragErgebnis {
  /** Datei relativ zum Projekt. */
  datei: string;
  status: McpEintragStatus;
  /** Bei 'skipped': warum die Datei unberuehrt blieb. */
  grund?: string;
}

// ── Codex: TOML ──────────────────────────────────────────────────────────────

/** TOML-Text in doppelten Anfuehrungszeichen; die JSON-Maskierung ist gueltiges TOML. */
const tomlText = (s: string): string => JSON.stringify(s);
const TOML_SCHLUESSEL = /^[A-Za-z0-9_-]+$/;

/**
 * Eine Tabellen-Kopfzeile: `[a.b]`, `[[a.b]]` oder `[projects.'C:\x']` — innen
 * keine Klammer und kein Komma, danach hoechstens ein Kommentar. Eine
 * Fortsetzungszeile eines Arrays (`"a", "b"],`) ist damit keine.
 */
const KOPFZEILE = /^\s*\[\[?[^[\],]+\]\]?\s*(?:#.*)?$/;
/** Die Tabelle des cachly-Servers samt Untertabellen (`[mcp_servers.cachly.env]` schreibt `codex mcp add`). */
const CACHLY_KOPF = /^\s*\[\s*mcp_servers\s*\.\s*(?:cachly|"cachly"|'cachly')\s*(?:\.[^\]]*)?\]\s*(?:#.*)?$/;
/** cachly in einer Form, die hier nicht verlustfrei umgeschrieben wird (Inline-Tabelle, gepunkteter Schluessel). */
const ANDERE_CACHLY_FORM = /^\s*(?:mcp_servers\s*\.\s*)?["']?cachly["']?\s*(?:\.|=)/m;

/** Der Block, den cachly in .codex/config.toml schreibt. */
export function codexMcpBlock(env: Record<string, string>): string {
  const paare = Object.entries(env).map(([k, v]) => {
    if (!TOML_SCHLUESSEL.test(k)) throw new Error(`env name not usable as a TOML key: ${k}`);
    return `${k} = ${tomlText(v)}`;
  });
  return [
    '[mcp_servers.cachly]',
    `command = ${tomlText(SERVER_BEFEHL)}`,
    `args = [${SERVER_ARGS.map(tomlText).join(', ')}]`,
    `env = { ${paare.join(', ')} }`,
  ].join('\n');
}

/**
 * Der Text ohne die Tabelle `[mcp_servers.cachly]` und ihre Untertabellen.
 * Alles andere bleibt Zeile fuer Zeile. `rest` ist '' wenn nichts uebrig bleibt.
 */
export function ohneCodexMcpEintrag(text: string): { rest: string; entfernt: boolean } {
  const rest: string[] = [];
  let drin = false;
  let entfernt = false;
  for (const zeile of text.replace(/\r\n/g, '\n').split('\n')) {
    if (KOPFZEILE.test(zeile)) {
      drin = CACHLY_KOPF.test(zeile);
      if (drin) { entfernt = true; continue; }
    }
    if (!drin) rest.push(zeile);
  }
  const t = rest.join('\n').replace(/\s+$/, '');
  return { rest: t ? t + '\n' : '', entfernt };
}

/** Setzt den cachly-Block ans Ende; ein vorhandener wird ersetzt. Pure. */
export function setzeCodexMcpEintrag(
  text: string,
  env: Record<string, string>,
): { text: string; changed: boolean } | { grund: string } {
  const block = codexMcpBlock(env);
  const normal = text.replace(/\r\n/g, '\n');
  const { rest } = ohneCodexMcpEintrag(normal);
  if (ANDERE_CACHLY_FORM.test(rest)) {
    return { grund: 'has a "cachly" server in a form cachly does not rewrite (inline table or dotted key)' };
  }
  const neu = (rest ? rest + '\n' : '') + block + '\n';
  return { text: neu, changed: neu !== normal };
}

/** Schreibt .codex/config.toml im Projekt. Wirft nie wegen des Inhalts, nur bei Dateisystemfehlern. */
export async function installCodexMcp(projectDir: string, env: Record<string, string>): Promise<McpEintragErgebnis> {
  const pfad = resolve(projectDir, CODEX_CONFIG_DATEI);
  const roh = existsSync(pfad) ? await readFile(pfad, 'utf-8') : '';
  const vorher = roh.charCodeAt(0) === 0xfeff ? roh.slice(1) : roh;
  const r = setzeCodexMcpEintrag(vorher, env);
  if ('grund' in r) return { datei: CODEX_CONFIG_DATEI, status: 'skipped', grund: r.grund };
  if (!r.changed) return { datei: CODEX_CONFIG_DATEI, status: 'unchanged' };
  await mkdir(dirname(pfad), { recursive: true });
  await writeFile(pfad, r.text, 'utf-8');
  return { datei: CODEX_CONFIG_DATEI, status: roh ? 'updated' : 'written' };
}

// ── Gemini CLI: JSON ─────────────────────────────────────────────────────────

const istObjekt = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Schreibt mcpServers.cachly in .gemini/settings.json. Eine Datei, die sich
 * nicht als reines JSON lesen laesst (Gemini erlaubt Kommentare), bleibt
 * unberuehrt — wie bei den Gemini-Hooks (ambient-hooks.ts).
 */
export async function installGeminiMcp(projectDir: string, env: Record<string, string>): Promise<McpEintragErgebnis> {
  const datei = GEMINI_SETTINGS_DATEI;
  const pfad = resolve(projectDir, datei);
  const roh = existsSync(pfad) ? await readFile(pfad, 'utf-8') : '';
  const text = roh.charCodeAt(0) === 0xfeff ? roh.slice(1) : roh;
  let d: unknown;
  try {
    d = text.trim() ? JSON.parse(text) : {};
  } catch {
    const grund = /^\s*\/\/|\/\*/m.test(text) ? 'has comments, and cachly only rewrites plain JSON' : 'is not valid JSON';
    return { datei, status: 'skipped', grund };
  }
  if (!istObjekt(d)) return { datei, status: 'skipped', grund: 'is not a JSON object' };
  if (d.mcpServers !== undefined && !istObjekt(d.mcpServers)) {
    return { datei, status: 'skipped', grund: 'has a "mcpServers" field that is not an object' };
  }
  const eintrag = { command: SERVER_BEFEHL, args: [...SERVER_ARGS], env };
  const neu = { ...d, mcpServers: { ...(d.mcpServers ?? {}), cachly: eintrag } };
  if (JSON.stringify(neu) === JSON.stringify(d)) return { datei, status: 'unchanged' };
  await mkdir(dirname(pfad), { recursive: true });
  await writeFile(pfad, JSON.stringify(neu, null, 2) + '\n', 'utf-8');
  return { datei, status: roh ? 'updated' : 'written' };
}
