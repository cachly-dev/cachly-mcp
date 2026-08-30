/**
 * ══ Drei Etiketten, die keine Selbstauskunft brauchen ═════════════════════
 *
 * ── Woher das kommt (Karte kdqyy5syhxqn, Mads Hansen 20.08.2026) ──────────
 *
 * Hansen schlägt used/ignored/contradicted als zweites Signal vor. Der
 * Einwand ist der Kern: WER setzt das Etikett? Ein Werkzeug, das seinen
 * eigenen Abruf als "benutzt" markiert, ist ein selbstgemeldeter Exit-Code —
 * billig zu erheben und systematisch großzügig.
 *
 * Drei seiner Etiketten brauchen KEINE Selbstauskunft — sie folgen aus
 * Ereignissen, die ohnehin im Bestand stehen:
 *
 *   WIDERSPROCHEN  die gelieferte Lektion wurde NACH der Lieferung ersetzt
 *                  (ersetzt_am > Lieferzeit) — eine spätere Korrektur hat
 *                  ihr widersprochen.
 *   KORRIGIERT     die gelieferte Lektion wurde binnen KORREKTUR_TAGE nach
 *                  der Lieferung bearbeitet (audit_trail) — wer sie kurz
 *                  nach dem Lesen anfasst, hat etwas auszubessern gefunden.
 *   VERALTET       die Lektion war zum Lieferzeitpunkt BEREITS ersetzt
 *                  (ersetzt_am < Lieferzeit) — ausgeliefert wurde die alte
 *                  Fassung, obwohl es eine neuere gab.
 *
 * Das vierte, "benutzt", hat keine ehrliche mechanische Fassung — nur
 * schwache Stellvertreter. Drei ehrliche Felder sind mehr wert als vier,
 * von denen eines schmeichelt.
 *
 * ── Die Gegenprobe ist Teil des Vertrags ──────────────────────────────────
 *
 * Ein Abruf ohne spätere Ereignisse bekommt KEIN Etikett — nicht ersatzweise
 * "benutzt". Ein leeres Array ist die ehrliche Antwort.
 */

/** Ein Eintrag im Liefer-Journal: was wurde wann herausgegeben. */
export type Lieferung = {
  /** ISO-Zeitpunkt der Lieferung. */
  ts: string;
  /** Die gelieferten Themen (Top-3 der Antwort). */
  themen: string[];
};

/** Der heutige Stand einer Lektion, soweit die Etiketten ihn brauchen. */
export type LektionsStand = {
  ersetzt_durch?: string;
  ersetzt_am?: string;
  audit_trail?: Array<{ ts?: string }>;
};

export const KORREKTUR_TAGE = 14;

export type Etikett = 'widersprochen' | 'korrigiert' | 'veraltet';

/**
 * Die Etiketten EINER gelieferten Lektion — rein mechanisch.
 *
 * `stand` ist der HEUTIGE Datensatz des Themas (null, wenn gelöscht).
 * Kein Feld darin ist eine Selbstauskunft: ersetzt_am schreibt die
 * Korrektur, audit_trail schreibt jede Bearbeitung.
 */
export function etikettenFuer(lieferTs: string, stand: LektionsStand | null): Etikett[] {
  if (!stand) return [];
  const geliefert = Date.parse(lieferTs);
  if (Number.isNaN(geliefert)) return [];
  const raus: Etikett[] = [];

  const ersetztAm = stand.ersetzt_am ? Date.parse(stand.ersetzt_am) : NaN;
  if (!Number.isNaN(ersetztAm)) {
    if (ersetztAm > geliefert) raus.push('widersprochen');
    // Streng KLEINER: eine Ersetzung im selben Moment ist keine veraltete
    // Lieferung, sondern ein Wettlauf — im Zweifel kein Vorwurf.
    if (ersetztAm < geliefert) raus.push('veraltet');
  }

  const frist = geliefert + KORREKTUR_TAGE * 86_400_000;
  const korrigiert = (stand.audit_trail ?? []).some((e) => {
    const t = e.ts ? Date.parse(e.ts) : NaN;
    return !Number.isNaN(t) && t > geliefert && t <= frist;
  });
  if (korrigiert) raus.push('korrigiert');

  return raus;
}

/** Journal-Schlüssel je Instanz — eine gedeckelte Liste, neueste zuerst. */
export function lieferJournalSchluessel(instanceId: string): string {
  return `cachly:liefer:journal:${instanceId}`;
}

/** Hoechstens so viele Journal-Eintraege bleiben liegen. */
export const JOURNAL_DECKEL = 5000;
