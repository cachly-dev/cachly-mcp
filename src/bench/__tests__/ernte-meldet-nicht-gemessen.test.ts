import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bewertePaar, ueberlappung, frageAusIssue, lektionAusPr } from '../fremdernte.js';

/**
 * ══ Die Ernte darf Stille nicht als Null buchen ═════════════════════════════
 *
 * ── Der Anlass, gemessen am 24.08.2026 ────────────────────────────────────
 *
 * Ein Lauf ueber 16 oeffentliche Projekte. Die ersten fuenf lieferten 260 bis
 * 277 Paare. Ab dem sechsten stand in jeder Zeile dasselbe:
 *
 *   ansible/ansible     0 Paare, 300 "ohne PR-Bezug"   —  7628 vorhanden
 *   grafana/grafana     0 Paare, 300 "ohne PR-Bezug"   — 12022 vorhanden
 *   home-assistant      0 Paare, 300 "ohne PR-Bezug"   — 16454 vorhanden
 *
 * Zehn Projekte behaupteten, kein einziges ihrer Issues habe einen
 * verknuepften PR — bei zusammen ueber 60000 verknuepften Paaren.
 *
 * Der Grund war banal: das Stundenkontingent ist 5000, ein Projekt kostete
 * ueber den alten Weg rund 700 Anfragen. Nach fuenf Projekten war es leer.
 *
 * ── Warum das trotzdem nicht der Fehler war ──────────────────────────────
 *
 * Ein leeres Kontingent ist kein Fehler, sondern eine Tatsache. Der Fehler
 * war ein `catch`, das JEDEN Fehler zur Aussage "dieses Issue hat keinen PR"
 * machte. Die Ernte schrieb eine gueltige leere Datei, meldete "fertig" und
 * endete mit 0.
 *
 * Das ist die Fehlerklasse, die im Haus schon sechs Mal zugeschlagen hat:
 * **es gibt keinen Zustand "nicht gemessen", also wird Stille als Null
 * gebucht.** Eine Null sieht aus wie ein Ergebnis.
 *
 * ── Warum diese Probe zweimal umgeschrieben wurde ────────────────────────
 *
 * Die erste Fassung prueste Zeichenketten: `'ohne-pr'`, `nichtGemessen`,
 * `KOSTEN_JE_ISSUE`. Zwei Stunden spaeter wurde die Ernte von REST auf
 * GraphQL umgestellt — dieselben Regeln, andere Woerter — und sieben von
 * dreizehn Proben fielen um, obwohl NICHTS schlechter geworden war.
 *
 * Das ist der Waechter, der die Schreibweise bewacht statt die Regel. Er ist
 * im Haus schon einmal genau so aufgefallen (`leerzustand-verlangt-nichts-
 * unmoegliches`, 22.08.2026).
 *
 * Diese Fassung prueft, wo immer es geht, das VERHALTEN der ausgefuehrten
 * Funktionen. Nur wo das nicht geht — weil ein echter Lauf Netz und
 * Kontingent braucht — bleibt eine Regel im Quelltext stehen.
 */

const QUELLE = readFileSync(resolve(__dirname, '..', 'fremdernte.ts'), 'utf8');

/**
 * Kommentare ausblenden, ohne Zeilen zu verschieben.
 *
 * Ohne das faellt diese Probe an ihrer eigenen Erklaerung um: der Text oben
 * zitiert Code woertlich. Genau das ist im Haus schon fuenf Mal passiert.
 */
