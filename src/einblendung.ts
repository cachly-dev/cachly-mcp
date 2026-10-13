/**
 * Die automatische Einblendung — EIN Kern fuer beide Hook-Wege.
 *
 * ── Warum es diese Datei gibt (08.10.2026) ──────────────────────────────────
 *
 * Bis heute gab es zwei Einblendungen:
 *
 *   Weg 1 (unsere Repo-Fassung, tools/ambient-recall/*.mjs): ganzer Bestand
 *     ungekuerzt von `/export`, auf der Platte vorgehalten, lokal sortiert
 *     (PR #661), die Spitze vom Leser nachgemischt (PR #672), gerahmt (#691).
 *   Weg 2 (was Kunden per `init`/`autopilot` bekommen): der Hook ruft
 *     `cachly ambient-recall`, das rief `smart_recall` mit einem Zeitdeckel
 *     von 3 Sekunden.
 *
 * Gemessen am 08.10.2026 mit 10 echten Fachfragen gegen den Echtbestand:
 * Weg 2 blendete 0 von 10 ein — jede Frage endete genau am 3-s-Deckel
 * (3004 bis 3018 ms). Kunden bekamen also nichts, waehrend wir selbst
 * Weg 1 benutzten. Zwei Wege mit einer Zahl ist der Fehler vom 20.08.2026.
 *
 * Jetzt steht die ganze Logik von Weg 1 HIER. `cachly ambient-recall` ruft
 * sie direkt; tools/ambient-recall/ bekommt sie als gebuendelte Datei
 * (`einblendung-kern.gen.mjs`, erzeugt von scripts/einblendung-kern-buendeln.mjs,
 * bewacht von __tests__/einblendung-kern-abgleich.test.ts) und ist nur noch
 * eine duenne Huelle.
 *
 * ── Was das kostet ──────────────────────────────────────────────────────────
 *
 *   * Je Prompt kein Netzaufruf fuer den Bestand: er liegt auf der Platte.
 *     Ist er aelter als BESTAND_TTL_MS, frischt ein abgekoppelter Nebenlauf
 *     ihn auf; der laufende Prompt wartet nie darauf.
 *   * Ein Netzaufruf je Prompt fuer den Leser, hoechstens LESER_HOOK_ZEITLIMIT_MS.
 *     Antwortet er nicht, bleibt die lokale Ordnung — Rueckfall statt nichts.
 *     Faellt er 3-mal in Folge aus, fragt der Hook ihn 10 Minuten nicht
 *     (Leser-Sicherung, leser-sicherung.ts; Zustand in sicherungsPfad).
 *   * Pro Lektion ANZEIGE_ZEICHEN Zeichen, hoechstens drei Lektionen, 600 Token.
 *
 * Node 18+ (natives fetch/fs). Nur Node-Bordmittel — die gebuendelte Datei
 * laeuft ohne node_modules.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { Einblendbestand, torWoerter, type EinblendLektion } from './einblendung-kern.js';
import { rahmeEin } from './einblendung-rahmen.js';
import { istMarkiert } from './verdacht-marke.js';
import { leserText as leserTextZuschnitt } from './seltenheitsbestand.js';
import { mischeMitLeser } from './leser.js';
import { LeserSicherung, dateiSpeicher, frageLeser, type LeserAntwort } from './leser-sicherung.js';
import { LESER_TIEFE_EINBLENDUNG, LESER_ZEITLIMIT_MS } from './rangfolge-stellschrauben.js';
// Gueltigkeit nach Version (Abhakliste 4.5): Logik und Begruendung in der Datei selbst.
import { stufeEinblendungNachVersion } from './gueltigkeit-version.js';
import {
  ARME,
  BASIS_MIN_BELEGE,
  MERKMAL_KANDIDATEN,
  OHNE_LERNEN,
  entscheide,
  leseArmZaehlung,
  lernEinstellungen,
  lernenAuffrischen,
  merkeEntscheidung,
  neuerSatz,
  sitzungsKennung,
  zugKennung,
  type Entscheidung,
  type Kandidat,
} from './lernen.js';

// Alles, was der abhaengigkeitsfreie Hook braucht, reist ueber diese Datei.
export * from './einblendung-kern.js';
export { mischeMitLeser };
export { belohnungMelden, lernenAuffrischen, lernEinstellungen, ARME } from './lernen.js';

/** Zugangsdaten der Einblendung. */
export interface EinblendConfig {
  apiUrl: string;
  jwt: string;
  instanceId: string;
}

/**
 * Wie lange der vorgehaltene Bestand als frisch gilt.
 *
 * Zehn Minuten sind ein Kompromiss, kein Messwert: `/export` liest den ganzen
 * Bestand (gemessen gegen den Echtbestand: 760 Lektionen, 1,6 MB, 0,9 s), das
 * soll nicht im Minutentakt laufen.
 */
export const BESTAND_TTL_MS = 10 * 60 * 1000;

