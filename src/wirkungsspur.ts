/**
 * ══ Die Wirkungsspur — hat die Lektion geholfen? ═══════════════════════════
 *
 * ── Warum es das bis zum 23.08.2026 nicht gab ─────────────────────────────
 *
 * Jede Kennzahl dieses Produkts zaehlt ANZEIGEN, keine WIRKUNG:
 *
 *   recall_count      die Lektion wurde ausgegeben
 *   ROI-Stunden       eine Lektion wurde ausgegeben, mal einer Schaetzung
 *   team_confirm      ein Mensch findet die Lektion allgemein gut
 *
 * Nirgends steht: **diese Lektion hat genau diese Frage beantwortet.**
 *
 * Das ist dieselbe Fehlerklasse, die uns an diesem einen Tag dreimal begegnet
 * ist: die Heartbeat-Pings, die den ROI aufblaehten (PR #158), die
 * CI-Lektionen im Topf `ci:ci` mit recall_count 0, und die Rangfolge, deren
 * Gewichte von Hand abgetastet statt gelernt werden.
 *
 * ── Was ohne diese Spur nicht geht ───────────────────────────────────────
 *
 * Gemessen am 23.08.2026 auf dem echten Bestand (499 Lektionen, 100 Fragen):
 *
 *     im Topf (75 Kandidaten)   97 %
 *     Top 10                    71 %
 *     Top 3                     55 %
 *     Platz 1                   41 %
 *
 * Das Finden ist geloest. Alle 56 verlorenen Punkte entstehen beim ORDNEN.
 * Und die Gewichte dieser Ordnung — EINGANG_SORTIER_GEWICHT 0,2, die Gewichte
 * in GEWICHTE, die Schwelle 0,5 — sind von Hand abgetastet worden. Sie sind
 * das beste Wissen von jemandem, nicht das Ergebnis von Faellen.
 *
 * Mit dieser Spur werden sie lernbar. Ohne sie bleibt jede Verbesserung eine
 * Abtastung auf 100 handgeschriebenen Fragen.
 *
 * ── Die drei Faelle, und warum der dritte der wichtigste ist ─────────────
 *
 *   1. geholfen, stand auf Platz 1     Bestaetigung. Am wenigsten wert.
 *   2. geholfen, stand auf Platz 7     Die Sortierung war zu schwach.
 *   3. geholfen, stand GAR NICHT drin  Der Topf hat sie nicht aufgenommen.
 *
 * Fall 3 (`platz: 0`) ist der wertvollste und der, den ein naiver Entwurf
 * vergisst: er fragt nur nach dem, was angezeigt wurde. Genau deshalb steht
 * `platz` hier als Pflichtfeld mit einer ausdruecklichen Null-Bedeutung — und
 * nicht als optionale Zusatzangabe.
 *
 * Der vierte Fall zaehlt genauso: `geholfen: false` auf Platz 1 heisst, die
 * Sortierung war sich sicher und lag falsch. Das ist ein harter Gegenbeleg.
 */

/**
 * Woher die Rueckmeldung kommt — und das ist kein Beiwerk.
 *
 * `gemeldet`   Ein Mensch (oder sein Modell) hat ausdruecklich gesagt: das
 *              hat mein Problem geloest. Starker Beleg.
 * `abgeleitet` Der Server hat gesehen, dass jemand nach einer Suche GENAU
 *              EINE der angebotenen Lektionen geoeffnet hat. Das ist eine
 *              AUSWAHL, keine Loesung.
 *
 * Die beiden duerfen NIE in eine Zahl fallen. Auswahl als Hilfe zu verbuchen
 * waere genau die Luege, gegen die diese Spur gebaut ist: die ROI-Stunden
 * zaehlten Anzeigen als Wert (PR #158), `recall_count` zaehlt Anzeigen als
 * Nutzung. Wer daraus jetzt "Klick = geholfen" macht, hat nichts gelernt.
 *
 * Deshalb rechnet `werteAus` beide getrennt und nennt beide Zahlen.
 */
export type Quelle = 'gemeldet' | 'abgeleitet';

export type Wirkungseintrag = {
  /** Zeitpunkt, ISO-8601. */
  ts: string;
  /** Ausdrueckliche Meldung oder vom Server beobachtete Auswahl. */
  quelle: Quelle;
  /** Die Frage, so wie sie gestellt wurde. Ungekuerzt bis 500 Zeichen. */
  frage: string;
  /** Das Thema der Lektion, um die es geht. */
  thema: string;
  /** Hat sie geholfen? */
  geholfen: boolean;
  /**
   * Auf welchem Platz stand sie in der Antwort, 1-basiert.
   *
   * **0 heisst: sie stand GAR NICHT drin.** Das ist kein fehlender Wert,
   * sondern die Aussage mit dem groessten Informationsgehalt — die Sortierung
   * hat sie nicht einmal in den Topf genommen.
   */
  platz: number;
  /** Freitext. Optional, hoechstens 500 Zeichen. */
  notiz: string;
  /** Wer die Rueckmeldung gibt. Optional. */
  autor: string;
};