function ohneKommentare(quelle: string): string {
  const nichtUmbruch = /[^\n]/g;
  return quelle
    .replace(/\/\*[\s\S]*?\*\//g, (t) => t.replace(nichtUmbruch, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (t, vor: string) => vor + ' '.repeat(t.length - vor.length));
}

const CODE = ohneKommentare(QUELLE);

describe('Die Auswahl laesst kein Paar durch, das die Messung verfaelscht', () => {
  const gutefrage = 'Pushing docker images to the registry fails with an EOF error '
    + 'after upgrading, while the previous version worked without any change to my setup.';
  const gutelektion = 'The upload handler closed the stream before the last chunk was '
    + 'flushed. routers/api/packages/container/container.go tests/integration/api_test.go';

  it('ein brauchbares Paar kommt durch', () => {
    const b = bewertePaar(gutefrage, gutelektion, 2, 4);
    expect(b.ablehnung).toBeUndefined();
    expect(b.wert).toBeGreaterThan(0);
  });

  it('ein Paar, dessen Antwort in der Frage steht, wird abgelehnt', () => {
    /*
     * Der gefaehrlichste Fall ueberhaupt. Es macht die Zahlen schoen und
     * beweist nichts: eine Suche, die es findet, hat nur abgeschrieben.
     * Dieselbe Fehlerklasse wie am 20.08.2026, als der Messstand eine andere
     * Anordnung mass als die ausgelieferte.
     */
    const b = bewertePaar(gutefrage, `${gutefrage} And here is the fix for it in the code.`, 3, 5);
    expect(b.ablehnung).toBe('Antwort steht in der Frage');
  });

  it('ein Umbau ueber 200 Dateien ist keine Lektion', () => {
    expect(bewertePaar(gutefrage, gutelektion, 213, 9).ablehnung).toBe('Umbau statt Behebung');
  });

  it('ein Titel ohne Rumpf ist keine Frage', () => {
    expect(bewertePaar('crash on start', gutelektion, 2, 1).ablehnung).toBe('Frage zu duenn');
  });

  it('eine Lektion ohne Beschreibung traegt nichts', () => {
    expect(bewertePaar(gutefrage, 'fixed it', 2, 1).ablehnung).toBe('Lektion zu duenn');
  });

  it('von zwei brauchbaren Paaren gewinnt das SCHWERERE', () => {
    /*
     * Der Sinn der ganzen Auswahl. Ein Fall mit wenig Ueberlappung, wenigen
     * geaenderten Dateien und Diskussion ist der, an dem sich eine Sortierung
     * ueberhaupt beweisen kann.
     */
    const schwer = bewertePaar(gutefrage, gutelektion, 2, 11);
    const leicht = bewertePaar(gutefrage, `${gutefrage.slice(0, 70)} ${gutelektion}`, 30, 0);
    expect(schwer.wert).toBeGreaterThan(leicht.wert);
  });
});

describe('Die Ueberlappung misst, was sie messen soll', () => {
  it('gleicher Text ist voll ueberlappend', () => {
    expect(ueberlappung('timeout beim deploy', 'timeout beim deploy')).toBe(1);
  });

  it('fremder Text ueberlappt nicht', () => {
    expect(ueberlappung('timeout beim deploy', 'schriftgroesse falsch')).toBe(0);
  });

  it('sie wird an der FRAGE gemessen, nicht an beiden zusammen', () => {
    /*
     * Durch die Vereinigung geteilt wuerde eine sehr lange Lektion die Zahl
     * kleinruehren — und genau die langen Lektionen enthalten die Antwort.
     * Die Gefahr heisst "die Antwort steht in der Frage", nicht "beide sind
     * lang".
     */
    const kurz = ueberlappung('timeout deploy', 'timeout deploy');
    const lang = ueberlappung('timeout deploy', `timeout deploy ${'wort '.repeat(200)}`);
    expect(kurz).toBe(lang);
  });

  it('KONTROLLE: eine leere Frage liefert 0 und keinen Fehler', () => {
    // Sonst entstuende NaN — eine Zahl, die jeden Vergleich still verliert.
    expect(ueberlappung('', 'irgendwas')).toBe(0);
  });
});

describe('Die Lektion enthaelt den PR-Titel nicht', () => {
  it('nur Rumpf und Dateien', () => {
    // Der Titel wiederholt fast immer das Issue. Wer ihn aufnimmt, baut die
    // Antwort in die Frage ein — die Suche waere trivial.
    const l = lektionAusPr('Closes the stream after the last chunk.', ['a.go', 'b.go']);
    expect(l).toContain('a.go');
    expect(l).toContain('last chunk');
  });

  it('Codebloecke fliegen raus, aus Frage wie Lektion', () => {
    // Ein Codeblock ist Beleg, nicht Frage — und er wuerde die Ueberlappung
    // kuenstlich hochtreiben.
    expect(frageAusIssue('t', 'davor ```const x = 1``` danach')).not.toContain('const x');
    expect(lektionAusPr('davor ```const x = 1``` danach', [])).not.toContain('const x');
  });
});

describe('Ein leeres Kontingent ist eine eigene Fehlerart', () => {
  it('es gibt sie ueberhaupt', () => {
    expect(CODE).toContain('class KontingentLeer');
  });

  it('sie wird an dem einzigen verlaesslichen Merkmal erkannt', () => {
    /*
     * GitHub meldet ein leeres Kontingent als 403 ODER 429 — mit
     * `x-ratelimit-remaining: 0`. Ein blosser 403 ist aber auch "du darfst
     * dieses Repo nicht sehen". Wer nur auf den Status prueft, wartet eine
     * Stunde auf etwas, das nie kommt.
     *
     * Ueber GraphQL kommt dieselbe Auskunft zusaetzlich als Fehlerart
     * RATE_LIMITED bei HTTP 200.
     */
    expect(CODE).toContain('x-ratelimit-remaining');
    expect(CODE).toContain('RATE_LIMITED');
  });

  it('sie wird NICHT wiederholt', () => {
    // Drei Versuche gegen ein leeres Kontingent sind drei Punkte aus einem
    // Konto, das keine mehr hat.
    expect(CODE).toMatch(/if \(e instanceof KontingentLeer\) throw e;/);
  });

  it('sie nennt die Uhrzeit, ab der es wieder geht', () => {
    // "Kontingent leer" allein laesst nur eine Handlung zu: raten.
    expect(CODE).toContain('wiederAb');
    expect(CODE).toMatch(/x-ratelimit-reset/);
  });
});

describe('Kein Fehler wird still zu einem Ergebnis', () => {
  it('kein `catch`, das jeden Fehler zu null macht', () => {
    /*
     * Die eine Zeile, an der alles hing. Sie darf in keiner Form
     * zurueckkommen — auch nicht als `catch (e) { return null }`.
     */
    expect(CODE).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*return null;?\s*\}/);
  });

  it('eine GraphQL-Fehlerliste bei HTTP 200 wird gelesen', () => {
    /*
     * GraphQL antwortet auf einen Fehler mit Status 200 und einer
     * `errors`-Liste. Wer nur `antwort.ok` prueft, liest `undefined` als
     * "keine Ergebnisse" — dieselbe Stille, dieselbe Null.
     */
    expect(CODE).toMatch(/d\.errors/);
    expect(CODE).toContain('weder Daten noch Fehler');
  });

  it('die Ablehnungen werden gezaehlt UND benannt', () => {
    // Eine Zahl ohne Grund ist eine Aufforderung zum Raten. Eine Auswahl, die
    // nicht sagt, was sie weggelassen hat, ist eine Behauptung.
    expect(CODE).toContain('abgelehnt');
    expect(CODE).toMatch(/abgelehnt\.set/);
  });
});