/**
 * Junges Brain (12.10.2026): so lange nach dem ersten Bestand gilt ein Brain
 * als im Aufbau. Probe mit dem echten Plugin an einer frischen Installation:
 * Der erste Treffer speicherte 9 von spaeter 21 Lektionen, weil der Start-
 * Import (startwissen.ts) 25 s bis 200 s braucht — und der Bestand blieb
 * zehn Minuten stehen. Ein Brain im Aufbau wird deshalb oefter und ohne
 * Verzoegerung neu geholt.
 */
export const JUNG_FENSTER_MS = 5 * 60 * 1000;
/** Im Aufbau gilt der Bestand nur so lange als frisch. */
export const BESTAND_TTL_JUNG_MS = 10 * 1000;
/** Zeitdeckel fuer das Neuholen im Aufbau: der Prompt wartet hoechstens so lange. */
export const JUNG_ABRUF_MS = 2000;
/** Ein Brain mit weniger Lektionen ist klein: sein Neuholen kostet fast nichts (ein Export von 50 Lektionen ist rund 100 KB). */
export const KLEIN_LEKTIONEN = 50;
/** Ein kleines Brain ausserhalb des Aufbaus: halbe Minute statt zehn. */
export const BESTAND_TTL_KLEIN_MS = 60 * 1000;

/** Wie lange der Bestand auf der Platte als frisch gilt — und ob ein Veralteter sofort neu geholt wird. */
export interface BestandFrist {
  ttlMs: number;
  /** true: der Prompt holt neu und wartet (hoechstens JUNG_ABRUF_MS). false: alter Stand, Auffrischen im Nebenlauf. */
  sofort: boolean;
}

/**
 * Die Frist fuer einen Bestand, nach Alter des Brains und Zahl der Lektionen.
 *
 *   Aufbau  (erster Bestand juenger als 5 min)  10 s, der Prompt holt neu
 *   klein   (weniger als 50 Lektionen)          60 s, Nebenlauf
 *   sonst                                       10 min, Nebenlauf (wie bisher)
 *
 * `seitMs` ist das Alter des ERSTEN Bestands dieser Instanz auf der Platte.
 */
export function bestandFrist(anzahl: number, seitMs: number): BestandFrist {
  if (seitMs < JUNG_FENSTER_MS) return { ttlMs: BESTAND_TTL_JUNG_MS, sofort: true };
  if (anzahl < KLEIN_LEKTIONEN) return { ttlMs: BESTAND_TTL_KLEIN_MS, sofort: false };
  return { ttlMs: BESTAND_TTL_MS, sofort: false };
}

/** Obergrenze fuer den Abruf, damit ein langsamer Server nie einen Zug aufhaelt. */
export const ABRUF_TIMEOUT_MS = 8000;
/** Fruehestens so oft darf ein Nebenlauf starten — gegen einen Prozess-Schwarm bei Dauerfehler. */
const NEBENLAUF_SPERRE_MS = 60 * 1000;
/**
 * Wie viel Text je Lektion eingeblendet wird. 120 Zeichen — der entscheidende
 * Satz einer Lektion soll nach Hausregel in den ersten 100 Zeichen von
 * `what_worked` stehen. Wer die Zahl hebt, hebt die Token je Prompt.
 */
export const ANZEIGE_ZEICHEN = 120;

/**
 * Die besten so vielen Kandidaten liest der Leser im Hook: 10, nicht die 25
 * von smart_recall. Bei 25 kam der Leser unter Bau-Last nur in 31,6 % der
 * Prompts binnen 2,5 s, bei 10 in 90,9 % (Zahlen an LESER_TIEFE_EINBLENDUNG
 * in rangfolge-stellschrauben.ts).
 */
export const LESER_TIEFE = LESER_TIEFE_EINBLENDUNG;
/** So viel Text je Kandidat bekommt der Leser (Zuschnitt des Trainings). */
export const LESER_MAX_ZEICHEN = 1500;
/**
 * Zeitlimit des Lesers im Hook — dieselbe Zahl wie im Produkt.
 *
 * Bis zum 08.10.2026 stand hier 1500 ms. Gemessen an dem Tag: der Hausleser
 * braucht fuer 25 Texte 1650 bis 1856 ms auf dem Server (2488/1741/1880 ms beim
 * Client). Mit 1500 ms lief er im Netz-Protokoll unserer eigenen Sitzungen bei
 * 4 von 72 Prompts — die Einblendung war faktisch ohne Leser. Antwortet er
 * auch in 2500 ms nicht, bleibt wie bisher die lokale Ordnung.
 */
export const LESER_HOOK_ZEITLIMIT_MS = LESER_ZEITLIMIT_MS;

/** Wohin das Netz-Protokoll je Prompt geht ("wurde etwas eingeblendet, und warum nicht"). */
export const NETZ_PROTOKOLL = join(tmpdir(), 'cachly-ambient-netlog.jsonl');

