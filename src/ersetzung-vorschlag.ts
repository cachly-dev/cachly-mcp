import { inhaltsWoerter, grobStamm } from './rangfolge.js';

/**
 * ══ Der Ersetzungs-Vorschlag beim Schreiben ═══════════════════════════════
 *
 * ── Der Befund, der das erzwingt (31.08.2026, Karte i3zn0u2e1kf8) ─────────
 *
 * 642 Lektionen im eigenen Bestand, NULL mit ersetzt_durch. Die Kante
 * (Banner, Verdrängung, gilt_bis, Etiketten, Netto-Kennzahl hängen alle
 * daran) wird beim echten Schreiben schlicht nie gesetzt — am 20.08. waren
 * 47 von 521 Lektionen TEXTLICH Korrekturen einer früheren, verknüpft war
 * keine. Ein Feld, das niemand setzt, trägt nichts.
 *
 * ── Vorschlagen, nie automatisch setzen ───────────────────────────────────
 *
 * Eine falsche Kante ist schlimmer als keine (dieselbe Regel wie bei den
 * abgeleiteten Tatsachen): die alte Lektion würde zu Unrecht verdrängt und
 * als Geschichte etikettiert. Deshalb nur ein HINWEIS mit dem gelesenen
 * Beleg — setzen muss der Schreiber.
 *
 * ── Die Heuristik, absichtlich eng ────────────────────────────────────────
 *
 * Vorgeschlagen wird nur, wenn BEIDES zutrifft:
 *   1. NÄHE: die Themen teilen Wortstämme (>= halbe Überlappung) ODER die
 *      Inhaltswörter der Texte überlappen deutlich (Jaccard >= 0,3).
 *   2. GEGENAUSSAGE: der neue Text trägt ein Korrektur-Signalwort
 *      ("doch nicht", "stattdessen", "in Wahrheit", "widerlegt", …).
 * Eng heißt: lieber einen echten Fall verpassen als bei jedem zweiten
 * Schreiben einen Fehlvorschlag zeigen, den man sich abgewöhnt zu lesen.
 */

const SIGNALE = /\b(nicht mehr|doch nicht|stattdessen|statt dessen|in wahrheit|widerlegt|war falsch|stimmt nicht|korrektur|korrigiert|entgegen|no longer|instead|actually|turned out|wrong|superseded)\b/i;

export type VorschlagsKandidat = {
  topic: string;
  what_worked?: string;
};

function staemme(text: string): Set<string> {
  return new Set([...inhaltsWoerter(text)].map(grobStamm));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let schnitt = 0;
  for (const x of a) if (b.has(x)) schnitt++;
  return schnitt / (a.size + b.size - schnitt);
}

/** Themen-Nähe: geteilte Slug-Stämme, gemessen an der KLEINEREN Menge. */
export function themenNaehe(a: string, b: string): number {
  const sa = staemme(a.replace(/[:\-_/.]+/g, ' '));
  const sb = staemme(b.replace(/[:\-_/.]+/g, ' '));
  if (sa.size === 0 || sb.size === 0) return 0;
  let schnitt = 0;
  for (const x of sa) if (sb.has(x)) schnitt++;
  return schnitt / Math.min(sa.size, sb.size);
}

/**
 * Der eine Vorschlag — oder null. Nennt IMMER den Beleg (Signalwort +
 * Nähe), damit der Schreiber die Heuristik prüfen kann statt ihr zu
 * glauben.
 */
export function schlageErsetzungVor(
  neuesTopic: string,
  neuerText: string,
  kandidaten: readonly VorschlagsKandidat[],
): string | null {
  const signal = neuerText.match(SIGNALE);
  if (!signal) return null;

  const neueWoerter = staemme(neuerText);
  let bester: { topic: string; grund: string; wert: number } | null = null;
  for (const k of kandidaten) {
    if (k.topic === neuesTopic) continue; // gleiche Kante = normaler Update-Pfad
    const tn = themenNaehe(neuesTopic, k.topic);
    const tj = jaccard(neueWoerter, staemme(k.what_worked ?? ''));
    if (tn >= 0.5) {
      if (!bester || tn > bester.wert) {
        bester = { topic: k.topic, grund: `Themen-Naehe ${(100 * tn).toFixed(0)} %`, wert: tn };
      }
    } else if (tj >= 0.3) {
      if (!bester || tj > bester.wert) {
        bester = { topic: k.topic, grund: `Text-Ueberlappung ${(100 * tj).toFixed(0)} %`, wert: tj };
      }
    }
  }
  if (!bester) return null;

  return (
    `🔁 Das klingt wie eine Korrektur von \`${bester.topic}\` `
    + `("${signal[0]}" + ${bester.grund}). Wenn ja: dieselbe Lektion noch einmal mit `
    + `\`ersetzt="${bester.topic}"\` schreiben — dann wird die alte Fassung im Abruf `
    + `verdraengt statt weiter als aktuell geliefert. Wenn nein: nichts zu tun.`
  );
}
