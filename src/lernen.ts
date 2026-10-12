/**
 * Lernen aus Nutzung — Kontrollgruppe, Banditen, Belohnung (Abhakliste Stufe 7).
 *
 * ── Warum es diese Datei gibt (12.10.2026) ──────────────────────────────────
 *
 * Die Einblendung (einblendung.ts) wurde bisher nur von Hand eingestellt:
 * Tor (2 Frageworte), hoechstens 3 Lektionen, Leser-Tiefe 15. Ob eine
 * Einblendung dem Agenten genuetzt hat, wurde nirgends festgehalten. Das
 * Protokoll kannte Token und Trefferzahl, aber nicht WELCHE Lektion gezeigt
 * wurde und ob der Agent sie danach aufgriff. Eine eigene Beobachtung vom
 * 11.10. ("die meisten Einblendungen daneben") liess sich deshalb nicht
 * nachmessen.
 *
 * Diese Datei legt die Maschinerie an, bevor die Daten reichen — damit sie
 * ab dem ersten Tag sammelt:
 *
 *   1. KONTROLLGRUPPE — ein fester Anteil (Vorgabe 5 %) der Prompts mit
 *      Kandidaten wird berechnet und protokolliert, aber NICHT gezeigt. Wer
 *      dazugehoert, entscheidet ein Hash aus (Instanz, Sitzung, Prompt):
 *      dieselbe Frage in derselben Sitzung faellt immer gleich.
 *   2. ARME — drei Einstellungen der Einblendung (ARME unten). Arm 0 ist
 *      genau der heutige Stand.
 *   3. BANDIT — Thompson-Ziehung aus Beta-Verteilungen, aber nur im
 *      Erkundungsanteil (hoechstens 10 %). Sonst gilt der fuehrende Arm, und
 *      das ist Arm 0, bis ein anderer ihn mit 95 % Sicherheit schlaegt und
 *      beide mindestens 30 Bewertungen haben. Arm 0 hat ein starkes Vorwissen
 *      (100 Pseudo-Beobachtungen), damit ohne Daten nichts schlechter wird.
 *   4. BELOHNUNG — siehe `bewerteZug`.
 *
 * ── Wo der Zustand liegt ────────────────────────────────────────────────────
 *
 * Jeder Hook-Lauf ist ein eigener kurzer Prozess. Die Zaehlungen je Arm
 * fuehrt der Server (Tabelle `einblendungen`, GET /api/v1/einblendung/arme,
 * ueber alle Konten, 28 Tage). Der abgekoppelte Nebenlauf, der den Bestand
 * auffrischt (hoechstens alle zehn Minuten, niemand wartet auf ihn), holt sie
 * und legt sie auf die Platte. Vor dem Prompt gibt es also KEINEN
 * zusaetzlichen Netzaufruf; der Prompt schreibt nur eine Zeile in eine lokale
 * Datei. Gemeldet wird am Ende des Zugs (Stop-Hook) oder spaeter im Nebenlauf.
 *
 * ── Was das NICHT leistet ───────────────────────────────────────────────────
 *
 *   * Die Belohnung misst Aufgreifen beim Namen, nicht Nutzen. Siehe
 *     `bewerteZug`.
 *   * Bewertet wird nur in Claude Code (Stop-Hook mit Gespraechsprotokoll).
 *     Cursor, VS Code, Codex und Gemini melden ihre Entscheidungen
 *     unbewertet.
 *   * Gemeldet wird nach bestem Bemuehen. Geht eine Meldung verloren, fehlt
 *     eine Zeile; der Hook wartet nie darauf.
 *
 * Abschalten: CACHLY_LERNEN=0 (oder CACHLY_NO_TELEMETRY=1). Dann gibt es weder
 * Kontrollgruppe noch Erkundung — ohne Meldung waere beides nur Verlust.
 *
 * Nur Node-Bordmittel — die Datei reist im Hook-Buendel ohne node_modules.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

import { letzterZug, type LetzterZug } from './schreibbeleg.js';

/** Zugang zur API — dieselbe Form wie EinblendConfig in einblendung.ts. */
export interface LernZugang {
  apiUrl: string;
  jwt: string;
  instanceId: string;
}

