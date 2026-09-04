// Recall-Trichter — WORAN scheiterte der Abruf, nicht OB er scheiterte.
//
// ── Der Anlass (Karte oy6vyq7egtkj, TokenLat-Austausch 25.08.2026) ─────────
//
// Giulio misst eine Trefferquote (gesucht 83,3 %, nuetzlich 85,0 %) — und
// steht vor derselben Wand wie wir: die EINE Zahl sagt nicht, wohin das
// naechste Investment gehoert. Unser Retrieval-Split (97/72/55/41) hat das
// fuer den Sortierer beantwortet; hier kommt dieselbe Zerlegung fuer die
// LEBENDE Nutzung: jeder fehlgeschlagene Versuch (learn_from_attempts mit
// outcome=failure) wird am Schreibzeitpunkt einer Klasse zugeordnet.
//
// ── Die fuenf Klassen ───────────────────────────────────────────────────────
//
//   ohne-vorwissen   Es GAB keine passende Lektion. Kein Werkzeug haette
//                    geholfen — der dritte Ausgang, gezaehlt statt in
//                    "nicht gesucht" versteckt (sonst waere Klasse 1
//                    aufgeblaeht und das Investment liefe in die Irre).
//   nicht-gesucht    Eine passende Lektion existierte, aber im Fenster gab
//                    es keine thematisch passende Suche.
//   nominierung      Es wurde passend gesucht — geliefert wurde NICHTS.
//   ranking          Es wurde geliefert — aber die passende Lektion war
//                    nicht dabei (Burial: im Retrieval-Split der Riese).
//   anwendung        Die passende Lektion WAR in einer Lieferung — der
//                    Fehler passierte trotzdem.
//
// Die Zuordnung ist eine Heuristik auf Stammnaehe (dieselbe wie beim
// Ersetzungs-Vorschlag: pruefbar eng statt beeindruckend breit). Sie
// klassifiziert den EINZELFALL mitunter falsch — die VERTEILUNG ueber
// Dutzende Sessions ist die Zahl, um die es der Karte geht.

import { inhaltsWoerter, grobStamm } from './rangfolge.js';
import { themenNaehe } from './ersetzung-vorschlag.js';

/** Eine protokollierte Suche: Frage plus das, was geliefert wurde. */
export interface TrichterSuche {
  ts: string;
  frage: string;
  /** Themen-Slugs der gelieferten Lektionen; leer = Schweigen. */
  geliefert: string[];
}

export interface TrichterKandidat {
  topic: string;
  what_worked?: string;
}

export type TrichterKlasse =
  | 'ohne-vorwissen'
  | 'nicht-gesucht'
  | 'nominierung'
  | 'ranking'
  | 'anwendung';

export const SUCH_DECKEL = 500;
/** Suchen aelter als das zaehlen nicht — eine Woche alte Suche ist kein Suchen. */
export const SUCH_FENSTER_MS = 24 * 3600 * 1000;

export function suchProtokollSchluessel(instanceId: string): string {
  return `cachly:stats:suchprotokoll:${instanceId}`;
}

export function trichterSchluessel(instanceId: string): string {
  return `cachly:stats:recall-trichter:${instanceId}`;
}

function staemme(text: string): Set<string> {
  return new Set([...inhaltsWoerter(text)].map(grobStamm));
}

function textNaehe(a: string, b: string): number {
  const sa = staemme(a);
  const sb = staemme(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let schnitt = 0;
  for (const x of sa) if (sb.has(x)) schnitt++;
  return schnitt / (sa.size + sb.size - schnitt);
}

/** Nah = geteilte Themen-Staemme (>= halbe Ueberlappung) oder deutliche Text-Ueberlappung. */
function lektionPasst(topic: string, whatFailed: string, k: TrichterKandidat): boolean {
  if (themenNaehe(topic, k.topic) >= 0.5) return true;
  return textNaehe(whatFailed, k.what_worked ?? '') >= 0.3;
}

function suchePasst(topic: string, s: TrichterSuche): boolean {
  return themenNaehe(s.frage, topic) >= 0.5;
}

/**
 * Ordnet EINEN Fehlschlag einer Klasse zu. Reine Funktion — der Handler
 * liefert das Suchprotokoll und die Kandidaten, hier faellt nur das Urteil.
 */
export function klassifiziereFehlschlag(
  topic: string,
  whatFailed: string,
  suchen: readonly TrichterSuche[],
  vorhandene: readonly TrichterKandidat[],
  jetztMs: number = Date.now(),
): TrichterKlasse {
  // Die eigene, gerade geschriebene Lektion ist kein Vorwissen.
  const passende = vorhandene.filter((k) => k.topic !== topic && lektionPasst(topic, whatFailed, k));
  if (passende.length === 0) return 'ohne-vorwissen';

  const imFenster = suchen.filter((s) => {
    const t = Date.parse(s.ts);
    return Number.isFinite(t) && jetztMs - t <= SUCH_FENSTER_MS && suchePasst(topic, s);
  });
  if (imFenster.length === 0) return 'nicht-gesucht';

  const passendeThemen = new Set(passende.map((k) => k.topic));
  let irgendwasGeliefert = false;
  for (const s of imFenster) {
    for (const g of s.geliefert) {
      if (passendeThemen.has(g)) return 'anwendung';
      irgendwasGeliefert = true;
    }
  }
  return irgendwasGeliefert ? 'ranking' : 'nominierung';
}
