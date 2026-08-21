/**
 * Varianten-Interferenz — die Frage einmal stellen, viele Wege gehen.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ GEMESSEN UND NICHT VERDRAHTET (21.08.2026).                              ║
 * ║                                                                          ║
 * ║ Am eingefrorenen Korpus, alle Kombinationen aus K=3/5/9 und Staerke      ║
 * ║ 0,3/0,5/0,8 (src/bench/interferenz-vergleich.ts):                        ║
 * ║                                                                          ║
 * ║   Bauform            Platz 1     @3    Top 10   Topf                     ║
 * ║   heute                39,0     51,0    71,0    90,0                     ║
 * ║   K=5 staerke=0,5      39,0     51,0    72,0    90,0                     ║
 * ║   (alle uebrigen: gleich oder schlechter)                                ║
 * ║                                                                          ║
 * ║ Von den 10 Fragen, die gar nicht in den Topf kamen, wurde KEINE einzige  ║
 * ║ gerettet.                                                                ║
 * ║                                                                          ║
 * ║ Der Grund steht in der Diagnose (src/bench/warum-durchgefallen.ts):      ║
 * ║ bge-m3-Vektoren sind DICHT. Bedeutung liegt ueber alle 1024 Dimensionen  ║
 * ║ verteilt, nicht in Abschnitten. Einen Abschnitt zu daempfen ist deshalb  ║
 * ║ keine "lass ein Wort weg"-Operation, sondern eine Drehung, die alle      ║
 * ║ Kandidaten aehnlich trifft — gemessen: Kosinus zur Ausgangsfrage 0,99    ║
 * ║ bei Staerke 0,3 und noch 0,89 bei 0,8. Die Rangfolge bewegt sich nicht.  ║
 * ║                                                                          ║
 * ║ Die Analogie war falsch, nicht die Umsetzung: Interferenz braucht Wege,  ║
 * ║ die sich WIRKLICH unterscheiden. Im Vektorraum eines dichten Modells     ║
 * ║ gibt es die nicht zum Nulltarif — echte Textvarianten kosten je einen    ║
 * ║ Einbettungsaufruf, und genau den sollte diese Idee sparen.               ║
 * ║                                                                          ║
 * ║ Was die Messung stattdessen fand, steht in src/bench/topfgroesse.ts:     ║
 * ║ der Topf war mit 25 zu klein. 75 hebt die Decke von 90 auf 97 Prozent.   ║
 * ║                                                                          ║
 * ║ Die Datei bleibt mitsamt Proben, damit der naechste Anlauf die Messung   ║
 * ║ vorfindet statt sie zu wiederholen.                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── Das Vorbild ─────────────────────────────────────────────────────────────
 *
 * Feynmans Pfadintegral: Licht probiert alle Wege gleichzeitig. Die Phasen der
 * falschen Wege loeschen sich gegenseitig aus, uebrig bleibt der richtige.
 * Nicht weil einer ausgewaehlt wurde — weil die anderen einander aufheben.
 *
 * ── Das Problem, gegen das es antritt ───────────────────────────────────────
 *
 * Gemessen am 21.08.2026 am eingefrorenen Korpus: von 100 Fragen kommen 10 gar
 * nicht erst in den Topf. Diese zehn sind fuer JEDE spaetere Stufe verloren —
 * die beste Sortierung der Welt kann nichts sortieren, was nicht da ist.
 *
 * Die Vorauswahl haengt heute an EINER Zahl je Lektion: der Naehe zu EINEM
 * Fragevektor. Eine ungluecklich formulierte Frage zeigt in eine leicht
 * falsche Richtung, und die richtige Lektion faellt aus den Top 25. Es gibt
 * keinen zweiten Versuch.
 *
 * ── Was hier passiert ───────────────────────────────────────────────────────
 *
 * Aus dem einen Fragevektor werden K leicht verschobene Varianten erzeugt.
 * Jede nominiert ihre eigene Top-Liste. Wer in vielen Varianten weit vorne
 * steht, ist stabil gemeint; wer nur in einer auftaucht, war der Zufallstreffer
 * einer bestimmten Formulierung.
 *
 * WICHTIG, und der ganze Grund, warum das billig ist: die Varianten entstehen
 * IM VEKTORRAUM, nicht im Text. Kein einziger zusaetzlicher Einbettungsaufruf,
 * kein Netz, keine Latenz von Belang — nur Arithmetik auf 1024 Zahlen.
 *
 * ── Warum deterministisch und nicht zufaellig ───────────────────────────────
 *
 * Zwei Laeufe auf derselben Frage MUESSEN dieselbe Antwort geben. Ein
 * Suchergebnis, das bei jedem Aufruf leicht anders ist, ist nicht
 * reproduzierbar — und ein Messstand darauf misst sein eigenes Rauschen.
 * Die Streuung kommt deshalb aus einer festen Achsenwahl je Variantenindex,
 * nicht aus einem Zufallsgenerator.
 */

