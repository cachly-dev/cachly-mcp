// Zeitmessung — Messpunkte auf stderr, standardmaessig AUS.
//
// ── Warum es das gibt (11.10.2026) ──────────────────────────────────────────
//
// Probe von aussen mit 0.10.176: ein frisch angelegtes, LEERES Brain brauchte
// 18,5 s bis zur ersten Antwort auf smart_recall. Wo die Zeit blieb, war von
// aussen nicht zu sehen — nur der Beginn (Test-Brain nach ~1 s) und ein
// stderr-Hinweis nach 11,2 s. Mit CACHLY_ZEITMESSUNG=1 schreibt der Server an
// den Stellen, die auf dem Weg zur ersten Antwort Zeit kosten koennen, eine
// Zeile mit den Millisekunden seit Prozessstart.
//
// Ohne die Variable tut `zeitpunkt` nichts: keine Ausgabe, kein Speicher.

import { performance } from 'node:perf_hooks';

/** Ist die Messausgabe eingeschaltet? Wird bei jedem Aufruf gelesen (Tests). */
export function zeitmessungAn(env: Record<string, string | undefined> = process.env): boolean {
  return /^(1|true|on|an|ja|yes)$/i.test((env.CACHLY_ZEITMESSUNG ?? '').trim());
}

/**
 * Ein Messpunkt: `[zeit] +<ms seit Prozessstart> <was>` auf stderr.
 * Tut nichts, wenn CACHLY_ZEITMESSUNG nicht gesetzt ist.
 */
export function zeitpunkt(was: string): void {
  if (!zeitmessungAn()) return;
  process.stderr.write(`[zeit] +${Math.round(performance.now())} ms ${was}\n`);
}