// ── Zugangsdaten: erst Umgebung, dann die naechste .mcp.json nach oben ───────
export function resolveConfig(startDir: string = process.cwd()): EinblendConfig {
  const cfg: EinblendConfig = {
    apiUrl: process.env.CACHLY_API_URL || 'https://api.cachly.dev',
    jwt: process.env.CACHLY_JWT || '',
    instanceId: process.env.CACHLY_BRAIN_INSTANCE_ID || '',
  };
  if (cfg.jwt && cfg.instanceId) return cfg;

  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const p = join(dir, '.mcp.json');
    if (existsSync(p)) {
      try {
        const env = JSON.parse(readFileSync(p, 'utf8'))?.mcpServers?.cachly?.env ?? {};
        cfg.apiUrl = cfg.apiUrl || env.CACHLY_API_URL || 'https://api.cachly.dev';
        cfg.jwt = cfg.jwt || env.CACHLY_JWT || '';
        cfg.instanceId = cfg.instanceId || env.CACHLY_BRAIN_INSTANCE_ID || '';
        if (cfg.jwt && cfg.instanceId) return cfg;
      } catch { /* eine kaputte .mcp.json ist kein Grund, den Zug aufzuhalten */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cfg;
}

function kurzHash(instanceId: string): string {
  return createHash('sha1').update(instanceId).digest('hex').slice(0, 12);
}

/** Wo der Bestand einer Instanz auf der Platte liegt. Beide Wege teilen ihn. */
export function bestandPfad(instanceId: string): string {
  return join(tmpdir(), `cachly-ambient-bestand-${kurzHash(instanceId)}.json`);
}

/**
 * Wo die Leser-Sicherung einer Instanz ihren Zustand haelt. Jeder Prompt ist
 * ein eigener Prozess — ohne Datei wuesste der naechste nichts vom letzten.
 */
export function sicherungsPfad(instanceId: string): string {
  return join(tmpdir(), `cachly-leser-sicherung-${kurzHash(instanceId)}.json`);
}

/** Je Zweck eine Sperre: der Start-Import haelt das Auffrischen nicht auf. */
function sperrPfad(instanceId: string, zweck = 'ambient-auffrischen'): string {
  return join(tmpdir(), `cachly-${zweck}-${kurzHash(instanceId)}.lock`);
}

/**
 * Den ganzen Bestand vom Server holen — ungekuerzt.
 *
 * `/export` und nicht `/recall`: /recall ist die Zusammenfassung fuers
 * Dashboard (oberste 50, what_worked auf 120 Zeichen, what_failed und context
 * fehlen). Genau diese Kuerzung war der Grund, warum die Einblendung nicht
 * richtig sortieren KONNTE (api/internal/handler/export_handler.go).
 *
 * Rueckgabe: Array der Lektionen, oder null bei jedem Fehler.
 */
async function holeVomServer(
  cfg: EinblendConfig,
  { fetchFn = fetch, zeitlimitMs = ABRUF_TIMEOUT_MS }: { fetchFn?: typeof fetch; zeitlimitMs?: number } = {},
): Promise<EinblendLektion[] | null> {
  try {
    const res = await fetchFn(`${cfg.apiUrl}/api/v1/instances/${cfg.instanceId}/export`, {
      headers: { Authorization: `Bearer ${cfg.jwt}` },
      signal: AbortSignal.timeout(zeitlimitMs),
    });
    if (!res.ok) return null;
    const j = await res.json() as { lessons?: unknown };
    if (!Array.isArray(j?.lessons)) return null;
    // Der Export reicht die gespeicherten Werte roh durch: als Objekt ODER als
    // JSON-Zeichenkette. Beides annehmen.
    return (j.lessons as unknown[])
      .map((l) => (typeof l === 'string' ? sicherParsen(l) : l))
      .filter((l): l is EinblendLektion => !!l && typeof l === 'object');
  } catch {
    return null;
  }
}

function sicherParsen(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * `seit` ist der Zeitpunkt des ERSTEN Bestands dieser Instanz und bleibt bei
 * jedem Neuschreiben stehen. Alte Dateien ohne das Feld gelten als `at`.
 */
function schreibeBestand(pfad: string, lektionen: EinblendLektion[]): void {
  try {
    const jetzt = Date.now();
    const seit = leseBestand(pfad)?.seit ?? jetzt;
    mkdirSync(dirname(pfad), { recursive: true });
    writeFileSync(pfad, JSON.stringify({ at: jetzt, seit, lessons: lektionen }), { mode: 0o600 });
  } catch { /* der Zwischenspeicher ist bestes Bemuehen, kein Muss */ }
}

function leseBestand(pfad: string): { at: number; seit: number; lessons: EinblendLektion[] } | null {
  try {
    const c = JSON.parse(readFileSync(pfad, 'utf8'));
    if (Array.isArray(c?.lessons)) {
      const at = Number(c.at) || 0;
      return { at, seit: Number(c.seit) || at, lessons: c.lessons };
    }
  } catch { /* kaputte Datei = kein Bestand */ }
  return null;
}

/**
 * Einen abgekoppelten Nebenlauf starten, der den Bestand auffrischt.
 *
 * `befehl` sind die Argumente fuer `node` — der Weg, auf dem der Nebenlauf
 * dieselbe Funktion mit `force` ruft. Die Repo-Fassung gibt ihr
 * bestand-auffrischen.mjs, die CLI sich selbst mit `ambient-auffrischen`.
 *
 * Die Sperrdatei verhindert einen Prozess-Schwarm, wenn der Server dauerhaft
 * nicht antwortet: hoechstens ein Nebenlauf je NEBENLAUF_SPERRE_MS und Zweck.
 * Der Start-Import (startwissen-hook.ts) nutzt dieselbe Funktion mit eigenem
 * Zweck und `ordner`: er laeuft nicht im Projektordner, denn unter Windows
 * sperrt ein Prozess sein Arbeitsverzeichnis gegen Loeschen und Umbenennen.
 * true = der Nebenlauf ist gestartet.
 */
export function starteNebenlauf(
  cfg: EinblendConfig,
  befehl: string[],
  { zweck, ordner }: { zweck?: string; ordner?: string } = {},
): boolean {
  const sperre = sperrPfad(cfg.instanceId, zweck);
  try {
    if (existsSync(sperre) && Date.now() - statSync(sperre).mtimeMs < NEBENLAUF_SPERRE_MS) return false;
    writeFileSync(sperre, String(Date.now()), { mode: 0o600 });
  } catch { return false; }

  try {
    const kind = spawn(process.execPath, befehl, {
      detached: true,
      stdio: 'ignore',
      ...(ordner ? { cwd: ordner } : {}),
      env: {
        ...process.env,
        CACHLY_API_URL: cfg.apiUrl,
        CACHLY_JWT: cfg.jwt,
        CACHLY_BRAIN_INSTANCE_ID: cfg.instanceId,
      },
    });
    kind.unref();
    return true;
  } catch {
    // kein Nebenlauf ist kein Fehler: der naechste Prompt versucht es erneut
    return false;
  }
}

export type BestandQuelle = 'nicht-eingerichtet' | 'server' | 'platte' | 'platte-alt' | 'server-nicht-erreichbar';

export interface HoleBestandOptionen {
  /** SessionStart und Nebenlauf: immer frisch holen (Rueckfall: alter Stand auf der Platte). */
  force?: boolean;
  /** Argumente fuer `node`, die den Nebenlauf starten. Fehlt es, wird nicht im Hintergrund aufgefrischt. */
  nebenlauf?: string[];
  /** Zeitdeckel fuer den Abruf, wenn wirklich gewartet werden muss. */
  abrufMs?: number;
  /**
   * Nur der Nebenlauf: mit dem frischen Abruf die Zaehlungen je Arm holen und
   * ruhende Entscheidungen melden (lernen.ts). Nicht beim SessionStart — dort
   * wartet der Mensch aufs Briefing.
   */
  lernen?: boolean;
  /** Nur fuer Tests. */
  fetchFn?: typeof fetch;
}

/**
 * Der vorgehaltene Bestand.
 *
 *   force         -> frisch holen; scheitert das, der alte Stand von der Platte
 *   frisch genug  -> Platte, 0 ms
 *   zu alt        -> Platte SOFORT, Auffrischen im Nebenlauf
 *   gar nichts da -> einmal warten und holen
 *
 * `quelle` benennt, WOHER der Bestand kam — sonst wird Stille als gruen gebucht.
 */
export async function holeBestand(
  cfg: EinblendConfig,
  { force = false, nebenlauf, abrufMs = ABRUF_TIMEOUT_MS, lernen = false, fetchFn }: HoleBestandOptionen = {},
): Promise<{ lessons: EinblendLektion[]; quelle: BestandQuelle }> {
  if (!cfg.jwt || !cfg.instanceId) return { lessons: [], quelle: 'nicht-eingerichtet' };
  const pfad = bestandPfad(cfg.instanceId);

  if (force) {
    // Im Nebenlauf zusaetzlich: Zaehlungen je Arm holen, ruhende Entscheidungen
    // melden (lernen.ts) — parallel, eigener Zeitdeckel, scheitert still.
    const [frisch] = await Promise.all([
      holeVomServer(cfg, { fetchFn, zeitlimitMs: abrufMs }),
      lernen ? lernenAuffrischen(cfg, { fetchFn }) : undefined,
    ]);
    if (frisch) { schreibeBestand(pfad, frisch); return { lessons: frisch, quelle: 'server' }; }
    const alt = leseBestand(pfad);
    return alt
      ? { lessons: alt.lessons, quelle: 'platte-alt' }
      : { lessons: [], quelle: 'server-nicht-erreichbar' };
  }

  const da = leseBestand(pfad);
  if (da) {
    const jetzt = Date.now();
    const frist = bestandFrist(da.lessons.length, jetzt - da.seit);
    const frischGenug = jetzt - da.at < frist.ttlMs;
    if (frischGenug) return { lessons: da.lessons, quelle: 'platte' };
    if (frist.sofort) {
      // Brain im Aufbau: nicht auf den Nebenlauf warten, sonst sieht der
      // naechste Prompt wieder den alten Stand. Scheitert das Holen oder
      // dauert es zu lange, bleibt der alte Stand von der Platte.
      const frisch = await holeVomServer(cfg, { fetchFn, zeitlimitMs: Math.min(abrufMs, JUNG_ABRUF_MS) });
      if (frisch) { schreibeBestand(pfad, frisch); return { lessons: frisch, quelle: 'server' }; }
      return { lessons: da.lessons, quelle: 'platte-alt' };
    }
    if (nebenlauf) starteNebenlauf(cfg, nebenlauf);
    return { lessons: da.lessons, quelle: 'platte-alt' };
  }

  const frisch = await holeVomServer(cfg, { fetchFn, zeitlimitMs: abrufMs });
  if (frisch) { schreibeBestand(pfad, frisch); return { lessons: frisch, quelle: 'server' }; }
  return { lessons: [], quelle: 'server-nicht-erreichbar' };
}

/** Grobe Token-Schaetzung: vier Zeichen je Token. */
export function estimateTokens(str: unknown): number {
  return Math.ceil(String(str).length / 4);
}

/**
 * Eine Lektion als eine Zeile, gekuerzt auf ANZEIGE_ZEICHEN.
 */
export function renderLesson(l: EinblendLektion): string {
  const sev = l.severity ? `[${l.severity}] ` : '';
  const what = String(l.what_worked ?? '').replace(/\s+/g, ' ').trim();
  const kurz = what.length > ANZEIGE_ZEICHEN ? `${what.slice(0, ANZEIGE_ZEICHEN)}…` : what;
  // Gueltigkeit nach Version: "gilt fuer next@<15, hier 15.2.0" (nur bei Abweichlern gesetzt).
  const vh = typeof l.versionshinweis === 'string' ? ` [${l.versionshinweis}]` : '';
  return `- ${sev}${l.topic}${vh}: ${kurz}`;
}

export interface AuswahlOptionen {
  /** Tor: so viele verschiedene Frageworte muss eine Lektion enthalten. */
  minBelege?: number;
  topK?: number;
  tokenBudget?: number;
}

export interface Auswahl {
  lessons: EinblendLektion[];
  tokens: number;
  topScore: number;
  belege: number;
}

const LEER: Auswahl = { lessons: [], tokens: 0, topScore: 0, belege: 0 };

/** Ein sortierter Kandidat; `leser` ist der Punkt des Lesers, wenn er ihn gelesen hat. */
interface Geordnet {
  lektion: EinblendLektion;
  punkte: number;
  belege: number;
  leser?: number;
}

function waehleAus(sortiert: Geordnet[], topK: number, tokenBudget: number): Auswahl {
  if (sortiert.length === 0) return { ...LEER };
  const gewaehlt: EinblendLektion[] = [];
  let verbraucht = 0;
  // Gueltigkeit nach Version: Lektionen, die nicht zu den Versionen dieses
  // Projekts passen, stehen hinten und tragen einen Hinweis. Ohne `gilt_fuer`
  // unter den Kandidaten: dieselbe Liste, kein Dateizugriff.
  sortiert = stufeEinblendungNachVersion(sortiert);
  for (const { lektion } of sortiert.slice(0, topK)) {
    const t = estimateTokens(renderLesson(lektion));
    if (verbraucht + t > tokenBudget) break;
    gewaehlt.push(lektion);
    verbraucht += t;
  }
  return {
    lessons: gewaehlt,
    tokens: verbraucht,
    // Die Punktzahl ist nur INNERHALB dieses Aufrufs vergleichbar.
    topScore: Math.round(sortiert[0].punkte * 100) / 100,
    belege: sortiert[0].belege,
  };
}

/**
 * Die Lektionen fuer einen Prompt auswaehlen — ohne Leser.
 *
 *   TOR       — `belege` zaehlt, wie viele verschiedene Frageworte im Text der
 *               Lektion vorkommen. Unter `minBelege` wird nichts eingeblendet.
 *   ORDNUNG   — `Einblendbestand.sortiere` (Wortsuche + Seltenheit).
 */
export function selectRelevant(
  prompt: string,
  lessons: EinblendLektion[],
  { minBelege = 2, topK = 3, tokenBudget = 600 }: AuswahlOptionen = {},
): Auswahl {
  if (!Array.isArray(lessons) || lessons.length === 0) return { ...LEER };
  if (torWoerter(prompt).length === 0) return { ...LEER };
  const sortiert = new Einblendbestand(lessons).sortiere(prompt).filter((x) => x.belege >= minBelege);
  if (sortiert.length === 0) return { ...LEER };
  return waehleAus(sortiert, topK, tokenBudget);
}

// ── Der Leser fuer die Einblendung ───────────────────────────────────────────
//
// Dieselbe Mischung wie im MCP-Server (leser.ts): die besten `tiefe`
// Kandidaten der lokalen Sortierung liest der Leser-Endpunkt (POST
// /api/v1/rerank, mit Instanz-Kennung — die API entscheidet, welcher Leser
// liest), Hauspunkt und Leserpunkt werden je auf 0..1 gespreizt und 1:1
// addiert. Alles hinter `tiefe` behaelt seine Ordnung.

/** Der Text, den der Leser je Lektion sieht. */
export function leserText(l: EinblendLektion): string {
  return leserTextZuschnitt(l as Record<string, unknown>, LESER_MAX_ZEICHEN);
}

/**
 * Der Leser fuer einen Prompt — hinter der Leser-Sicherung dieser Instanz.
 * `uebersprungen` heisst: die Sicherung ist offen, es gab keinen Netzaufruf.
 */
export async function leserAnfrageApi(
  cfg: EinblendConfig,
  prompt: string,
  texte: string[],
  { zeitlimitMs = LESER_HOOK_ZEITLIMIT_MS, fetchFn }: { zeitlimitMs?: number; fetchFn?: typeof fetch } = {},
): Promise<LeserAntwort> {
  if (!cfg?.jwt || !cfg?.instanceId || texte.length === 0) return { art: 'ohne' };
  if (['0', 'off', 'aus', 'false'].includes(String(process.env.CACHLY_LESER || '').toLowerCase())) return { art: 'ohne' };
  const sicherung = new LeserSicherung(dateiSpeicher(sicherungsPfad(cfg.instanceId)));
  return frageLeser({
    url: `${cfg.apiUrl}/api/v1/rerank`,
    jwt: cfg.jwt,
    frage: prompt,
    texte,
    instanceId: cfg.instanceId,
    zeitlimitMs,
    fetchFn,
  }, sicherung);
}

/** Wie leserAnfrageApi, aber `null` fuer jede Antwort ohne Punkte. */
export async function leserPunkteApi(
  cfg: EinblendConfig,
  prompt: string,
  texte: string[],
  optionen: { zeitlimitMs?: number; fetchFn?: typeof fetch } = {},
): Promise<{ scores: number[]; provider: string; ms: number } | null> {
  const a = await leserAnfrageApi(cfg, prompt, texte, optionen);
  return a.art === 'punkte' ? { scores: a.scores, provider: a.provider, ms: a.ms } : null;
}

export interface AuswahlMitLeser extends Auswahl {
  /**
   * Wer die Spitze gemischt hat: der Anbieter ('tei', der eigene Dienst), wenn der
   * Leser geantwortet hat. 'uebersprungen': die Leser-Sicherung war offen,
   * der Leser wurde nicht gefragt. 'aus': nicht gefragt (abgeschaltet, nichts
   * zu lesen) oder gefragt ohne brauchbare Antwort.
   */
  leser: string;
  leserMs: number;
}

interface Ordnung {
  /** Alle Kandidaten ueber dem Tor, die besten `tiefe` vom Leser nachgemischt. */
  sortiert: Geordnet[];
  leser: string;
  leserMs: number;
}

/**
 * Sortieren, Tor, Leser — ohne Auswahl. Die Auswahl (wie viele, welches Tor)
 * trifft der Aufrufer; promptEinblendung tut das je Arm (lernen.ts).
 */
async function ordneMitLeser(
  prompt: string,
  lessons: EinblendLektion[],
  cfg: EinblendConfig,
  { minBelege, tiefe, zeitlimitMs, fetchFn }: { minBelege: number; tiefe: number; zeitlimitMs: number; fetchFn?: typeof fetch },
): Promise<Ordnung> {
  const leer: Ordnung = { sortiert: [], leser: 'aus', leserMs: 0 };
  if (!Array.isArray(lessons) || lessons.length === 0) return leer;
  if (torWoerter(prompt).length === 0) return leer;
  let sortiert: Geordnet[] = new Einblendbestand(lessons).sortiere(prompt).filter((x) => x.belege >= minBelege);
  if (sortiert.length === 0) return leer;

  let leserArt = 'aus';
  let leserMs = 0;
  if (sortiert.length > 1 && tiefe > 0) {
    const kopf = sortiert.slice(0, tiefe);
    const rest = sortiert.slice(tiefe);
    const antwort = await leserAnfrageApi(cfg, prompt, kopf.map((x) => leserText(x.lektion)), { zeitlimitMs, fetchFn });
    if (antwort.art === 'punkte') {
      const neu = mischeMitLeser(kopf.map((x) => x.punkte), antwort.scores, 1.0);
      sortiert = [...neu.map((i) => ({ ...kopf[i], leser: antwort.scores[i] })), ...rest];
      leserArt = antwort.provider;
      leserMs = antwort.ms;
    } else if (antwort.art === 'uebersprungen') {
      leserArt = 'uebersprungen';
    }
  }
  return { sortiert, leser: leserArt, leserMs };
}

/**
 * Wie selectRelevant, aber die besten `tiefe` werden vom Leser neu gemischt.
 * Antwortet der Leser nicht binnen `zeitlimitMs`, bleibt die lokale Ordnung.
 */
export async function selectRelevantMitLeser(
  prompt: string,
  lessons: EinblendLektion[],
  cfg: EinblendConfig,
  {
    minBelege = 2, topK = 3, tokenBudget = 600, tiefe = LESER_TIEFE,
    zeitlimitMs = LESER_HOOK_ZEITLIMIT_MS, fetchFn,
  }: AuswahlOptionen & { tiefe?: number; zeitlimitMs?: number; fetchFn?: typeof fetch } = {},
): Promise<AuswahlMitLeser> {
  const o = await ordneMitLeser(prompt, lessons, cfg, { minBelege, tiefe, zeitlimitMs, fetchFn });
  return { ...waehleAus(o.sortiert, topK, tokenBudget), leser: o.leser, leserMs: o.leserMs };
}

// ── Die fertigen Einblendungen ───────────────────────────────────────────────

/** Der Text, den Claude Code je Prompt einblendet — oder '' fuer "nichts". */
export function promptKontext(a: Auswahl): string {
  if (!a.lessons.length) return '';
  const body = a.lessons.map(renderLesson).join('\n');
  return `🧠 Cachly Brain — relevant lessons for this task (auto-recall, ${a.lessons.length}):\n` +
    `${rahmeEin(body)}\n(ambient-recall · ~${a.tokens} tokens · match score ${a.topScore})`;
}

/** Wie viele Lektionen das Sitzungs-Briefing zeigt. */
export const SITZUNG_TOP_N = 5;

/**
 * Das Sitzungs-Briefing: die meistgenutzten Lektionen, ohne Changelog-Rauschen
 * (blosse Kategorie-Themen wie "deploy:" oder "auto:*", deren what_worked ein
 * Code-Klumpen ist). Leer, wenn der Bestand leer ist.
 */
export function sitzungsKontext(alle: EinblendLektion[]): string {
  // Eine beim Speichern als verdaechtig markierte Lektion kommt nicht von selbst in den
  // Kontext (verdacht-marke.ts). Dieselbe Regel wie in Einblendbestand, hier fuers Briefing.
  const lessons = alle.filter((l) => !istMarkiert(l));
  if (!lessons.length) return '';
  const sinnvoll = lessons.filter((l) => {
    const topic = String(l.topic ?? '');
    if (/^auto:/.test(topic)) return false;
    if (/^[a-z]+:?$/.test(topic)) return false;
    return true;
  });
  const top = [...(sinnvoll.length ? sinnvoll : lessons)]
    .sort((a, b) => (Number(b.recall_count) || 0) - (Number(a.recall_count) || 0))
    .slice(0, SITZUNG_TOP_N);
  const body = top.map(renderLesson).join('\n');
  return `🧠 Cachly Brain — ambient recall active (${lessons.length} lessons). ` +
    `Top by proven reuse:\n${rahmeEin(body)}\n` +
    `(Relevant lessons for each task are auto-injected per prompt. ~${estimateTokens(body)} tokens.)`;
}

/** Die JSON-Antwort, die Claude Code von einem Hook erwartet. '' = nichts beitragen. */
export function hookAusgabe(event: string, additionalContext: string): string {
  if (!additionalContext) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } });
}

