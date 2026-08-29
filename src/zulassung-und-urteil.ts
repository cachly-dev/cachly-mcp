/**
 * ══ Zulassung vor Urteil ══════════════════════════════════════════════════
 *
 * ── Woher das kommt (29.08.2026) ──────────────────────────────────────────
 *
 * Edward Izgorodin, Kommentar vom 28.08.2026 unter unserem Artikel:
 *
 *   "Dedup and contradiction are not two ends of one scale. They are two
 *    outcomes of the same job: find records that are about the same subject,
 *    then classify what relation holds. Similarity is not the verdict there,
 *    it is admission to the proceedings. Your key gate skips the admission
 *    step and goes straight to identity."
 *
 * Er hatte recht, und die Messung war eindeutig
 * (`bench/widerspruch-ist-keine-distanz.mjs`, Commit 3712470e):
 *
 *     A  heutige Regel                    0 Widerspruchsgruppen
 *     B  Zulassung ab 0,3 Ueberlappung  125 Paare
 *     C  davon mit Gegenteil-Merkmal     39 Paare
 *
 * **Null.** Die Widerspruchs-Erkennung hat in 499 Lektionen noch nie etwas
 * gefunden — sie verlangt buchstabengleiche Themennamen. Ganz oben in der
 * Arbeitsliste stand ein Paar mit Ueberlappung 1,00
 * (`kanzlei:board-batch-2-2026-07-18` gegen `kanzlei:board-batch-2026-07-18`),
 * und fuer die alte Regel waren das zwei voellig fremde Themen.
 *
 * ── Die zwei Stufen ───────────────────────────────────────────────────────
 *
 *   1  ZULASSUNG — gehoeren zwei Eintraege ueberhaupt zum selben Subjekt?
 *      Aehnlichkeit ist hier die EINTRITTSKARTE, nicht das Urteil.
 *   2  URTEIL — welche Beziehung besteht? Und die hat mehr als zwei Werte.
 *
 * Ein Paar kann zugelassen und trotzdem als "doch nicht verwandt"
 * zurueckgewiesen werden. Das ist kein Fehler, das ist der Sinn der Trennung.
 *
 * ── Was dieses Modul NICHT tut ────────────────────────────────────────────
 *
 * Es entscheidet nicht, welcher Widerspruch echt ist. Es liefert eine
 * ARBEITSLISTE mit Begruendung je Paar. Ein Modul, das aus Wortmerkmalen
 * einen Widerspruch macht, erfindet die Menge, die es zaehlen soll — genau
 * der Einwand, den der Zweifler im Altmeisterlauf erhoben hat.
 *
 * Und es loescht nichts. `memory_consolidate` loescht seit dem 13.08.2026
 * keine Lektion mehr, und daran aendert sich hier nichts.
 */

/** Die moeglichen Beziehungen zwischen zwei zugelassenen Eintraegen. */
export type Beziehung =
  | 'doppelung'      // dasselbe, zweimal geschrieben
  | 'widerspruch'    // beide behaupten etwas, und es geht nicht zusammen
  | 'ersetzung'      // die Welt hat sich geaendert, das Alte war damals richtig
  | 'stuetzung'      // beide sagen dasselbe aus verschiedenen Richtungen
  | 'unverwandt';    // zugelassen, aber bei naeherem Hinsehen doch nichts

export type Paar = {
  a: { topic: string; outcome?: string; what_worked?: string; what_failed?: string };
  b: { topic: string; outcome?: string; what_worked?: string; what_failed?: string };
  /** Wie stark ueberlappen die Themennamen? 0 bis 1. */
  naehe: number;
  beziehung: Beziehung;
  /** Warum dieses Urteil. Pflicht — ein Urteil ohne Begruendung ist eine Behauptung. */
  grund: string;
};

/**
 * Woerter eines Themennamens.
 *
 * Die Grenze liegt bei ZWEI Zeichen, nicht bei drei. Bei drei fiel `v2` aus
 * `deploy:api-v2` heraus, und `deploy:api` galt als buchstabengleich — genau
 * die Verwechslung, gegen die dieses Modul gebaut ist. Der Fall steht in der
 * Selbstprobe.
 */
export function themenWoerter(topic: string): Set<string> {
  return new Set(
    String(topic ?? '')
      .toLowerCase()
      .split(/[^a-z0-9äöüß]+/)
      .filter((w) => w.length >= 2),
  );
}

/** Jaccard-Ueberlappung zweier Themennamen. */
export function naehe(a: string, b: string): number {
  const A = themenWoerter(a);
  const B = themenWoerter(b);
  if (A.size === 0 || B.size === 0) return 0;
  let gemeinsam = 0;
  for (const w of A) if (B.has(w)) gemeinsam++;
  return gemeinsam / (A.size + B.size - gemeinsam);
}

