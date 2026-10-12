/**
 * Der Trainingssatz fuer den Entscheider (Abhakliste 4.2) und die 50
 * Giftproben (Teil von 4.4).
 *
 * ── Was dabei entsteht ────────────────────────────────────────────────────
 *
 * Drei Klassen je Paar (Frage, Lektion): passt / verwandt / passt_nicht.
 * Dazu je Frage, bei der keine der gezeigten Lektionen passt, ein Eintrag
 * `keine_passt` — daran lernt der Entscheider das Schweigen.
 *
 * Geschrieben wird NACH AUSSEN (nie ins Repo), Standard:
 *   ~/.cachly/entscheider/trainingssatz-v1/
 *     train.jsonl, dev.jsonl           der Satz
 *     meta.json                        Zaehlungen, Lizenzen, Saat, Git-SHA, Pruefsummen
 *     giftproben-v1.jsonl              50 Gift + 50 harmlose Gegenstuecke
 *     stichprobe-verwandt-20.jsonl     die 20 Zeilen fuer die Handpruefung
 *     messlatte-ohne-lektion-im-training.json
 *                                      NUR Kennungen: die Pruefsatz-Fragen, deren Lektion
 *                                      das Training nie gesehen hat (siehe unten)
 *
 * ── Harte Regel gegen Selbstbetrug ────────────────────────────────────────
 *
 * Der Pruefsatz (pruefsatz-3000.json, 3.003 Fragen) ist die Messlatte. Er
 * darf nicht im Trainingssatz stehen: weder die Fragen noch ihre Paare noch
 * ihre Kennungen noch Beinahe-Doppelte. `pruefeUeberschneidung` bricht ab
 * (Exit 3), sobald eines davon vorkommt. Gesperrt sind ausserdem die
 * frueheren Messlatten (pruefsatz-frisch, pruefsatz-alt, korpus-gross,
 * fragen-gross, der alte 20er-Satz). Vor jedem Lauf beweist eine Gegenprobe,
 * dass die Pruefung nicht blind ist: eingeschleuste Pruefsatz-Fragen muessen
 * gefunden werden, sonst bricht der Lauf ab.
 *
 * Was die Fragen-Pruefung NICHT sieht: Einstell- und Pruefsatz fragen nach
 * DENSELBEN 499 Hauslektionen (je rund 6 Fragen). Ein Modell, das die
 * Lektionstexte im Training gesehen hat, kennt sie auf dem Pruefsatz schon.
 * Deshalb wird nach Projektfamilie getrennt (Themenpraefix, `kanzlei-kompass`
 * zaehlt zu `kanzlei`): ganze Familien gehen nur nach `dev`, ihre Lektionen
 * erscheinen im Training nie — weder als Treffer noch als Negativ. Die
 * Pruefsatz-Fragen zu diesen Lektionen stehen in
 * `messlatte-ohne-lektion-im-training.json` und sind die ehrliche Messung.
 * Dasselbe gilt fuer die Fremdprojekte: ganze Projekte gehen nach `dev`.
 *
 * ── Woher die Rangfolge kommt ─────────────────────────────────────────────
 *
 * Harte Negative sind Kandidaten, die die heutige Rangfolge vor die richtige
 * Lektion setzt. Das Skript RECHNET sie nicht nach, es liest sie:
 *
 *   Haus   Mitschrift des echten smart_recall-Handlers, ohne Netz und ohne
 *          Leser (so wie `npm run bench:ausgabe`). Schritt 1, rund 10 Minuten:
 *            CACHLY_TOPF_PROTOKOLL=$HOME/.cachly/entscheider/rangfolge/haus-einstell.jsonl \
 *              npm run bench:ausgabe -- --pruefsatz $HOME/.cachly/bench-korpus/einstellsatz-3000.json
 *          Die Mitschrift traegt je Frage `gezeigt`: die ersten 10 der Hausordnung.
 *   Fremd  Merkmalsauszug `merkmale-fremdsatz-teil.jsonl`, bewertet mit
 *          `punktzahl` (beleg-kaskade-messen.ts, an die ausgelieferte
 *          `bewerteTopf` geeicht; ohne Zweitmodell, daher etwas schwaecher).
 *
 * ── Die Klassen ───────────────────────────────────────────────────────────
 *
 * passt        die Lektion, aus der die Frage entstand (Haus: Einstellsatz-Ziel,
 *              Fremd: der PR, der das Issue schloss)
 * verwandt     NICHT die gesuchte Lektion, aber inhaltlich nah. Mass ist die
 *              Textaehnlichkeit (TF-IDF-Kosinus der Inhaltswoerter, Seltenheit aus dem
 *              eigenen Bestand):
 *                Haus   gleiche Projektfamilie und Aehnlichkeit >= 0,10, oder
 *                       andere Familie und Aehnlichkeit >= 0,15
 *                Fremd  gleiches Projekt und Aehnlichkeit >= 0,15 (Vorlagenwoerter, die in
 *                       mehr als 5 % der Lektionen stehen, zaehlen nicht), oder
 *                       Aehnlichkeit >= 0,10 bei gemeinsamer Datei/gemeinsamem Ordner
 *                       (mindestens 3 Ebenen tief) im Aenderungsumfang
 * passt_nicht  alles andere
 * Die Regel ist eine Naeherung. Ein "verwandt" kann in Wahrheit ein zweiter guter
 * Treffer sein, ein "passt_nicht" auch. Die Handpruefungen (stichprobe-verwandt-20,
 * stichprobe-passt-nicht-hart-20) messen, wie oft; das Ergebnis steht in meta.json.
 * Die erste Fassung der Haus-Regel ("gleiche Familie = verwandt") hielt der Handpruefung
 * nicht stand: bei 3 von 9 Haus-Paaren teilten die Lektionen nur den Projektnamen.
 *
 * ── Negative je Frage ─────────────────────────────────────────────────────
 *
 *   hart_vor_treffer     die Rangfolge setzte sie VOR die richtige Lektion
 *   hart_verloren        die richtige Lektion kam gar nicht in die ersten 10
 *   hart_hinter_treffer  Platz hinter der richtigen (Auffuellung)
 *   leicht_zufall        eine zufaellige Lektion der eigenen Seite (train/dev)
 * Hoechstens 5 harte und 1 leichtes Negativ je Frage.
 *
 * ── keine_passt ───────────────────────────────────────────────────────────
 *
 *   verloren                 die richtige Lektion fehlt in den ersten 10 der
 *                            Rangfolge: keiner der gezeigten Kandidaten passt
 *   ohne_treffer_simuliert   25 % der uebrigen Fragen, mit der richtigen
 *                            Lektion aus der Liste GENOMMEN. Die Zeile traegt
 *                            dieselbe `frage_id` wie die echte Frage; wer sie
 *                            nutzt, laesst die `passt`-Zeile dieser Frage weg.
 *
 * ── Metadaten je Zeile ────────────────────────────────────────────────────
 *
 * quelle, lizenz, erzeuger, darf_offen (+ offen_grund), pii. `darf_offen` heisst:
 * die Zeile erfuellt die Filter aus .agent/cachly/LIZENZEN-entscheider-2026-10-11.md
 * (kein Claude-Text, freizuegige Quelllizenz, kein E-Mail-/@Name-/IP-Muster).
 * Das ist KEINE juristische Freigabe — die Abnahme steht aus.
 *
 * Aufruf (aus sdk/mcp):
 *   npm run bench:entscheider-satz
 *   npm run bench:entscheider-satz -- --saat 7 --nach /tmp/satz
 *   npm run bench:entscheider-satz -- --selbstprobe     (nur Gegenprobe + Giftproben-Form)
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { punktzahl } from './beleg-kaskade-messen.js';
import { leserText } from '../seltenheitsbestand.js';
import { schwaerze } from '../geheimnis-filter.js';
import { ALLE_PROBEN, GIFT_PROBEN, HARMLOSE_PROBEN, type Giftprobe } from './entscheider-giftproben.js';

// ── Feste Werte ───────────────────────────────────────────────────────────────

export const STANDARD_SAAT = 20261012;
export const SATZ_VERSION = 'trainingssatz-v1';
/** Der Zuschnitt, den auch der Leser im Produkt sieht (seltenheitsbestand.leserText). */
export const KANDIDAT_MAX_ZEICHEN = 1500;
export const HART_MAX = 5;
export const LEICHT_JE_FRAGE = 1;
export const SIMULIERT_ANTEIL = 0.25;
export const DEV_ANTEIL_HAUS = 0.3;
export const DEV_ANTEIL_FREMD = 0.2;
/** Wie viele der ersten Plaetze der Rangfolge als Liste gelten. */
export const LISTE_TIEFE = 10;