export interface PromptEinblendungOptionen {
  /** Argumente fuer `node`, die den Nebenlauf starten (siehe starteNebenlauf). */
  nebenlauf?: string[];
  /** Zeitdeckel fuer den Bestandsabruf, falls noch nichts auf der Platte liegt. */
  abrufMs?: number;
  /** false: ohne Leser sortieren (z. B. vor jedem Edit, wo jede Sekunde zaehlt). */
  leser?: boolean;
  /** Sitzungskennung fuers Netz-Protokoll. */
  session?: string | null;
  /** Protokollzeile schreiben (Vorgabe: ja). */
  protokoll?: boolean;
  /**
   * Hook-Ereignis. Gelernt (Kontrollgruppe, Arme) wird nur bei
   * 'UserPromptSubmit' — vor einem Edit (PreToolUse) bleibt alles wie bisher.
   */
  ereignis?: string;
  /** Welcher Editor fragt ('claude', 'cursor', 'copilot', 'codex', 'gemini', ...). */
  editor?: string;
  /** false: ohne Lernen (Arm 0, keine Kontrollgruppe). Sonst entscheidet die Umgebung (lernen.ts). */
  lernen?: boolean;
  /** Nur fuer Tests. */
  fetchFn?: typeof fetch;
}

export interface PromptEinblendung {
  /** Fertiger Einblendetext oder ''. */
  kontext: string;
  auswahl: AuswahlMitLeser;
  quelle: BestandQuelle;
  bestand: number;
  /** Wie entschieden wurde (lernen.ts). `kontrolle`: berechnet, nicht gezeigt. */
  entscheidung: Entscheidung;
}

