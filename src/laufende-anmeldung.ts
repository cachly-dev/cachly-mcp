/**
 * Eine laufende Geraete-Anmeldung ueberlebt den Prozess.
 *
 * ── Warum (19.11.2026) ────────────────────────────────────────────────────
 *
 * Gemessen im API-Protokoll vom 10. bis 19.11.: 46 Geraete-Codes ausgegeben,
 * 1 freigegeben. Eine Person in Brasilien bekam am 17.11. in Folge 13
 * verschiedene Codes, und zu jedem Code fragte ihr Rechner nur ein- bis
 * zweimal nach. Der MCP-Prozess lebte also jeweils nur fuer einen
 * Werkzeugaufruf. Jeder neue Prozess wusste nichts vom Code davor und
 * erzeugte einen neuen. Wer den ersten Link geoeffnet hatte, gab einen Code
 * frei, nach dem niemand mehr fragte.
 *
 * Jetzt merkt sich der Prozess den Code in `~/.cachly/anmeldung-laeuft.json`.
 * Der naechste Prozess nimmt denselben Code und fragt weiter nach, solange er
 * gilt. Nach Erfolg oder Ablauf verschwindet die Datei.
 *
 * Der Geraete-Code ist kein Schluessel, aber nach der Freigabe holt man mit
 * ihm einmalig den Schluessel ab. Deshalb liegt er neben `credentials.json`,
 * nur fuer den Eigentuemer lesbar (0600, unter Windows ohne Wirkung).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface GemerkteAnmeldung {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  /** Abfrageabstand in ms. */
  pollInterval: number;
  /** Ablauf als epoch ms. */
  deadline: number;
  /** Die API, bei der der Code gilt. Ein Code einer anderen API zaehlt nicht. */
  apiUrl: string;
}

export interface AnmeldungOptionen {
  /** Ueberschreibt das Heimverzeichnis (Tests). */
  home?: string;
  /** Jetzt als epoch ms (Tests). */
  jetzt?: number;
}

/**
 * Ein Code mit weniger Restzeit wird nicht mehr weitergegeben. Wer ihn jetzt
 * erst liest, schafft Konto und Freigabe nicht mehr; ein frischer Code ist
 * dann ehrlicher.
 */
export const MINDEST_RESTZEIT_MS = 2 * 60_000;

function heim(opts: AnmeldungOptionen): string {
  return opts.home ?? process.env.HOME ?? process.env.USERPROFILE ?? process.env.APPDATA ?? '';
}

export function anmeldungPfad(opts: AnmeldungOptionen = {}): string {
  return resolve(heim(opts), '.cachly', 'anmeldung-laeuft.json');
}

function istGemerkteAnmeldung(x: unknown): x is GemerkteAnmeldung {
  if (!x || typeof x !== 'object') return false;
  const a = x as Record<string, unknown>;
  return typeof a.deviceCode === 'string' && a.deviceCode.length > 0
    && typeof a.userCode === 'string' && a.userCode.length > 0
    && typeof a.verifyUrl === 'string' && /^https?:\/\//.test(a.verifyUrl)
    && typeof a.pollInterval === 'number' && a.pollInterval > 0
    && typeof a.deadline === 'number'
    && typeof a.apiUrl === 'string';
}

/**
 * Liest die gemerkte Anmeldung, wenn sie zur selben API gehoert und noch
 * mindestens {@link MINDEST_RESTZEIT_MS} gilt. Sonst `null`; eine abgelaufene
 * oder kaputte Datei wird dabei entfernt. Wirft nie.
 */
export function ladeLaufendeAnmeldung(apiUrl: string, opts: AnmeldungOptionen = {}): GemerkteAnmeldung | null {
  const pfad = anmeldungPfad(opts);
  let roh: unknown;
  try {
    roh = JSON.parse(readFileSync(pfad, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') loesche(pfad);
    return null;
  }
  if (!istGemerkteAnmeldung(roh)) {
    loesche(pfad);
    return null;
  }
  const jetzt = opts.jetzt ?? Date.now();
  if (roh.deadline - jetzt < MINDEST_RESTZEIT_MS) {
    loesche(pfad);
    return null;
  }
  if (roh.apiUrl !== apiUrl) return null;
  return roh;
}

/** Merkt die Anmeldung (Temp-Datei + Umbenennen, 0600). Wirft nie. */
export function merkeAnmeldung(a: GemerkteAnmeldung, opts: AnmeldungOptionen = {}): void {
  try {
    const ziel = anmeldungPfad(opts);
    mkdirSync(dirname(ziel), { recursive: true });
    const tmp = `${ziel}.${process.pid}-${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(a, null, 2), 'utf8');
    try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
    renameSync(tmp, ziel);
  } catch { /* Merken ist Bequemlichkeit; die Anmeldung laeuft auch ohne */ }
}

/**
 * Entfernt die gemerkte Anmeldung, aber nur, wenn sie zu `deviceCode` gehoert.
 * Ein anderer Prozess kann inzwischen einen neueren Code gemerkt haben; den
 * loescht ein alter Code nicht. Wirft nie.
 */
export function vergissAnmeldung(deviceCode: string, opts: AnmeldungOptionen = {}): void {
  const pfad = anmeldungPfad(opts);
  try {
    const roh = JSON.parse(readFileSync(pfad, 'utf8')) as Partial<GemerkteAnmeldung>;
    if (roh?.deviceCode !== deviceCode) return;
  } catch {
    return;
  }
  loesche(pfad);
}

function loesche(pfad: string): void {
  try { unlinkSync(pfad); } catch { /* schon weg */ }
}
