/**
 * Verklebte Felder trennen, BEVOR eine Lektion geschrieben wird.
 *
 * ── Der Anlass, gemessen am 22.08.2026 ──────────────────────────────────────
 *
 * `ohneMarkierungen()` in eingaenge.ts filtert beim Einbetten die Zeichenkette
 * `</what_worked>\n<what_failed>` aus dem Text. Der Kommentar dort sagt, viele
 * Lektionen enthielten das "woertlich". Was er NICHT sagt: wo es herkommt.
 *
 * Es kommt beim SCHREIBEN herein. Wer `learn_from_attempts` aufruft und ein
 * Feld mit dem falschen Tag schliesst, uebergibt den gesamten Rest — inklusive
 * der Marke des naechsten Feldes — als Inhalt von `what_worked`. Das Ergebnis
 * sieht aus wie eine gefuellte Lektion, hat aber ein leeres `what_failed` und
 * einen Fliesstext mit Steuerzeichen darin.
 *
 * Belegt an derselben Lektion zweimal hintereinander, beide Male unbemerkt:
 * die Rueckmeldung des Werkzeugs zeigte den verklebten Text an, ohne dass
 * irgendetwas rot wurde.
 *
 * ── Warum hier und nicht beim Lesen ─────────────────────────────────────────
 *
 * Beim Lesen wird gefiltert, damit der Vektor nicht auf Feldnamen zeigt. Das
 * ist richtig und bleibt. Es heilt aber nur die Einbettung — im Bestand steht
 * der Text weiter falsch, `what_failed` bleibt leer, und das Briefing zeigt
 * Steuerzeichen. Zwei Stellen fuer dasselbe Problem waeren die uebliche
 * Fehlerklasse dieses Hauses: eine Information an zwei Orten gepflegt.
 *
 * Deshalb wird HIER repariert, an der einzigen Stelle, an der der Fehler
 * entsteht.
 *
 * ── Was es ausdruecklich NICHT tut ──────────────────────────────────────────
 *
 * Es fasst Text NICHT an, der die Feldnamen bloss ERWAEHNT. "der what_failed-
 * Text stand in what_worked" ist ein voellig normaler Satz in einer Lektion
 * ueber genau diesen Fehler. Getrennt wird nur an einer echten Marke, also an
 * spitzen Klammern.
 *
 * Und es wirft nie Text weg. Findet es keinen Platz fuer ein Stueck, bleibt
 * es stehen, wo es war — nur ohne die Marke.
 */

/** Die Felder einer Lektion, die verkleben koennen. */
export interface Lektionsfelder {
  what_worked: string;
  what_failed?: string;
  context?: string;
}

/** Nur diese drei. `topic` und `outcome` sind kurz und kleben nicht. */
const FELDNAMEN = ['what_worked', 'what_failed', 'context'] as const;
type Feldname = (typeof FELDNAMEN)[number];

/**
 * Eine Marke ist ein Feldname in spitzen Klammern — in allen Formen, die
 * tatsaechlich vorkommen:
 *
 *   </what_worked>                       schliessend
 *   <what_failed>                        oeffnend
 *   <parameter name="what_failed">       die Form, die den Fehler ausloest
 *
 * Ohne spitze Klammern ist es Fliesstext und bleibt unberuehrt.
 */
const MARKE = new RegExp(
  String.raw`<\/?(?:parameter\s+name\s*=\s*["']?)?(${FELDNAMEN.join('|')})["']?\s*\/?>`,
  'gi',
);

/** Ist in diesem Text ueberhaupt eine Marke? Billig, fuer den Normalfall. */
export function hatFeldmarke(text: string | undefined): boolean {
  if (!text) return false;
  MARKE.lastIndex = 0;
  return MARKE.test(text);
}

/**
 * Trennt verklebte Felder auf und gibt sie einzeln zurueck.
 *
 * Der Text VOR der ersten Marke bleibt in dem Feld, in dem er stand. Jedes
 * Stueck dahinter geht in das Feld, dessen Marke davorstand — aber nur, wenn
 * dieses Feld noch leer ist. Ein bereits gefuelltes Feld wird nie
 * ueberschrieben; das Stueck haengt sich dann hinten an, damit nichts
 * verlorengeht.
 */
export function repariereFelder(f: Lektionsfelder): Lektionsfelder {
  if (!hatFeldmarke(f.what_worked) && !hatFeldmarke(f.what_failed) && !hatFeldmarke(f.context)) {
    return f;
  }

  const aus: Record<Feldname, string> = {
    what_worked: '',
    what_failed: f.what_failed ?? '',
    context: f.context ?? '',
  };

  // Nur what_worked wird zerlegt — dort landet der Rest, weil es das erste
  // lange Feld ist. Die anderen beiden werden nur von Marken befreit.
  const text = f.what_worked ?? '';
  const stuecke: Array<{ ziel: Feldname; text: string }> = [];
  let letzterIndex = 0;
  let aktuellesZiel: Feldname = 'what_worked';

  MARKE.lastIndex = 0;
  for (let m = MARKE.exec(text); m !== null; m = MARKE.exec(text)) {
    stuecke.push({ ziel: aktuellesZiel, text: text.slice(letzterIndex, m.index) });
    const genannt = m[1].toLowerCase() as Feldname;
    // Eine SCHLIESSENDE Marke sagt nur "hier endet etwas" und nennt kein
    // neues Ziel. Der Text danach gehoert dem naechsten genannten Feld —
    // bis dahin bleibt er beim bisherigen.
    aktuellesZiel = m[0].startsWith('</') ? aktuellesZiel : genannt;
    letzterIndex = m.index + m[0].length;
  }
  stuecke.push({ ziel: aktuellesZiel, text: text.slice(letzterIndex) });

  for (const s of stuecke) {
    const t = s.text.trim();
    if (!t) continue;
    if (aus[s.ziel]) aus[s.ziel] = `${aus[s.ziel]}\n\n${t}`;
    else aus[s.ziel] = t;
  }

  // Reste in den anderen beiden Feldern: Marke raus, Text behalten.
  const entmarken = (s: string): string => s.replace(MARKE, ' ').replace(/[ \t]{2,}/g, ' ').trim();

  return {
    what_worked: entmarken(aus.what_worked),
    what_failed: aus.what_failed ? entmarken(aus.what_failed) : f.what_failed,
    context: aus.context ? entmarken(aus.context) : f.context,
  };
}
