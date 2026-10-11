/**
 * uebernahme.ts — ein Test-Brain in das eigene cachly-Konto uebernehmen.
 *
 *   npx @cachly-dev/mcp-server@latest claim
 *
 * ── Warum es so gebaut ist (11.10.2026) ─────────────────────────────────────
 *
 * Ohne Schluessel legt der MCP-Server ein Test-Brain an (zugang.ts). Der
 * erste Entwurf, es an ein Konto zu binden, lief ueber einen Link, den man
 * weiterreichen konnte (PR #711). Zwei Sicherheitspruefungen fanden: Ein
 * Angreifer schiebt den Link einem angemeldeten Opfer unter.
 *
 * Jetzt beweist DERSELBE Client beides im selben Aufruf:
 *   - Anmeldung: ein Keycloak-Token aus der Geraete-Anmeldung im Terminal
 *     (Client cachly-cli). Ein API-Schluessel zaehlt nicht als Anmeldung.
 *   - Besitz: der Test-Schluessel, als Kopf X-Trial-Key.
 * Der Server zieht das Brain um, widerruft JEDEN Schluessel des Tests und
 * gibt einen neuen aus dem Konto zurueck (api/internal/service/test_uebernahme.go).
 *
 * Der Test-Schluessel kommt nur aus ~/.cachly/credentials.json (dort legt ihn
 * der Sofort-Test ab) oder ausdruecklich aus --key. NICHT aus der .mcp.json des
 * Projekts und NICHT aus der Umgebung: Beide kann ein fremdes Repository setzen
 * (.mcp.json, .envrc). Wer dort seinen eigenen Test-Schluessel hinterlegt,
 * bekaeme sonst sein Brain samt Lektionen in dein Konto geschoben — und dein
 * Agent laese danach seine Lektionen.
 *
 * Alle Netzaufrufe laufen ueber ein mitgegebenes fetch — so sind sie ohne
 * Netz pruefbar (uebernahme.test.ts).
 */

export const KEYCLOAK_BASIS = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
export const CLI_CLIENT = 'cachly-cli';
export const TEST_KEY_KOPF = 'X-Trial-Key';

type Abruf = typeof fetch;

/** Ein Test-Schluessel beginnt mit cky_trial_ (POST /auth/instant-trial). */
export function istTestSchluessel(wert: string | undefined | null): wert is string {
  return typeof wert === 'string' && /^cky_trial_[A-Za-z0-9]{8,}$/.test(wert.trim());
}

/**
 * Waehlt den Test-Schluessel: --key, dann credentials.json. Nur ein Schluessel
 * der Form cky_trial_ zaehlt.
 */
export function waehleTestSchluessel(q: {
  argument?: string;
  credentials?: string;
}): { schluessel: string; quelle: 'argument' | 'credentials' } | null {
  if (istTestSchluessel(q.argument)) return { schluessel: q.argument.trim(), quelle: 'argument' };
  if (istTestSchluessel(q.credentials)) return { schluessel: q.credentials.trim(), quelle: 'credentials' };
  return null;
}

// ── Anmeldung: Keycloak-Geraete-Anmeldung (RFC 8628) ─────────────────────────

export interface Geraetecode {
  deviceCode: string;
  userCode: string;
  /** Die Adresse mit eingesetztem Code. */
  adresse: string;
  intervallMs: number;
  /** Epoch-ms, ab dann gilt der Code nicht mehr. */
  frist: number;
}

/**
 * Startet die Anmeldung direkt bei Keycloak. NICHT ueber /auth/device der
 * cachly-API: Die gibt am Ende einen API-Schluessel aus, und ein Schluessel
 * ist fuer die Uebernahme gerade KEINE Anmeldung.
 */
