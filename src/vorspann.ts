/**
 * Der Vorspann einer Lektion — die ersten 100 Zeichen, und nur die.
 *
 * GEMESSEN am 16.08.2026: Das Session-Briefing zeigt je Lektion rund 100
 * Zeichen. In `node4:einrichtung-contabo-und-fallen` stand die gesuchte
 * Adresse `10.8.0.7` an Zeichen 323, und die passende Warnung im Feld
 * `what_failed`, das im Briefing gar nicht erscheint. Die Lektion war
 * eingeblendet. Der Fehler passierte trotzdem.
 *
 * Die Abhilfe war eine SCHREIBREGEL, kein Codefix: die entscheidende Tatsache
 * gehoert in die ersten 100 Zeichen — die Zahl, die Adresse, der Befehl. Nicht
 * der Anlass, nicht die Ausstattung, nicht die Vorgeschichte.
 *
 * Eine Regel, die kein Skript prueft, ist aber kein Gesetz, sondern ein
 * Wunsch. Dieses Modul prueft sie — im Moment des Schreibens, wo der Autor
 * (Mensch oder Agent) die Lektion noch in der Hand hat.
 *
 * Bewusst ein HINWEIS und keine Ablehnung: es gibt Lektionen ohne harte Zahl
 * (eine Entscheidung, eine Richtung), und eine abgelehnte Lektion ist immer
 * schlechter als eine unscharf formulierte.
 */

/** So viel sieht die naechste Sitzung im Briefing. Gemessen, nicht geschaetzt. */
export const VORSPANN_ZEICHEN = 100;

/**
 * Was als "harte Tatsache" zaehlt.
 *
 * Jedes Muster steht fuer etwas, das man beim naechsten Mal ABSCHREIBEN will
 * und nicht neu herausfinden: eine Adresse, ein Port, eine Zahl mit Einheit,
 * ein Pfad, ein Befehl, eine Version, ein Schluessel-Wert-Paar.
 */