/** Die Kandidaten, die gemerkt werden: die besten MERKMAL_KANDIDATEN und jeder ausgewaehlte. */
function kandidatenFuer(sortiert: Geordnet[], ausgewaehlt: EinblendLektion[]): Kandidat[] {
  return sortiert
    .map((x, rang) => ({ x, rang, gezeigt: ausgewaehlt.includes(x.lektion) }))
    .filter(({ rang, gezeigt }) => rang < MERKMAL_KANDIDATEN || gezeigt)
    .map(({ x, rang, gezeigt }) => ({
      thema: String(x.lektion.topic ?? ''),
      rang,
      punkte: Math.round(x.punkte * 1000) / 1000,
      belege: x.belege,
      leser: typeof x.leser === 'number' && Number.isFinite(x.leser) ? Math.round(x.leser * 1000) / 1000 : null,
      gezeigt,
    }));
}

/**
 * Der ganze Weg je Prompt: Bestand holen, sortieren, Leser, Tor, Rahmen.
 * Beide Hooks (Repo-Fassung und `cachly ambient-recall`) rufen GENAU diese
 * Funktion — es gibt keinen zweiten Weg.
 *
 * Seit 12.10.2026 mit Lernen (lernen.ts): ein Arm bestimmt Tor und Zahl der
 * Lektionen (Arm 0 = der Stand davor), ein kleiner Anteil ist Kontrollgruppe
 * (berechnet, gemerkt, NICHT gezeigt). Die Entscheidung landet in einer
 * lokalen Datei; gemeldet wird erst am Ende des Zugs — vor dem Prompt gibt es
 * keinen zusaetzlichen Netzaufruf.
 */
