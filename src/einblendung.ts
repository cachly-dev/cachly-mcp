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
import { leserText as leserTextZuschnitt } from './seltenheitsbestand.js';
import { mischeMitLeser } from './leser.js';
import { LESER_TIEFE as LESER_TIEFE_PRODUKT, LESER_ZEITLIMIT_MS } from './rangfolge-stellschrauben.js';

// Alles, was der abhaengigkeitsfreie Hook braucht, reist ueber diese Datei.
export * from './einblendung-kern.js';
export { mischeMitLeser };

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

/** Die besten so vielen Kandidaten liest der Leser — dieselbe Tiefe wie im Produkt. */
export const LESER_TIEFE = LESER_TIEFE_PRODUKT;
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

function sperrPfad(instanceId: string): string {
  return join(tmpdir(), `cachly-ambient-auffrischen-${kurzHash(instanceId)}.lock`);
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

function schreibeBestand(pfad: string, lektionen: EinblendLektion[]): void {
  try {
    mkdirSync(dirname(pfad), { recursive: true });
    writeFileSync(pfad, JSON.stringify({ at: Date.now(), lessons: lektionen }), { mode: 0o600 });
  } catch { /* der Zwischenspeicher ist bestes Bemuehen, kein Muss */ }
}

function leseBestand(pfad: string): { at: number; lessons: EinblendLektion[] } | null {
  try {
    const c = JSON.parse(readFileSync(pfad, 'utf8'));
    if (Array.isArray(c?.lessons)) return { at: Number(c.at) || 0, lessons: c.lessons };
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
 * nicht antwortet: hoechstens ein Nebenlauf je NEBENLAUF_SPERRE_MS.
 */
export function starteNebenlauf(cfg: EinblendConfig, befehl: string[]): void {
  const sperre = sperrPfad(cfg.instanceId);
  try {
    if (existsSync(sperre) && Date.now() - statSync(sperre).mtimeMs < NEBENLAUF_SPERRE_MS) return;
    writeFileSync(sperre, String(Date.now()), { mode: 0o600 });
  } catch { return; }

  try {
    const kind = spawn(process.execPath, befehl, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        CACHLY_API_URL: cfg.apiUrl,
        CACHLY_JWT: cfg.jwt,
        CACHLY_BRAIN_INSTANCE_ID: cfg.instanceId,
      },
    });
    kind.unref();
  } catch { /* kein Nebenlauf ist kein Fehler: der naechste Prompt versucht es erneut */ }
}

export type BestandQuelle = 'nicht-eingerichtet' | 'server' | 'platte' | 'platte-alt' | 'server-nicht-erreichbar';

export interface HoleBestandOptionen {
  /** SessionStart und Nebenlauf: immer frisch holen (Rueckfall: alter Stand auf der Platte). */
  force?: boolean;
  /** Argumente fuer `node`, die den Nebenlauf starten. Fehlt es, wird nicht im Hintergrund aufgefrischt. */
  nebenlauf?: string[];
  /** Zeitdeckel fuer den Abruf, wenn wirklich gewartet werden muss. */
  abrufMs?: number;
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
  { force = false, nebenlauf, abrufMs = ABRUF_TIMEOUT_MS, fetchFn }: HoleBestandOptionen = {},
): Promise<{ lessons: EinblendLektion[]; quelle: BestandQuelle }> {
  if (!cfg.jwt || !cfg.instanceId) return { lessons: [], quelle: 'nicht-eingerichtet' };
  const pfad = bestandPfad(cfg.instanceId);

  if (force) {
    const frisch = await holeVomServer(cfg, { fetchFn, zeitlimitMs: abrufMs });
    if (frisch) { schreibeBestand(pfad, frisch); return { lessons: frisch, quelle: 'server' }; }
    const alt = leseBestand(pfad);
    return alt
      ? { lessons: alt.lessons, quelle: 'platte-alt' }
      : { lessons: [], quelle: 'server-nicht-erreichbar' };
  }

  const da = leseBestand(pfad);
  if (da) {
    const frischGenug = Date.now() - da.at < BESTAND_TTL_MS;
    if (!frischGenug && nebenlauf) starteNebenlauf(cfg, nebenlauf);
    return { lessons: da.lessons, quelle: frischGenug ? 'platte' : 'platte-alt' };
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
  return `- ${sev}${l.topic}: ${kurz}`;
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

function waehleAus(
  sortiert: { lektion: EinblendLektion; punkte: number; belege: number }[],
  topK: number,
  tokenBudget: number,
): Auswahl {
  const gewaehlt: EinblendLektion[] = [];
  let verbraucht = 0;
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

export async function leserPunkteApi(
  cfg: EinblendConfig,
  prompt: string,
  texte: string[],
  { zeitlimitMs = LESER_HOOK_ZEITLIMIT_MS, fetchFn = fetch }: { zeitlimitMs?: number; fetchFn?: typeof fetch } = {},
): Promise<{ scores: number[]; provider: string; ms: number } | null> {
  if (!cfg?.jwt || !cfg?.instanceId || texte.length === 0) return null;
  if (['0', 'off', 'aus', 'false'].includes(String(process.env.CACHLY_LESER || '').toLowerCase())) return null;
  try {
    const res = await fetchFn(`${cfg.apiUrl}/api/v1/rerank`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.jwt}` },
      body: JSON.stringify({ query: prompt, texts: texte, instance_id: cfg.instanceId }),
      signal: AbortSignal.timeout(zeitlimitMs),
    });
    if (!res.ok) return null;
    const j = await res.json() as { scores?: unknown; provider?: unknown; ms?: unknown };
    const scores = Array.isArray(j.scores) ? j.scores : null;
    if (!scores || scores.length !== texte.length || !scores.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    return { scores: scores as number[], provider: typeof j.provider === 'string' ? j.provider : '?', ms: Number(j.ms) || 0 };
  } catch {
    return null;
  }
}

export interface AuswahlMitLeser extends Auswahl {
  /** 'jev' | 'tei' | 'aus' — wer die Spitze gemischt hat. */
  leser: string;
  leserMs: number;
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
  const leer: AuswahlMitLeser = { ...LEER, leser: 'aus', leserMs: 0 };
  if (!Array.isArray(lessons) || lessons.length === 0) return leer;
  if (torWoerter(prompt).length === 0) return leer;
  let sortiert = new Einblendbestand(lessons).sortiere(prompt).filter((x) => x.belege >= minBelege);
  if (sortiert.length === 0) return leer;

  let leserArt = 'aus';
  let leserMs = 0;
  if (sortiert.length > 1 && tiefe > 0) {
    const kopf = sortiert.slice(0, tiefe);
    const rest = sortiert.slice(tiefe);
    const antwort = await leserPunkteApi(cfg, prompt, kopf.map((x) => leserText(x.lektion)), { zeitlimitMs, fetchFn });
    if (antwort) {
      const neu = mischeMitLeser(kopf.map((x) => x.punkte), antwort.scores, 1.0);
      sortiert = [...neu.map((i) => kopf[i]), ...rest];
      leserArt = antwort.provider;
      leserMs = antwort.ms;
    }
  }
  return { ...waehleAus(sortiert, topK, tokenBudget), leser: leserArt, leserMs };
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
export function sitzungsKontext(lessons: EinblendLektion[]): string {
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
  /** Nur fuer Tests. */
  fetchFn?: typeof fetch;
}

export interface PromptEinblendung {
  /** Fertiger Einblendetext oder ''. */
  kontext: string;
  auswahl: AuswahlMitLeser;
  quelle: BestandQuelle;
  bestand: number;
}

/**
 * Der ganze Weg je Prompt: Bestand holen, sortieren, Leser, Tor, Rahmen.
 * Beide Hooks (Repo-Fassung und `cachly ambient-recall`) rufen GENAU diese
 * Funktion — es gibt keinen zweiten Weg.
 */
export async function promptEinblendung(
  prompt: string,
  cfg: EinblendConfig,
  { nebenlauf, abrufMs, leser = true, session = null, protokoll = true, fetchFn }: PromptEinblendungOptionen = {},
): Promise<PromptEinblendung> {
  const { lessons, quelle } = await holeBestand(cfg, { nebenlauf, abrufMs, fetchFn });
  const auswahl = await selectRelevantMitLeser(prompt, lessons, cfg, { tiefe: leser ? LESER_TIEFE : 0, fetchFn });
  if (protokoll) {
    try {
      appendFileSync(NETZ_PROTOKOLL, JSON.stringify({
        at: Date.now(),
        session,
        prompt_tokens: estimateTokens(prompt),
        injected_tokens: auswahl.tokens, // Bruttokosten dieses Zuges
        matches: auswahl.lessons.length, // 0 = nichts eingeblendet
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
  return { kontext: promptKontext(auswahl), auswahl, quelle, bestand: lessons.length };
}
