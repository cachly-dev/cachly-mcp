/**
 * Raumkorrektur: den Einbettungsraum brauchbar machen, bevor man darin sucht.
 *
 * ── Drei Übel, drei Gegenmittel ─────────────────────────────────────────────
 *
 * Ein Einbettungsraum ist nicht neutral. Er hat Eigenschaften, die das Sortieren
 * verderben — alle drei am 19.08.2026 an 499 echten Lektionen gemessen:
 *
 * 1. GEMEINSAME GRUNDRICHTUNG (Anisotropie). Ein durchschnittlicher Vektor
 *    zeigt zu 69,8 Prozent in Richtung des Schwerpunkts aller Vektoren. Dieser
 *    Anteil ist in JEDEM Vergleich derselbe und sagt daher nichts — er hebt nur
 *    alle Werte an und drückt die Unterschiede zusammen. Gemessen liegen alle
 *    Ähnlichkeiten zwischen 0,42 und 0,61.
 *
 * 2. RICHTUNGEN, DIE NUR SCHREIBSTIL SIND. Nach dem Schwerpunkt bleiben ein
 *    paar Hauptrichtungen übrig, die keine Bedeutung tragen, sondern Textsorte:
 *    "ist eine Fehlermeldung", "enthält Codeschnipsel", "ist auf Deutsch".
 *    Sie sind stark und lenken die Rangfolge.
 *
 * 3. NABEN. Manche Vektoren liegen einfach nahe an vielem. Sie erscheinen als
 *    Treffer für Fragen, mit denen sie nichts zu tun haben. Belegt: die Lektion
 *    `forge:arbeitskopie-nach-dem-merge-sofort-abraeumen` stand bei "Ich beende
 *    den Prozess, kurz darauf ist er neu da" UND bei "Wenn der Zwischenspeicher
 *    abläuft, schlagen alle Anfragen durch" auf Platz 1. Zwei Fragen ohne
 *    Berührungspunkt, dieselbe falsche Antwort.
 *
 * ── Die Gegenmittel ─────────────────────────────────────────────────────────
 *
 * Zu 1 und 2: Schwerpunkt abziehen und die stärksten verbleibenden
 * Hauptrichtungen entfernen. Was danach übrig bleibt, ist das, worin sich die
 * Texte inhaltlich unterscheiden.
 *
 * Zu 3: jedem Vektor seine eigene "Geselligkeit" ausrechnen — wie nah liegt er
 * im Mittel an seinen nächsten Nachbarn. Wer überall nah dran ist, bekommt
 * einen Abzug. Das ist die Idee hinter CSLS aus der Wortübersetzung, hier auf
 * den Fall übertragen, dass zur Bauzeit keine Fragen vorliegen: die Nachbarn
 * sind die anderen Lektionen.
 *
 * Entscheidend für den Betrieb: ALLES DAVON WIRD EINMAL AUSGERECHNET. Zur
 * Fragezeit bleibt ein Skalarprodukt und eine Subtraktion. Die Rangfolge wird
 * besser, ohne dass jemand länger wartet.
 */

