/**
 * Welche der 122 Werkzeuge werden wirklich benutzt?
 *
 * ANLASS 19.08.2026: Die Glama-Bewertung sagt, cachly habe zu viele Werkzeuge
 * und viele liessen sich zusammenlegen. Der Einwand ist plausibel — nur konnte
 * ihm niemand mit Zahlen begegnen, weil es KEINE Messung gab. Nirgends im
 * Server wurde festgehalten, welches Werkzeug wie oft gerufen wird.
 *
 * Ohne diese Zahl ist jedes Zusammenlegen geraten. Man streicht dann das, was
 * man selbst selten benutzt — und das ist selten dasselbe wie das, was die
 * Nutzer selten benutzen.
 *
 * Diese Datei ist die Rechnung dazu, ohne Datenzugriff und ohne neues
 * Werkzeug: gezaehlt wird an der EINEN Stelle, durch die jeder Aufruf geht
 * (handleTool), und gelesen wird in `brain_metrics`, das es schon gibt. Ein
 * 123. Werkzeug, um zu messen, dass es zu viele Werkzeuge gibt, waere die
 * Pointe, die niemand will.
 */

/** Redis-Hash je Brain: Feld = Werkzeugname, Wert = Anzahl der Aufrufe. */
export function nutzungsSchluessel(instanceId: string): string {
  return `cachly:stats:tool_calls:${instanceId}`;
}

export interface WerkzeugZeile {
  name: string;
  aufrufe: number;
  /** Anteil an allen Aufrufen, 0..1. */
  anteil: number;
}

export interface NutzungsBild {
  /** Alle Aufrufe zusammen. */
  gesamt: number;
  /** Wie viele verschiedene Werkzeuge ueberhaupt je gerufen wurden. */
  benutzte: number;
  /** Absteigend sortiert, gekappt. */
  spitze: WerkzeugZeile[];
  /**
   * Wie viele Aufrufe auf die Spitzengruppe entfallen, 0..1.
   *
   * Die eigentlich interessante Zahl: liegt sie bei 0,9, dann traegt eine
   * Handvoll Werkzeuge die ganze Arbeit — und der Rest ist Erklaerungsbedarf,
   * nicht Funktionsumfang.
   */
  anteilSpitze: number;
}

/**
 * Rohzaehler zu einem lesbaren Bild verdichten.
 *
 * Rein, damit sich die Verdichtung ohne Redis pruefen laesst. Ungueltige
 * Zaehler (kein Zahlwert, negativ) fallen heraus statt NaN zu erzeugen — eine
 * kaputte Zeile darf nicht die ganze Auswertung vergiften.
 */
export function verdichte(roh: Record<string, string | number>, spitzeN = 15): NutzungsBild {
  const zeilen: { name: string; aufrufe: number }[] = [];
  for (const [name, wert] of Object.entries(roh)) {
    const n = typeof wert === 'number' ? wert : Number(wert);
    if (!Number.isFinite(n) || n <= 0) continue;
    zeilen.push({ name, aufrufe: Math.floor(n) });
  }
  const gesamt = zeilen.reduce((s, z) => s + z.aufrufe, 0);
  zeilen.sort((a, b) => b.aufrufe - a.aufrufe || a.name.localeCompare(b.name));
  const spitze = zeilen.slice(0, Math.max(0, spitzeN)).map((z) => ({
    ...z,
    anteil: gesamt > 0 ? z.aufrufe / gesamt : 0,
  }));
  const summeSpitze = spitze.reduce((s, z) => s + z.aufrufe, 0);
  return {
    gesamt,
    benutzte: zeilen.length,
    spitze,
    anteilSpitze: gesamt > 0 ? summeSpitze / gesamt : 0,
  };
}

/**
 * Der Satz, der die Glama-Frage beantwortet.
 *
 * Bewusst mit der Zahl der NIE gerufenen Werkzeuge: das ist die Angabe, an der
 * sich entscheidet, ob zusammengelegt werden sollte — und sie ist unbequem
 * genug, dass niemand sie schoenreden kann.
 *
 * Ohne einen einzigen Aufruf wird NICHT behauptet, alles sei ungenutzt: eine
 * frische Instanz hat noch nichts gemessen, und "0 von 122 benutzt" waere dann
 * eine Aussage ueber die Messung, nicht ueber das Produkt.
 */
export function nutzungInWorten(bild: NutzungsBild, werkzeugeGesamt: number): string {
  if (bild.gesamt === 0) {
    return 'Noch keine Werkzeug-Aufrufe gezählt — die Messung beginnt mit dem nächsten Aufruf.';
  }
  const nie = Math.max(0, werkzeugeGesamt - bild.benutzte);
  const prozent = Math.round(bild.anteilSpitze * 100);
  return (
    `${bild.benutzte} von ${werkzeugeGesamt} Werkzeugen wurden hier je gerufen (${nie} nie). ` +
    `Die ${bild.spitze.length} häufigsten tragen ${prozent} % aller ${bild.gesamt} Aufrufe.`
  );
}
