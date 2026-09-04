/**
 * Herkunft einer Lektion: WER hat sie geschrieben (Karte y48oajjojklf).
 *
 * Eine Lektion wusste bisher, WANN sie geschrieben wurde (ts) und WAS lief
 * (Befehl, Ergebnis) — aber nicht, WER: welcher Agent, unter welchem Konto.
 * Sobald mehrere Agenten oder Teammitglieder in ein Brain schreiben, kann
 * "neuer gewinnt" keinen Widerspruch mehr erklaeren (Edward Izgorodin,
 * 02.09.2026: "Bi-temporality is a degenerate provenance model — it keeps
 * the when of an assertion and discards the who").
 *
 * Reihenfolge: erst Identitaet speichern, dann (spaeter, andere Karte) eine
 * Autoritaetsregel. Hier wird NUR gespeichert, nie gewichtet.
 *
 * Der Schluessel selbst verlaesst den Prozess nie: `principal` ist ein
 * Fingerabdruck (sha256, 12 Zeichen) oder das `sub` eines JWT.
 */

import { createHash } from 'node:crypto';

export interface LektionsQuelle {
  /** Welcher Agent schrieb: CACHLY_AGENT, sonst der MCP-Client (Name/Version), sonst "unbekannt". */
  agent: string;
  /** Unter welchem Konto: key:<fingerabdruck> oder sub:<jwt-sub>; fehlt ohne Zugangsdaten. */
  principal?: string;
  /** Ueber welchen Weg die Lektion kam. */
  via: 'mcp';
}

let clientKennung = '';

/** Vom MCP-Server nach dem Handshake gesetzt (Name und Version des Clients). */
export function setzeClientKennung(name?: string, version?: string): void {
  const n = String(name ?? '').trim();
  const v = String(version ?? '').trim();
  clientKennung = n ? (v ? `${n}/${v}` : n) : '';
}

export function clientKennungFuerTests(): string {
  return clientKennung;
}

function jwtSub(token: string): string {
  const teile = token.split('.');
  if (teile.length !== 3) return '';
  try {
    const roh = Buffer.from(teile[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const sub = (JSON.parse(roh) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub.slice(0, 64) : '';
  } catch {
    return '';
  }
}

export function ermittleQuelle(env: NodeJS.ProcessEnv = process.env): LektionsQuelle {
  const agent = String(env.CACHLY_AGENT ?? '').trim() || clientKennung || 'unbekannt';
  const token = String(env.CACHLY_JWT ?? '').trim();
  let principal: string | undefined;
  if (token) {
    const sub = jwtSub(token);
    principal = sub ? `sub:${sub}` : `key:${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
  }
  return { agent, ...(principal ? { principal } : {}), via: 'mcp' };
}

/** Die Zeile fuer den Abruf: Autor, Agent, Konto — "Urheber unbekannt", wenn nichts da ist. */
export function quelleZeile(author: string | undefined, quelle: LektionsQuelle | undefined): string {
  const teile: string[] = [];
  if (author) teile.push(`@${author}`);
  if (quelle?.agent && quelle.agent !== 'unbekannt') teile.push(`via ${quelle.agent}`);
  if (quelle?.principal) teile.push(quelle.principal);
  return teile.length > 0 ? `👤 **Source:** ${teile.join(' · ')}` : '👤 **Source:** Urheber unbekannt';
}