export type Klasse = 'passt' | 'verwandt' | 'passt_nicht';
export type Seite = 'train' | 'dev';

/** Freizuegige Lizenzen nach der Lizenzstudie (LIZENZEN-entscheider-2026-10-11.md). */
export const FREIZUEGIG = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'Unlicense', '0BSD', 'CC0-1.0']);

/**
 * Lizenz je Fremdprojekt. Quelle: GitHub-API `repos/<owner>/<name>` (license.spdx_id),
 * abgefragt am 12.10.2026. Der Projektname ist der Themenpraefix im Fremdsatz:
 * airflow=apache/airflow, angular=angular/angular, ansible=ansible/ansible,
 * argo-cd=argoproj/argo-cd, caddy=caddyserver/caddy, cargo=rust-lang/cargo,
 * cockroach=cockroachdb/cockroach, compose=docker/compose, core=vuejs/core,
 * deno=denoland/deno. (`core` ist NICHT home-assistant/core: die Fragen nennen "Vue version".)
 */
export const FREMD_LIZENZ: Record<string, string> = {
  airflow: 'Apache-2.0',
  angular: 'MIT',
  ansible: 'GPL-3.0',
  'argo-cd': 'Apache-2.0',
  caddy: 'Apache-2.0',
  cargo: 'Apache-2.0',
  cockroach: 'NOASSERTION',
  compose: 'Apache-2.0',
  core: 'MIT',
  deno: 'MIT',
};

// ── Kleine Bausteine (rein, getestet) ─────────────────────────────────────────

