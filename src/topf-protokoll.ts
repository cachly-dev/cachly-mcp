/**
 * Mitschrift der Vorauswahl — wer kommt ueberhaupt in die Bewertung?
 *
 * Warum es das gibt (03.09.2026, Naturworkshop 6, Fund des Oekologen):
 * Der Topf fasst hoechstens 75 Kandidaten. Eine lange Sitzung liefert 10 bis
 * 20 Stuecke, und alle konkurrieren um dieselbe knappe Groesse: Aehnlichkeit
 * zum Fragetext. Die Frage beschreibt meist den Vorfall — also gewinnen die
 * Vorfall-Stuecke, und die Entscheidungs-Stuecke derselben Sitzung koennen
 * den Topf gar nicht erreichen. Wir haben den Topf bisher als Liste
 * behandelt, nie als endlichen Raum, und nie gemessen, wer darin steht.
 *
 * Diese Mitschrift aendert am Verhalten NICHTS. Sie schreibt nur auf, was
 * ohnehin passiert. Sie ist standardmaessig aus und wird ueber
 * CACHLY_TOPF_PROTOKOLL=<dateipfad> eingeschaltet — nur fuer Messlaeufe.
 *
 * Bewusst ohne Auswertung: hier stehen die rohen Themennamen. Wie daraus
 * Sitzungen werden, weiss der Messaufbau, nicht das Produkt. Ein Server, der
 * Bench-Namensschemata kennt, misst irgendwann sich selbst.
 */

import { appendFileSync } from "node:fs";

/** Der Pfad wird EINMAL gelesen. Ein Schalter, der sich mitten im Lauf
 *  aendert, macht die Messung unlesbar. */
const VORGABE = process.env.CACHLY_TOPF_PROTOKOLL?.trim() || "";

/**
 * Je Prozess eine eigene Datei: `topf.jsonl` wird zu `topf.<pid>.jsonl`.
 *
 * Der Messlauf faehrt vier Zellen gleichzeitig, jede mit eigenem Server. Ein
 * gemeinsames Anhaengen ist bei Zeilen von zwei Kilobyte nicht mehr atomar —
 * dann stehen halbe JSON-Zeilen in der Datei, und der Auswertende haelt einen
 * Schreibunfall fuer ein Messergebnis. Die Auswertung liest alle Dateien des
 * Musters ein.
 */
const ZIEL = VORGABE
  ? VORGABE.replace(/(\.[^.\\/]+)?$/, (endung) => `.${process.pid}${endung || ""}`)
  : "";

/** Aus, solange kein Pfad gesetzt ist — und das ist der Normalfall. */
export const topfProtokollAktiv = ZIEL.length > 0;

export interface TopfNotiz {
  /** Die Frage, gekuerzt: sie ordnet die Zeile der Zelle zu. */
  frage: string;
  /** Alle Themennamen im Topf, in Topf-Reihenfolge. */
  themen: string[];
  /** Wie viele Kandidaten die Wortsuche beisteuerte. */
  ausWortsuche: number;
  /** Wie viele die Bedeutungssuche beisteuerte (vor dem Zusammenlegen). */
  ausSinnsuche: number;
  /** Die Obergrenze, gegen die gemessen wird. */
  obergrenze: number;
  /** Die Themennamen, die es am Ende in die Antwort geschafft haben. */
  gezeigt: string[];
}

/**
 * Eine Zeile anhaengen. Schlaegt das Schreiben fehl, bleibt es still: eine
 * Messung darf den Abruf nicht toeten, den sie misst.
 */
export function schreibeTopfNotiz(notiz: TopfNotiz): void {
  if (!topfProtokollAktiv) return;
  try {
    appendFileSync(
      ZIEL,
      `${JSON.stringify({ zeit: new Date().toISOString(), ...notiz })}\n`,
      "utf8",
    );
  } catch {
    // Absichtlich stumm. Ein voller Datentraeger oder ein fehlendes
    // Verzeichnis ist ein Problem des Messaufbaus, nicht des Abrufs.
  }
}
