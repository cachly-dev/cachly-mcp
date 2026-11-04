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
      // Die Texte dieser Datei sind seit 04.11.2026 englisch (ki-10): sie stehen in
      // brain_doctor, das eine KI und ihr Nutzer lesen.
      text: 'Eviction policy cannot be read (CONFIG GET is blocked) — unknown whether this store silently deletes when it is full.',
    });
  } else if (l.richtlinie.startsWith('allkeys')) {
    aus.push({
      art: 'fehler',
      text: `Eviction policy is \`${l.richtlinie}\`: when the store is full, the least recently used lesson is DELETED without a message. A memory must not evict like a cache. Use \`volatile-lru\` (only evicts what expires anyway) or \`noeviction\` (fails loudly).`,
    });
  } else if (l.richtlinie === 'volatile-lru' || l.richtlinie === 'noeviction') {
    aus.push({ art: 'gut', text: `Eviction policy \`${l.richtlinie}\` — lessons without an expiry date are safe.` });
  } else {
    aus.push({ art: 'hinweis', text: `Eviction policy \`${l.richtlinie}\` — not checked for this use.` });
  }

  const a = anteil(l);
  if (l.benutzt === null) {
    aus.push({ art: 'ungemessen', text: 'Usage cannot be read.' });
  } else if (a === null) {
    aus.push({ art: 'hinweis', text: `${mb(l.benutzt)} used, no size limit set — this store grows until the machine is full.` });
  } else if (a >= 0.9) {
    aus.push({ art: 'fehler', text: `${mb(l.benutzt)} of ${mb(l.grenze as number)} used (${Math.round(a * 100)} %). New lessons will soon fail to save.` });
  } else if (a >= 0.75) {
    aus.push({ art: 'hinweis', text: `${mb(l.benutzt)} of ${mb(l.grenze as number)} used (${Math.round(a * 100)} %).` });
  } else {
    aus.push({ art: 'gut', text: `${mb(l.benutzt)} of ${mb(l.grenze as number)} used (${Math.round(a * 100)} %).` });
  }

  return aus;
}

/** Eine Zahl aus einem INFO-Block, z. B. `used_memory`. `null`, wenn sie fehlt. */
export function zahlAusInfo(info: string, name: string): number | null {
  const t = new RegExp(`^${name}:(\\d+)`, 'm').exec(info);
  return t ? Number(t[1]) : null;
}
