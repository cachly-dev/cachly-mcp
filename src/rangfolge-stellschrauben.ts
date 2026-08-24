/**
 * ══ Die Stellschrauben der Rangfolge — an EINEM Ort ═══════════════════════
 *
 * ── Warum es diese Datei gibt (23.08.2026) ───────────────────────────────
 *
 * Drei Zahlen standen doppelt: einmal im ausgelieferten Pfad
 * (`handlers/brain.ts`), einmal im Messstand (`bench/echter-korpus.ts`) und
 * teils noch in drei weiteren Messwerkzeugen.
 *
 *     SINN_TOPF                75   ->  bench: const POOL = 75
 *     EINGANG_SCHWELLE         0.5  ->  bench: const EINGANG_SCHWELLE = 0.5
 *     EINGANG_SORTIER_GEWICHT  0.2  ->  bench: gewicht: 0.2
 *
 * Der Messstand baut die Sortierung nach, statt sie aufzurufen. Das ist
 * bekannt — die Kommentare dort warnen an drei Stellen ausdruecklich davor:
 *
 *     "Der Bench muss das spiegeln, sonst misst er eine andere Suchmaschine
 *      als die ausgelieferte."
 *     "Wer ihn hier aufnimmt, ohne ihn dort einzubauen, misst wieder eine
 *      andere Suchmaschine als die ausgelieferte."
 *
 * Zwei Quellen, die von Hand gleichgehalten werden, gehen irgendwann
 * auseinander. Genau das ist am 20.08.2026 schon einmal passiert: der
 * Messstand sortierte mit `bewerteTopf`, der ausgelieferte Pfad mit
 * `mischeRangfolgen` (RRF). Die Fehlertext-Eingaenge brachten im Messstand
 * +6 Punkte, im Produkt +1. Die Zahl im Ergebnisdokument war richtig — sie
 * beschrieb nur eine Suchmaschine, die es nicht gab.
 *
 * Diese Datei nimmt der Disziplin die Arbeit ab. Wer eine Zahl aendert,
 * aendert sie hier, und beide Seiten ziehen mit. Die Probe
 * `stellschrauben-stehen-nur-hier.test.ts` haelt fest, dass niemand sie
 * wieder abschreibt.
 *
 * Die BEGRUENDUNG jeder Zahl bleibt dort, wo sie hingehoert: bei den
 * Messungen in `handlers/brain.ts`. Hier steht der Wert, dort steht warum.
 */

/**
 * Wie viele Themen der Bedeutungsabgleich in die engere Wahl nimmt.
 *
 * Ein Messstand mit anderem Topf misst eine andere Suchmaschine.
 */
export const SINN_TOPF = 75;

/**
 * Ab welcher Naehe eine Fehlertext-Tuer ueberhaupt mitzaehlt.
 *
 * Darunter meldet sie "kein Wert" (−2) statt "schlechter Wert". Der
 * Unterschied ist der ganze gemessene Schaden gewesen, nicht die Idee —
 * Begruendung mit Zahlen in `handlers/brain.ts` ueber dem Tuer-Block.
 *
 * Seit `spreizeImTopf` Luecken neutral behandelt (Karte azmqezaxx2kx) ist
 * diese Schwelle nicht mehr die einzige Absicherung. Sie bleibt, weil eine
 * Tuer unterhalb 0,5 auch als Wert nichts taugt — gemessen, nicht vermutet.
 */
export const EINGANG_SCHWELLE = 0.5;

/**
 * Wie stark die Tuer mitsortiert.
 *
 * 0,2 liegt mittig im Band, in dem Platz 1 UND Findequote@3 ihr Maximum
 * halten (Abtastung in `bench/schwelle-abtasten.ts`).
 */
export const EINGANG_SORTIER_GEWICHT = 0.7;
