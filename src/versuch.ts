/**
 * Messtechnik fuer den Rueckfall-Versuch (dev.to "rules-before-the-run").
 *
 * ── Worum es geht ────────────────────────────────────────────────────────────
 *
 * Der Artikel sagt zu: wir messen, ob eine abgerufene Lektion, die WIRKLICH bis
 * ins Modell kommt, den Rueckfall senkt (dieselbe Lektion muss kein zweites Mal
 * geschrieben werden). Diese Datei baut nur das Messgeraet. Sie startet nichts.
 *
 * Ohne den Schalter `CACHLY_VERSUCH=an` (siehe `versuchStart`) aendert sich am
 * Verhalten des Recall-Pfads NICHTS — kein Zurueckhalten, kein Schreiben nach
 * Redis, keine Markierung im Text. Das ist keine Nebenbedingung, das ist der
 * ganze Zweck: der Versuch soll erst beginnen, wenn Heinrich ihn startet.
 *
 * ── Der Kanarienvogel ────────────────────────────────────────────────────────
 *
 * Zu pruefen ist nicht, ob eine Lektion ABGERUFEN wurde. Zu pruefen ist, ob ihr
 * Text VOLLSTAENDIG in der Antwort landet, die das Modell sieht. Anlass: eine
 * Lektion trug die gesuchte Adresse an Zeichen 323 von `what_worked`, die
 * Anzeige schnitt bei 100 Zeichen ab (siehe lesson-preview.ts). Die Lektion war
 * eingeblendet, der Fehler passierte trotzdem — genau der Zustand, den ein
 * "wurde abgerufen"-Zaehler nie sieht.
 *
 * Die Markierung sitzt deshalb am Ende von `what_worked` — dem Feld, an dem der
 * Anlass hing, und dem Feld, das `lessonPreviewLines` als Erstes und am
 * grosszuegigsten kuerzt. Sie besteht aus acht Zero-Width-Space-Zeichen
 * (U+200B): unsichtbar in jedem Renderer (Terminal, Markdown, HTML), und sie
 * uebersteht sowohl `flat()`s Leerzeichen-Kollaps als auch `String#trim()` —
 * beide fassen nur "richtige" Leerzeichen an, U+200B gehoert zu keiner der
 * beiden Kategorien. Acht Wiederholungen, damit ein einzelnes zufaelliges
 * Zero-Width-Zeichen in echtem Nutzertext die Markierung nicht vortaeuscht.
 *
 * WICHTIG: die Markierung wird NICHT roh ans Ende des JSON-Strings gehaengt.
 * Das wuerde `JSON.parse` in `recallVorschau` brechen und den Fallback-Pfad
 * (rohes `trimTo` ueber das GANZE JSON-Objekt) erzwingen — einen Pfad, den
 * echte, unmarkierte Lektionen nie durchlaufen. Das Ergebnis waere ein
 * Fehlalarm, kein Messwert. Die Markierung wird darum in die geparste
 * `what_worked`-Zeichenkette eingefuegt, das Objekt bleibt gueltiges JSON, und
 * der Kanarienvogel durchlaeuft exakt den Pfad, den eine echte Lektion auch
 * durchlaeuft.
 *
 * Geprueft wird am Ende die WIRKLICH zusammengebaute Antwort (`lines.join`),
 * nicht eine Nebenrechnung — siehe `schliesseVersuchAb`. Die Markierung wird
 * danach aus dem Text entfernt, bevor er den Nutzer erreicht.
 */