/** Die Punktzahl einer Lektion in EINER Variante. */
export interface Kandidat { topic: string; naehe: number }

/**
 * Erzeugt K Varianten eines Fragevektors.
 *
 * Variante 0 ist IMMER die unveraenderte Frage. Damit kann die Interferenz im
 * schlimmsten Fall nur so gut sein wie vorher plus Zusatzstimmen — sie kann
 * die Ausgangslage nicht verlieren.
 *
 * Die uebrigen K-1 daempfen jeweils einen anderen Abschnitt des Vektors. Das
 * ist die Vektorraum-Entsprechung zu "lass ein paar Woerter weg": ein Teil der
 * Bedeutung wird leiser gedreht, der Rest bleibt. Faellt eine Lektion dadurch
 * heraus, hing sie an genau diesem Abschnitt.
 *
 * @param fv der Fragevektor
 * @param k wie viele Varianten insgesamt (inklusive der unveraenderten)
 * @param staerke wie stark gedaempft wird (0 = gar nicht, 1 = Abschnitt aus)
 */
export function varianten(fv: number[], k = 5, staerke = 0.5): number[][] {
  if (k <= 1 || fv.length === 0) return [fv];
  const aus: number[][] = [fv];
  const abschnitte = k - 1;
  const breite = Math.max(1, Math.floor(fv.length / abschnitte));
  for (let i = 0; i < abschnitte; i++) {
    const von = i * breite;
    const bis = i === abschnitte - 1 ? fv.length : von + breite;
    const v = fv.slice();
    for (let j = von; j < bis; j++) v[j] *= (1 - staerke);
    aus.push(v);
  }
  return aus;
}

/**
 * Ueberlagert die Nominierungen mehrerer Varianten.
 *
 * Das Gewicht einer Stimme faellt mit dem Platz (1/(platz+1)) — wie bei
 * Reciprocal Rank Fusion, aber MIT einem Zusatz, der hier den Unterschied
 * macht: die Naehe geht mit ein. Reine Platz-Fusion kann nicht unterscheiden,
 * ob Platz 1 knapp oder deutlich gewonnen hat; genau daran ist am 20.08. die
 * erste Eingangs-Verdrahtung gescheitert.
 *
 * Variante 0 (die unveraenderte Frage) zaehlt doppelt: sie ist die Frage, die
 * der Nutzer wirklich gestellt hat. Die anderen sind Hypothesen darueber, was
 * er gemeint haben koennte.
 *
 * @param listen je Variante eine nach Naehe absteigend sortierte Kandidatenliste
 * @param wieViele wie viele Themen am Ende nominiert werden
 */
export function ueberlagere(listen: Kandidat[][], wieViele: number): string[] {
  const punkte = new Map<string, number>();
  for (const [vi, liste] of listen.entries()) {
    const gewicht = vi === 0 ? 2 : 1;
    for (const [platz, kandidat] of liste.entries()) {
      // Negative Naehe heisst "kein Vektor" (-2) oder "zeigt weg" — solche
      // Stimmen werden nicht gezaehlt, statt die Summe nach unten zu ziehen.
      if (kandidat.naehe <= 0) continue;
      const stimme = gewicht * (kandidat.naehe / (platz + 1));
      punkte.set(kandidat.topic, (punkte.get(kandidat.topic) ?? 0) + stimme);
    }
  }
  return [...punkte.entries()]
    // Bei Gleichstand entscheidet der Name — zwei Laeufe muessen dieselbe
    // Reihenfolge geben, sonst misst der Messstand sein eigenes Rauschen.
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, wieViele)
    .map(([topic]) => topic);
}
