/**
 * Trampelpfade: das System lernt die Fragen, mit denen man es wirklich sucht.
 *
 * ── Der Gedanke ─────────────────────────────────────────────────────────────
 *
 * Ein Immunsystem hält Andockstellen vorrätig — und nach jeder überstandenen
 * Infektion bleiben Gedächtniszellen zurück, die genau diesen Erreger beim
 * nächsten Mal sofort greifen. Die Andockstellen sind gebaut (`eingaenge.ts`,
 * die Fehlertexte). Das hier sind die Gedächtniszellen.
 *
 * Wenn eine Frage eine Lektion findet, ist diese Frage ein bewiesener Weg zu
 * ihr. Sie wird als eigener Eingang gespeichert — beim nächsten Mal ist der
 * Weg breiter.
 *
 * ── Warum erst beim ZWEITEN Mal ─────────────────────────────────────────────
 *
 * Der Bauplan wollte den Eingang speichern, sobald eine Lektion „benutzt oder
 * bestätigt" wurde. Dieses Signal gibt es nicht: der Server sieht, was er
 * ausgeliefert hat, nicht was jemand damit gemacht hat. Es zu erfinden wäre
 * eine Zahl ohne Deckung.
 *
 * Also das, was ein Trampelpfad wirklich ist: **Wiederholung.** Ein einzelnes
 * Durchqueren macht keinen Weg. Führt dieselbe Frage ZWEIMAL zu derselben
 * Lektion, ist sie ein Pfad — und braucht dafür keine Bestätigung von außen,
 * sondern nur Geduld.
 *
 * ── Was das kann, und was ausdrücklich nicht ────────────────────────────────
 *
 * ES HILFT: einer Frage, die die Lektion heute auf Platz 3 findet, morgen auf
 * Platz 1. Genau das ist der gemessene Engpass — 37 richtige Antworten liegen
 * im Topf und werden nicht gezeigt (`.agent/cachly/tor0-tor1-ergebnis.md`).
 *
 * ES HILFT NICHT: einer Frage, die die Lektion gar nicht findet. Die wird nie
 * aufgezeichnet, weil sie nie ankam. Dieser blinde Fleck ist der Grund, warum
 * die Fehlertext-Eingänge daneben bestehen bleiben — sie wirken ohne Nutzung.
 */

import type { Redis } from 'ioredis';
import { packe } from './bedeutung.js';
import { EINGANG_PRAEFIX } from './eingaenge.js';

/** Wo die noch unbewiesenen Spuren liegen: Frage → wie oft sie hierher führte. */
export const SPUR_PRAEFIX = 'cachly:lesson:spur:';

/**
 * Wo die bewiesenen Pfade liegen — als eigener Hash, NICHT im Eingangs-Hash.
 *
 * Grund: `schreibeEingaenge` löscht seinen Hash vor jedem Schreiben, damit die
 * Fehlertexte einer alten Fassung nicht neben denen der neuen stehen bleiben.
 * Lägen die gelernten Fragen dort, würde jedes erneute Lernen der Lektion die
 * gesammelte Erfahrung wegwerfen — ein Gedächtnis, das beim Dazulernen
 * vergisst.
 */
export const PFAD_PRAEFIX = 'cachly:lesson:pfad:';

/** Ab wie vielen Malen eine Frage als Pfad gilt. Einmal ist Zufall. */
export const PFAD_SCHWELLE = 2;

/** Höchstens so viele gelernte Fragen je Lektion. Der schwächste weicht. */
export const PFAD_KAPPE = 8;

/** Nur Fragen dieser Länge werden aufgezeichnet. */
const MIN_LAENGE = 8;
const MAX_LAENGE = 200;

/**
 * Zwei Fragen, die sich nur in Zeichensetzung und Grossschreibung
 * unterscheiden, sind derselbe Weg.
 *
 * Bewusst KEIN Stammformen-Verfahren: am 19.08.2026 gemessen kostete
 * Stammbildung drei Punkte Findequote. Hier geht es ausserdem um Gleichheit,
 * nicht um Ähnlichkeit — wer „docker startet nicht" und „Docker startet
 * nicht!" trennt, zählt zweimal halb statt einmal ganz.
 */
export function spurSchluessel(frage: string): string {
  return frage
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LAENGE);
}