/**
 * Die Zulassungsschwelle.
 *
 * 0,3 ist GESETZT, nicht hergeleitet — und das ist der ehrliche Unterschied
 * zu Fellegi und Sunter (1969), die ihre Schwellen aus geforderten
 * Fehlerraten ableiten. Solange wir die Fehlerraten nicht kennen, ist jede
 * Zahl hier eine Entscheidung und keine Rechnung. Sie steht deshalb
 * exportiert da, damit man sie bewegen und die Wirkung messen kann.
 */
export const ZULASSUNG = 0.3;

/** Merkmale, die auf ein Gegenteil hindeuten. Ausgeschrieben, damit man streiten kann. */
const GEGENTEIL = [
  /\bnicht\b/i, /\bkein(e|en|em|er)?\b/i, /\bstatt\b/i, /\bfalsch\b/i,
  /\bwar falsch\b/i, /\bkorrektur\b/i, /\bdoch nicht\b/i, /\bentgegen\b/i,
  /\bnever\b/i, /\bwrong\b/i, /\binstead\b/i, /\bno longer\b/i,
];

/** Merkmale, die auf eine Ersetzung statt eines Widerspruchs deuten. */
const ERSETZUNG = [
  /\bnicht mehr\b/i, /\bseit\b/i, /\bab (sofort|heute|dem)\b/i,
  /\bumgestellt\b/i, /\bmigriert\b/i, /\breplaced\b/i, /\bmoved to\b/i,
];

const text = (x: { what_worked?: string; what_failed?: string }): string =>
  `${x.what_worked ?? ''} ${x.what_failed ?? ''}`;

/**
 * Stufe 1: gehoeren die beiden zum selben Subjekt?
 *
 * Bewusst nur der Themenname. Der Volltext waere breiter und wuerde mehr
 * zulassen — aber die Zulassung soll BILLIG sein; teuer wird erst das
 * Urteil. Wer sie breiter will, misst vorher, wie viele Paare dazukommen.
 */
export function zugelassen(a: { topic: string }, b: { topic: string }): boolean {
  return naehe(a.topic, b.topic) >= ZULASSUNG;
}

/**
 * Stufe 2: welche Beziehung besteht?
 *
 * Die Reihenfolge der Pruefungen ist die Aussage. Ersetzung wird VOR
 * Widerspruch geprueft: "laeuft nicht mehr auf Port 3000" ist kein
 * Widerspruch zu "laeuft auf Port 3000", sondern seine Nachfolge. Wer das
 * verwechselt, macht aus jeder Weiterentwicklung einen Streit.
 */
export function urteile(a: Paar['a'], b: Paar['b']): { beziehung: Beziehung; grund: string } {
  const ta = text(a);
  const tb = text(b);

  if (ta.trim() === tb.trim() && ta.trim() !== '') {
    return { beziehung: 'doppelung', grund: 'beide Texte sind Zeichen fuer Zeichen gleich' };
  }

  const ersetzungA = ERSETZUNG.some((r) => r.test(ta));
  const ersetzungB = ERSETZUNG.some((r) => r.test(tb));
  if (ersetzungA !== ersetzungB) {
    const wer = ersetzungA ? 'der erste' : 'der zweite';
    return {
      beziehung: 'ersetzung',
      grund: `${wer} Eintrag nennt eine Aenderung ("nicht mehr", "seit", "umgestellt") — das ist Nachfolge, kein Streit`,
    };
  }

  const gegenA = GEGENTEIL.some((r) => r.test(ta));
  const gegenB = GEGENTEIL.some((r) => r.test(tb));
  if (gegenA !== gegenB) {
    return {
      beziehung: 'widerspruch',
      grund: `genau einer der beiden Texte traegt eine Verneinung — ${gegenA ? 'der erste' : 'der zweite'}`,
    };
  }

  if (a.outcome && b.outcome && a.outcome !== b.outcome) {
    return {
      beziehung: 'widerspruch',
      grund: `gleiches Subjekt, verschiedener Ausgang (${a.outcome} gegen ${b.outcome})`,
    };
  }

  if (a.outcome && b.outcome && a.outcome === b.outcome) {
    return { beziehung: 'stuetzung', grund: `beide melden ${a.outcome} zum selben Subjekt` };
  }

  return { beziehung: 'unverwandt', grund: 'zugelassen, aber kein Merkmal spricht fuer eine Beziehung' };
}

/**
 * Beide Stufen ueber eine Menge von Lektionen.
 *
 * Quadratisch, und das ist bei einigen hundert Lektionen bezahlbar. Wer auf
 * Zehntausende geht, braucht vorher einen Vorfilter — dann steht hier eine
 * Zahl statt dieses Satzes.
 */
export function findePaare(lektionen: readonly Paar['a'][]): Paar[] {
  const raus: Paar[] = [];
  for (let i = 0; i < lektionen.length; i++) {
    for (let j = i + 1; j < lektionen.length; j++) {
      const a = lektionen[i];
      const b = lektionen[j];
      if (!zugelassen(a, b)) continue;
      const { beziehung, grund } = urteile(a, b);
      raus.push({ a, b, naehe: naehe(a.topic, b.topic), beziehung, grund });
    }
  }
  return raus;
}
