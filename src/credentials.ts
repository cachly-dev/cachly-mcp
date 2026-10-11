// Credentials — where the ambient hooks and CLI resolve the API key from
// (GROW-015): never a literal in a generated/committed file, always the
// environment or a file in the user's home directory.

import { existsSync, mkdirSync, writeFileSync, renameSync, chmodSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface CredentialsHomeOptions {
  /** Overrides the resolved user home directory (tests inject a temp dir). */
  home?: string;
}

export interface ResolveApiKeyOptions extends CredentialsHomeOptions {
  /** Project directory checked for a legacy `.mcp.json` entry. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment to read CACHLY_JWT/CACHLY_API_KEY from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

function defaultHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.env.APPDATA ?? '';
}

/**
 * Ein nicht ersetzter Platzhalter zaehlt als NICHTS.
 *
 * ── Warum (28.08.2026) ────────────────────────────────────────────────────
 *
 * Das Claude-Code-Plugin deklariert seine Umgebung so:
 *
 *     "CACHLY_JWT": "${user_config.api_key}"
 *
 * Setzt der Nutzer den Wert nie, kann bei uns entweder ein leerer String
 * ankommen (harmlos) oder der Text `${user_config.api_key}` selbst. Der zweite
 * Fall ist der gefaehrliche: er ist "wahr", also haelt jede Pruefung ihn fuer
 * einen Schluessel. Der Server wuerde mit einem Unsinns-Schluessel arbeiten,
 * jede Anfrage mit 401 scheitern — und die Selbsteinrichtung wuerde NICHT
 * anspringen, weil ja scheinbar ein Schluessel da ist.
 *
 * Das waere die stille Variante des Fehlers, den das Plugin gerade beheben
 * soll. Also faellt der Platzhalter hier heraus, bevor ihn jemand benutzt.
 */
export function istPlatzhalter(value: string): boolean {
  return /^\$\{[^}]*\}$/.test(value.trim());
}

function nonEmpty(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return istPlatzhalter(value) ? undefined : value;
}

/**
 * Path of the local credentials file in the user's home directory
 * (`<home>/.cachly/credentials.json`) — never inside a project checkout.
 * Mirrors the HOME/USERPROFILE/APPDATA fallback `persistApiKeyToConfig`
 * already uses for `~/.claude/mcp.json`.
 */
export function credentialsPath(opts: CredentialsHomeOptions = {}): string {
  const home = opts.home ?? defaultHome();
  return resolve(home, '.cachly', 'credentials.json');
}

/**
 * Persists the API key to {@link credentialsPath} so ambient hooks (which run
 * as bare OS processes and never see the MCP config's env) can find it at
 * run time without it ever being embedded in a generated script. Writes via
 * a temp file + rename so a crash mid-write can never leave a truncated
 * file, and restricts the file to the owner (0600 — a no-op on Windows).
 * Best-effort: a failure here never throws, matching every other ambient-path
 * write (setup and CLI auth still succeed without a persisted copy).
 */
export function saveApiKey(key: string, opts: CredentialsHomeOptions = {}): void {
  // Die Instanz bleibt nur stehen, wenn der Schluessel derselbe ist. Ein neuer
  // Schluessel kann zu einem anderen Konto gehoeren; die alte Instanz daneben
  // waere dann eine falsche Paarung, und jeder Hook-Aufruf scheiterte still.
  const alt = readCredentialsFile(opts);
  const instanceId = alt?.apiKey === key ? nonEmpty(alt.instanceId) : undefined;
  writeCredentialsFile({ apiKey: key, ...(instanceId ? { instanceId } : {}) }, opts);
}

/**
 * Legt die Instanz neben den Schluessel in {@link credentialsPath}.
 *
 * Warum (11.10.2026): Die Hooks laufen als nackte Prozesse. Den Schluessel
 * fanden sie hier, die Instanz aber nur in `~/.claude/mcp.json` — einer Datei,
 * die nur entsteht, wenn jemand sie anlegt. Wer cachly als Plugin installierte,
 * hatte nach dem Sofort-Test einen Schluessel und keine Instanz, und die
 * Einblendung blieb still.
 *
 * Geschrieben wird nur, wenn `apiKey` der Schluessel in der Datei ist: eine
 * Instanz gehoert zu einem Konto, und sie darf nie neben dem Schluessel eines
 * anderen Kontos landen. Wirft nie.
 */
export function saveInstanceId(instanceId: string, opts: CredentialsHomeOptions & { apiKey: string }): void {
  const alt = readCredentialsFile(opts);
  if (!nonEmpty(instanceId) || !alt?.apiKey || alt.apiKey !== opts.apiKey) return;
  if (alt.instanceId === instanceId) return;
  writeCredentialsFile({ ...alt, instanceId }, opts);
}

/** Die Instanz aus {@link credentialsPath}, oder undefined. Alte Dateien ohne Instanz: undefined. */
export function readInstanceId(opts: CredentialsHomeOptions = {}): string | undefined {
  return nonEmpty(readCredentialsFile(opts)?.instanceId);
}

interface CredentialsFile {
  apiKey?: string;
  instanceId?: string;
}

function readCredentialsFile(opts: CredentialsHomeOptions): CredentialsFile | null {
  try {
    const path = credentialsPath(opts);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CredentialsFile) : null;
  } catch {
    return null;
  }
}

/** Temp file + rename, owner-only. Best-effort: never throws. */
function writeCredentialsFile(inhalt: CredentialsFile, opts: CredentialsHomeOptions): void {
  try {
    const target = credentialsPath(opts);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}-${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(inhalt, null, 2), 'utf8');
    try { chmodSync(tmp, 0o600); } catch { /* e.g. Windows — best-effort */ }
    renameSync(tmp, target);
  } catch { /* best-effort — a failed persist must not break the caller */ }
}

function readHomeCredential(opts: ResolveApiKeyOptions): string | undefined {
  return nonEmpty(readCredentialsFile(opts)?.apiKey);
}

function readProjectConfigKey(opts: ResolveApiKeyOptions): string | undefined {
  try {
    const path = resolve(opts.cwd ?? process.cwd(), '.mcp.json');
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
    };
    return nonEmpty(parsed.mcpServers?.cachly?.env?.CACHLY_JWT);
  } catch {
    return undefined;
  }
}

/**
 * Resolves the API key the same way for every ambient/CLI caller, in order:
 * `CACHLY_JWT` env -> `CACHLY_API_KEY` env -> {@link credentialsPath} in the
 * user's home -> (legacy fallback) `mcpServers.cachly.env.CACHLY_JWT` in a
 * project's `.mcp.json`, for installs from before this file existed. A
 * corrupt file at any source counts as empty rather than throwing. Returns
 * `undefined` — never an empty string — when nothing is found, so callers
 * can tell "no key" apart from "empty key" with a plain truthiness check.
 */
export function resolveApiKey(opts: ResolveApiKeyOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  return (
    nonEmpty(env.CACHLY_JWT) ??
    nonEmpty(env.CACHLY_API_KEY) ??
    readHomeCredential(opts) ??
    readProjectConfigKey(opts)
  );
}
