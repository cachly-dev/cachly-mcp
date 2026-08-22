/**
 * Wertbeitrag — was ein einzelner Abruf zur Zeitersparnis beiträgt.
 *
 * ─── DER ANLASS ────────────────────────────────────────────────────────────
 *
 * Am 17.08.2026 zeigte das Panel eines Brains mit 475 Lektionen eine
 * Zeitersparnis von 54 Tagen und einen Gegenwert von 97.237,50 €. Nachgerechnet
 * stammte praktisch die ganze Zahl aus dem STARTER-KORPUS: `docker:layer-cache`
 * stand bei 973 Abrufen, `cache:stampede` bei 971, dahinter neun weitere
 * Starter-Lektionen mit je rund 208. Die echten, projektbezogenen Lektionen
 * standen bei zwei bis fünf.
 *
 * Der Starter-Korpus ist genau das, wofür er gedacht ist: ein Startvorrat, der
 * dafür sorgt, dass die erste Frage an ein leeres Brain nicht ins Leere geht.
 * Er ist eingekauftes Allgemeinwissen — Docker-Cache, JWT-Uhrzeitversatz,
 * N+1-Abfragen. Er ist NICHT das, was jemand über sein Projekt gelernt hat.
 *
 * Ihn in die Wertschätzung einzurechnen macht die Zahl doppelt falsch:
 *   - Sie wächst, ohne dass jemand etwas gelernt hat.
 *   - Sie wächst am schnellsten in Brains, die am wenigsten eigenes Wissen
 *     haben — dort gibt es ja nichts anderes zu treffen.
 *
 * Eine Kennzahl, die dann am besten aussieht, wenn das Produkt am wenigsten
 * leistet, ist schlimmer als gar keine.
 *
 * ─── WARUM KEINE NAMENSLISTE ───────────────────────────────────────────────
 *
 * Naheliegend wäre gewesen, die sechs auffälligen Themen hart auszuschliessen.
 * Das wäre ein Wächter, der auf den Anlass genagelt ist: Beim nächsten
 * Starter-Korpus mit anderen Namen wäre er blind. Die Starter-Lektionen tragen
 * seit ihrer Einführung `source: 'starter'` im Datensatz — genau dafür. Diese
 * Datei benutzt die Markierung, nicht die Namen.
 *
 * ─── NACHTRAG 22.08.2026: DIE MARKIERUNG GAB ES NICHT ──────────────────────
 *
 * Der Absatz darüber stand fünf Tage lang so da und war falsch. Gemessen in
 * der Gegenrede über die Zahl „Brain saved you ~1664h":
 *
 *     brain_hygiene(dry_run) → "Startvorrat entwertet (Zähler auf 0): 0"
 *     bei 543 gescannten Lektionen.
 *
 * NULL. Der Filter griff bei keiner einzigen. `docker:layer-cache` — der
 * Anlass dieser ganzen Datei — zählte weiterhin voll mit inzwischen 974
 * Abrufen.
 *
 * Der Grund: Die eingebauten Lektionen kommen über `import_public_brain`
 * herein und tragen dabei gar kein `source`-Feld. Die Markierung, auf die
 * sich der Absatz oben verlässt, wird beim Schreiben nie gesetzt.
 *
 * Das ist die eigentliche Lehre, und sie ist unbequemer als die erste: Der
 * Fix war gebaut, beschrieben und begründet — und hat nie gewirkt. Niemand
 * hat nachgemessen, ob er greift. Fünf Tage lang stand in dieser Datei ein
 * Kommentar über einen Schutz, den es nicht gab.
 *
 * Deshalb prüft `istStarterLektion` jetzt drei Dinge (Herkunft, Thema,
 * fremder Installationsweg) — und deshalb steht darunter eine Probe, die
 * nicht den Code liest, sondern eine echte Lektion durch die Funktion
 * schickt. Ein Kommentar ist kein Beweis.
 */

import { STARTER_CORPUS } from './starter-corpus.js';