import { randomBytes, createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { meldeEinmal, meldeUndVermerke, VERSUCH_LEER } from './aussetzer.js';

/**
 * So viel Speicher, wie ein Vermerk braucht. Bewusst strukturell getippt und
 * nicht als Redis-Typ: dieses Modul soll ohne Redis-Abhaengigkeit pruefbar
 * bleiben.
 */
type VermerkSpeicherArt = Parameters<typeof meldeUndVermerke>[0];

// ── Der Schalter ─────────────────────────────────────────────────────────────

export const VERSUCH_ENV = 'CACHLY_VERSUCH';
export const VERSUCH_SALZ_ENV = 'CACHLY_VERSUCH_SALZ';

/** Grund fuer `meldeEinmal`: Versuch eingeschaltet, aber kein Salz gesetzt. */
export const OHNE_SALZ = 'versuch-ohne-salz';

/**
 * Der einzige Einstiegspunkt fuer die Frage "soll der Versuch jetzt laufen?".
 *
 * Gibt das Salz zurueck, wenn ja — sonst `null`. Zwei Faelle enden bei `null`:
 * der Schalter steht nicht auf "an", oder er steht auf "an", aber das Salz
 * fehlt. Der zweite Fall meldet sich einmal je Prozess nach stderr (ueber
 * `meldeEinmal`) und verhaelt sich danach wie der erste — still weiterlaufen
 * waere die Fehlerklasse, gegen die `aussetzer.ts` gebaut wurde.
 */
export function versuchStart(speicher?: VermerkSpeicherArt | null): string | null {
  if (process.env[VERSUCH_ENV] !== 'an') return null;
  const salz = process.env[VERSUCH_SALZ_ENV];
  if (!salz) {
    const text = `${VERSUCH_ENV}=an, aber ${VERSUCH_SALZ_ENV} fehlt — der Versuch verhaelt sich wie "aus"`;
    if (speicher) {
      // Ohne Speicher stand die Meldung nur im Arbeitsspeicher und war nach
      // jedem Deploy weg (Karte opupbt3l9wcq, gefunden von der Gegenrede,
      // Rolle: Der Betreiber). Der Versuch konnte damit WOCHENLANG leer
      // laufen: "keine Daten" sah genauso aus wie "noch nicht genug Daten".
      //
      // meldeUndVermerke faengt jeden eigenen Fehler ab und gibt eine
      // Zusage zurueck, die niemand einloesen muss — deshalb `void`. Diese
      // Funktion bleibt synchron, weil ihre Aufrufer es sind.
      void meldeUndVermerke(speicher, VERSUCH_LEER, text);
    } else {
      meldeEinmal(OHNE_SALZ, text);
    }
    return null;
  }
  return salz;
}

// ── Turn-Kennung ─────────────────────────────────────────────────────────────

/**
 * Eine neue, stabile Kennung je Recall-Aufruf.
 *
 * Im Recall-Pfad gibt es keine vorhandene Anfrage- oder Turn-Kennung, die man
 * verlaengern koennte — `requester` ist ein Autorenname, `cachly:session:current`
 * haelt Zustand je INSTANZ, nicht je Aufruf. Darum: Zeitstempel (sortierbar,
 * in einer Zeile lesbar) plus vier zufaellige Byte, damit zwei Aufrufe in
 * derselben Millisekunde nicht kollidieren.
 */
export function neueKennung(): string {
  const zeit = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15); // 20260820T171523
  const zufall = randomBytes(4).toString('hex');
  return `${zeit}-${zufall}`;
}

// ── Zuteilung ────────────────────────────────────────────────────────────────

export type Zuteilung = 'HOLD' | 'DELIVER';

/**
 * Reine Funktion, ohne Netz testbar: Kennung + Salz -> HOLD oder DELIVER.
 *
 * Berechnung exakt wie oeffentlich angekuendigt: Kennung und Salz aneinander-
 * haengen, SHA-256, die ersten VIER Hex-Ziffern als Zahl lesen, modulo 100.
 * Unter 50 heisst HOLD, sonst DELIVER.
 */
export function zuteilung(kennung: string, salz: string): Zuteilung {
  const hash = createHash('sha256').update(`${kennung}${salz}`).digest('hex');
  const ersteVier = hash.slice(0, 4);
  const zahl = parseInt(ersteVier, 16) % 100;
  return zahl < 50 ? 'HOLD' : 'DELIVER';
}

// ── Zulassung ────────────────────────────────────────────────────────────────

/** Ohne einen Treffer ueber dieser Punktzahl gibt es nichts zu messen. */
export const ZULASSUNGS_SCHWELLE = 0;

/** Gibt es ueberhaupt einen Treffer, der ueber der Schwelle liegt? */
export function istZulassungsfaehig(hoechstePunktzahl: number, schwelle: number = ZULASSUNGS_SCHWELLE): boolean {
  return hoechstePunktzahl > schwelle;
}

/** Der Grund, warum eine Anfrage NICHT zulassungsfaehig ist — oder `undefined`. */
export function zulassungsGrund(hoechstePunktzahl: number, schwelle: number = ZULASSUNGS_SCHWELLE): string | undefined {
  if (istZulassungsfaehig(hoechstePunktzahl, schwelle)) return undefined;
  return `hoechste Punktzahl ${hoechstePunktzahl.toFixed(3)} liegt nicht ueber der Schwelle ${schwelle}`;
}