/** Skalarprodukt. */
export function punktprodukt(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function laenge(v: number[]): number {
  return Math.sqrt(punktprodukt(v, v));
}

/** Auf Länge 1 bringen. Ein Nullvektor bleibt, was er ist. */
export function normiere(v: number[]): number[] {
  const l = laenge(v);
  return l > 1e-12 ? v.map((x) => x / l) : v.slice();
}

/** Der Schwerpunkt — die gemeinsame Grundrichtung aller Vektoren. */
export function schwerpunkt(vs: number[][]): number[] {
  const d = vs[0]?.length ?? 0;
  const m = new Array<number>(d).fill(0);
  for (const v of vs) for (let i = 0; i < d; i++) m[i] += v[i];
  for (let i = 0; i < d; i++) m[i] /= Math.max(1, vs.length);
  return m;
}

/**
 * Die stärksten Hauptrichtungen, über Potenziteration mit Deflation.
 *
 * Warum von Hand statt einer Bibliothek: es sind rund zwanzig Zeilen, läuft
 * einmal, und eine Abhängigkeit für zwanzig Zeilen ist eine Abhängigkeit, die
 * jemand pflegen muss.
 *
 * Die Vektoren müssen bereits zentriert sein — sonst ist die erste
 * Hauptrichtung nur der Schwerpunkt, den wir gerade abgezogen haben.
 */
export function hauptrichtungen(zentriert: number[][], anzahl: number, schritte = 30): number[][] {
  const d = zentriert[0]?.length ?? 0;
  const rest = zentriert.map((v) => v.slice());
  const aus: number[][] = [];

  for (let k = 0; k < anzahl; k++) {
    // Startvektor: fest, nicht zufällig — sonst liefert derselbe Bestand bei
    // jedem Lauf leicht andere Richtungen, und niemand kann eine Messung
    // wiederholen.
    let u = new Array<number>(d).fill(0).map((_, i) => Math.sin(i * (k + 1) * 0.7));
    u = normiere(u);

    for (let s = 0; s < schritte; s++) {
      const neu = new Array<number>(d).fill(0);
      for (const v of rest) {
        const p = punktprodukt(v, u);
        for (let i = 0; i < d; i++) neu[i] += p * v[i];
      }
      const l = laenge(neu);
      if (l < 1e-12) break;
      for (let i = 0; i < d; i++) neu[i] /= l;
      u = neu;
    }
    aus.push(u);

    // Deflation: den gefundenen Anteil aus allen Vektoren entfernen, damit die
    // nächste Iteration eine ANDERE Richtung findet.
    for (const v of rest) {
      const p = punktprodukt(v, u);
      for (let i = 0; i < d; i++) v[i] -= p * u[i];
    }
  }
  return aus;
}

/** Was von einem Vektor bleibt, wenn Schwerpunkt und Hauptrichtungen weg sind. */
export function bereinige(v: number[], mitte: number[], richtungen: number[][]): number[] {
  const w = v.map((x, i) => x - mitte[i]);
  for (const u of richtungen) {
    const p = punktprodukt(w, u);
    for (let i = 0; i < w.length; i++) w[i] -= p * u[i];
  }
  return normiere(w);
}

/**
 * Die "Geselligkeit" jedes Vektors: mittlere Ähnlichkeit zu seinen k nächsten
 * Nachbarn im selben Bestand.
 *
 * Ein hoher Wert heißt: dieser Vektor liegt in einer dichten Gegend und ist
 * vielem nah. Solche Naben erscheinen als Treffer für Fragen, mit denen sie
 * nichts zu tun haben — nicht weil sie passen, sondern weil sie überall
 * passen.
 *
 * Der Wert wird EINMAL berechnet und beim Suchen abgezogen. Kosten zur
 * Fragezeit: eine Subtraktion.
 */
export function geselligkeit(normierte: number[][], k = 10): number[] {
  const n = normierte.length;
  const aus = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    // Die k besten Ähnlichkeiten sammeln, ohne alles zu sortieren.
    const beste: number[] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const s = punktprodukt(normierte[i], normierte[j]);
      if (beste.length < k) {
        beste.push(s);
        if (beste.length === k) beste.sort((a, b) => a - b);
      } else if (s > beste[0]) {
        beste[0] = s;
        beste.sort((a, b) => a - b);
      }
    }
    aus[i] = beste.length ? beste.reduce((a, b) => a + b, 0) / beste.length : 0;
  }
  return aus;
}

/**
 * Ein fertig vorbereiteter Raum: bereinigte Vektoren plus Nabenabzug.
 *
 * Alles hier ist Bauzeit. Zur Fragezeit ruft man `bewerte` — ein Skalarprodukt
 * je Lektion und eine Subtraktion.
 */
export interface Raum {
  mitte: number[];
  richtungen: number[][];
  vektoren: number[][];
  abzug: number[];
  beta: number;
}

export function baueRaum(
  roh: Array<number[] | null>,
  optionen: { richtungen?: number; nachbarn?: number; beta?: number } = {},
): Raum {
  const anzahlRichtungen = optionen.richtungen ?? 3;
  const nachbarn = optionen.nachbarn ?? 10;
  const beta = optionen.beta ?? 0.5;

  const da = roh.filter(Boolean) as number[][];
  const mitte = schwerpunkt(da);
  const zentriert = da.map((v) => v.map((x, i) => x - mitte[i]));
  const richtungen = anzahlRichtungen > 0 ? hauptrichtungen(zentriert, anzahlRichtungen) : [];

  // Bereinigte Vektoren in der ursprünglichen Reihenfolge — Lücken bleiben
  // Lücken, damit ein fehlender Vektor nicht still zu einem Nullvektor wird,
  // der zu allem gleich weit entfernt ist.
  const vektoren: number[][] = [];
  const gueltigeIndizes: number[] = [];
  for (const [i, v] of roh.entries()) {
    if (!v) { vektoren.push([]); continue; }
    vektoren.push(bereinige(v, mitte, richtungen));
    gueltigeIndizes.push(i);
  }

  const abzug = new Array<number>(roh.length).fill(0);
  const nurGueltige = gueltigeIndizes.map((i) => vektoren[i]);
  const g = geselligkeit(nurGueltige, nachbarn);
  gueltigeIndizes.forEach((idx, k) => { abzug[idx] = g[k]; });

  return { mitte, richtungen, vektoren, abzug, beta };
}

/**
 * Bewertet eine Frage gegen alle Lektionen des Raums.
 *
 * `2 * cos - abzug` ist die Form aus CSLS. Der Faktor 2 sorgt dafür, dass der
 * Abzug die Ähnlichkeit dämpft und nicht überstimmt.
 */
export function bewerteImRaum(raum: Raum, frage: number[]): number[] {
  const f = bereinige(frage, raum.mitte, raum.richtungen);
  return raum.vektoren.map((v, i) =>
    v.length === 0 ? -2 : 2 * punktprodukt(f, v) - raum.beta * raum.abzug[i]);
}