// ── Die Arme ─────────────────────────────────────────────────────────────────

export interface Arm {
  readonly arm: number;
  readonly name: string;
  /** Tor: so viele verschiedene Frageworte muss eine Lektion enthalten. */
  readonly minBelege: number;
  /** Hoechstens so viele Lektionen werden gezeigt. */
  readonly topK: number;
}

/**
 * Drei Einstellungen. Arm 0 ist der heutige Stand (selectRelevant: Tor 2,
 * drei Lektionen). Arm 1 und 2 sind die zwei naheliegenden Antworten auf
 * "Einblendung zu laut" (Abhakliste, Eingang 11.10.): strengeres Tor oder
 * nur die beste Lektion. Die Leser-Tiefe (15) bleibt in allen Armen gleich —
 * sie ist gemessen (PR #755), und ihr Preis ist Wartezeit, die die Belohnung
 * nicht sieht.
 */
export const ARME: readonly Arm[] = [
  { arm: 0, name: 'heute', minBelege: 2, topK: 3 },
  { arm: 1, name: 'strenger', minBelege: 3, topK: 3 },
  { arm: 2, name: 'knapper', minBelege: 2, topK: 1 },
];

/** Das niedrigste Tor aller Arme: so weit wird vor der Armwahl gefiltert. */
export const BASIS_MIN_BELEGE = Math.min(...ARME.map((a) => a.minBelege));

/** Beta-Verteilung als Pseudo-Zaehlung: a Erfolge, b Misserfolge. */
export interface Beta {
  a: number;
  b: number;
}

/**
 * Vorwissen je Arm. Arm 0: Mittel 0,20 mit Gewicht 100 — stark. Arm 1 und 2:
 * Mittel 0,18 mit Gewicht 10 — schwach und einen Hauch schlechter, damit
 * Arm 0 ohne Daten fuehrt. Die 0,20 ist eine Annahme, kein Messwert; mit
 * echten Zaehlungen verliert sie nach rund 100 bewerteten Einblendungen
 * ihr Gewicht.
 */
export const VORWISSEN: readonly Beta[] = [
  { a: 20, b: 80 },
  { a: 1.8, b: 8.2 },
  { a: 1.8, b: 8.2 },
];

/** Ein Arm loest Arm 0 erst ab, wenn er ihn mit 95 % Sicherheit schlaegt (einseitig). */
export const SICHERHEIT_Z = 1.645;

/**
 * ... und erst, wenn BEIDE mindestens so viele echte Bewertungen haben. Sonst
 * vergliche man 15 Beobachtungen mit einer Annahme (dem Vorwissen von Arm 0).
 */
export const MINDEST_BEWERTUNGEN = 30;

// ── Einstellungen ────────────────────────────────────────────────────────────

export const KONTROLLE_ANTEIL_VORGABE = 0.05;
export const KONTROLLE_ANTEIL_HOECHSTENS = 0.5;
export const ERKUNDUNG_VORGABE = 0.1;
/** Erkundung hoechstens 10 % — auch wenn die Umgebung mehr verlangt. */
export const ERKUNDUNG_HOECHSTENS = 0.1;

export interface LernEinstellungen {
  aktiv: boolean;
  kontrolleAnteil: number;
  erkundung: number;
}

/**
 * Ein Anteil aus der Umgebung. "0.05", "5 %" und "5" bedeuten dasselbe:
 * Werte ab 1 und Werte mit Prozentzeichen gelten als Prozent. Unlesbares
 * ergibt die Vorgabe, zu Grosses wird gedeckelt.
 */
