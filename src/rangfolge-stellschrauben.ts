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
 * 75 — und ein Messstand mit anderem Topf misst eine andere Suchmaschine
 * (Naturworkshop 2: mit Bench-Vorgabe 25 statt der echten 75 war die
 * vermeintliche Vorauswahl-Luecke zu zwei Dritteln eingebildet).
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
 * 0,7 seit dem 24.08. (Anhebung von 0,2 in der Messstand-Serie zu Karte
 * azmqezaxx2kx: Untergrenzen 41/55/71/97 gehalten). Der alte Satz "0,2 liegt
 * mittig im Band" beschrieb die Abtastung VOR dieser Anhebung
 * (`bench/schwelle-abtasten.ts`) und stand hier zwei Tage lang neben dem
 * neuen Wert — genau die Drift-Klasse, die Kommentare zu Zahlen befaellt:
 * Wer eine Stellschraube dreht, dreht den Satz darueber MIT.
 */
export const EINGANG_SORTIER_GEWICHT = 0.7;

/**
 * Wie viele getippte Woerter im Treffer stehen muessen, damit er als Beleg gilt.
 *
 * 1 — ein einziges exakt getroffenes Wort genuegt. Bewusst eine ANZAHL und
 * kein Anteil: ein Anteil bestraft die lange Frage. "xyzzy api key" auf eine
 * Lektion, die das seltene "xyzzy" exakt enthaelt, waere ein Drittel und damit
 * unter jeder brauchbaren Schwelle — obwohl der Treffer genau richtig ist.
 * Genau daran fiel die Probe `brain-flow` am 27.08.2026 rot aus, bevor die
 * Zahl je ausgeliefert wurde.
 *
 * Zwei unscharfe Treffer (Tippfehler-Toleranz, je 0,5) reichen ebenfalls, ein
 * einzelner nicht.
 *
 * Diese Schwelle darf keinen Treffer fressen, der geholfen haette; sie faengt
 * nur die Faelle ab, in denen KEIN getipptes Wort vorkommt und der Treffer
 * allein ueber die Synonym-Bruecke nach oben kam. Genau davor warnt der
 * Kommentar in `search.ts`: die Bruecke landet bei allgemeinen Woertern, und
 * `log` steht in hunderten Lektionen.
 *
 * Sie greift ausserdem nur, wenn KEIN Treffer der Liste belegt ist — nicht als
 * Filter auf einzelne. Entweder die Liste taugt, oder sie taugt nicht.
 *
 * Warum Wortbelege und nicht die Punktzahl: `hybridScore` ist min-max normiert
 * und damit relativ. Ein einzelner Treffer bekommt dort IMMER 0, der beste
 * einer Liste IMMER 1 — beides unbrauchbar fuer "taugt das ueberhaupt?".
 * Die ganze Herleitung steht in abstention.ts.
 *
 * Der Anlass: 21 Prozent der automatisch eingeblendeten Lektionen passten am
 * 13.08.2026 nicht zur Aufgabe. Der Wert selbst ist eine erste, vorsichtige
 * Setzung und noch NICHT am Bench abgetastet — wer ihn aendert, faehrt beide
 * Pflicht-Benches (eigener Satz mit Untergrenzen 41/55/71/97 und LoCoMo) und
 * traegt die Zahl hier ein.
 */
export const WORT_BELEG_SCHWELLE = 1;

export const SINN_BELEG_SCHWELLE = 0.35;

/**
 * Ab welcher Zuversicht eine Ursache-Wirkung-Kante allein als Beleg zaehlt.
 *
 * 0,35 — und das ist bewusst KEINE neue Zahl, sondern dieselbe, die der
 * Graphdurchlauf in `handlers/brain.ts` schon anwendet:
 *
 *     if (!edge || edge.edgeType !== 'fixes' || edge.confidence < 0.35) continue;
 *
 * Eine Zurueckhaltung, die strenger waere als der Filter davor, wuerde
 * Treffer verwerfen, die der Abruf gerade erst bewusst durchgelassen hat.
 * Ein reiner Graph-Treffer haengt ausserdem an einem getippten Wort: der
 * Durchlauf startet nur an Knoten, deren Name ein Fragewort enthaelt.
 */
export const CKG_BELEG_SCHWELLE = 0.35;
