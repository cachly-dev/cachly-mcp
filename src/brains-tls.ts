// Welcher Weg fuehrt zur Instanz: TLS oder Klartext? (Brains-TLS Stufe 2)
//
// ── Warum es das gibt (19.10.2026) ──────────────────────────────────────────
//
// Verwaltete Brains sprachen bis Stufe 1 nur `redis://` ohne TLS ueber einen
// oeffentlichen Port — Passwort und Lektionen im Klartext durchs Internet
// (Lektion sicherheit:valkey-instanzen-ohne-tls-ueber-oeffentliche-ports).
// Seit Stufe 1 (API, provisioner/k8s_tls.go) hoert jede umgestellte Instanz
// zusaetzlich auf einem TLS-Port, und GET /instances/:id/connection nennt ihn
// (`tls_port`) samt dem Zertifikat der eigenen Stelle (`tls_ca`).
//
// ── Die Regel ───────────────────────────────────────────────────────────────
//
//   1. Nennt die API tls_port UND tls_ca → TLS auf diesem Port, geprueft gegen
//      die eigene Stelle (zusaetzlich zur System-Liste, damit ein spaeterer
//      Wechsel auf ein oeffentliches Zertifikat nichts bricht).
//   2. Sonst tls_enabled (BYOC mit rediss://) → TLS wie bisher, System-Liste.
//   3. Sonst Klartext — genau wie vor Stufe 2.
//
// Ausdruecklich KEIN stiller Rueckfall auf Klartext, wenn TLS scheitert: wer
// den TLS-Port blockiert, koennte sonst den Klartext erzwingen. Fuer den
// Notfall gibt es CACHLY_BRAINS_TLS=aus.

import { rootCertificates, type ConnectionOptions } from 'node:tls';

/** Was GET /api/v1/instances/:id/connection fuer die Wegwahl liefert. */
export interface VerbindungsAuskunft {
  password?: string;
  tls_enabled?: boolean;
  tls_port?: number;
  tls_ca?: string;
}

export interface VerbindungsWeg {
  host: string;
  port: number;
  /** undefined = Klartext. */
  tls?: ConnectionOptions;
  /** Fuer Meldungen: welcher Weg gewaehlt wurde. */
  art: 'tls-eigene-stelle' | 'tls-system' | 'klartext';
}

export function verbindungsWeg(
  inst: { host: string; port: number; tls_enabled?: boolean },
  auskunft: VerbindungsAuskunft | undefined,
  env: Record<string, string | undefined> = process.env,
): VerbindungsWeg {
  const tlsErlaubt = env.CACHLY_BRAINS_TLS !== 'aus';
  const tlsPort = Number(auskunft?.tls_port ?? 0);
  const ca = typeof auskunft?.tls_ca === 'string' ? auskunft.tls_ca : '';
  if (tlsErlaubt && Number.isInteger(tlsPort) && tlsPort > 0 && ca.includes('BEGIN CERTIFICATE')) {
    return { host: inst.host, port: tlsPort, tls: { ca: [...rootCertificates, ca] }, art: 'tls-eigene-stelle' };
  }
  // Wie vor Stufe 2: ohne Auskunft gilt inst.tls_enabled, Vorgabe true.
  const tlsEnabled = auskunft ? auskunft.tls_enabled !== false : inst.tls_enabled !== false;
  if (tlsEnabled) {
    return { host: inst.host, port: inst.port, tls: {}, art: 'tls-system' };
  }
  return { host: inst.host, port: inst.port, art: 'klartext' };
}