const HARTE_MUSTER: { name: string; re: RegExp }[] = [
  { name: 'IP-Adresse', re: /\b\d{1,3}(?:\.\d{1,3}){3}\b/ },
  { name: 'Port', re: /:\d{2,5}\b/ },
  { name: 'Zahl', re: /\b\d+(?:[.,]\d+)?\s*(?:%|s|ms|m|h|d|MB|GB|TB|KB|k|x|×|EUR|€|\$)?\b/ },
  { name: 'Pfad', re: /(?:^|\s)(?:\/[\w.-]+){2,}|[A-Za-z]:\\[\w\\.-]+/ },
  { name: 'Befehl oder Datei', re: /`[^`]+`|\b[\w-]+\.(?:ts|tsx|go|js|mjs|py|sh|yml|yaml|json|sql|env)\b/ },
  // Ein Name in Grossbuchstaben mit mindestens zwei Unterstrichen ist in der
  // Praxis immer eine Umgebungsvariable oder ein Schalter — also etwas zum
  // Abschreiben. Zwei Unterstriche, damit nicht jedes betonte Wort greift.
  // Der Doppelpunkt ist bewusst NICHT dabei. Er war zuerst erlaubt, und die
  // Gegenprobe fing sofort den Fehlalarm: "WICHTIG:" ist ein betontes Wort,
  // keine Angabe. Bleibt das Gleichheitszeichen (PORT=3095) und der Name mit
  // mindestens zwei Unterstrichen, der in der Praxis immer eine
  // Umgebungsvariable ist.
  { name: 'Schluessel', re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}\b|\b[A-Z][A-Z0-9_]{3,}\s*=/ },
  { name: 'Version', re: /\bv?\d+\.\d+(?:\.\d+)?\b/ },
];

export interface VorspannBefund {
  /** Die ersten VORSPANN_ZEICHEN Zeichen — das, was die naechste Sitzung sieht. */
  vorspann: string;
  /** Traegt der Vorspann mindestens eine harte Tatsache? */
  traegtTatsache: boolean;
  /** Welche Muster gegriffen haben (leer, wenn keines). */
  gefunden: string[];
  /**
   * Steht die erste harte Tatsache erst HINTER dem Vorspann? Dann ist die
   * Lektion nicht inhaltsleer — sie ist nur falsch herum geschrieben, und
   * genau dieser Fall ist der teure.
   */
  tatsacheStehtSpaeter: boolean;
  /** Position der ersten harten Tatsache im ganzen Text, oder -1. */
  ersteTatsacheBei: number;
  /**
   * Endet der Vorspann MITTEN im Satz?
   *
   * GEMESSEN am 19.08.2026 an einer selbst geschriebenen Lektion. Ihre ersten
   * 100 Zeichen lauteten:
   *
   *   "109 Testdateien lesen Quelltext, 102 OHNE Kommentar-Filter, 13 davon
   *    GRUEN weil"
   *
   * Drei Zahlen, alle drei da — und genau bei "weil" ist Schluss. Das Briefing
   * zeigt also die Zahlen, aber nicht, WOFUER sie stehen. Wer das liest, weiss
   * nicht, ob 13 gut oder schlecht ist.
   *
   * Die Tatsachen-Pruefung allein war zufrieden, und zu Recht — die Zahlen
   * stehen ja vorn. Was fehlte, war ihre Wirkung, und die passt fast immer in
   * denselben Satz: "13 Waechter waren gruen, ohne etwas zu pruefen" sind 47
   * Zeichen und vollstaendig.
   */
  abgeschnitten: boolean;
}

/**
 * Steht im Vorspann ein abgeschlossener Gedanke?
 *
 * Mechanisch, nicht inhaltlich: gesucht wird ein Satzende (Punkt, Semikolon,
 * Ausrufe- oder Fragezeichen) innerhalb der ersten 100 Zeichen. Findet sich
 * keines, endet der Vorspann mitten im Satz.
 *
 * Absichtlich KEINE Bedeutungspruefung. Ein Waechter, der raet, ob ein Satz
 * "vollstaendig genug" ist, schlaegt bei jeder zweiten Lektion falschen Alarm
 * — und ein Waechter, der zu oft Nein sagt, wird abgeschaltet. Ein fehlendes
 * Satzzeichen ist dagegen eine Tatsache.
 *
 * Ein Text, der insgesamt kuerzer ist als der Vorspann, gilt NICHT als
 * abgeschnitten: dort steht alles, was es gibt.
 */
function endetMittenImSatz(text: string): boolean {
  if (text.length <= VORSPANN_ZEICHEN) return false;
  const vorspann = text.slice(0, VORSPANN_ZEICHEN);
  // Zwei Feinheiten, beide am echten Fall gelernt:
  //
  // 1. Ein Punkt in "10.8.0.7" oder "v1.2" beendet keinen Satz — deshalb muss
  //    auf das Satzzeichen ein Leerzeichen oder das Textende folgen.
  // 2. Der DOPPELPUNKT zaehlt NICHT. Er leitet ein, er schliesst nicht ab.
  //    Genau daran scheiterte die erste Fassung: "GEMESSEN 19.08.2026: 109
  //    Testdateien ... 13 davon GRUEN weil" galt als abgeschlossen, weil der
  //    Doppelpunkt nach dem Datum mitzaehlte. Der Satz endet dort aber nicht,
  //    er faengt an.
  return !/[.;!?](?:\s|$)/.test(vorspann);
}

/** Frueheste Fundstelle irgendeines harten Musters, oder -1. */
function ersteFundstelle(text: string): number {
  let best = -1;
  for (const m of HARTE_MUSTER) {
    const treffer = m.re.exec(text);
    if (!treffer) continue;
    const i = treffer.index;
    if (best === -1 || i < best) best = i;
  }
  return best;
}

/**
 * Prueft den Vorspann von `what_worked`.
 *
 * Leerer oder fehlender Text ergibt einen Befund ohne Tatsache und ohne
 * "steht spaeter" — es gibt dann nichts umzustellen, sondern nichts zu lesen.
 */
export function pruefeVorspann(whatWorked: string | null | undefined): VorspannBefund {
  const text = typeof whatWorked === 'string' ? whatWorked : '';
  const vorspann = text.slice(0, VORSPANN_ZEICHEN);
  const gefunden = HARTE_MUSTER.filter(m => m.re.test(vorspann)).map(m => m.name);
  const ersteTatsacheBei = ersteFundstelle(text);
  return {
    vorspann,
    traegtTatsache: gefunden.length > 0,
    gefunden,
    tatsacheStehtSpaeter: gefunden.length === 0 && ersteTatsacheBei >= VORSPANN_ZEICHEN,
    ersteTatsacheBei,
    abgeschnitten: endetMittenImSatz(text),
  };
}

/**
 * Ein Satz fuer den Autor — oder null, wenn alles in Ordnung ist.
 *
 * Der Hinweis nennt die POSITION, wenn die Tatsache nur zu weit hinten steht.
 * Ohne Zahl waere er eine Ermahnung; mit Zahl ist er eine Anweisung, die man
 * in zehn Sekunden befolgen kann.
 */
export function vorspannHinweis(whatWorked: string | null | undefined): string | null {
  const b = pruefeVorspann(whatWorked);
  if (!b.vorspann.trim()) return null;

  /*
   * Die Zahl ist da, aber der Satz ist es nicht.
   *
   * Dieser Fall kam am 19.08.2026 dazu und ist der feinere: die alte Pruefung
   * war zufrieden, weil drei Zahlen in den ersten 100 Zeichen standen — und
   * genau bei "weil" war Schluss. Zahlen ohne ihre Wirkung sind im Briefing
   * kein Wissen, sondern ein Raetsel.
   */
  if (b.traegtTatsache && b.abgeschnitten) {
    return (
      `📏 **Der Vorspann endet mitten im Satz** — die Zahl steht vorn, ihre Wirkung nicht. ` +
      `Das Briefing der nächsten Sitzung bricht bei ${VORSPANN_ZEICHEN} Zeichen ab und zeigt dann ` +
      `eine Zahl ohne Bedeutung. Ein abgeschlossener Satz in den ersten ${VORSPANN_ZEICHEN} Zeichen ` +
      `genügt: nicht „13 davon grün weil", sondern „13 Wächter waren grün, ohne etwas zu prüfen."`
    );
  }
  if (b.traegtTatsache) return null;

  if (b.tatsacheStehtSpaeter) {
    return (
      `📏 **Die entscheidende Tatsache steht bei Zeichen ${b.ersteTatsacheBei}** — das Briefing der nächsten ` +
      `Sitzung endet bei ${VORSPANN_ZEICHEN}. Stell die Zahl, Adresse oder den Befehl an den Anfang von ` +
      `\`what_worked\`; die Vorgeschichte gehört ans Ende oder in \`context\`.`
    );
  }
  return (
    `📏 **In den ersten ${VORSPANN_ZEICHEN} Zeichen steht keine Zahl, Adresse oder Befehl** — nur so viel sieht ` +
    `die nächste Sitzung im Briefing. Trägt diese Lektion eine harte Tatsache, gehört sie nach vorn.`
  );
}