/** fmtStunden macht aus Minuten eine lesbare Angabe ("21 h", "3 d 4 h"). */
export function fmtStunden(minuten: number): string {
  const gesamt = Math.max(0, Math.round(minuten));
  if (gesamt < 60) return `${gesamt} min`;
  const stunden = Math.floor(gesamt / 60);
  if (stunden < 24) return `${stunden} h`;
  const tage = Math.floor(stunden / 24);
  const rest = stunden % 24;
  return rest > 0 ? `${tage} d ${rest} h` : `${tage} d`;
}

/** Eine Lektion, soweit sie für die Bewertung gebraucht wird. */
export interface BewertbareLektion {
  severity?: string;
  source?: string;
  topic?: string;
  what_worked?: string;
  recall_count?: number;
  [k: string]: unknown;
}

/**
 * Der ausgelieferte Startvorrat, nach Thema aufgeschlagen — ABGELEITET.
 *
 * Erster Versuch am 22.08.2026 war eine von Hand gepflegte Namensliste. Sie war
 * schon beim Schreiben falsch: sieben Themen fehlten, drei standen darin, die
 * es gar nicht gibt. Eine zweite Liste derselben Wahrheit laeuft auseinander,
 * bevor sie fertig ist.
 */
const STARTER_NACH_THEMA: ReadonlyMap<string, string> = new Map(
  STARTER_CORPUS.map((l) => [l.topic, l.what_worked]),
);

/** Die Themen des Startvorrats — fuer Aufrufer, die nur die Namen brauchen. */
export const STARTER_THEMEN: ReadonlySet<string> = new Set(STARTER_NACH_THEMA.keys());

/**
 * Herkuenfte, die NICHT als eigene Lernleistung zaehlen.
 *
 * Es gibt zwei Wege, auf denen fremdes Wissen in ein Brain kommt, und sie
 * schreiben ZWEI VERSCHIEDENE Werte:
 *
 *   brain_seed_starter   (share.ts)  → source: 'starter'
 *   import_public_brain  (team.ts)   → source: 'public_brain'
 *
 * `marketplace:` und `syndicate:` sind vorgemerkt, damit der naechste
 * Einbauweg nicht wieder still durchrutscht.
 */
const FREMDE_HERKUNFT = /^(starter|public_brain|marketplace:|syndicate:|import)/;

/**
 * Stammt die Lektion aus fremdem Wissen statt aus eigener Arbeit?
 *
 * Solche Lektionen duerfen abgerufen werden und sind nuetzlich — sie zaehlen
 * nur nicht als etwas, das dieser Mensch oder dieses Team gelernt hat.
 *
 * ── NACHTRAG 22.08.2026: der Filter kannte nur die Haelfte ──────────────────
 *
 * Der Schutz war seit dem 17.08. gebaut, beschrieben und begruendet — und hat
 * die groesste Einzelquelle nie erwischt. Er pruefte:
 *
 *     return lesson?.source === 'starter';
 *
 * `import_public_brain` schreibt aber `source: 'public_brain'` (team.ts:1610),
 * und dahinter steht eine EIGENE eingebaute Liste von rund 40 Lektionen ueber
 * go, docker, kubernetes, react, typescript und python — darunter
 * `docker:layer-cache`, die meistabgerufene Lektion dieses Brains ueberhaupt
 * (980 Abrufe, gemessen am 22.08.2026).
 *
 * Ein Vergleich auf genau eine Zeichenkette ist blind fuer den zweiten Weg.
 * Und weil `brain_hygiene` (team.ts:1247) die Zeitersparnis aus derselben
 * Funktion NEU rechnet, machte die Luecke die Zahl nicht nur zu gross, sondern
 * beim Aufraeumen noch groesser: 1664 h → 6445 h.
 *
 * ── Warum trotzdem nicht nur ueber die Namen ────────────────────────────────
 *
 * Eine reine Namensliste wuerde eine echte Regel brechen: Wer selbst etwas
 * ueber `docker:layer-cache` lernt, hat etwas gelernt. Deshalb entscheidet
 * zuerst die Herkunft. Nur wenn gar keine dasteht — `learn_from_attempts`
 * setzt das Feld nicht — wird das Thema geprueft, und dann muss auch der TEXT
 * wortgleich der ausgelieferte sein. Ein eigener Satz zum selben Thema zaehlt.
 */