export function leseAnteil(roh: string | undefined, vorgabe: number, hoechstens: number): number {
  const t = String(roh ?? '').trim();
  if (!t) return vorgabe;
  const prozent = t.endsWith('%');
  const n = Number(t.replace(/%$/, '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return vorgabe;
  const wert = prozent || n >= 1 ? n / 100 : n;
  return Math.min(wert, hoechstens);
}

export function lernEinstellungen(env: Record<string, string | undefined> = process.env): LernEinstellungen {
  const aus = ['0', 'off', 'aus', 'false'].includes(String(env.CACHLY_LERNEN ?? '').trim().toLowerCase());
  return {
    aktiv: !aus && env.CACHLY_NO_TELEMETRY !== '1',
    kontrolleAnteil: leseAnteil(env.CACHLY_KONTROLLE_ANTEIL, KONTROLLE_ANTEIL_VORGABE, KONTROLLE_ANTEIL_HOECHSTENS),
    erkundung: leseAnteil(env.CACHLY_ERKUNDUNG, ERKUNDUNG_VORGABE, ERKUNDUNG_HOECHSTENS),
  };
}

// ── Deterministischer Zufall ─────────────────────────────────────────────────

export interface Zufall {
  /** Gleichverteilt in [0, 1): Kontrollgruppe ja/nein. */
  kontrolle: number;
  /** Gleichverteilt in [0, 1), unabhaengig vom ersten: Erkundung ja/nein. */
  erkundung: number;
  /** Saat fuer die Thompson-Ziehung. */
  saat: number;
}

/** Derselbe (Instanz, Sitzung, Prompt) ergibt immer dieselben Zahlen. */
export function zufallFuer(instanceId: string, sitzung: string | null | undefined, prompt: string): Zufall {
  const promptHash = createHash('sha256').update(prompt).digest('hex');
  const h = createHash('sha256').update(`${instanceId}|${sitzung ?? ''}|${promptHash}`).digest();
  return {
    kontrolle: h.readUIntBE(0, 6) / 2 ** 48,
    erkundung: h.readUIntBE(6, 6) / 2 ** 48,
    saat: h.readUInt32BE(12),
  };
}

/** Kleiner Zufallsgenerator mit Saat (mulberry32): gleiche Saat, gleiche Folge. */
export function zufallsfolge(saat: number): () => number {
  let s = saat >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(z: () => number): number {
  const u = 1 - z(); // (0, 1]
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * z());
}

/** Gamma(form, 1) nach Marsaglia und Tsang. */
function gamma(form: number, z: () => number): number {
  if (form < 1) return gamma(form + 1, z) * Math.pow(1 - z(), 1 / form);
  const d = form - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(z);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - z();
    if (u < 1 - 0.0331 * x ** 4) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Eine Ziehung aus Beta(a, b). */
export function zieheBeta(p: Beta, z: () => number): number {
  const x = gamma(p.a, z);
  const y = gamma(p.b, z);
  return x / (x + y);
}

// ── Bandit ───────────────────────────────────────────────────────────────────

/** Bewertete Einblendungen je Arm, wie GET /api/v1/einblendung/arme sie liefert. */
export interface ArmZaehlung {
  arm: number;
  erfolge: number;
  misserfolge: number;
}

/** Vorwissen plus Zaehlung, je Arm in der Reihenfolge von ARME. */
export function posterior(zaehlung: readonly ArmZaehlung[] | null | undefined): Beta[] {
  return VORWISSEN.map((v, arm) => {
    const z = zaehlung?.find((x) => x?.arm === arm);
    const s = Math.max(0, Number(z?.erfolge) || 0);
    const f = Math.max(0, Number(z?.misserfolge) || 0);
    return { a: v.a + s, b: v.b + f };
  });
}

export function mittel(p: Beta): number {
  return p.a / (p.a + p.b);
}

function varianz(p: Beta): number {
  const n = p.a + p.b;
  return (p.a * p.b) / (n * n * (n + 1));
}

/** Echte Bewertungen eines Arms: Posterior minus Vorwissen. */
function bewertungen(post: readonly Beta[], k: number): number {
  const v = VORWISSEN[k] ?? { a: 0, b: 0 };
  return post[k].a + post[k].b - v.a - v.b;
}

/**
 * Der Arm, der gilt, wenn nicht erkundet wird. Arm 0, bis ein anderer ihn mit
 * 95 % Sicherheit schlaegt (Normalnaeherung der Differenz zweier Betas) und
 * beide mindestens MINDEST_BEWERTUNGEN echte Bewertungen haben; unter
 * mehreren solchen der mit dem hoechsten Mittel. Glueckstreffer kippen ihn
 * nicht — das Vorwissen von Arm 0 wiegt 100 Beobachtungen.
 */
export function fuehrenderArm(post: readonly Beta[]): number {
  if (bewertungen(post, 0) < MINDEST_BEWERTUNGEN) return 0;
  let fuehrend = 0;
  for (let k = 1; k < post.length; k++) {
    if (bewertungen(post, k) < MINDEST_BEWERTUNGEN) continue;
    const z = (mittel(post[k]) - mittel(post[0])) / Math.sqrt(varianz(post[k]) + varianz(post[0]));
    if (z >= SICHERHEIT_Z && mittel(post[k]) > mittel(post[fuehrend])) fuehrend = k;
  }
  return fuehrend;
}

/**
 * Thompson-Ziehung mit Erkundungsdeckel. Nur wenn `zufall.erkundung` unter
 * `erkundung` liegt (hoechstens 10 % der Prompts), zieht jeder Arm aus seiner
 * Beta-Verteilung und der hoechste gewinnt. Sonst gilt der fuehrende Arm.
 * `erkundet` heisst: ein anderer als der fuehrende Arm wurde gewaehlt.
 */
export function waehleArm(post: readonly Beta[], zufall: Zufall, erkundung: number): { arm: number; erkundet: boolean } {
  const fuehrend = fuehrenderArm(post);
  if (!(zufall.erkundung < Math.min(erkundung, ERKUNDUNG_HOECHSTENS))) return { arm: fuehrend, erkundet: false };
  const z = zufallsfolge(zufall.saat);
  let bester = fuehrend;
  let besterWert = -1;
  post.forEach((p, k) => {
    const w = zieheBeta(p, z);
    if (w > besterWert) {
      besterWert = w;
      bester = k;
    }
  });
  return { arm: bester, erkundet: bester !== fuehrend };
}

export function istKontrolle(u: number, anteil: number): boolean {
  return anteil > 0 && u < anteil;
}

export interface Entscheidung {
  /** false: Lernen aus (Umgebung) — Arm 0, keine Kontrollgruppe, nichts gemerkt. */
  aktiv: boolean;
  /** true: berechnet und gemerkt, aber NICHT gezeigt. */
  kontrolle: boolean;
  arm: number;
  erkundet: boolean;
}

export const OHNE_LERNEN: Entscheidung = { aktiv: false, kontrolle: false, arm: 0, erkundet: false };

/**
 * Die Entscheidung fuer einen Prompt: Kontrollgruppe? Welcher Arm?
 * Die Kontrollgruppe bekommt Arm 0 — sie misst die Wirkung des heutigen Stands.
 */
export function entscheide(e: {
  instanceId: string;
  sitzung: string | null | undefined;
  prompt: string;
  zaehlung?: readonly ArmZaehlung[] | null;
  einstellungen?: LernEinstellungen;
}): Entscheidung {
  const ein = e.einstellungen ?? lernEinstellungen();
  if (!ein.aktiv) return OHNE_LERNEN;
  const zufall = zufallFuer(e.instanceId, e.sitzung, e.prompt);
  if (istKontrolle(zufall.kontrolle, ein.kontrolleAnteil)) return { aktiv: true, kontrolle: true, arm: 0, erkundet: false };
  const { arm, erkundet } = waehleArm(posterior(e.zaehlung), zufall, ein.erkundung);
  return { aktiv: true, kontrolle: false, arm, erkundet };
}

// ── Belohnung ────────────────────────────────────────────────────────────────

/** Ein Kandidat der Einblendung, wie er lokal gemerkt wird (Thema im Klartext). */
export interface Kandidat {
  thema: string;
  /** Platz nach Sortierung und Leser, ab 0. */
  rang: number;
  /** Hauspunkte (nur innerhalb des Aufrufs vergleichbar). */
  punkte: number;
  belege: number;
  /** Punkt des Lesers, wenn er geantwortet hat. */
  leser: number | null;
  /** Vom Arm ausgewaehlt (gezeigt, ausser in der Kontrollgruppe). */
  gezeigt: boolean;
}

/**
 * Taugt ein Thema als Erkennungszeichen? Es muss lang genug sein und einen
 * Trenner tragen (`deploy:api`, `node4-zugang`). Ein Thema wie "docker"
 * stuende in jeder zweiten Antwort und zaehlte jedes Mal als aufgegriffen.
 */
export function zaehlbaresThema(thema: string): boolean {
  const t = thema.trim();
  return t.length >= 6 && /[:/_.-]/.test(t);
}

export interface Bewertung {
  /** 1 = aufgegriffen, 0 = nicht, -1 = nicht bewertbar (kein zaehlbares Thema). */
  belohnung: -1 | 0 | 1;
  /** Bitmaske ueber die Kandidaten: Bit i = Kandidat i wurde aufgegriffen. */
  benutzt: number;
}

/**
 * Die Belohnung einer Einblendung.
 *
 * MISST: Hat der Agent im selben Zug (bis zum Stop) eine der ausgewaehlten
 * Lektionen beim Namen genannt — im Antworttext oder in der Eingabe eines
 * Werkzeugaufrufs, z. B. recall_best_solution(topic="…")? Dann 1, sonst 0.
 * In der Kontrollgruppe gilt dieselbe Regel fuer die Lektionen, die gezeigt
 * WORDEN WAEREN: Der Vergleich beider Quoten ist die Wirkung des Zeigens.
 *
 * MISST NICHT: ob die Lektion richtig war, ob sie einen Fehler verhindert
 * hat, oder stilles Nutzen ohne Namen. Werkzeug-Ergebnisse zaehlen nicht —
 * eine Lektion, die nur in einer Suchantwort steht, wurde nicht aufgegriffen.
 * Themen ohne Trenner zaehlen nicht (`zaehlbaresThema`); hat keine
 * ausgewaehlte Lektion ein zaehlbares Thema, ist die Einblendung -1.
 */
export function bewerteZug(zug: Pick<LetzterZug, 'antwortText' | 'werkzeugEingaben'>, kandidaten: readonly Kandidat[]): Bewertung {
  const text = `${zug.antwortText}\n${zug.werkzeugEingaben}`.toLowerCase();
  let benutzt = 0;
  kandidaten.forEach((k, i) => {
    if (zaehlbaresThema(k.thema) && text.includes(k.thema.trim().toLowerCase())) benutzt |= 1 << i;
  });
  const ausgewaehlt = kandidaten.map((k, i) => ({ k, i })).filter(({ k }) => k.gezeigt && zaehlbaresThema(k.thema));
  if (!ausgewaehlt.length) return { belohnung: -1, benutzt };
  return { belohnung: ausgewaehlt.some(({ i }) => benutzt & (1 << i)) ? 1 : 0, benutzt };
}

// ── Lokal merken, spaeter melden ─────────────────────────────────────────────

/** Eine Entscheidung, wie sie lokal liegt (bis sie gemeldet ist). */
export interface Entscheidungssatz {
  id: string;
  ts: string;
  /** Kennung der Sitzung als Hash. */
  sitzung: string;
  /**
   * Hash der ersten 200 Zeichen des Prompts. Der Stop-Hook bewertet nur, wenn
   * der Zug im Protokoll mit genau diesem Prompt begann — sonst gehoerte er zu
   * einer anderen Frage.
   */
  zug: string;
  ereignis: string;
  editor: string;
  arm: number;
  kontrolle: boolean;
  erkundet: boolean;
  /** So viele Lektionen hat der Arm ausgewaehlt. Gezeigt nur ohne Kontrolle. */
  ausgewaehlt: number;
  /** So viele Kandidaten passierten das niedrigste Tor. */
  kandidatenZahl: number;
  belege: number;
  topScore: number;
  leser: string;
  leserMs: number;
  quelle: string;
  bestand: number;
  kandidaten: Kandidat[];
  belohnung: -1 | 0 | 1;
  benutzt: number;
}

/** So viele Kandidaten je Entscheidung werden gemerkt (plus jeder ausgewaehlte). */
export const MERKMAL_KANDIDATEN = 5;
/** Hoechstens so viele Entscheidungen je Sitzungsdatei und Meldung. */
export const SAETZE_HOECHSTENS = 50;
/** Eine Sitzungsdatei, die so lange ruht, meldet der Nebenlauf (unbewertet). */
export const RUHE_MS = 30 * 60 * 1000;
/** Aelteres wird ungemeldet geloescht. */
export const VERFALL_MS = 7 * 24 * 60 * 60 * 1000;
/** Zaehlungen je Arm, die aelter sind, gelten nicht mehr. */
export const ARME_VERFALL_MS = 7 * 24 * 60 * 60 * 1000;
/** Zeitdeckel je Meldung. */
export const MELDE_ZEITLIMIT_MS = 3000;

function kurz(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

/** Erkennungszeichen eines Zugs: Hash der ersten 200 Zeichen, Leerraum zusammengezogen. */
export function zugKennung(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim().slice(0, 200)).digest('hex').slice(0, 16);
}

export function lernOrdner(): string {
  return join(tmpdir(), 'cachly-lernen');
}

/** Eine Datei je (Instanz, Sitzung): Prompt und Stop derselben Sitzung laufen nacheinander. */
export function offenPfad(instanceId: string, sitzung: string | null | undefined): string {
  return join(lernOrdner(), `${kurz(instanceId)}-${kurz(sitzung ?? 'ohne')}.jsonl`);
}

export function armePfad(instanceId: string): string {
  return join(tmpdir(), `cachly-lernen-arme-${kurz(instanceId)}.json`);
}

export function sitzungsKennung(sitzung: string | null | undefined): string {
  return kurz(sitzung ?? 'ohne');
}

/** Ein neuer Satz mit frischer Kennung. */
export function neuerSatz(felder: Omit<Entscheidungssatz, 'id' | 'ts' | 'belohnung' | 'benutzt'>): Entscheidungssatz {
  return { id: randomUUID(), ts: new Date().toISOString(), belohnung: -1, benutzt: 0, ...felder };
}

/** Haengt eine Entscheidung an die Sitzungsdatei. Wirft nie. */
export function merkeEntscheidung(instanceId: string, sitzung: string | null | undefined, satz: Entscheidungssatz): void {
  try {
    mkdirSync(lernOrdner(), { recursive: true });
    appendFileSync(offenPfad(instanceId, sitzung), JSON.stringify(satz) + '\n', { mode: 0o600 });
  } catch {
    // Lernen ist Beiwerk — nie den Zug aufhalten
  }
}

function leseSaetze(pfad: string): Entscheidungssatz[] {
  try {
    return readFileSync(pfad, 'utf8')
      .split('\n')
      .filter((z) => z.trim())
      .map((z) => {
        try {
          return JSON.parse(z) as Entscheidungssatz;
        } catch {
          return null;
        }
      })
      .filter((s): s is Entscheidungssatz => !!s && typeof s.id === 'string' && Array.isArray(s.kandidaten))
      .slice(-SAETZE_HOECHSTENS);
  } catch {
    return [];
  }
}

/**
 * Was der Server bekommt: KEIN Thema im Klartext, KEIN Prompt. Themen werden
 * je Instanz gehasht — innerhalb einer Instanz bleiben sie wiedererkennbar
 * (fuer Abfolgen und Rangfolge-Training), ueber Instanzen hinweg nicht.
 */
export function fuerServer(instanceId: string, s: Entscheidungssatz): Record<string, unknown> {
  return {
    id: s.id,
    ts: s.ts,
    sitzung: s.sitzung,
    ereignis: s.ereignis,
    editor: s.editor,
    arm: s.arm,
    kontrolle: s.kontrolle,
    erkundet: s.erkundet,
    ausgewaehlt: s.ausgewaehlt,
    kandidaten_zahl: s.kandidatenZahl,
    belege: s.belege,
    top_score: s.topScore,
    leser: s.leser,
    leser_ms: s.leserMs,
    quelle: s.quelle,
    bestand: s.bestand,
    belohnung: s.belohnung,
    benutzt: s.benutzt,
    merkmale: s.kandidaten.map((k) => ({
      t: kurz(`${instanceId}|${k.thema}`),
      r: k.rang,
      p: k.punkte,
      b: k.belege,
      l: k.leser,
      g: k.gezeigt,
    })),
  };
}

async function sende(
  cfg: LernZugang,
  saetze: Entscheidungssatz[],
  fetchFn: typeof fetch,
  zeitlimitMs: number,
): Promise<boolean> {
  if (!saetze.length) return true;
  try {
    const r = await fetchFn(`${cfg.apiUrl}/api/v1/instances/${cfg.instanceId}/einblendungen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.jwt}` },
      body: JSON.stringify({ entscheidungen: saetze.map((s) => fuerServer(cfg.instanceId, s)) }),
      signal: AbortSignal.timeout(zeitlimitMs),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export interface MeldeOptionen {
  fetchFn?: typeof fetch;
  zeitlimitMs?: number;
  einstellungen?: LernEinstellungen;
}

/**
 * Stop-Hook: bewertet die Entscheidung dieses Zugs und meldet alles, was die
 * Sitzung gemerkt hat. Rueckgabe: die Bewertung, oder null (nichts zu tun,
 * Zug passt zu keiner Entscheidung). Wirft nie.
 *
 * Bewertet wird nur die neueste unbewertete Entscheidung, und nur, wenn der
 * Zug im Protokoll mit ihrem Prompt beginnt (`zugKennung`). Aeltere
 * unbewertete — abgebrochene Zuege — gehen unbewertet mit.
 */
export async function belohnungMelden(
  cfg: LernZugang,
  sitzung: string | null | undefined,
  zeilen: string[] | null,
  { fetchFn = fetch, zeitlimitMs = MELDE_ZEITLIMIT_MS, einstellungen }: MeldeOptionen = {},
): Promise<Bewertung | null> {
  try {
    const ein = einstellungen ?? lernEinstellungen();
    if (!ein.aktiv || !cfg?.jwt || !cfg?.instanceId) return null;
    const pfad = offenPfad(cfg.instanceId, sitzung);
    const saetze = leseSaetze(pfad);
    if (!saetze.length) return null;

    let bewertung: Bewertung | null = null;
    if (zeilen) {
      const zug = letzterZug(zeilen);
      const kennung = zugKennung(zug.frage);
      const offen = [...saetze].reverse().find((s) => s.belohnung === -1 && s.zug === kennung);
      if (offen) {
        bewertung = bewerteZug(zug, offen.kandidaten);
        offen.belohnung = bewertung.belohnung;
        offen.benutzt = bewertung.benutzt;
      }
    }

    if (await sende(cfg, saetze, fetchFn, zeitlimitMs)) {
      rmSync(pfad, { force: true });
    } else {
      // Bewertung behalten; der Nebenlauf meldet die Datei, sobald sie ruht.
      writeFileSync(pfad, saetze.map((s) => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
    }
    return bewertung;
  } catch {
    return null;
  }
}

/**
 * Nebenlauf: meldet ruhende Sitzungsdateien dieser Instanz (unbewertet, wenn
 * kein Stop kam — Cursor, VS Code, Codex, Gemini, abgebrochene Zuege) und
 * loescht Verfallenes. Hoechstens 20 Dateien je Lauf.
 */
async function meldeRuhende(cfg: LernZugang, fetchFn: typeof fetch, zeitlimitMs: number, jetzt: number): Promise<void> {
  let namen: string[];
  try {
    namen = readdirSync(lernOrdner());
  } catch {
    return;
  }
  const praefix = `${kurz(cfg.instanceId)}-`;
  const ruhend: string[] = [];
  for (const name of namen) {
    const pfad = join(lernOrdner(), name);
    try {
      const alter = jetzt - statSync(pfad).mtimeMs;
      if (alter > VERFALL_MS) rmSync(pfad, { force: true });
      else if (name.startsWith(praefix) && alter >= RUHE_MS && ruhend.length < 20) ruhend.push(pfad);
    } catch {
      // eine Datei, die nicht will, haelt die anderen nicht auf
    }
  }
  // Gleichzeitig: der ganze Lauf dauert hoechstens ein Zeitlimit, nicht zwanzig.
  await Promise.all(
    ruhend.map(async (pfad) => {
      if (await sende(cfg, leseSaetze(pfad), fetchFn, zeitlimitMs)) rmSync(pfad, { force: true });
    }),
  );
}

/** Holt die Zaehlungen je Arm und legt sie auf die Platte. */
async function holeArme(cfg: LernZugang, fetchFn: typeof fetch, zeitlimitMs: number): Promise<void> {
  try {
    const r = await fetchFn(`${cfg.apiUrl}/api/v1/einblendung/arme`, {
      headers: { Authorization: `Bearer ${cfg.jwt}` },
      signal: AbortSignal.timeout(zeitlimitMs),
    });
    if (!r.ok) return;
    const j = (await r.json()) as { arme?: unknown };
    if (!Array.isArray(j?.arme)) return;
    const arme = (j.arme as ArmZaehlung[])
      .filter((a) => a && Number.isInteger(a.arm))
      .map((a) => ({ arm: a.arm, erfolge: Number(a.erfolge) || 0, misserfolge: Number(a.misserfolge) || 0 }));
    writeFileSync(armePfad(cfg.instanceId), JSON.stringify({ at: Date.now(), arme }), { mode: 0o600 });
  } catch {
    // ohne Zaehlung gilt das Vorwissen — also Arm 0
  }
}

/** Die Zaehlungen je Arm von der Platte, oder null (fehlt, kaputt, verfallen). */
export function leseArmZaehlung(instanceId: string, jetzt = Date.now()): ArmZaehlung[] | null {
  try {
    const c = JSON.parse(readFileSync(armePfad(instanceId), 'utf8')) as { at?: number; arme?: ArmZaehlung[] };
    if (!Array.isArray(c?.arme) || jetzt - Number(c.at) > ARME_VERFALL_MS) return null;
    return c.arme;
  } catch {
    return null;
  }
}

/**
 * Laeuft im Nebenlauf, der den Bestand auffrischt (holeBestand mit
 * `lernen: true`): Zaehlungen je Arm holen, ruhende Entscheidungen melden.
 * NICHT beim SessionStart — dort wartet der Mensch aufs Briefing. Wirft nie.
 */
export async function lernenAuffrischen(
  cfg: LernZugang,
  { fetchFn = fetch, zeitlimitMs = MELDE_ZEITLIMIT_MS, einstellungen, jetzt = Date.now() }: MeldeOptionen & { jetzt?: number } = {},
): Promise<void> {
  try {
    const ein = einstellungen ?? lernEinstellungen();
    if (!ein.aktiv || !cfg?.jwt || !cfg?.instanceId) return;
    await Promise.all([holeArme(cfg, fetchFn, zeitlimitMs), meldeRuhende(cfg, fetchFn, zeitlimitMs, jetzt)]);
  } catch {
    // bestes Bemuehen
  }
}