// ── Kanarienvogel ────────────────────────────────────────────────────────────

/**
 * Acht Zero-Width-Spaces. Siehe Dateikopf fuer die Begruendung der Wahl.
 *
 * Ueber String.fromCharCode, nicht als roher Unicode-Buchstabe im
 * Quelltext — ein unsichtbares Zeichen zwischen Anfuehrungszeichen ist beim
 * Lesen und in `git diff` nicht von "kein Zeichen" zu unterscheiden.
 */
export const KANARIEN_MARKIERUNG = String.fromCharCode(0x200b).repeat(8);

/**
 * Setzt die Kanarien-Markierung ans Ende des `what_worked`-Feldes.
 *
 * `inhalt` ist der rohe Redis-Wert, wie ihn `recallVorschau` bekommt — meist
 * das JSON einer Lektion, manchmal (Kontext-Eintraege, Index) einfacher Text.
 * Ist es eine Lektion mit `what_worked`, wandert die Markierung dorthin und
 * das Objekt bleibt gueltiges JSON (Begruendung siehe Dateikopf). Sonst wird
 * roh ans Ende angehaengt — das ist fuer Nicht-Lektionen korrekt, weil
 * `recallVorschau` sie ohnehin nur als Rohtext kuerzt.
 */
export function markiereDatensatz(inhalt: string, markierung: string = KANARIEN_MARKIERUNG): string {
  try {
    const objekt = JSON.parse(inhalt) as Record<string, unknown>;
    if (typeof objekt.what_worked === 'string') {
      objekt.what_worked = `${objekt.what_worked}${markierung}`;
      return JSON.stringify(objekt);
    }
  } catch {
    // kein JSON — Markierung ans Ende des Rohtexts, siehe unten
  }
  return `${inhalt}${markierung}`;
}

/**
 * Ueberlebt die Markierung in der fertig zusammengebauten Antwort?
 *
 * Ueberlebt sie: der ganze Datensatz kam durch. Fehlt sie: er wurde gekuerzt.
 */
export function kanarienUeberlebt(fertigeAntwort: string, markierung: string = KANARIEN_MARKIERUNG): boolean {
  return fertigeAntwort.includes(markierung);
}

/** Entfernt die Markierung, bevor der Text den Nutzer erreicht. */
export function entferneMarkierung(text: string, markierung: string = KANARIEN_MARKIERUNG): string {
  return text.split(markierung).join('');
}

// ── Themenschluessel ─────────────────────────────────────────────────────────

const LEKTION_PRAEFIX = 'cachly:lesson:best:';

/** Redis-Schluessel einer Lektion -> ihr Themenname (ohne Praefix). */
export function themaVon(key: string): string {
  return key.startsWith(LEKTION_PRAEFIX) ? key.slice(LEKTION_PRAEFIX.length) : key;
}

// ── Protokoll je Turn ────────────────────────────────────────────────────────

/** Hash der Frage — die Frage selbst wird nie gespeichert (Zusage des Artikels). */
export function hashFrage(frage: string): string {
  return createHash('sha256').update(frage).digest('hex');
}

const TURN_TTL_SEKUNDEN = 90 * 24 * 60 * 60; // 90 Tage — der Versuch dauert 14

/** Redis-Schluessel fuer den Protokoll-Eintrag einer Kennung. */
export function turnSchluessel(kennung: string): string {
  return `cachly:versuch:turn:${kennung}`;
}

export interface VersuchTurnProtokoll {
  ts: string;
  frageHash: string;
  hoechstePunktzahl: number;
  /** Themenschluessel der zurueckgegebenen (tatsaechlich gezeigten) Lektionen. */
  themen: string[];
  zulassungsfaehig: boolean;
  zulassungsGrund?: string;
  zuteilung: Zuteilung;
  /** Nur bei HOLD gesetzt: das Thema, das weggelassen wurde. */
  weggelassenesThema?: string;
  kanarienBestanden: boolean;
}

/**
 * Schreibt den Turn-Eintrag. Schlaegt das fehl, wird NICHTS geworfen — der
 * Nutzer wartet auf eine Antwort, nicht auf ein Protokoll.
 */
export async function schreibeTurnProtokoll(
  redis: Redis,
  kennung: string,
  protokoll: VersuchTurnProtokoll,
): Promise<void> {
  try {
    await redis.set(turnSchluessel(kennung), JSON.stringify(protokoll), 'EX', TURN_TTL_SEKUNDEN);
  } catch {
    // Ein fehlendes Protokoll ist besser als eine gescheiterte Suche.
  }
}

