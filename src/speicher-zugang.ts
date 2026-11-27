/**
 * Die Anmeldung am Speicher eines Brains (Stufe 2, Bauplan A5, 27.11.2026).
 *
 * Aus baueVerbindung (index.ts) herausgeloest, damit die Tests genau das
 * pruefen koennen, was der Redis-Client bekommt:
 *
 *   holeVerbindungsAuskunft  GET /connection. Antwort 409
 *                            member_access_unavailable: EIN klarer Satz, und
 *                            danach KEIN Verbindungsversuch (vorher ging es
 *                            ohne Passwort weiter und endete in NOAUTH).
 *   anmeldungAus             Benutzername nur, wenn die API einen nennt
 *                            (Mitglied, `access: "member"`).
 *   baueSpeicherClient       new Redis(...) mit dieser Anmeldung; die
 *                            Verbindung eines Mitglieds laeuft durch die
 *                            Huelle, die NOPERM uebersetzt (rolle.ts).
 *
 * Besitzer und Admins: dieselben Optionen wie vor Stufe 2 (nur Passwort).
 */

import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { VerbindungsAuskunft } from './brains-tls.js';
import { alsMitgliedsSpeicher, apiFehler, CODE_ZUGANG_NICHT_VERFUEGBAR, zugangNichtVerfuegbarText } from './rolle.js';

export interface Anmeldung {
  /** Eigener Benutzer eines Mitglieds (m-<16 hex>); fehlt bei Besitzer und Admin. */
  username?: string;
  password?: string;
  /** true bei `access: "member"`: eingeschraenkter Benutzer, Huelle um den Client. */
  mitglied: boolean;
  role?: string;
}

/**
 * Holt die Zugangsdaten. Wirft bei 409 member_access_unavailable den Satz
 * (zugangNichtVerfuegbarText) und bei 401/403 wie bisher "API key rejected".
 * Andere Fehler (Zeitlimit, 500): undefined, die Verbindung versucht es wie
 * bisher ohne Passwort.
 */
export async function holeVerbindungsAuskunft(
  holen: () => Promise<VerbindungsAuskunft>,
  brainName: string,
): Promise<VerbindungsAuskunft | undefined> {
  try {
    return await holen();
  } catch (connErr) {
    // Stufe 2: Ein Mitglied bekommt gerade keinen eigenen Zugang. Ein klarer
    // Satz, KEIN Versuch ohne Passwort, und nie das volle Passwort als Ersatz.
    const f = apiFehler(connErr);
    if (f.status === 409 && f.code === CODE_ZUGANG_NICHT_VERFUEGBAR) {
      throw new McpError(ErrorCode.InvalidRequest, zugangNichtVerfuegbarText(brainName, f.reason));
    }
    // If the connection endpoint fails and the instance has a password, we cannot connect.
    // Surface the error so the user knows why Redis auth will fail rather than getting a cryptic NOAUTH.
    const msg = connErr instanceof Error ? connErr.message : String(connErr);
    if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
      throw new McpError(ErrorCode.InvalidRequest,
        `API key rejected — run \`cachly setup\` to refresh your credentials.`);
    }
    // Other failures (timeout, 500): proceed without password, Redis will surface NOAUTH if needed
    return undefined;
  }
}

/** Wie sich der Client anmeldet, aus der Antwort von /connection. */
export function anmeldungAus(auskunft: VerbindungsAuskunft | undefined): Anmeldung {
  const username = typeof auskunft?.username === 'string' && auskunft.username ? auskunft.username : undefined;
  const password = typeof auskunft?.password === 'string' && auskunft.password ? auskunft.password : undefined;
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    mitglied: auskunft?.access === 'member',
    ...(typeof auskunft?.role === 'string' ? { role: auskunft.role } : {}),
  };
}

/**
 * Die Anmelde-Optionen fuer new Redis(). Ohne Benutzername waere das
 * Mitglieds-Passwort beim Standardbenutzer WRONGPASS.
 */
export function anmeldeOptionen(a: Anmeldung): { username?: string; password?: string } {
  return { ...(a.username ? { username: a.username } : {}), password: a.password || undefined };
}

/** Baut den Client mit dieser Anmeldung; ein Mitglied bekommt die Huelle (rolle.ts). */
export function baueSpeicherClient<R extends object>(
  Klasse: new (optionen: Record<string, unknown>) => R,
  basis: Record<string, unknown>,
  anmeldung: Anmeldung,
  instanceId: string,
): { roh: R; nutzbar: R } {
  const roh = new Klasse({ ...basis, ...anmeldeOptionen(anmeldung) });
  const nutzbar = anmeldung.mitglied
    ? alsMitgliedsSpeicher(roh, { role: anmeldung.role, username: anmeldung.username, instanceId })
    : roh;
  return { roh, nutzbar };
}