/** Was beim Anlegen hereinkommt — alles andere wird ergaenzt. */
export type WirkungsEingabe = {
  frage?: unknown;
  thema?: unknown;
  geholfen?: unknown;
  platz?: unknown;
  notiz?: unknown;
  autor?: unknown;
};

export type Pruefergebnis =
  | { ok: true; eintrag: Wirkungseintrag }
  | { ok: false; grund: string };

const MAX_FRAGE = 500;
const MAX_NOTIZ = 500;

function text(x: unknown, max: number): string {
  return typeof x === 'string' ? x.trim().slice(0, max) : '';
}

/**
 * Prueft eine Rueckmeldung und macht daraus einen Eintrag.
 *
 * Bewusst STRENG bei `geholfen` und `platz`: eine Trainingsspur mit geratenen
 * Werten ist schlimmer als gar keine. Wer nicht weiss, auf welchem Platz die
 * Lektion stand, soll es nicht schaetzen — dafuer gibt es keine Vorgabe.
 *
 * @param jetzt Zeitstempel als ISO-Text. Wird uebergeben statt gelesen, damit
 *              die Probe nicht von der Uhr abhaengt.
 */
export function pruefeWirkung(eingabe: WirkungsEingabe, jetzt: string): Pruefergebnis {
  const frage = text(eingabe.frage, MAX_FRAGE);
  if (!frage) return { ok: false, grund: 'frage fehlt — ohne die Frage ist der Eintrag wertlos' };

  const thema = text(eingabe.thema, 200);
  if (!thema) return { ok: false, grund: 'thema fehlt — welche Lektion ist gemeint?' };

  if (typeof eingabe.geholfen !== 'boolean') {
    return {
      ok: false,
      grund: 'geholfen muss true oder false sein — "weiss nicht" ist keine Rueckmeldung',
    };
  }

  if (typeof eingabe.platz !== 'number' || !Number.isInteger(eingabe.platz) || eingabe.platz < 0) {
    return {
      ok: false,
      grund: 'platz muss eine ganze Zahl ab 0 sein (0 = die Lektion stand gar nicht in der Antwort)',
    };
  }

  return {
    ok: true,
    eintrag: {
      ts: jetzt,
      quelle: 'gemeldet',
      frage,
      thema,
      geholfen: eingabe.geholfen,
      platz: eingabe.platz,
      notiz: text(eingabe.notiz, MAX_NOTIZ),
      autor: text(eingabe.autor, 80),
    },
  };
}

/**
 * ══ Der automatische Weg ═══════════════════════════════════════════════════
 *
 * Ein Werkzeug, das jemand aufrufen MUSS, ruft niemand auf. Eine Anweisung in
 * CLAUDE.md wirkt bei einem Hersteller und bei den anderen nicht.
 *
 * Es gibt aber ein Ereignispaar, das der Server OHNE Zutun sieht:
 *
 *     1. jemand sucht          smart_recall("warum bricht der Deploy ab")
 *     2. jemand oeffnet eine   recall_best_solution("ci:zeitgrenze-…")
 *
 * Schritt 2 ist eine AUSWAHL aus dem, was Schritt 1 angeboten hat. Auf welchem
 * Platz die gewaehlte Lektion stand, ist genau die Zahl, die der Sortierung
 * fehlt — und sie faellt an, ohne dass irgendeine KI, irgendeine IDE oder
 * irgendein Hersteller etwas anders machen muss.
 *
 * Der wertvollste Fall faellt dabei mit ab: wird eine Lektion geoeffnet, die
 * in der Antwort GAR NICHT stand, dann kannte der Mensch sie beim Namen und
 * die Suche hat sie nicht gefunden. Das ist `platz: 0`.
 *
 * ── Was hier NICHT behauptet wird ────────────────────────────────────────
 *
 * `geholfen: true` heisst bei einer abgeleiteten Zeile: **ausgewaehlt**, nicht
 * geloest. Deshalb traegt sie `quelle: 'abgeleitet'`, und `werteAus` rechnet
 * sie getrennt. Wer beides zusammenwirft, hat aus den aufgeblaehten
 * ROI-Stunden nichts gelernt.
 */
export type LetzterRecall = { frage: string; themen: string[] };

export function leiteAb(
  letzter: LetzterRecall | null | undefined,
  geoeffnetesThema: string,
  jetzt: string,
): Wirkungseintrag | null {
  if (!letzter) return null;
  const frage = text(letzter.frage, MAX_FRAGE);
  const thema = text(geoeffnetesThema, 200);
  if (!frage || !thema) return null;
  if (!Array.isArray(letzter.themen)) return null;

  const i = letzter.themen.indexOf(thema);
  return {
    ts: jetzt,
    quelle: 'abgeleitet',
    frage,
    thema,
    // Ausgewaehlt. Nicht "geloest" — siehe der Block darueber.
    geholfen: true,
    platz: i === -1 ? 0 : i + 1,
    notiz: i === -1
      ? 'automatisch: geoeffnet, obwohl nicht in der Antwort'
      : 'automatisch: aus der Antwort geoeffnet',
    autor: '',
  };
}