// ── Anschluss an den Recall-Pfad ─────────────────────────────────────────────

/** Ein Kandidat aus der schon sortierten Trefferliste von smart_recall. */
export interface VersuchTreffer {
  key: string;
  content: string;
  punktzahl: number;
}

export interface ZuteilungsErgebnis {
  /** Die neue Trefferliste — bei HOLD fehlt der bisher beste Treffer. */
  treffer: VersuchTreffer[];
  zuteilung: Zuteilung;
  zulassungsfaehig: boolean;
  zulassungsGrund?: string;
  /** War DELIVER UND es gab einen Treffer, der die Markierung tragen konnte. */
  markierungGesetzt: boolean;
  weggelassenesThema?: string;
}

/**
 * Wendet Zulassung + Zuteilung auf eine Trefferliste an. Reine Funktion,
 * mutiert `treffer` nicht.
 *
 * Ohne zulassungsfaehigen Treffer passiert nichts — Zuteilung wird trotzdem
 * berechnet und protokolliert, aber es gibt nichts zurueckzuhalten oder zu
 * markieren. Bei HOLD verschwindet der beste Treffer aus der Liste, die
 * uebrigen bleiben unveraendert. Bei DELIVER traegt der beste Treffer danach
 * die Kanarien-Markierung.
 */
export function wendeZuteilungAn(
  treffer: readonly VersuchTreffer[],
  kennung: string,
  salz: string,
  hoechstePunktzahl: number,
  schwelle: number = ZULASSUNGS_SCHWELLE,
): ZuteilungsErgebnis {
  const zulassungsfaehig = istZulassungsfaehig(hoechstePunktzahl, schwelle);
  const grund = zulassungsGrund(hoechstePunktzahl, schwelle);
  const entscheidung = zuteilung(kennung, salz);

  if (!zulassungsfaehig || treffer.length === 0) {
    return {
      treffer: [...treffer],
      zuteilung: entscheidung,
      zulassungsfaehig,
      zulassungsGrund: grund,
      markierungGesetzt: false,
    };
  }

  const [bester, ...rest] = treffer;

  if (entscheidung === 'HOLD') {
    return {
      treffer: rest,
      zuteilung: entscheidung,
      zulassungsfaehig,
      zulassungsGrund: grund,
      markierungGesetzt: false,
      weggelassenesThema: themaVon(bester.key),
    };
  }

  const markiert: VersuchTreffer = { ...bester, content: markiereDatensatz(bester.content) };
  return {
    treffer: [markiert, ...rest],
    zuteilung: entscheidung,
    zulassungsfaehig,
    zulassungsGrund: grund,
    markierungGesetzt: true,
  };
}

export interface VersuchProtokollTeil {
  frage: string;
  hoechstePunktzahl: number;
  themen: string[];
  zulassungsfaehig: boolean;
  zulassungsGrund?: string;
  zuteilung: Zuteilung;
  weggelassenesThema?: string;
  markierungGesetzt: boolean;
}

/**
 * Letzter Schritt: prueft den Kanarienvogel gegen die WIRKLICH zusammen-
 * gebaute Antwort, entfernt die Markierung, schreibt das Protokoll (fire-and-
 * forget) und gibt den bereinigten Text zurueck — den, den der Nutzer sieht.
 */
export function schliesseVersuchAb(
  redis: Redis,
  kennung: string,
  teil: VersuchProtokollTeil,
  fertigeAntwort: string,
): string {
  const kanarienBestanden = teil.markierungGesetzt ? kanarienUeberlebt(fertigeAntwort) : false;
  const bereinigt = entferneMarkierung(fertigeAntwort);

  const protokoll: VersuchTurnProtokoll = {
    ts: new Date().toISOString(),
    frageHash: hashFrage(teil.frage),
    hoechstePunktzahl: teil.hoechstePunktzahl,
    themen: teil.themen,
    zulassungsfaehig: teil.zulassungsfaehig,
    zulassungsGrund: teil.zulassungsGrund,
    zuteilung: teil.zuteilung,
    weggelassenesThema: teil.weggelassenesThema,
    kanarienBestanden,
  };
  void schreibeTurnProtokoll(redis, kennung, protokoll);

  return bereinigt;
}