/** FNV-1a, 32 Bit: aus einem Text eine stabile Zahl machen. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: gleiche Saat, gleiche Folge — auf jeder Maschine. */
export function rngVon(saat: number): () => number {
  let s = saat >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mischen<T>(liste: readonly T[], rng: () => number): T[] {
  const a = [...liste];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Klein, ohne Satzzeichen, Leerraum gekuerzt: so wird "gleiche Frage" erkannt. */
export function normalisiere(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function wortMenge(text: string): Set<string> {
  return new Set(normalisiere(text).split(' ').filter((w) => w.length > 2));
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let gemeinsam = 0;
  const [klein, gross] = a.size <= b.size ? [a, b] : [b, a];
  for (const w of klein) if (gross.has(w)) gemeinsam++;
  return gemeinsam / (a.size + b.size - gemeinsam);
}

export function sha256Datei(pfad: string): string {
  return createHash('sha256').update(readFileSync(pfad)).digest('hex');
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ── Die Klassen: Projektfamilie, Textaehnlichkeit, Dateipfade ────────────────

/** Der Themenpraefix vor dem ersten ":", bis zum ersten "-": `kanzlei-kompass:x` -> `kanzlei`. */
export function projektFamilie(topic: string): string {
  const praefix = topic.split(':')[0].toLowerCase();
  return praefix.split('-')[0] || praefix;
}

const STOP = new Set([
  'und', 'oder', 'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'nicht', 'kein', 'keine', 'mit', 'ohne',
  'wenn', 'beim', 'aus', 'von', 'vom', 'zum', 'zur', 'fuer', 'nur', 'auch', 'nach', 'vor', 'bei', 'wie', 'was', 'ist', 'sind',
  'wird', 'wurde', 'wurden', 'werden', 'hat', 'haben', 'sich', 'dass', 'alle', 'allen', 'ueber', 'unter', 'immer', 'nie',
  'erst', 'noch', 'dann', 'statt', 'durch', 'gegen', 'drei', 'zwei', 'vier', 'diese', 'dieser', 'dieses', 'sein', 'sind',
  'the', 'and', 'for', 'with', 'not', 'from', 'into', 'this', 'that', 'are', 'was', 'were', 'has', 'have', 'you', 'your',
  'can', 'will', 'would', 'should', 'could', 'when', 'what', 'which', 'about', 'than', 'then', 'also', 'more', 'some', 'any',
  'all', 'but', 'our', 'its', 'been', 'does', 'only', 'just', 'there', 'their', 'they', 'them',
]);

/** Inhaltswoerter: klein, ohne Markierungen und Adressen, ab 4 Zeichen, auf 6 Zeichen gekuerzt. */
export function inhaltsWoerter(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/[^a-z0-9äöüß]+/)
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOP.has(w))
    .map((w) => w.slice(0, 6));
}

/**
 * Kosinus-Aehnlichkeit zweier Lektionen auf TF-IDF der Inhaltswoerter. Die Seltenheit
 * (IDF) kommt aus dem eigenen Bestand: Wortmuster, die in fast jeder Lektion stehen
 * (Vorlagentext eines Pull-Requests), zaehlen kaum. `maxDfAnteil` wirft Woerter ganz
 * heraus, die in mehr als diesem Anteil der Lektionen stehen (Vorlagenwoerter).
 * Rein und stabil — gleiche Texte, gleiche Zahl.
 */
export class Aehnlichkeit {
  private readonly vek = new Map<string, Map<string, number>>();

  constructor(texte: ReadonlyMap<string, string>, maxDfAnteil = 1) {
    const woerter = new Map<string, string[]>();
    const df = new Map<string, number>();
    for (const [t, text] of texte) {
      const w = inhaltsWoerter(text);
      woerter.set(t, w);
      for (const x of new Set(w)) df.set(x, (df.get(x) ?? 0) + 1);
    }
    const n = texte.size;
    for (const [t, w] of woerter) {
      const tf = new Map<string, number>();
      for (const x of w) if ((df.get(x) ?? 0) / n <= maxDfAnteil) tf.set(x, (tf.get(x) ?? 0) + 1);
      const v = new Map<string, number>();
      let norm = 0;
      for (const [x, c] of tf) {
        const gewicht = (1 + Math.log(c)) * (Math.log((n + 1) / ((df.get(x) ?? 0) + 1)) + 1);
        v.set(x, gewicht);
        norm += gewicht * gewicht;
      }
      norm = Math.sqrt(norm) || 1;
      for (const [x, g] of v) v.set(x, g / norm);
      this.vek.set(t, v);
    }
  }

  kosinus(a: string, b: string): number {
    const va = this.vek.get(a);
    const vb = this.vek.get(b);
    if (!va || !vb) return 0;
    const [klein, gross] = va.size <= vb.size ? [va, vb] : [vb, va];
    let s = 0;
    for (const [w, x] of klein) { const y = gross.get(w); if (y) s += x * y; }
    return s;
  }
}

/**
 * Schwellen der Klasse "verwandt". Gemessen an den 499 Hauslektionen (TF-IDF, siehe
 * Aehnlichkeit): Paare gleicher Familie haben im Median 0,045 und im 90. Perzentil
 * 0,116; Paare verschiedener Familien 0,025 und 0,067 (99. Perzentil 0,125). Eine
 * Handpruefung am 12.10.2026 trennte "gleiche Familie, anderes Thema" (0,02 bis 0,06)
 * von "gleiche Familie, nah beieinander" (0,11 bis 0,26).
 */
export const HAUS_SCHWELLE_GLEICHE_FAMILIE = 0.10;
export const HAUS_SCHWELLE_ANDERE_FAMILIE = 0.15;
/**
 * Fremd: Pull-Request-Texte teilen viel Vorlage ("SUMMARY ISSUE TYPE Bugfix Pull Request"). Woerter,
 * die in mehr als 5 % der Lektionen stehen, zaehlen deshalb nicht. Mit gemeinsamen Dateien reicht
 * eine niedrigere Schwelle. Von Hand an 26 Paaren (12.10.2026) so gesetzt, dass die 4 als "nicht
 * verwandt" geurteilten unter 0,15 liegen; die endgueltige Pruefung ist die frische Stichprobe.
 */
export const FREMD_MAX_DF = 0.05;
export const FREMD_SCHWELLE = 0.15;
export const FREMD_SCHWELLE_MIT_PFAD = 0.10;

export function beurteileHaus(kandidat: string, ziel: string, sim: (a: string, b: string) => number): Klasse {
  if (kandidat === ziel) return 'passt';
  const gleiche = projektFamilie(kandidat) === projektFamilie(ziel);
  return sim(kandidat, ziel) >= (gleiche ? HAUS_SCHWELLE_GLEICHE_FAMILIE : HAUS_SCHWELLE_ANDERE_FAMILIE) ? 'verwandt' : 'passt_nicht';
}

const PFAD = /[\w.@-]+(?:\/[\w.@-]+)+\.\w{1,8}\b/g;

export function dateipfade(text: string): string[] {
  return [...new Set(text.match(PFAD) ?? [])];
}

/** Dieselbe Datei oder ein gemeinsamer Ordner von mindestens 3 Ebenen. */
export function pfadVerwandt(textA: string, textB: string): boolean {
  const pa = dateipfade(textA);
  const pb = dateipfade(textB);
  if (pa.length === 0 || pb.length === 0) return false;
  const mengeA = new Set(pa);
  if (pb.some((p) => mengeA.has(p))) return true;
  const ordner = (ps: string[]): Set<string> => new Set(
    ps.map((p) => p.split('/').slice(0, -1).join('/')).filter((o) => o.split('/').length >= 3),
  );
  const oa = ordner(pa);
  for (const o of ordner(pb)) if (oa.has(o)) return true;
  return false;
}

export function projektVonFremd(topic: string): string {
  return topic.split(':')[0];
}

/** Fremd: gleiches Projekt UND (Text nah genug, oder gleiche Dateien bei halbwegs nahem Text). */
export function beurteileFremd(
  kandidat: string, ziel: string, sim: (a: string, b: string) => number, text: (t: string) => string,
): Klasse {
  if (kandidat === ziel) return 'passt';
  if (projektVonFremd(kandidat) !== projektVonFremd(ziel)) return 'passt_nicht';
  const s = sim(kandidat, ziel);
  if (s >= FREMD_SCHWELLE) return 'verwandt';
  return s >= FREMD_SCHWELLE_MIT_PFAD && pfadVerwandt(text(kandidat), text(ziel)) ? 'verwandt' : 'passt_nicht';
}

// ── Personenmuster und Freigabe ───────────────────────────────────────────────

const PII_MUSTER: Array<[string, RegExp]> = [
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/],
  // Mit Fehlalarmen wie @Override — gewollt, die Freigabe soll lieber zu streng sein.
  ['at_name', /(?:^|[\s(])@[A-Za-z0-9][A-Za-z0-9_-]{1,38}\b/],
  ['ip', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
];

export function personenmuster(text: string): string[] {
  return PII_MUSTER.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export interface Freigabe { darf: boolean; grund: string }

export function bewerteFreigabe(opts: { erzeuger: string; lizenzen: string[]; pii: boolean; hausdaten: boolean }): Freigabe {
  const gruende: string[] = [];
  if (opts.erzeuger.startsWith('claude')) gruende.push('claude-text');
  if (opts.hausdaten) gruende.push('hausdaten');
  const nichtFrei = opts.lizenzen.filter((l) => !FREIZUEGIG.has(l) && l !== 'haus-eigen');
  if (nichtFrei.length > 0) gruende.push(`lizenz:${nichtFrei.join('+')}`);
  if (opts.pii) gruende.push('personenmuster');
  return gruende.length === 0
    ? { darf: true, grund: 'freizuegige-lizenz+keine-personenmuster' }
    : { darf: false, grund: gruende.join('+') };
}

// ── Trennung nach Einheiten (Familie oder Projekt) ───────────────────────────

/**
 * Waehlt ganze Einheiten fuer `dev`, bis etwa `anteil` der Eintraege erreicht ist.
 * Reihenfolge: nach Namen sortiert, dann mit der Saat gemischt — gleiche Saat,
 * gleiche Wahl. Eine Einheit, die den Zielwert um mehr als 10 % sprengt, wird
 * uebersprungen.
 */
export function waehleDev(groessen: ReadonlyMap<string, number>, anteil: number, saat: number): Set<string> {
  const namen = [...groessen.keys()].sort();
  const gemischt = mischen(namen, rngVon(saat ^ fnv1a('dev-wahl')));
  let gesamt = 0;
  for (const g of groessen.values()) gesamt += g;
  const ziel = Math.round(gesamt * anteil);
  const dev = new Set<string>();
  let summe = 0;
  for (const n of gemischt) {
    const g = groessen.get(n) ?? 0;
    if (summe + g > ziel * 1.1) continue;
    dev.add(n);
    summe += g;
    if (summe >= ziel) break;
  }
  return dev;
}

// ── Die Pruefung gegen den Pruefsatz ─────────────────────────────────────────

export interface SatzDatei {
  name: string;
  queries: Array<{ query: string; relevant?: string[]; id?: string }>;
}

export interface Gesperrt {
  /** Normalisierte Fragen aller gesperrten Saetze. */
  fragen: Set<string>;
  /** "<normalisierte Frage>\0<Lektion>" fuer jedes gesperrte Paar. */
  paare: Set<string>;
  ids: Set<string>;
  /** Wortmengen fuer die Beinahe-Doppelten-Suche, nur die der echten Messlatten. */
  woerter: Array<{ menge: Set<string>; frage: string; ziele: ReadonlySet<string> }>;
  jeDatei: Record<string, number>;
}

/** Saetze, die als Messlatte gelten: Beinahe-Doppelte werden gegen sie gesucht. */
export function sperreAus(saetze: SatzDatei[], messlatten: ReadonlySet<string>): Gesperrt {
  const g: Gesperrt = { fragen: new Set(), paare: new Set(), ids: new Set(), woerter: [], jeDatei: {} };
  for (const s of saetze) {
    g.jeDatei[s.name] = s.queries.length;
    for (const q of s.queries) {
      const n = normalisiere(q.query);
      g.fragen.add(n);
      for (const l of q.relevant ?? []) g.paare.add(`${n}\u0000${l}`);
      if (q.id) g.ids.add(q.id);
      if (messlatten.has(s.name)) g.woerter.push({ menge: wortMenge(q.query), frage: q.query, ziele: new Set(q.relevant ?? []) });
    }
  }
  return g;
}

export const NAH_DOPPELT = 0.8;
export const AEHNLICH = 0.6;

export interface PruefZeile { frage: string; frage_id: string; kandidat_id: string | null; ziel_id: string }

interface Naehe { frage: string; norm: string; art: 'nah_doppelt' | 'nah_gleiches_ziel' | 'aehnlich' | null; zu: string }

/**
 * Je verschiedene Frage die groesste Naehe zu einer Messlatten-Frage.
 *   nah_doppelt        Jaccard >= 0,8 auf Wortmengen: gilt als dieselbe Frage
 *   nah_gleiches_ziel  Jaccard >= 0,6 UND dieselbe Ziel-Lektion: fast dasselbe Paar
 *   aehnlich           Jaccard >= 0,6 sonst: wird nur gezaehlt
 */
function naehe(zeilen: ReadonlyArray<PruefZeile>, g: Gesperrt): Naehe[] {
  const einzeln = new Map<string, PruefZeile>();
  for (const z of zeilen) einzeln.set(normalisiere(z.frage), z);
  const mengen = g.woerter.map((w) => ({ ...w, n: w.menge.size }));
  const aus: Naehe[] = [];
  for (const [norm, z] of einzeln) {
    const m = wortMenge(z.frage);
    let art: Naehe['art'] = null;
    let zu = '';
    if (m.size > 0) {
      for (const w of mengen) {
        // Jaccard >= 0,6 braucht Mengen von aehnlicher Groesse: billiger Vorfilter.
        const verhaeltnis = m.size < w.n ? m.size / w.n : w.n / m.size;
        if (verhaeltnis < AEHNLICH) continue;
        const j = jaccard(m, w.menge);
        if (j >= NAH_DOPPELT) { art = 'nah_doppelt'; zu = w.frage; break; }
        if (j >= AEHNLICH) {
          if (w.ziele.has(z.ziel_id)) { art = 'nah_gleiches_ziel'; zu = w.frage; break; }
          if (art === null) { art = 'aehnlich'; zu = w.frage; }
        }
      }
    }
    aus.push({ frage: z.frage, norm, art, zu });
  }
  return aus;
}

/** Normalisierte Fragen, die zu nah an einer Messlatten-Frage liegen: sie werden NICHT uebernommen. */
export function nahDoppelte(zeilen: ReadonlyArray<PruefZeile>, g: Gesperrt): Array<{ norm: string; frage: string; art: string; zu: string }> {
  return naehe(zeilen, g)
    .filter((n) => n.art === 'nah_doppelt' || n.art === 'nah_gleiches_ziel')
    .map((n) => ({ norm: n.norm, frage: n.frage, art: n.art ?? '', zu: n.zu }));
}

export interface UeberschneidungsBericht {
  zeilenGeprueft: number;
  fragenGeprueft: number;
  gleicheFrage: number;
  gleichePaare: number;
  gleicheId: number;
  nahDoppelt: number;
  nahGleichesZiel: number;
  /** Jaccard 0,6 bis unter 0,8 bei anderer Ziel-Lektion: wird gemeldet, bricht nicht ab. */
  aehnlich: number;
  beispiele: string[];
}

export function pruefeUeberschneidung(zeilen: ReadonlyArray<PruefZeile>, g: Gesperrt): UeberschneidungsBericht {
  const b: UeberschneidungsBericht = {
    zeilenGeprueft: zeilen.length, fragenGeprueft: 0, gleicheFrage: 0, gleichePaare: 0, gleicheId: 0,
    nahDoppelt: 0, nahGleichesZiel: 0, aehnlich: 0, beispiele: [],
  };
  const merke = (text: string): void => { if (b.beispiele.length < 5) b.beispiele.push(text.slice(0, 200)); };
  for (const z of zeilen) {
    const n = normalisiere(z.frage);
    if (g.fragen.has(n)) { b.gleicheFrage++; merke(`Frage: ${z.frage}`); }
    if (z.kandidat_id !== null && g.paare.has(`${n}\u0000${z.kandidat_id}`)) { b.gleichePaare++; merke(`Paar: ${z.frage} -> ${z.kandidat_id}`); }
    if (g.ids.has(z.frage_id)) { b.gleicheId++; merke(`Kennung: ${z.frage_id}`); }
  }
  const alle = naehe(zeilen, g);
  b.fragenGeprueft = alle.length;
  for (const n of alle) {
    if (n.art === 'nah_doppelt') { b.nahDoppelt++; merke(`Nah-doppelt: ${n.frage} ~ ${n.zu}`); }
    else if (n.art === 'nah_gleiches_ziel') { b.nahGleichesZiel++; merke(`Nah, gleiches Ziel: ${n.frage} ~ ${n.zu}`); }
    else if (n.art === 'aehnlich') b.aehnlich++;
  }
  return b;
}

export function istUeberschneidung(b: UeberschneidungsBericht): boolean {
  return b.gleicheFrage > 0 || b.gleichePaare > 0 || b.gleicheId > 0 || b.nahDoppelt > 0 || b.nahGleichesZiel > 0;
}

/**
 * Beweist, dass die Pruefung nicht blind ist: schleust Pruefsatz-Fragen in vier
 * Formen ein (gleich, anders geschrieben, ein Wort weniger, gleiches Paar) plus
 * eine echte Pruefsatz-Kennung und verlangt, dass jede gefunden wird.
 */
export function gegenprobe(pruefsatz: SatzDatei, g: Gesperrt): { ok: boolean; befunde: Record<string, boolean> } {
  const lang = pruefsatz.queries.filter((q) => (q.relevant?.length ?? 0) > 0 && wortMenge(q.query).size >= 8);
  const q = lang[Math.floor(lang.length / 2)];
  const ziel = q.relevant?.[0] ?? '';
  const woerter = q.query.split(/\s+/);
  const eins = (frage: string, id = 'probe-0', kand: string | null = null) => pruefeUeberschneidung([{ frage, frage_id: id, kandidat_id: kand, ziel_id: ziel }], g);
  const gleich = eins(q.query);
  const andersGeschrieben = eins(`  ${q.query.toUpperCase()}!! `);
  const einWortWeniger = eins(woerter.slice(0, -1).join(' '));
  const paar = eins(q.query.replace(/\s+/g, '  '), 'probe-1', ziel);
  const mitKennung = pruefsatz.queries.find((x) => x.id);
  const kennung = mitKennung ? eins('voellig anderer text zur probe der kennung', mitKennung.id) : null;
  const befunde = {
    gleiche_frage: gleich.gleicheFrage === 1,
    andere_schreibweise: andersGeschrieben.gleicheFrage === 1,
    ein_wort_weniger: einWortWeniger.nahDoppelt === 1,
    gleiches_paar: paar.gleichePaare === 1,
    gleiche_kennung: kennung === null ? true : kennung.gleicheId === 1,
  };
  return { ok: Object.values(befunde).every(Boolean), befunde };
}

// ── Zeilen ────────────────────────────────────────────────────────────────────

export interface Zeile {
  frage_id: string;
  frage: string;
  kandidat_id: string | null;
  kandidat: string | null;
  label: Klasse | 'keine_passt';
  negativ_art: string | null;
  rang_haus: number | null;
  ziel_id: string;
  quelle: string;
  projekt: string;
  art_frage: string | null;
  guete: string | null;
  sprache: string | null;
  erzeuger: string;
  lizenz: string;
  darf_offen: boolean;
  offen_grund: string;
  pii: boolean;
  variante?: 'verloren' | 'ohne_treffer_simuliert';
  kandidat_ids?: string[];
  entfernt_kandidat_id?: string;
}

export interface Quelle {
  name: string;
  erzeuger: string;
  hausdaten: boolean;
  lizenzVon(topic: string): string;
  projektVon(topic: string): string;
  /** Kandidatentext je Thema (leserText), nur Themen mit Text. */
  texte: ReadonlyMap<string, string>;
  beurteile(kandidat: string, ziel: string): Klasse;
  seiteVon(topic: string): Seite;
}

export interface FrageEintrag {
  id: string;
  frage: string;
  ziel: string;
  seite: Seite;
  gezeigt: string[];
  art?: string | null;
  guete?: string | null;
  sprache?: string | null;
}

export interface Fragenergebnis {
  zeilen: Zeile[];
  platz: number | null;
  verloren: boolean;
  /** Die Ziel-Lektion hat keinen Text: eine Frage ohne lesbare Antwort wird nicht gelehrt. */
  uebersprungen?: boolean;
}

export function baueFrage(f: FrageEintrag, q: Quelle, saat: number, poolJeSeite: ReadonlyMap<Seite, string[]>): Fragenergebnis {
  if (!q.texte.has(f.ziel)) return { zeilen: [], platz: null, verloren: false, uebersprungen: true };
  const liste = f.gezeigt.slice(0, LISTE_TIEFE);
  const pos = liste.indexOf(f.ziel);
  const verloren = pos < 0;
  const erlaubt = (t: string): boolean => t !== f.ziel && q.texte.has(t) && q.seiteVon(t) === f.seite;

  const vor = (verloren ? liste : liste.slice(0, pos)).filter(erlaubt).map((t) => ({ t, art: verloren ? 'hart_verloren' : 'hart_vor_treffer' }));
  const hinten = (verloren ? [] : liste.slice(pos + 1)).filter(erlaubt).map((t) => ({ t, art: 'hart_hinter_treffer' }));
  const harte = [...vor, ...hinten].slice(0, HART_MAX);

  // Leichte Negative: zufaellig, aber stabil je Frage (nicht je Reihenfolge der Verarbeitung).
  const rng = rngVon(saat ^ fnv1a(`leicht:${f.id}`));
  const sperre = new Set([f.ziel, ...liste]);
  const kandidatenPool = (poolJeSeite.get(f.seite) ?? []).filter((t) => !sperre.has(t));
  const leicht = kandidatenPool.length === 0 ? [] : mischen(kandidatenPool, rng).slice(0, LEICHT_JE_FRAGE).map((t) => ({ t, art: 'leicht_zufall' }));

  const zeilen: Zeile[] = [];
  const zeileFuer = (t: string, art: string | null): Zeile => {
    const text = q.texte.get(t) ?? '';
    const lizenzen = [...new Set([q.lizenzVon(f.ziel), q.lizenzVon(t)])].sort();
    const pii = personenmuster(f.frage).length > 0 || personenmuster(text).length > 0;
    const frei = bewerteFreigabe({ erzeuger: q.erzeuger, lizenzen, pii, hausdaten: q.hausdaten });
    const rang = liste.indexOf(t);
    return {
      frage_id: f.id, frage: f.frage, kandidat_id: t, kandidat: text,
      label: q.beurteile(t, f.ziel), negativ_art: art, rang_haus: rang >= 0 ? rang + 1 : null,
      ziel_id: f.ziel, quelle: q.name, projekt: q.projektVon(f.ziel),
      art_frage: f.art ?? null, guete: f.guete ?? null, sprache: f.sprache ?? null,
      erzeuger: q.erzeuger, lizenz: lizenzen.join('+'), darf_offen: frei.darf, offen_grund: frei.grund, pii,
    };
  };

  zeilen.push(zeileFuer(f.ziel, null));
  for (const h of [...harte, ...leicht]) zeilen.push(zeileFuer(h.t, h.art));

  const keineZeile = (variante: 'verloren' | 'ohne_treffer_simuliert', ids: string[]): Zeile => {
    const basis = zeileFuer(ids[0], null);
    return {
      ...basis, kandidat_id: null, kandidat: null, label: 'keine_passt', negativ_art: null, rang_haus: null,
      variante, kandidat_ids: ids, ...(variante === 'ohne_treffer_simuliert' ? { entfernt_kandidat_id: f.ziel } : {}),
    };
  };
  const hartIds = harte.map((h) => h.t);
  if (verloren && hartIds.length > 0) {
    zeilen.push(keineZeile('verloren', hartIds));
  } else if (!verloren && hartIds.length >= 3 && rngVon(saat ^ fnv1a(`sim:${f.id}`))() < SIMULIERT_ANTEIL) {
    zeilen.push(keineZeile('ohne_treffer_simuliert', hartIds));
  }
  return { zeilen, platz: verloren ? null : pos + 1, verloren };
}

// ── Einlesen ──────────────────────────────────────────────────────────────────

class NichtGemessen extends Error {}

function fehlt(was: string, pfad: string): never {
  throw new NichtGemessen(`${was} fehlt (${pfad})`);
}

function liesJson<T>(pfad: string, was: string): T {
  if (!existsSync(pfad)) fehlt(was, pfad);
  return JSON.parse(readFileSync(pfad, 'utf8')) as T;
}

function liesJsonl<T>(pfad: string): T[] {
  return readFileSync(pfad, 'utf8').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z) as T);
}

/** Datei ODER Ordner mit *.jsonl der Topf-Mitschrift: Frage (200 Zeichen) -> erste Plaetze. */
export function mitschriftDateien(pfad: string): string[] {
  if (!existsSync(pfad)) fehlt('Rangfolge-Mitschrift (Haus)', pfad);
  const dateien = statSync(pfad).isDirectory()
    ? readdirSync(pfad).filter((d) => d.endsWith('.jsonl')).sort().map((d) => join(pfad, d))
    : [pfad];
  if (dateien.length === 0) fehlt('Rangfolge-Mitschrift (Haus), keine *.jsonl', pfad);
  return dateien;
}

export function ladeMitschrift(pfad: string): Map<string, string[]> {
  const dateien = mitschriftDateien(pfad);
  const aus = new Map<string, string[]>();
  for (const d of dateien) {
    for (const z of liesJsonl<{ frage: string; gezeigt: string[] }>(d)) {
      if (!aus.has(z.frage)) aus.set(z.frage, z.gezeigt);
    }
  }
  return aus;
}

interface Lektionsdatei { lessons: Array<{ topic: string; what_worked?: string; what_failed?: string }> }
interface EinstellFrage { query: string; relevant: string[]; id: string; art?: string; guete?: string; sprache?: string }

function git(args: string[], cwd: string): string {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); } catch { return 'unbekannt'; }
}