/**
 * Wie ein Eintrag fuer die Auswertung zaehlt.
 *
 * Nicht jede Rueckmeldung ist gleich viel wert. Diese Einordnung entscheidet
 * spaeter, was beim Lernen wie stark zieht — und sie steht hier als reine
 * Funktion, damit sie geprueft werden kann, statt in einer Abfrage zu
 * verschwinden.
 */
export type Lehrwert =
  /** Half, stand aber nicht in der Antwort. Der Topf hat versagt. */
  | 'fehlender-treffer'
  /** Half, stand aber weit hinten. Die Sortierung war zu schwach. */
  | 'zu-weit-hinten'
  /** Stand vorn und war falsch. Harter Gegenbeleg. */
  | 'falsch-und-sicher'
  /** Stand vorn und half. Bestaetigung. */
  | 'bestaetigung'
  /** Half nicht und stand hinten. Sagt wenig. */
  | 'unauffaellig';

/** Ab welchem Platz "weit hinten" beginnt. Drei, weil der Mensch drei sieht. */
export const SICHTBARE_PLAETZE = 3;

export function lehrwert(e: Pick<Wirkungseintrag, 'geholfen' | 'platz'>): Lehrwert {
  if (e.geholfen && e.platz === 0) return 'fehlender-treffer';
  if (e.geholfen && e.platz > SICHTBARE_PLAETZE) return 'zu-weit-hinten';
  if (!e.geholfen && e.platz > 0 && e.platz <= SICHTBARE_PLAETZE) return 'falsch-und-sicher';
  if (e.geholfen) return 'bestaetigung';
  return 'unauffaellig';
}

/**
 * Zaehlt eine Spur aus.
 *
 * `trefferquote` ist BEWUSST nicht "Anteil geholfen" — das waere eine Zahl
 * ueber die Lektionen. Gefragt ist die Zahl ueber die SORTIERUNG: von allen
 * Faellen, in denen ueberhaupt eine Lektion geholfen hat, wie oft stand sie
 * unter den ersten dreien?
 */
export function werteAus(spur: Wirkungseintrag[]): {
  gesamt: number;
  /** Nur die ausdruecklich gemeldeten Faelle. */
  gemeldet: number;
  /** Nur die vom Server beobachteten Auswahlen. */
  abgeleitet: number;
  geholfen: number;
  /**
   * Von allen GEMELDETEN hilfreichen Faellen: wie oft stand die Lektion unter
   * den ersten dreien? Abgeleitete Zeilen zaehlen hier BEWUSST nicht mit —
   * eine Auswahl ist keine Loesung.
   */
  trefferquote: number | null;
  /** Dieselbe Rechnung ueber die beobachteten Auswahlen, getrennt ausgewiesen. */
  auswahlquote: number | null;
  nachLehrwert: Record<Lehrwert, number>;
} {
  const nachLehrwert: Record<Lehrwert, number> = {
    'fehlender-treffer': 0,
    'zu-weit-hinten': 0,
    'falsch-und-sicher': 0,
    bestaetigung: 0,
    unauffaellig: 0,
  };
  let gemeldet = 0;
  let abgeleitet = 0;
  let geholfen = 0;
  let gemeldetGeholfen = 0;
  let gemeldetSichtbar = 0;
  let abgeleitetGesamt = 0;
  let abgeleitetSichtbar = 0;

  for (const e of spur) {
    nachLehrwert[lehrwert(e)]++;
    const sichtbar = e.platz > 0 && e.platz <= SICHTBARE_PLAETZE;
    if (e.quelle === 'abgeleitet') {
      abgeleitet++;
      abgeleitetGesamt++;
      if (sichtbar) abgeleitetSichtbar++;
      continue;
    }
    gemeldet++;
    if (e.geholfen) {
      geholfen++;
      gemeldetGeholfen++;
      if (sichtbar) gemeldetSichtbar++;
    }
  }

  return {
    gesamt: spur.length,
    gemeldet,
    abgeleitet,
    geholfen,
    // Ohne einen einzigen hilfreichen Fall gibt es keine Quote — und "0 %"
    // waere eine Aussage, die niemand gemessen hat.
    trefferquote: gemeldetGeholfen === 0 ? null : gemeldetSichtbar / gemeldetGeholfen,
    auswahlquote: abgeleitetGesamt === 0 ? null : abgeleitetSichtbar / abgeleitetGesamt,
    nachLehrwert,
  };
}
