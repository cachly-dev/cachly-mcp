/**
 * Was tut der Speicher WIRKLICH — nicht, was für ihn vorgesehen war.
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────────
 *
 * Am 20.08.2026 stand ein Bestand bei 23,6 MB von 25 MB Tarifgrenze und lief
 * dabei auf der Räumungsregel `allkeys-lru`. Diese Regel löscht bei Platzmangel
 * die am längsten ungenutzte Lektion — ohne Meldung, ohne Fehler, ohne Spur.
 * Genau die alten, selten gebrauchten Lektionen sind aber oft die wertvollen.
 *
 * Das Ärgerliche daran: der Code war seit April richtig. `evictionPolicy` gibt
 * für jeden Tarif `volatile-lru` zurück, und ein Test bewacht das seither. Die
 * laufende Instanz hatte trotzdem `allkeys-lru`, weil ein Container den
 * Startbefehl behält, mit dem er erzeugt wurde. Eine Regeländerung im Code
 * erreicht bestehende Instanzen NICHT.
 *
 * Ein Test beweist die Absicht. Diese Prüfung misst den Zustand. Das ist nicht
 * dieselbe Frage, und die zweite hat monatelang niemand gestellt.
 *
 * ── Warum "nicht gemessen" ein eigenes Urteil ist ──────────────────────────
 *
 * `CONFIG GET` ist auf manchen verwalteten Speichern gesperrt. Wer das als
 * "in Ordnung" verbucht, baut genau den Fehler wieder ein: Stille als grün.
 * Deshalb hat diese Prüfung drei Ausgänge, nicht zwei — gut, Hinweis, und
 * "konnte nicht nachsehen".
 */

/** Was vom laufenden Speicher abgelesen wurde. `null` = nicht ablesbar. */
export interface Speicherlage {
  /** Belegte Bytes. */
  benutzt: number | null;
  /** Obergrenze in Bytes. 0 bedeutet: keine gesetzt. */
  grenze: number | null;
  /** Die Räumungsregel, z. B. `volatile-lru`. */
  richtlinie: string | null;
}

export interface Urteil {
  art: 'gut' | 'hinweis' | 'fehler' | 'ungemessen';
  text: string;
}

/** Anteil der Belegung, 0 bis 1. `null`, wenn es keine Grenze gibt oder nichts ablesbar ist. */
export function anteil(l: Speicherlage): number | null {
  if (l.benutzt === null || l.grenze === null || l.grenze <= 0) return null;
  return l.benutzt / l.grenze;
}

const mb = (b: number): string => `${(b / 1024 / 1024).toFixed(1)} MB`;

/**
 * Das Urteil über eine Speicherlage.
 *
 * Die Reihenfolge ist Absicht: die stille Löschung steht vor der Füllung. Eine
 * halbvolle Instanz, die still löscht, ist gefährlicher als eine volle, die
 * laut scheitert.
 */
export function beurteileSpeicher(l: Speicherlage): Urteil[] {
  const aus: Urteil[] = [];

  if (l.richtlinie === null) {
    aus.push({
      art: 'ungemessen',
      text: 'Raeumungsregel nicht ablesbar (CONFIG GET gesperrt) — unbekannt, ob dieser Speicher bei Platzmangel still loescht.',
    });
  } else if (l.richtlinie.startsWith('allkeys')) {
    aus.push({
      art: 'fehler',
      text: `Raeumungsregel ist \`${l.richtlinie}\`: bei Platzmangel wird die am laengsten ungenutzte Lektion GELOESCHT, ohne Meldung. Ein Gedaechtnis darf nicht raeumen wie ein Zwischenspeicher. Richtig waere \`volatile-lru\` (raeumt nur, was ohnehin ablaeuft) oder \`noeviction\` (scheitert laut).`,
    });
  } else if (l.richtlinie === 'volatile-lru' || l.richtlinie === 'noeviction') {
    aus.push({ art: 'gut', text: `Raeumungsregel \`${l.richtlinie}\` — Lektionen ohne Ablaufdatum sind sicher.` });
  } else {
    aus.push({ art: 'hinweis', text: `Raeumungsregel \`${l.richtlinie}\` — ungeprueft fuer diesen Zweck.` });
  }

  const a = anteil(l);
  if (l.benutzt === null) {
    aus.push({ art: 'ungemessen', text: 'Belegung nicht ablesbar.' });
  } else if (a === null) {
    aus.push({ art: 'hinweis', text: `${mb(l.benutzt)} belegt, keine Obergrenze gesetzt — dieser Speicher waechst, bis der Rechner voll ist.` });
  } else if (a >= 0.9) {
    aus.push({ art: 'fehler', text: `${mb(l.benutzt)} von ${mb(l.grenze as number)} belegt (${Math.round(a * 100)} %). Die naechsten Lektionen scheitern bald.` });
  } else if (a >= 0.75) {
    aus.push({ art: 'hinweis', text: `${mb(l.benutzt)} von ${mb(l.grenze as number)} belegt (${Math.round(a * 100)} %).` });
  } else {
    aus.push({ art: 'gut', text: `${mb(l.benutzt)} von ${mb(l.grenze as number)} belegt (${Math.round(a * 100)} %).` });
  }

  return aus;
}

/** Eine Zahl aus einem INFO-Block, z. B. `used_memory`. `null`, wenn sie fehlt. */
export function zahlAusInfo(info: string, name: string): number | null {
  const t = new RegExp(`^${name}:(\\d+)`, 'm').exec(info);
  return t ? Number(t[1]) : null;
}