/** Taugt diese Frage überhaupt als Pfad? */
export function taugtAlsSpur(frage: string): boolean {
  const k = spurSchluessel(frage);
  // Eine Frage aus einem einzigen Wort ist kein Weg, sondern ein Stichwort —
  // sie würde jede Lektion an sich ziehen, die dieses Wort enthält.
  return k.length >= MIN_LAENGE && k.split(' ').length >= 2;
}

/**
 * Welche Fragen sollen ihre Kappe überleben?
 *
 * Absteigend nach Häufigkeit; bei Gleichstand gewinnt die kürzere. Eine kurze
 * Frage, die genauso oft hierher führte, ist die allgemeinere — sie fängt mehr
 * Formulierungen als ihre lange Schwester.
 */
export function behalte(
  pfade: Array<{ frage: string; anzahl: number }>,
  kappe = PFAD_KAPPE,
): Array<{ frage: string; anzahl: number }> {
  return pfade
    .slice()
    .sort((a, b) => b.anzahl - a.anzahl || a.frage.length - b.frage.length)
    .slice(0, kappe);
}

/**
 * Zeichnet auf, dass diese Frage zu diesen Lektionen geführt hat, und macht
 * aus einer Spur einen Pfad, sobald sie sich wiederholt.
 *
 * Bewusst KEIN await beim Aufrufer nötig: wer sucht, soll nicht warten, bis
 * das Gedächtnis nachgeführt ist. Fällt es aus, ist die Suche trotzdem
 * beantwortet — der Pfad entsteht dann eben beim nächsten Mal.
 *
 * @returns wie viele Fragen zu Pfaden befördert wurden
 */
export async function spurLegen(
  redis: Redis,
  frage: string,
  themen: string[],
  einbetten: (text: string) => Promise<number[] | null>,
): Promise<number> {
  if (!taugtAlsSpur(frage) || themen.length === 0) return 0;
  const schluessel = spurSchluessel(frage);
  let befoerdert = 0;

  for (const topic of themen) {
    const spurKey = `${SPUR_PRAEFIX}${topic}`;
    const pfadKey = `${PFAD_PRAEFIX}${topic}`;

    // Schon ein Pfad? Dann nur mitzaehlen, nicht noch einmal einbetten.
    const istPfad = await redis.hexists(pfadKey, schluessel);
    const anzahl = await redis.hincrby(spurKey, schluessel, 1);
    if (istPfad || anzahl < PFAD_SCHWELLE) continue;

    // Eingebettet wird die FRAGE, wiedererkannt wird der Schluessel.
    //
    // Zwei verschiedene Aufgaben: der Schluessel muss "Docker startet nicht!"
    // und "docker startet nicht" als denselben Weg erkennen — dafuer ist er
    // kleingeschrieben und ohne Zeichensetzung. Fuer die Bedeutung ist genau
    // das ein Verlust: im Deutschen traegt die Grossschreibung, ob "Sein" ein
    // Hauptwort ist. Also wird der Originalwortlaut eingebettet.
    const v = await einbetten(frage.trim().slice(0, MAX_LAENGE));
    if (!v?.length) continue;

    await redis.hset(pfadKey, schluessel, packe(v));
    befoerdert++;

    // Kappe durchsetzen: der am seltensten begangene Pfad weicht.
    const alle = await redis.hkeys(pfadKey);
    if (alle.length > PFAD_KAPPE) {
      const zaehler = await redis.hgetall(spurKey);
      const mitAnzahl = alle.map((f) => ({ frage: f, anzahl: Number(zaehler[f] ?? 0) }));
      const bleiben = new Set(behalte(mitAnzahl).map((x) => x.frage));
      const raus = alle.filter((f) => !bleiben.has(f));
      if (raus.length) await redis.hdel(pfadKey, ...raus);
    }
  }
  return befoerdert;
}

/**
 * Was `Eingangsbestand` laden muss: beide Hashes.
 *
 * Steht hier und nicht in eingaenge.ts, damit die Reihenfolge der Module
 * eindeutig bleibt — spuren kennt eingaenge, nicht umgekehrt.
 */
export const EINGANGS_PRAEFIXE = [EINGANG_PRAEFIX, PFAD_PRAEFIX] as const;