export function istStarterLektion(lesson: BewertbareLektion | null | undefined): boolean {
  if (!lesson) return false;

  if (typeof lesson.source === 'string' && lesson.source !== '') {
    // Herkunft steht da: sie entscheidet, in beide Richtungen.
    return FREMDE_HERKUNFT.test(lesson.source);
  }

  // Keine Herkunft: nur ein WORTGLEICHER Treffer aus dem Vorrat zaehlt nicht.
  if (typeof lesson.topic !== 'string') return false;
  const ausgeliefert = STARTER_NACH_THEMA.get(lesson.topic);
  if (ausgeliefert === undefined) return false;
  const eigener = typeof lesson.what_worked === 'string' ? lesson.what_worked : '';
  return eigener.trim() === ausgeliefert.trim();
}

/**
 * Minuten, die ein Abruf dieser Lektion einspart — 0 für fremdes Wissen.
 *
 * Die Staffel (30 / 60 / 240) ist unverändert; sie stand vorher an drei
 * Stellen im Code und steht jetzt hier. `basis` erlaubt der abweichenden
 * Staffel von causal_trace (60 / 120 / 240) ihren eigenen Grundwert, ohne dass
 * die Starter-Regel ein zweites Mal geschrieben werden muss.
 */
export function ersparteMinuten(
  lesson: BewertbareLektion | null | undefined,
  basis: 'recall' | 'trace' = 'recall',
): number {
  if (!lesson || istStarterLektion(lesson)) return 0;

  const sev = lesson.severity;
  if (sev === 'critical') return 240;
  if (sev === 'major') return basis === 'trace' ? 120 : 60;
  return basis === 'trace' ? 60 : 30;
}

/**
 * Zaehlt dieser Abruf ueberhaupt Zeit — oder ist es ein Wiedersehen?
 *
 * ── DER ZWEITE BEFUND VOM 22.08.2026 ────────────────────────────────────────
 *
 * Der Startvorrat-Filter war nur die halbe Ursache. Die andere Haelfte:
 * Zeitersparnis wurde bei JEDEM Abruf erneut gutgeschrieben.
 *
 * `smart_recall` schreibt bis zu FUENF Lektionen pro Aufruf die volle
 * Recherchezeit gut (brain.ts:1725 ff.). Die Anleitung des Servers verlangt
 * einen Aufruf "BEFORE every task", und eingeblendete Lektionen kommen
 * zusaetzlich bei jedem Prompt. Zehn Aufgaben in einer Sitzung konnten so
 * rechnerisch zweihundert Stunden erzeugen.
 *
 * Gemessen: Dieses Brain ist am 01.06.2026 entstanden, 82 Tage alt, und meldete
 * 1664,5 Stunden. Eine Person haette in 82 Tagen zu acht Stunden 656 Stunden
 * gehabt. Die Zahl war nicht zu hoch — sie war unmoeglich.
 *
 * ── Die Regel, die haelt ────────────────────────────────────────────────────
 *
 * Die Zusage lautet "time not re-researching known fixes". Recherchiert wird
 * EINMAL. Wer dieselbe Lektion zum neunhundertsten Mal sieht, spart nicht zum
 * neunhundertsten Mal eine Recherche — er spart ein Nachschlagen.
 *
 * Also: jede Lektion zaehlt genau EINMAL, beim ersten Abruf. Damit ist die
 * Zahl nach oben durch den Wissensstand begrenzt statt durch die Nutzung, sie
 * kann nicht mehr schneller wachsen als gelernt wird — und das Einblenden
 * treibt sie gar nicht mehr.
 *
 * Das ist dieselbe Fehlerklasse wie `cachly:metric-inflation-fixed` (PR #158,
 * stuendliche Heartbeat-Pings blaehten die ROI-Zahlen auf). Damals wurde die
 * eine Quelle abgestellt; die Bauart, die aus Wiederholung Wert macht, blieb.
 */
export function zaehltAlsErsparnis(lesson: BewertbareLektion | null | undefined): boolean {
  if (!lesson || istStarterLektion(lesson)) return false;
  // recall_count ist der Stand VOR diesem Abruf. 0 heisst: das erste Mal.
  const bisher = typeof lesson.recall_count === 'number' ? lesson.recall_count : 0;
  return bisher <= 0;
}