// ── Die Kennzahlen der Rangfolge ─────────────────────────────────────────────

function rangKennzahlen(plaetze: Array<number | null>): Record<string, number> {
  const n = plaetze.length;
  const bis = (k: number): number => plaetze.filter((p) => p !== null && p <= k).length;
  return {
    fragen: n,
    platz1: bis(1), platz1_proz: Number(((bis(1) / n) * 100).toFixed(1)),
    treffer3: bis(3), treffer3_proz: Number(((bis(3) / n) * 100).toFixed(1)),
    treffer10: bis(10), verloren_nach_10: n - bis(10),
  };
}

// ── Hauptlauf ─────────────────────────────────────────────────────────────────

interface Optionen {
  nach: string;
  saat: number;
  korpusOrdner: string;
  rangfolgeHaus: string;
  selbstprobe: boolean;
}

function optionen(argv: string[]): Optionen {
  const flag = (n: string): string | undefined => { const i = argv.indexOf(`--${n}`); return i === -1 ? undefined : argv[i + 1]; };
  const wurzel = join(homedir(), '.cachly');
  return {
    nach: resolve(flag('nach') ?? join(wurzel, 'entscheider', SATZ_VERSION)),
    saat: Number(flag('saat') ?? STANDARD_SAAT),
    korpusOrdner: resolve(flag('korpus-ordner') ?? join(wurzel, 'bench-korpus')),
    rangfolgeHaus: resolve(flag('rangfolge-haus') ?? join(wurzel, 'entscheider', 'rangfolge')),
    selbstprobe: argv.includes('--selbstprobe'),
  };
}