export async function promptEinblendung(
  prompt: string,
  cfg: EinblendConfig,
  {
    nebenlauf, abrufMs, leser = true, session = null, protokoll = true,
    ereignis = 'UserPromptSubmit', editor = '', lernen = true, fetchFn,
  }: PromptEinblendungOptionen = {},
): Promise<PromptEinblendung> {
  const { lessons, quelle } = await holeBestand(cfg, { nebenlauf, abrufMs, fetchFn });
  const einstellungen = lernEinstellungen();
  const lernt = lernen && einstellungen.aktiv && ereignis === 'UserPromptSubmit' && !!cfg.instanceId;
  const entscheidung: Entscheidung = lernt
    ? entscheide({ instanceId: cfg.instanceId, sitzung: session, prompt, zaehlung: leseArmZaehlung(cfg.instanceId), einstellungen })
    : OHNE_LERNEN;
  const arm = ARME[entscheidung.arm] ?? ARME[0];

  const o = await ordneMitLeser(prompt, lessons, cfg, {
    minBelege: BASIS_MIN_BELEGE,
    tiefe: leser ? LESER_TIEFE : 0,
    zeitlimitMs: LESER_HOOK_ZEITLIMIT_MS,
    fetchFn,
  });
  const auswahl: AuswahlMitLeser = {
    ...waehleAus(o.sortiert.filter((x) => x.belege >= arm.minBelege), arm.topK, 600),
    leser: o.leser,
    leserMs: o.leserMs,
  };
  const kontext = entscheidung.kontrolle ? '' : promptKontext(auswahl);

  if (lernt && o.sortiert.length > 0) {
    merkeEntscheidung(cfg.instanceId, session, neuerSatz({
      sitzung: sitzungsKennung(session),
      zug: zugKennung(prompt),
      ereignis,
      editor,
      arm: entscheidung.arm,
      kontrolle: entscheidung.kontrolle,
      erkundet: entscheidung.erkundet,
      ausgewaehlt: auswahl.lessons.length,
      kandidatenZahl: o.sortiert.length,
      belege: auswahl.belege,
      topScore: auswahl.topScore,
      leser: auswahl.leser,
      leserMs: auswahl.leserMs,
      quelle,
      bestand: lessons.length,
      kandidaten: kandidatenFuer(o.sortiert, auswahl.lessons),
    }));
  }

  if (protokoll) {
    try {
      appendFileSync(NETZ_PROTOKOLL, JSON.stringify({
        at: Date.now(),
        session,
        prompt_tokens: estimateTokens(prompt),
        injected_tokens: kontext ? auswahl.tokens : 0, // Bruttokosten dieses Zuges
        matches: kontext ? auswahl.lessons.length : 0, // 0 = nichts eingeblendet
        // Lernen (lernen.ts): Arm und Kontrollgruppe. In der Kontrollgruppe
        // steht hier, was gezeigt WORDEN WAERE.
        arm: entscheidung.arm,
        kontrolle: entscheidung.kontrolle,
        ausgewaehlt: auswahl.lessons.length,
        top_score: auswahl.topScore,
        belege: auswahl.belege,
        leser: auswahl.leser,
        leser_ms: auswahl.leserMs,
        // WOHER der Bestand kam und WIE GROSS er war — sonst sieht "matches: 0"
        // gleich aus, egal ob der Prompt belanglos war oder der Server schwieg.
        quelle,
        bestand: lessons.length,
      }) + '\n');
    } catch { /* bestes Bemuehen */ }
  }
  return { kontext, auswahl, quelle, bestand: lessons.length, entscheidung };
}