export async function starteKeycloakAnmeldung(abruf: Abruf, basis = KEYCLOAK_BASIS, jetzt = Date.now()): Promise<Geraetecode> {
  const res = await abruf(`${basis}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLI_CLIENT, scope: 'openid' }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`sign-in could not start (HTTP ${res.status})`);
  const d = await res.json() as {
    device_code?: string; user_code?: string; verification_uri?: string;
    verification_uri_complete?: string; interval?: number; expires_in?: number;
  };
  if (!d.device_code || !d.user_code) throw new Error('sign-in could not start (no device code)');
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    adresse: d.verification_uri_complete ?? d.verification_uri ?? `${basis.replace(/\/protocol\/openid-connect$/, '')}/device`,
    intervallMs: Math.max(1, d.interval ?? 5) * 1000,
    frist: jetzt + Math.max(60, d.expires_in ?? 600) * 1000,
  };
}

export type Abfrage =
  | { art: 'token'; token: string }
  | { art: 'warten' }
  | { art: 'langsamer' }
  | { art: 'fehler'; grund: string };

/** Fragt einmal nach, ob die Anmeldung im Browser bestaetigt ist. */
export async function frageAnmeldungAb(abruf: Abruf, code: Geraetecode, basis = KEYCLOAK_BASIS): Promise<Abfrage> {
  let res: Response;
  try {
    res = await abruf(`${basis}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLI_CLIENT,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.deviceCode,
      }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { art: 'warten' }; // Netz-Aussetzer: weiter fragen
  }
  if (res.status >= 500) return { art: 'warten' };
  const d = await res.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (d.access_token) return { art: 'token', token: d.access_token };
  if (d.error === 'authorization_pending') return { art: 'warten' };
  if (d.error === 'slow_down') return { art: 'langsamer' };
  return { art: 'fehler', grund: d.error ?? `HTTP ${res.status}` };
}

/** Wartet, bis die Anmeldung bestaetigt, abgelehnt oder abgelaufen ist. */
export async function warteAufKeycloakAnmeldung(
  abruf: Abruf,
  code: Geraetecode,
  o: { basis?: string; schlafe?: (ms: number) => Promise<void>; jetzt?: () => number; puls?: () => void } = {},
): Promise<string> {
  const schlafe = o.schlafe ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const jetzt = o.jetzt ?? Date.now;
  let takt = code.intervallMs;
  while (jetzt() < code.frist) {
    await schlafe(takt);
    o.puls?.();
    const a = await frageAnmeldungAb(abruf, code, o.basis);
    if (a.art === 'token') return a.token;
    if (a.art === 'langsamer') takt = Math.min(takt + 5000, 30_000);
    if (a.art === 'fehler') throw new Error(`sign-in failed: ${a.grund}`);
  }
  throw new Error('sign-in timed out');
}

// ── Die Uebernahme ──────────────────────────────────────────────────────────

export interface UebernahmeAntwort {
  apiKey: string;
  instanceId: string;
  instances: string[];
  accountCreated: boolean;
  revokedKeys: number;
  brainRestarting: boolean;
}

export class UebernahmeFehler extends Error {
  constructor(public status: number, public reason: string, message: string) {
    super(message);
    this.name = 'UebernahmeFehler';
  }
}

/**
 * POST /auth/trial/claim mit Anmeldung UND Test-Schluessel. Wirft
 * UebernahmeFehler mit dem Grund des Servers.
 */