const schreibe = (pfad: string, zeilen: unknown[]): string => {
  const text = zeilen.map((z) => JSON.stringify(z)).join('\n') + '\n';
  writeFileSync(pfad, text, 'utf8');
  return sha256Text(text);
};

function zaehle<T>(liste: T[], schluessel: (x: T) => string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of liste) { const k = schluessel(x); m[k] = (m[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
}

function giftZeilen(): Array<Record<string, unknown>> {
  let g = 0; let h = 0;
  return ALLE_PROBEN.map((p: Giftprobe) => {
    const id = p.label === 'gift' ? `gift-${String(++g).padStart(3, '0')}` : `harmlos-${String(++h).padStart(3, '0')}`;
    return {
      id, text: p.text, label: p.label, art: p.art,
      ...(p.bezug ? { bezug: p.bezug } : {}),
      erzeuger: 'claude', darf_offen: false, offen_grund: 'claude-text',
    };
  });
}

function giftBericht(): Record<string, unknown> {
  const arten = (liste: Giftprobe[]) => zaehle(liste, (p) => p.art);
  const filterTreffer = (liste: Giftprobe[]) => liste.filter((p) => schwaerze(p.text).funde.length > 0).length;
  const gift = GIFT_PROBEN.filter((p) => p.art === 'geheimnis_klartext');
  return {
    gift: GIFT_PROBEN.length, harmlos: HARMLOSE_PROBEN.length,
    arten_gift: arten(GIFT_PROBEN), arten_harmlos: arten(HARMLOSE_PROBEN),
    // Was der Muster-Filter im Produkt (geheimnis-filter.ts) heute schon schafft: die Grundlinie fuer 4.4.
    muster_filter_grundlinie: {
      beschreibung: 'schwaerze() aus src/geheimnis-filter.ts; Treffer = mindestens ein Fund',
      geheimnis_gift_erkannt: filterTreffer(gift),
      geheimnis_gift_gesamt: gift.length,
      alle_gift_erkannt: filterTreffer(GIFT_PROBEN),
      harmlos_faelschlich_erkannt: filterTreffer(HARMLOSE_PROBEN),
    },
  };
}

async function main(): Promise<void> {
  const o = optionen(process.argv.slice(2));
  const KB = o.korpusOrdner;
  const pfad = {
    korpus: join(KB, 'korpus-gross.json'),
    einstell: join(KB, 'einstellsatz-3000.json'),
    pruef: join(KB, 'pruefsatz-3000.json'),
    fremd: join(KB, 'fremdsatz-teil.json'),
    fremdMerkmale: join(KB, 'merkmale-fremdsatz-teil.jsonl'),
  };
  const gesperrteDateien = ['pruefsatz-3000.json', 'pruefsatz-frisch.json', 'pruefsatz-alt.json', 'korpus-gross.json', 'fragen-gross.json', 'korpus.json', 'korpus-en.json', 'fragen.json', 'fragen-en.json'];
  const messlatten = new Set(['pruefsatz-3000.json', 'pruefsatz-frisch.json']);

  // 1. Die Sperre bauen und die Pruefung selbst pruefen — VOR allem anderen.
  const pruefsatz = liesJson<SatzDatei>(pfad.pruef, 'Pruefsatz (pruefsatz-3000.json)');
  if (pruefsatz.queries.length !== 3003) throw new NichtGemessen(`Pruefsatz hat ${pruefsatz.queries.length} Fragen statt 3003 — falsche Datei?`);
  const saetze: SatzDatei[] = [];
  const fehlendeSperren: string[] = [];
  for (const d of gesperrteDateien) {
    const p = join(KB, d);
    if (!existsSync(p)) { fehlendeSperren.push(d); continue; }
    const j = JSON.parse(readFileSync(p, 'utf8')) as { queries?: SatzDatei['queries'] };
    saetze.push({ name: d, queries: j.queries ?? [] });
  }
  const gesperrt = sperreAus(saetze, messlatten);
  const probe = gegenprobe(pruefsatz, gesperrt);
  console.log('\nEntscheider-Trainingssatz');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(`Gegenprobe der Ueberschneidungspruefung: ${probe.ok ? 'JA, eingeschleuste Pruefsatz-Fragen werden gefunden' : 'NEIN'}  ${JSON.stringify(probe.befunde)}`);
  if (!probe.ok) { console.error('ABBRUCH: die Ueberschneidungspruefung ist blind.'); process.exit(3); }
  console.log(`Gesperrt: ${Object.entries(gesperrt.jeDatei).map(([d, n]) => `${d} ${n}`).join(' · ')}`);
  if (fehlendeSperren.length > 0) console.log(`  (nicht vorhanden, nicht gesperrt: ${fehlendeSperren.join(', ')})`);

  mkdirSync(o.nach, { recursive: true });
  const giftSumme = schreibe(join(o.nach, 'giftproben-v1.jsonl'), giftZeilen());
  console.log(`Giftproben: ${GIFT_PROBEN.length} Gift + ${HARMLOSE_PROBEN.length} harmlos -> giftproben-v1.jsonl`);
  if (o.selbstprobe) { console.log('--selbstprobe: fertig, kein Satz gebaut.'); return; }

  // 2. Haus
  const korpus = liesJson<Lektionsdatei>(pfad.korpus, 'Hauskorpus (korpus-gross.json)');
  const einstell = liesJson<{ queries: EinstellFrage[] }>(pfad.einstell, 'Einstellsatz (einstellsatz-3000.json)');
  const mitschrift = ladeMitschrift(o.rangfolgeHaus);
  const hausTexte = new Map<string, string>();
  const hausVolltext = new Map<string, string>();
  for (const l of korpus.lessons) {
    if (!l.what_worked) continue;
    hausTexte.set(l.topic, leserText(l as Record<string, unknown>, KANDIDAT_MAX_ZEICHEN));
    // Fuer die Klasse "verwandt" zaehlt die ganze Lektion, nicht nur der gezeigte Zuschnitt.
    hausVolltext.set(l.topic, `${l.topic.slice(l.topic.indexOf(':') + 1)} ${l.what_worked} ${l.what_failed ?? ''}`);
  }
  const hausSim = new Aehnlichkeit(hausVolltext);
  const familienGroesse = new Map<string, number>();
  for (const t of hausTexte.keys()) familienGroesse.set(projektFamilie(t), (familienGroesse.get(projektFamilie(t)) ?? 0) + 1);
  const devFamilien = waehleDev(familienGroesse, DEV_ANTEIL_HAUS, o.saat);
  const hausSeite = (t: string): Seite => (devFamilien.has(projektFamilie(t)) ? 'dev' : 'train');
  const hausQuelle: Quelle = {
    name: 'haus-einstell', erzeuger: 'claude', hausdaten: true,
    lizenzVon: () => 'haus-eigen', projektVon: projektFamilie, texte: hausTexte,
    beurteile: (k, z) => beurteileHaus(k, z, (a, b) => hausSim.kosinus(a, b)), seiteVon: hausSeite,
  };
  const hausPool = new Map<Seite, string[]>([
    ['train', [...hausTexte.keys()].filter((t) => hausSeite(t) === 'train').sort()],
    ['dev', [...hausTexte.keys()].filter((t) => hausSeite(t) === 'dev').sort()],
  ]);
  const hausFragen: FrageEintrag[] = einstell.queries.map((q) => {
    const gezeigt = mitschrift.get(q.query.slice(0, 200));
    if (!gezeigt) throw new NichtGemessen(`keine Rangfolge fuer Einstellfrage ${q.id} in ${o.rangfolgeHaus} — Schritt 1 (bench:ausgabe mit CACHLY_TOPF_PROTOKOLL) unvollstaendig`);
    return { id: q.id, frage: q.query, ziel: q.relevant[0], seite: hausSeite(q.relevant[0]), gezeigt, art: q.art, guete: q.guete, sprache: q.sprache };
  });

  // 3. Fremd
  const fremd = liesJson<{ lessons: Array<{ topic: string; what_worked: string }>; queries: Array<{ query: string; relevant: string[] }> }>(pfad.fremd, 'Fremdsatz (fremdsatz-teil.json)');
  if (!existsSync(pfad.fremdMerkmale)) fehlt('Fremd-Merkmale (merkmale-fremdsatz-teil.jsonl)', pfad.fremdMerkmale);
  const fremdTexte = new Map<string, string>();
  const fremdVolltext = new Map<string, string>();
  for (const l of fremd.lessons) {
    fremdTexte.set(l.topic, leserText(l as unknown as Record<string, unknown>, KANDIDAT_MAX_ZEICHEN));
    fremdVolltext.set(l.topic, l.what_worked);
  }
  const fremdSim = new Aehnlichkeit(fremdVolltext, FREMD_MAX_DF);
  const rangFremd = new Map<string, string[]>();
  for (const z of liesJsonl<{ query: string; topf: Array<{ t: string; nT: number; nTh: number; nR: number; sD: number; bE: number }> }>(pfad.fremdMerkmale)) {
    const p = punktzahl(z.topf);
    rangFremd.set(z.query, z.topf.map((k, i) => ({ t: k.t, p: p[i] })).sort((a, b) => b.p - a.p).slice(0, LISTE_TIEFE).map((x) => x.t));
  }
  const projektGroesse = new Map<string, number>();
  for (const q of fremd.queries) { const p = projektVonFremd(q.relevant[0]); projektGroesse.set(p, (projektGroesse.get(p) ?? 0) + 1); }
  const devProjekte = waehleDev(projektGroesse, DEV_ANTEIL_FREMD, o.saat);
  const fremdSeite = (t: string): Seite => (devProjekte.has(projektVonFremd(t)) ? 'dev' : 'train');
  const fremdQuelle: Quelle = {
    name: 'fremd-teil', erzeuger: 'mensch-github', hausdaten: false,
    lizenzVon: (t) => FREMD_LIZENZ[projektVonFremd(t)] ?? 'unbekannt', projektVon: projektVonFremd, texte: fremdTexte,
    beurteile: (k, z) => beurteileFremd(k, z, (a, b) => fremdSim.kosinus(a, b), (t) => fremdVolltext.get(t) ?? ''), seiteVon: fremdSeite,
  };
  const fremdPool = new Map<Seite, string[]>([
    ['train', [...fremdTexte.keys()].filter((t) => fremdSeite(t) === 'train').sort()],
    ['dev', [...fremdTexte.keys()].filter((t) => fremdSeite(t) === 'dev').sort()],
  ]);
  const fremdFragen: FrageEintrag[] = fremd.queries.map((q, i) => {
    const gezeigt = rangFremd.get(q.query);
    if (!gezeigt) throw new NichtGemessen(`keine Rangfolge fuer Fremdfrage ${i} in ${pfad.fremdMerkmale}`);
    return { id: `fremd-teil-${String(i).padStart(5, '0')}`, frage: q.query, ziel: q.relevant[0], seite: fremdSeite(q.relevant[0]), gezeigt };
  });

  // 4. Bauen
  const jeSeite: Record<Seite, Zeile[]> = { train: [], dev: [] };
  const plaetze: Record<string, Array<number | null>> = { 'haus-einstell': [], 'fremd-teil': [] };
  const uebersprungen: Record<string, number> = { 'haus-einstell': 0, 'fremd-teil': 0 };
  for (const [fragen, quelle, pool] of [[hausFragen, hausQuelle, hausPool], [fremdFragen, fremdQuelle, fremdPool]] as const) {
    for (const f of fragen) {
      const e = baueFrage(f, quelle, o.saat, pool);
      if (e.uebersprungen) { uebersprungen[quelle.name]++; continue; }
      jeSeite[f.seite].push(...e.zeilen);
      plaetze[quelle.name].push(e.platz);
    }
  }
  for (const s of ['train', 'dev'] as const) jeSeite[s] = mischen(jeSeite[s], rngVon(o.saat ^ fnv1a(`mischen:${s}`)));

  // 5. Die Pruefung — auf dem fertigen Satz, nicht auf den Eingaben.
  //    Beinahe-Doppelte (Jaccard >= 0,8, oder >= 0,6 bei derselben Ziel-Lektion) werden
  //    zuerst entfernt und gemeldet. Danach darf NICHTS mehr uebrig sein: gleiche Frage,
  //    gleiches Paar, gleiche Kennung brechen immer ab.
  const vorEntfernen = [...jeSeite.train, ...jeSeite.dev];
  const naheFragen = nahDoppelte(vorEntfernen, gesperrt);
  const naheNormen = new Set(naheFragen.map((n) => n.norm));
  const entfernteZeilen = vorEntfernen.filter((z) => naheNormen.has(normalisiere(z.frage))).length;
  for (const s of ['train', 'dev'] as const) jeSeite[s] = jeSeite[s].filter((z) => !naheNormen.has(normalisiere(z.frage)));
  console.log(`Beinahe-Doppelte zu einer Messlatten-Frage entfernt: ${naheFragen.length} Fragen (${entfernteZeilen} Zeilen)`);
  for (const n of naheFragen.slice(0, 5)) console.log(`  [${n.art}] "${n.frage}" ~ "${n.zu}"`);
  const alle = [...jeSeite.train, ...jeSeite.dev];
  const bericht = pruefeUeberschneidung(alle, gesperrt);
  console.log(`Ueberschneidung mit den gesperrten Saetzen (${bericht.zeilenGeprueft} Zeilen, ${bericht.fragenGeprueft} verschiedene Fragen):`);
  console.log(`  gleiche Frage ${bericht.gleicheFrage} · gleiche Paare ${bericht.gleichePaare} · gleiche Kennung ${bericht.gleicheId} · nah-doppelt (Jaccard >= ${NAH_DOPPELT}) ${bericht.nahDoppelt} · nah bei gleichem Ziel (>= ${AEHNLICH}) ${bericht.nahGleichesZiel} · aehnlich, anderes Ziel ${bericht.aehnlich}`);
  if (istUeberschneidung(bericht)) {
    console.error(`ABBRUCH: Ueberschneidung mit dem Pruefsatz oder einer frueheren Messlatte.\n${bericht.beispiele.join('\n')}`);
    process.exit(3);
  }
  // Lektionen: dev-Lektionen duerfen im Training nicht vorkommen — und umgekehrt.
  let seitenfehler = 0;
  for (const seite of ['train', 'dev'] as const) {
    for (const z of jeSeite[seite]) {
      const q = z.quelle === 'haus-einstell' ? hausQuelle : fremdQuelle;
      for (const t of [z.ziel_id, z.kandidat_id, ...(z.kandidat_ids ?? [])]) {
        if (t !== null && q.seiteVon(t) !== seite) seitenfehler++;
      }
    }
  }
  console.log(`Lektionen der anderen Seite (train/dev): ${seitenfehler}`);
  if (seitenfehler > 0) { console.error('ABBRUCH: eine Zeile nennt eine Lektion der anderen Seite.'); process.exit(3); }

  // 6. Schreiben
  const trainSumme = schreibe(join(o.nach, 'train.jsonl'), jeSeite.train);
  const devSumme = schreibe(join(o.nach, 'dev.jsonl'), jeSeite.dev);

  // Die ehrliche Teilmenge der Messlatte: Pruefsatz-Fragen, deren Lektion nur in dev lebt.
  const ehrlich = pruefsatz.queries.filter((q) => hausSeite(q.relevant?.[0] ?? '') === 'dev' && hausTexte.has(q.relevant?.[0] ?? ''));
  writeFileSync(join(o.nach, 'messlatte-ohne-lektion-im-training.json'), JSON.stringify({
    hinweis: 'NUR Kennungen der Pruefsatz-Fragen. Zum Messen, nie zum Trainieren. Ihre Ziel-Lektionen stehen weder als Treffer noch als Negativ im Training.',
    pruefsatz: 'pruefsatz-3000.json',
    saat: o.saat,
    dev_familien: [...devFamilien].sort(),
    anzahl: ehrlich.length,
    von: pruefsatz.queries.length,
    ids: ehrlich.map((q) => q.id).sort(),
  }, null, 1) + '\n', 'utf8');

  // Die Handpruefung: je 20 Zeilen aus der DATEIMITTE von train.jsonl (mittleres Drittel),
  // fest gezogen mit der Saat. (a) label=verwandt: stimmt die Regel? (b) harte Negative
  // (label=passt_nicht, hart_vor_treffer/hart_verloren): waere der Kandidat eigentlich eine Antwort?
  const train = jeSeite.train;
  const von = Math.floor(train.length / 3);
  const bis = Math.floor((train.length * 2) / 3);
  const mitteZeilen = train.map((z, i) => ({ z, nr: i + 1 })).filter(({ nr }) => nr - 1 >= von && nr - 1 < bis);
  const ziehe = (aus: typeof mitteZeilen, name: string, quelle: string, n: number) =>
    mischen(aus.filter(({ z }) => z.quelle === quelle), rngVon(o.saat ^ fnv1a(`${name}:${quelle}`))).slice(0, n);
  const sichtbar = ({ z, nr }: { z: Zeile; nr: number }) => ({
    zeile_nr: nr, quelle: z.quelle, label: z.label, frage: z.frage, ziel_id: z.ziel_id, kandidat_id: z.kandidat_id, negativ_art: z.negativ_art,
    ziel_text: (z.quelle === 'haus-einstell' ? hausTexte : fremdTexte).get(z.ziel_id)?.slice(0, 400), kandidat: z.kandidat?.slice(0, 400),
  });
  const stichprobeVon = (name: string, filter: (z: Zeile) => boolean) => {
    const aus = mitteZeilen.filter(({ z }) => filter(z));
    const anteilFremd = aus.filter(({ z }) => z.quelle === 'fremd-teil').length / Math.max(1, aus.length);
    const nFremd = Math.max(6, Math.round(20 * anteilFremd));
    const zeilen = [...ziehe(aus, name, 'haus-einstell', 20 - nFremd), ...ziehe(aus, name, 'fremd-teil', nFremd)].map(sichtbar);
    schreibe(join(o.nach, `stichprobe-${name}-20.jsonl`), zeilen);
    return { nHaus: 20 - nFremd, nFremd };
  };
  const nV = stichprobeVon('verwandt', (z) => z.label === 'verwandt');
  stichprobeVon('passt-nicht-hart', (z) => z.label === 'passt_nicht' && (z.negativ_art === 'hart_vor_treffer' || z.negativ_art === 'hart_verloren'));

  // 7. meta.json
  const urteilPfad = join(o.nach, 'stichprobe-urteil.json');
  const urteil = existsSync(urteilPfad) ? JSON.parse(readFileSync(urteilPfad, 'utf8')) as unknown : null;
  const gitOrdner = dirname(fileURLToPath(import.meta.url));
  const zeilen = (s: Zeile[]) => s.filter((z) => z.label !== 'keine_passt');
  const sicht = (s: Zeile[]) => ({
    zeilen: s.length,
    paare: zeilen(s).length,
    klassen: zaehle(s, (z) => z.label),
    je_quelle_und_klasse: zaehle(s, (z) => `${z.quelle}/${z.label}`),
    negativ_art: zaehle(zeilen(s).filter((z) => z.negativ_art), (z) => z.negativ_art ?? ''),
    keine_passt_je_variante: zaehle(s.filter((z) => z.label === 'keine_passt'), (z) => `${z.quelle}/${z.variante ?? ''}`),
    fragen: new Set(s.map((z) => z.frage_id)).size,
  });
  const alleZeilen = [...jeSeite.train, ...jeSeite.dev];
  const offen = (s: Zeile[]) => ({ ja: s.filter((z) => z.darf_offen).length, nein: s.filter((z) => !z.darf_offen).length, anteil_ja_proz: Number(((s.filter((z) => z.darf_offen).length / Math.max(1, s.length)) * 100).toFixed(1)) });
  const laengen = zeilen(alleZeilen).map((z) => (z.frage.length + (z.kandidat?.length ?? 0))).sort((a, b) => a - b);
  const meta = {
    satz: SATZ_VERSION,
    erzeugt: new Date().toISOString(),
    saat: o.saat,
    git_sha: git(['rev-parse', 'HEAD'], gitOrdner),
    git_zweig: git(['rev-parse', '--abbrev-ref', 'HEAD'], gitOrdner),
    git_skript_geaendert: git(['status', '--porcelain', '--', 'entscheider-trainingssatz.ts', 'entscheider-giftproben.ts'], gitOrdner) !== '',
    skript: 'sdk/mcp/src/bench/entscheider-trainingssatz.ts',
    parameter: {
      liste_tiefe: LISTE_TIEFE, hart_max: HART_MAX, leicht_je_frage: LEICHT_JE_FRAGE, simuliert_anteil: SIMULIERT_ANTEIL,
      dev_anteil_haus: DEV_ANTEIL_HAUS, dev_anteil_fremd: DEV_ANTEIL_FREMD, kandidat_max_zeichen: KANDIDAT_MAX_ZEICHEN,
      kandidat_text: 'leserText(lektion, 1500) = "<topic>\\n<what_worked>" (src/seltenheitsbestand.ts), wie ihn auch der Leser im Produkt sieht; what_failed bleibt draussen',
    },
    eingaben: Object.fromEntries(Object.entries(pfad).map(([k, p]) => [k, { pfad: p, sha256: sha256Datei(p) }])),
    rangfolge_haus_mitschrift: { pfad: o.rangfolgeHaus, dateien: mitschriftDateien(o.rangfolgeHaus).map((d) => ({ datei: d, sha256: sha256Datei(d) })) },
    zaehlung: {
      gesamt: sicht(alleZeilen),
      train: sicht(jeSeite.train),
      dev: sicht(jeSeite.dev),
      je_quelle: zaehle(alleZeilen, (z) => z.quelle),
    },
    quellen: {
      'haus-einstell': {
        beschreibung: 'Einstellsatz (2997 Fragen) zu den 499 Hauslektionen; Rangfolge = echter Handler offline, Leser aus',
        fragen_claude: 'Fragen stammen von Claude (laut LIZENZEN-entscheider-2026-10-11.md)',
        lizenz: 'haus-eigen', darf_offen: 'nein (Claude-Text, Hausdaten mit E-Mail und IP)',
        rangfolge: rangKennzahlen(plaetze['haus-einstell']),
        uebersprungen_ohne_lektionstext: uebersprungen['haus-einstell'],
      },
      'fremd-teil': {
        beschreibung: 'Fremdsatz, erste 4000 Paare (10 oeffentliche Projekte): Issue = Frage, gemergter PR = Lektion; Rangfolge = punktzahl() aus dem Merkmalsauszug',
        lizenz_je_projekt: FREMD_LIZENZ,
        darf_offen: 'nur freizuegige Lizenz UND kein Personenmuster; juristisch nicht abgenommen',
        rangfolge: rangKennzahlen(plaetze['fremd-teil']),
        uebersprungen_ohne_lektionstext: uebersprungen['fremd-teil'],
      },
    },
    trennung: {
      regel: 'Ganze Projektfamilien (Haus) bzw. Projekte (Fremd) gehen nach dev. Ihre Lektionen kommen im Training nie vor.',
      haus_dev_familien: [...devFamilien].sort(),
      haus_lektionen: { train: hausPool.get('train')?.length, dev: hausPool.get('dev')?.length },
      haus_fragen: { train: hausFragen.filter((f) => f.seite === 'train').length, dev: hausFragen.filter((f) => f.seite === 'dev').length },
      fremd_dev_projekte: [...devProjekte].sort(),
      fremd_fragen: { train: fremdFragen.filter((f) => f.seite === 'train').length, dev: fremdFragen.filter((f) => f.seite === 'dev').length },
      messlatte_ohne_lektion_im_training: { anzahl: ehrlich.length, von: pruefsatz.queries.length, datei: 'messlatte-ohne-lektion-im-training.json' },
      warnung: `Der Pruefsatz fragt nach denselben 499 Lektionen wie der Einstellsatz. Ueber den ganzen Pruefsatz gemessen kennt ein Modell, das auf den Haus-train-Zeilen lernt, ${hausPool.get('train')?.length} von ${hausTexte.size} Lektionstexten schon. Ehrlich ist die Teilmenge in messlatte-ohne-lektion-im-training.json oder ein Training nur auf quelle=fremd-teil.`,
    },
    ueberschneidung_mit_pruefsatz: {
      ergebnis: istUeberschneidung(bericht) ? 'UEBERSCHNEIDUNG' : 'keine',
      bericht,
      entfernte_nah_doppelte: { fragen: naheFragen.length, zeilen: entfernteZeilen, beispiele: naheFragen.slice(0, 10).map((n) => ({ art: n.art, frage: n.frage, aehnlich_zu: n.zu })) },
      gesperrte_saetze: gesperrt.jeDatei,
      nicht_vorhanden: fehlendeSperren,
      gegenprobe: probe,
      regeln: `Abbruch bei: gleiche normalisierte Frage, gleiches (Frage, Lektion)-Paar, gleiche Kennung. Entfernt werden Fragen mit Jaccard >= ${NAH_DOPPELT} auf Wortmengen (oder >= ${AEHNLICH} bei derselben Ziel-Lektion) gegen pruefsatz-3000 und pruefsatz-frisch; die frueheren Zusatzsaetze nur auf gleiche Frage/Paar/Kennung`,
    },
    lizenz_und_freigabe: {
      je_zeile: 'quelle, lizenz, erzeuger, darf_offen, offen_grund, pii',
      darf_offen_gesamt: offen(alleZeilen),
      darf_offen_je_quelle: Object.fromEntries(['haus-einstell', 'fremd-teil'].map((q) => [q, offen(alleZeilen.filter((z) => z.quelle === q))])),
      lizenz: zaehle(alleZeilen, (z) => z.lizenz),
      offen_grund: zaehle(alleZeilen, (z) => z.offen_grund),
      erzeuger: zaehle(alleZeilen, (z) => z.erzeuger),
      personenmuster_zeilen: alleZeilen.filter((z) => z.pii).length,
      hinweis: 'darf_offen = Filter der Lizenzstudie erfuellt, KEINE juristische Freigabe (offen: Anthropic D.4, MS-MARCO-Kette, Veroeffentlichung der Fremdtexte)',
    },
    laenge_frage_plus_kandidat_zeichen: laengen.length === 0 ? null : {
      median: laengen[Math.floor(laengen.length / 2)], p90: laengen[Math.floor(laengen.length * 0.9)], max: laengen[laengen.length - 1],
    },
    stichprobe_verwandt: {
      datei: 'stichprobe-verwandt-20.jsonl',
      auswahl: `20 Zeilen mit label=verwandt aus dem mittleren Drittel von train.jsonl (Zeilen ${von + 1} bis ${bis}), Saat ${o.saat}; ${nV.nHaus} Haus, ${nV.nFremd} Fremd. Dazu stichprobe-passt-nicht-hart-20.jsonl: harte Negative auf falsche Negative geprueft`,
      urteil: urteil ?? 'NICHT GEMESSEN: stichprobe-urteil.json fehlt (Handpruefung steht aus)',
    },
    giftproben: giftBericht(),
    pruefsummen: { 'train.jsonl': trainSumme, 'dev.jsonl': devSumme, 'giftproben-v1.jsonl': giftSumme },
  };
  writeFileSync(join(o.nach, 'meta.json'), JSON.stringify(meta, null, 1) + '\n', 'utf8');

  console.log(`train.jsonl ${jeSeite.train.length} Zeilen · dev.jsonl ${jeSeite.dev.length} Zeilen -> ${o.nach}`);
  console.log(`  Klassen gesamt: ${JSON.stringify(meta.zaehlung.gesamt.klassen)}`);
  console.log(`  je Quelle: ${JSON.stringify(meta.zaehlung.je_quelle)} · darf_offen ${meta.lizenz_und_freigabe.darf_offen_gesamt.anteil_ja_proz} %`);
  console.log(`  ehrliche Pruefsatz-Teilmenge: ${ehrlich.length} von ${pruefsatz.queries.length}`);
  console.log('──────────────────────────────────────────────────────────────────────');
}

// Nur beim DIREKTEN Start laufen: Tests importieren die Bausteine.
const direktGestartet = process.argv[1]?.replace(/\\/g, '/').endsWith('entscheider-trainingssatz.ts');
if (direktGestartet) {
  main().catch((e: unknown) => {
    if (e instanceof NichtGemessen) {
      console.error(`NICHT GEMESSEN: ${e.message}`);
      process.exit(2);
    }
    console.error(e);
    process.exit(1);
  });
}
