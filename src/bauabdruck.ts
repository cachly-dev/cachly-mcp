// Bauabdruck: zeigt, welcher Stand des Servers gerade laeuft.
//
// Zwei Bauten koennen dieselbe Versionsnummer tragen und trotzdem
// verschiedenen Code ausfuehren. Gemessen am 20.08.2026: package.json sagte
// beim installierten UND beim aktuellen Server 0.10.124 — der installierte
// dist/ hatte den Code aus instances.ts (get_connection_string) trotzdem
// nicht. Von aussen war das nicht zu unterscheiden. Der Bauabdruck macht den
// Commit sichtbar, nicht nur die Versionsnummer.
//
// Die echten Werte kommen aus scripts/bauabdruck.mjs, das beim Bauen
// (`npm run build`) eine JSON-Datei daneben schreibt. Diese Datei ist
// generiert und steht darum in .gitignore. DIESE Datei (bauabdruck.ts) ist
// eingecheckt und bleibt es — sie ist die Rueckfall-Fassung, die einspringt,
// wenn noch nie gebaut wurde. Genau das prueft CI im Schritt "Type check":
// `tsc --noEmit` laeuft dort OHNE vorherigen `npm run build`.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Bauabdruck {
  version: string;
  commit: string;
  /** ISO-Zeitstempel, oder "unbekannt" solange nie gebaut wurde. */
  gebautAm: string;
}

/** Rueckfall, solange kein Bauabdruck generiert wurde (kein Absturz, keine Erfindung). */
export const RUECKFALL_BAUABDRUCK: Bauabdruck = {
  version: 'unbekannt',
  commit: 'unbekannt',
  gebautAm: 'unbekannt',
};

function istBauabdruck(wert: unknown): wert is Bauabdruck {
  if (typeof wert !== 'object' || wert === null) return false;
  const w = wert as Record<string, unknown>;
  return typeof w.version === 'string' && typeof w.commit === 'string' && typeof w.gebautAm === 'string';
}

/**
 * Laedt den generierten Bauabdruck aus dem eigenen Verzeichnis.
 *
 * Faellt auf RUECKFALL_BAUABDRUCK zurueck, wenn die Datei fehlt, kein gueltiges
 * JSON enthaelt oder die falsche Form hat — ein fehlender Bauabdruck ist kein
 * Grund, den Server gar nicht erst zu starten.
 */
export function ladeBauabdruck(verzeichnis: string = dirname(fileURLToPath(import.meta.url))): Bauabdruck {
  const pfad = join(verzeichnis, 'bauabdruck-daten.generiert.json');
  if (!existsSync(pfad)) return RUECKFALL_BAUABDRUCK;
  try {
    const wert: unknown = JSON.parse(readFileSync(pfad, 'utf-8'));
    return istBauabdruck(wert) ? wert : RUECKFALL_BAUABDRUCK;
  } catch {
    return RUECKFALL_BAUABDRUCK;
  }
}

/** Der Bauabdruck dieses laufenden Prozesses — einmal beim Start geladen. */
export const bauabdruck: Bauabdruck = ladeBauabdruck();

/** Ab wie vielen Tagen der Bauabdruck in brain_doctor als alt gilt (🟡). */
export const ALTER_SCHWELLE_TAGE = 14;

/**
 * Der Waechter: ist der Bauabdruck aelter als die Schwelle?
 *
 * Eigene Funktion, damit sie einzeln aufrufbar und pruefbar ist — aus
 * demselben Grund wie beurteileDeckung in eingaenge.ts: ein Wächter, den man
 * nicht einzeln aufrufen kann, ist ein Wächter, dessen Nein niemand je sieht.
 * "unbekannt" gilt NICHT als alt — ein Server, der nie gebaut wurde, ist ein
 * anderer Zustand als einer, der seit Wochen laeuft.
 */
export function istAlt(gebautAm: string, jetzt: Date = new Date()): boolean {
  const datum = new Date(gebautAm);
  if (Number.isNaN(datum.getTime())) return false;
  const tage = (jetzt.getTime() - datum.getTime()) / 86_400_000;
  return tage > ALTER_SCHWELLE_TAGE;
}

/**
 * Baut die Zeile fuer brain_doctor — Form und Ton wie die Zeile
 * "Semantic coverage" dort: Emoji, Fettdruck-Label, Zahlen statt Adjektive.
 *
 * Ein Server, der seit Wochen laeuft, ist kein Fehler — aber man muss es
 * sehen koennen. Darum 🟡 statt ❌ fuer den Altersfall.
 */
export function formatiereBauabdruck(a: Bauabdruck, jetzt: Date = new Date()): string {
  if (a.gebautAm === 'unbekannt') {
    return `❔ **Bauabdruck: unbekannt** — noch kein \`npm run build\` gelaufen, Version/Commit nicht feststellbar`;
  }
  const datum = new Date(a.gebautAm);
  const gueltigesDatum = !Number.isNaN(datum.getTime());
  const alt = gueltigesDatum && istAlt(a.gebautAm, jetzt);
  const tage = gueltigesDatum ? Math.floor((jetzt.getTime() - datum.getTime()) / 86_400_000) : null;
  const alterText = tage === null ? '' : ` (vor ${tage} Tag${tage === 1 ? '' : 'en'})`;
  const emoji = alt ? '🟡' : '✅';
  const hinweis = alt
    ? ` — laeuft laenger als ${ALTER_SCHWELLE_TAGE} Tage. Kein Fehler, aber sichtbar.`
    : '';
  const datumsText = gueltigesDatum ? a.gebautAm.slice(0, 10) : a.gebautAm;
  return `${emoji} **Bauabdruck:** v${a.version} · commit \`${a.commit}\` · gebaut am ${datumsText}${alterText}${hinweis}`;
}