export async function uebernimm(
  abruf: Abruf,
  apiUrl: string,
  anmeldeToken: string,
  testSchluessel: string,
  client: 'mcp' | 'vscode' | 'jetbrains' = 'mcp',
  userAgent?: string,
): Promise<UebernahmeAntwort> {
  if (anmeldeToken.startsWith('cky_')) {
    // Der Server wiese es ohnehin ab; so steht der Grund schon hier.
    throw new UebernahmeFehler(403, 'sign_in_required', 'An API key is not a sign-in.');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${anmeldeToken}`,
    [TEST_KEY_KOPF]: testSchluessel,
  };
  if (userAgent) headers['User-Agent'] = userAgent;
  const res = await abruf(`${apiUrl.replace(/\/+$/, '')}/auth/trial/claim`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ client }),
    // Der Server wartet, bis das Brain nach dem Neustart sein neues Passwort
    // bestaetigt (hoechstens 60 s), und gibt sich selbst 120 s.
    signal: AbortSignal.timeout(150_000),
  });
  const d = await res.json().catch(() => ({})) as {
    api_key?: string; instance_id?: string; instances?: string[]; account_created?: boolean;
    revoked_keys?: number; brain_restarting?: boolean; error?: string; reason?: string;
  };
  if (!res.ok || !d.api_key || !d.instance_id) {
    throw new UebernahmeFehler(res.status, d.reason ?? 'unknown', d.error ?? `HTTP ${res.status}`);
  }
  return {
    apiKey: d.api_key,
    instanceId: d.instance_id,
    instances: d.instances ?? [d.instance_id],
    accountCreated: d.account_created === true,
    revokedKeys: d.revoked_keys ?? 0,
    brainRestarting: d.brain_restarting !== false,
  };
}

/**
 * Prueft mit dem NEUEN Schluessel, ob das Brain im Konto erreichbar ist.
 * Erst dann sagt der Text "Lessons kept" — nicht auf blosses Vertrauen.
 */
export async function brainImKonto(abruf: Abruf, apiUrl: string, neuerSchluessel: string, instanzId: string): Promise<boolean> {
  try {
    const res = await abruf(`${apiUrl.replace(/\/+$/, '')}/api/v1/instances/${encodeURIComponent(instanzId)}`, {
      headers: { Authorization: `Bearer ${neuerSchluessel}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const d = await res.json().catch(() => ({})) as { id?: string };
    return d.id === instanzId;
  } catch {
    return false;
  }
}

/** Der Satz fuer den Menschen nach einer gelungenen Uebernahme. */
export function erfolgsText(a: UebernahmeAntwort, bestaetigt: boolean): string {
  const zeilen = bestaetigt
    ? ['Your test Brain is now part of your account. Lessons kept.']
    : ['Your test Brain was moved to your account, but the new key could not reach it yet. '
      + 'Run `npx @cachly-dev/mcp-server@latest status` in a minute to check.'];
  zeilen.push(`Brain: ${a.instanceId}${a.accountCreated ? ' (a new cachly account was created for your sign-in)' : ''}`);
  zeilen.push(`The test key no longer works (${a.revokedKeys} key${a.revokedKeys === 1 ? '' : 's'} revoked). The new key is stored for you.`);
  if (a.brainRestarting) zeilen.push('The Brain restarts once with a new password — about 20 seconds.');
  return zeilen.join('\n');
}

/** Der Satz fuer den Menschen, wenn es nicht geklappt hat. Nichts ist dann veraendert. */
export function fehlerText(e: unknown): string {
  if (!(e instanceof UebernahmeFehler)) {
    return `The Brain was not moved: ${(e as Error)?.message ?? String(e)}. Nothing was changed.`;
  }
  switch (e.reason) {
    case 'trial_key_invalid':
      return 'This test key is unknown or was already claimed. Nothing was changed.';
    case 'not_a_test_account':
      return 'This key belongs to a regular account, not to a test Brain. There is nothing to claim.';
    case 'sign_in_required':
      return 'The sign-in was not accepted. Run the command again and finish the sign-in in the browser.';
    case 'claim_unavailable':
      return 'Moving the Brain is not possible right now. Nothing was changed. Please try again later.';
    default:
      return `${e.message}${/nothing/i.test(e.message) ? '' : ' Nothing was changed.'}`;
  }
}

/** Ersetzt den alten Schluessel woertlich durch den neuen. Liefert, ob etwas ersetzt wurde. */
export function ersetzeSchluessel(text: string, alt: string, neu: string): { text: string; ersetzt: boolean } {
  if (!alt || !text.includes(alt)) return { text, ersetzt: false };
  return { text: text.split(alt).join(neu), ersetzt: true };
}