describe('Eine leere Ernte wird nicht geschrieben', () => {
  it('der Abbruch steht VOR dem Schreiben', () => {
    /*
     * Die Reihenfolge ist der ganze Punkt. Wird erst geschrieben und dann
     * gemeldet, liegt eine gueltige leere Datei da — und die naechste Ernte
     * ueberspringt sie, weil sie "schon vorliegt". Der Zirkeltest rechnet
     * dann auf null Paaren eine schoene Zahl.
     */
    const abbruch = CODE.indexOf('rohPaare.length === 0');
    const schreiben = CODE.indexOf('writeFileSync(resolve(nach)');
    expect(abbruch, 'die Abbruchpruefung fehlt').toBeGreaterThan(-1);
    expect(schreiben, 'das Schreiben fehlt').toBeGreaterThan(-1);
    expect(abbruch, 'erst schreiben, dann melden — genau der Fehler').toBeLessThan(schreiben);
  });

  it('der Abbruch hat einen eigenen Rueckgabewert', () => {
    // Mit 0 zu enden ist die Aussage "fertig". Ein Sammellauf laeuft dann
    // weiter und verbrennt den Rest des Kontingents auf leere Dateien.
    expect(CODE).toMatch(/process\.exit\(4\)/);
  });

  it('die Kosten und der Rest des Kontingents werden gemeldet', () => {
    // Ohne diese Zeile merkt man erst am naechsten Projekt, dass es eng wird.
    expect(CODE).toContain('punkteUebrig');
  });
});
