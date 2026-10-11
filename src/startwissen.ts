// Startwissen — ein neues Brain lernt im Hintergrund aus der Git-Geschichte
// des Projekts, in dem der Nutzer gerade arbeitet.
//
// ── Warum es das gibt (11.10.2026) ──────────────────────────────────────────
//
// Probe von aussen mit 0.10.175: frischer Start ohne Schluessel, Test-Brain in
// 0,4 s (zugang.ts). Die erste Antwort auf smart_recall lautete dann "Nichts
// Passendes im Bestand". Ein neues Brain ist leer — der Nutzer erlebt in der
// ersten Sitzung nichts von dem, was cachly kann.
//
// Den Import gab es schon: brain_from_git (handlers/fedbrain.ts). Er lief aber
// nur, wenn jemand ihn aufrief, oder SYNCHRON im ersten session_start — und
// der kommt erst beim ZWEITEN Werkzeugaufruf und haelt ihn fuer den ganzen
// Import an.
//
// ── Was jetzt gilt ──────────────────────────────────────────────────────────
//
// Legt dieser Prozess ein Brain NEU an (Sofort-Test oder Anmeldung mit neuer
// Instanz), startet hier im Hintergrund ein Import:
//
//   1. Nur wenn der Projektordner in einem Git-Repo liegt. Plugin-, Paket- und
//      Heimordner zaehlen nicht: deren Geschichte ist nicht die des Nutzers.
//   2. Nur wenn das Brain noch KEINE Lektion hat.
//   3. Nur einmal je Instanz: die Marke `cachly:startwissen:git` im Brain wird
//      per SET NX beansprucht. Ein Neustart findet sie und importiert nicht
//      noch einmal.
//   4. Hoechstens 30 Commits.
//   5. Die Vektoren fuer den Bedeutungsabgleich NACHEINANDER: hoechstens eine
//      Einbettungsanfrage zur Zeit, mit Pause dazwischen. Die Einbettung laeuft
//      auf CPU (bge-m3, 7-21 s je langem Text), und Massen-Ingest hat schon
//      8.597 x 503 erzeugt. Jedes Thema steht vorher im Nachtrag
//      (VEKTOR_NACHTRAG) — stirbt der Prozess mittendrin, bettet smart_recall
//      den Rest spaeter nach.
//
// Der erste Werkzeugaufruf wartet auf NICHTS davon. Die Zahl der gelernten
// Lektionen haengt an der ersten Antwort NACH dem Import (holeStartwissenHinweis).

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import type { Redis } from 'ioredis';
import { safeJsonParse, scanKeys } from './utils.js';
import {
  NAME_VEKTOR_PRAEFIX, VEKTOR_NACHTRAG, VEKTOR_PRAEFIX, packe, textFuerNamensVektor, textFuerVektor,
} from './bedeutung.js';

/** Die Marke im Brain. Steht sie, gibt es keinen zweiten Import. */
export const STARTWISSEN_MARKE = 'cachly:startwissen:git';
/** Hoechstens so viele Commits. */
export const STARTWISSEN_COMMITS = 30;
/** Pause vor jeder Einbettungsanfrage: hoechstens 40 je Minute, die Grenze liegt bei 60. */
export const EINBETT_PAUSE_MS = 1500;
/** Wartezeit vor dem Start: die erste Antwort geht zuerst hinaus. */
export const ANLAUF_MS = 1000;
/** Nach so vielen Fehlschlaegen hintereinander hoert das Einbetten auf; der Nachtrag bleibt. */
const FEHLER_GRENZE = 3;
/** Dieselbe Lebensdauer wie die Lektionen aus brain_from_git. */
const LEBENSDAUER_S = 90 * 86400;

export type StartwissenErgebnis =
  | { art: 'kein-repo'; ordner: string }
  | { art: 'ausgeschlossen'; ordner: string; grund: string }
  | { art: 'hat-lektionen' }
  | { art: 'schon-erledigt' }
  | { art: 'fertig'; ordner: string; lektionen: number; vektoren: number }
  | { art: 'fehler'; grund: string };

export interface StartwissenUmfeld {
  instanzId: string;
  /** getConnection aus index.ts. */
  verbindung: (instanzId: string) => Promise<Redis>;
  /** Fuehrt brain_from_git aus (handleFedbrainTool). */
  ausGit: (args: { instance_id: string; repo_path: string; limit: number }) => Promise<unknown>;
  /** Der Ordner, in dem der Nutzer arbeitet (siehe waehleProjektOrdner). */
  projektOrdner: () => Promise<string>;
  /** Git-Wurzel des Ordners, '' = kein Repo. Standard: git rev-parse --show-toplevel. */
  gitWurzel?: (ordner: string) => Promise<string>;
  /** Eine Einbettung. Fehlt sie, bleiben die Themen im Nachtrag. */
  einbetten?: (text: string) => Promise<number[]>;
  /** Ist gerade ein Einbettungsdienst eingerichtet? Standard: ja, wenn `einbetten` da ist. */
  hatEinbettung?: () => boolean;
  /** Wird nach dem Import mit der Zahl der neuen Lektionen gerufen (Ereignis). */
  melde?: (lektionen: number) => void;
  env?: Record<string, string | undefined>;
  pauseMs?: number;
  anlaufMs?: number;
  schlafen?: (ms: number) => Promise<void>;
  /** Zeile fuer das Editor-Protokoll. Standard: stderr. */
  protokoll?: (zeile: string) => void;
}

const schlafe = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Welcher Ordner ist das Projekt? Der erste Treffer zaehlt, in dieser Reihenfolge:
 * die erste file://-Wurzel des Clients (MCP roots), CLAUDE_PROJECT_DIR,
 * CACHLY_WORKSPACE, das Arbeitsverzeichnis. Es wird NICHT weitergesucht, wenn
 * der erste Ordner kein Repo ist: dann ist das Projekt eben keins.
 */
export function waehleProjektOrdner(q: {
  wurzeln?: ReadonlyArray<{ uri: string }>;
  env?: Record<string, string | undefined>;
  cwd: string;
  dateiPfad: (uri: string) => string;
}): string {
  for (const w of q.wurzeln ?? []) {
    if (!w.uri.startsWith('file:')) continue;
    try { return q.dateiPfad(w.uri); } catch { /* kaputte URI: naechste */ }
  }
  const env = q.env ?? {};
  for (const name of ['CLAUDE_PROJECT_DIR', 'CACHLY_WORKSPACE']) {
    const wert = (env[name] ?? '').trim();
    // Ein nicht ersetzter Platzhalter wie ${CLAUDE_PROJECT_DIR} ist kein Ordner.
    if (wert && !wert.includes('${')) return wert;
  }
  return q.cwd;
}

function liegtIn(pfad: string, ordner: string): boolean {
  const r = relative(ordner, pfad);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

function gleich(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Warum diese Git-Wurzel NICHT das Projekt des Nutzers ist — oder '' wenn sie es ist.
 *
 * Der Server laeuft per npx aus einem Paketordner, als Plugin aus dem
 * Plugin-Ordner. Ist eines davon ein Git-Checkout, laege dort cachlys eigene
 * Geschichte, und die gehoert nicht in das Brain des Nutzers. Das Heimverzeichnis
 * ist ein Repo nur bei Dotfiles-Sammlungen — auch das ist kein Projekt.
 */
export function ausschlussGrund(wurzel: string, env: Record<string, string | undefined> = process.env): string {
  const w = resolve(wurzel);
  const plugin = (env.CLAUDE_PLUGIN_ROOT ?? '').trim();
  if (plugin && !plugin.includes('${') && liegtIn(w, resolve(plugin))) return 'plugin-ordner';
  if (w.split(/[\\/]+/).some((teil) => teil === 'node_modules' || teil === '_npx')) return 'paketordner';
  const heim = env.HOME || env.USERPROFILE || homedir();
  if (heim && gleich(w, resolve(heim))) return 'heimordner';
  return '';
}

/** Die Git-Wurzel des Ordners oder '' — ohne die Ereignisschleife anzuhalten. */
export function echteGitWurzel(ordner: string): Promise<string> {
  return new Promise((fertig) => {
    try {
      execFile('git', ['rev-parse', '--show-toplevel'], { cwd: ordner, timeout: 5000, windowsHide: true }, (fehler, aus) => {
        const zeile = String(aus ?? '').trim();
        fertig(fehler || !zeile ? '' : resolve(zeile));
      });
    } catch {
      fertig('');
    }
  });
}

/** Der Satz an der ersten Antwort nach dem Import. Geht an den Assistenten. */
export function startwissenSatz(lektionen: number, wurzel: string): string {
  return [
    '',
    '',
    '---',
    `ℹ️ **cachly:** this new Brain just learned ${lektionen} lesson${lektionen === 1 ? '' : 's'} `
      + `from the git history of \`${basename(wurzel)}\` (last ${STARTWISSEN_COMMITS} commits at most). `
      + '`smart_recall` finds them now. Tell the user once.',
  ].join('\n');
}

// Der Satz, der an der naechsten Antwort haengt. Leer = nichts zu sagen.
let _hinweis = '';

/** Gibt den Satz EINMAL zurueck und vergisst ihn dann. */
export function holeStartwissenHinweis(): string {
  const h = _hinweis;
  _hinweis = '';
  return h;
}

/**
 * Der Import selbst. Wirft nie; jeder Ausgang steht im Ergebnis und auf stderr.
 */
export async function lerneAusGitGeschichte(u: StartwissenUmfeld): Promise<StartwissenErgebnis> {
  const log = u.protokoll ?? ((z: string) => { process.stderr.write(z); });
  const env = u.env ?? process.env;
  try {
    const ordner = resolve(await u.projektOrdner());
    const wurzel = await (u.gitWurzel ?? echteGitWurzel)(ordner);
    if (!wurzel) {
      log(`cachly: ${ordner} is not a git repository — the new Brain starts without git history.\n`);
      return { art: 'kein-repo', ordner };
    }
    const grund = ausschlussGrund(wurzel, env);
    if (grund) {
      log(`cachly: ${wurzel} is not a user project (${grund}) — no import from git history.\n`);
      return { art: 'ausgeschlossen', ordner: wurzel, grund };
    }

    const redis = await u.verbindung(u.instanzId);
    if ((await scanKeys(redis, 'cachly:lesson:best:*', { max: 1 })).length > 0) {
      log('cachly: this Brain already has lessons — no import from git history.\n');
      return { art: 'hat-lektionen' };
    }
    const beansprucht = await redis.set(
      STARTWISSEN_MARKE,
      JSON.stringify({ stand: 'laeuft', seit: new Date().toISOString(), ordner: wurzel }),
      'NX',
    );
    if (beansprucht !== 'OK') return { art: 'schon-erledigt' };

    log(`cachly: new Brain — learning from the last ${STARTWISSEN_COMMITS} commits of ${wurzel} in the background.\n`);
    const start = Date.now();
    try {
      await u.ausGit({ instance_id: u.instanzId, repo_path: wurzel, limit: STARTWISSEN_COMMITS });
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      await redis.set(STARTWISSEN_MARKE, JSON.stringify({ stand: 'abgebrochen', am: new Date().toISOString(), grund: text.slice(0, 200) }))
        .catch(() => undefined);
      log(`cachly: import from git history failed: ${text}\n`);
      return { art: 'fehler', grund: text };
    }

    // Welche Lektionen kamen aus Git? Nur die mit der Marke von brain_from_git —
    // ein gleichzeitiges learn_from_attempts des Nutzers zaehlt nicht mit.
    const themen: Array<{ topic: string; lektion: Record<string, unknown> }> = [];
    for (const schluessel of await scanKeys(redis, 'cachly:lesson:best:*', { max: 1000 })) {
      const lektion = safeJsonParse<Record<string, unknown>>(await redis.get(schluessel), {});
      const tags = Array.isArray(lektion.tags) ? lektion.tags : [];
      if (!tags.includes('brain_from_git')) continue;
      themen.push({ topic: schluessel.slice('cachly:lesson:best:'.length), lektion });
    }
    await redis.set(STARTWISSEN_MARKE, JSON.stringify({
      stand: 'fertig', am: new Date().toISOString(), ordner: wurzel, lektionen: themen.length,
    })).catch(() => undefined);
    const sekunden = ((Date.now() - start) / 1000).toFixed(1);
    log(`cachly: learned ${themen.length} lessons from git history in ${sekunden} s.\n`);
    if (themen.length > 0) _hinweis = startwissenSatz(themen.length, wurzel);
    try { u.melde?.(themen.length); } catch { /* ein Ereignis stoert nie */ }

    const vektoren = await betteNacheinander(redis, themen, u, log);
    return { art: 'fertig', ordner: wurzel, lektionen: themen.length, vektoren };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    log(`cachly: import from git history stopped: ${text}\n`);
    return { art: 'fehler', grund: text };
  }
}

/**
 * Vektoren fuer die neuen Lektionen, EINE Anfrage zur Zeit. Gibt zurueck, wie
 * viele Volltext-Vektoren geschrieben wurden.
 */
async function betteNacheinander(
  redis: Redis,
  themen: Array<{ topic: string; lektion: Record<string, unknown> }>,
  u: StartwissenUmfeld,
  log: (z: string) => void,
): Promise<number> {
  const einbetten = u.einbetten;
  if (!einbetten || themen.length === 0) return 0;
  if (!(u.hatEinbettung ?? (() => true))()) return 0;

  // Erst vermerken, dann rechnen: stirbt der Prozess dazwischen, heilt
  // smart_recall den Rest (heileVektorNachtrag in handlers/brain.ts).
  for (const { topic } of themen) await redis.sadd(VEKTOR_NACHTRAG, topic).catch(() => undefined);

  const schlafen = u.schlafen ?? schlafe;
  const pause = u.pauseMs ?? EINBETT_PAUSE_MS;
  let geschrieben = 0;
  let fehlerInFolge = 0;
  for (const { topic, lektion } of themen) {
    try {
      await schlafen(pause);
      const v = await einbetten(textFuerVektor({ ...lektion, topic }));
      if (v?.length) {
        await redis.set(`${VEKTOR_PRAEFIX}${topic}`, packe(v), 'EX', LEBENSDAUER_S);
        await redis.srem(VEKTOR_NACHTRAG, topic);
        geschrieben++;
      }
      await schlafen(pause);
      const nv = await einbetten(textFuerNamensVektor(topic));
      if (nv?.length) await redis.set(`${NAME_VEKTOR_PRAEFIX}${topic}`, packe(nv), 'EX', LEBENSDAUER_S);
      fehlerInFolge = 0;
    } catch {
      fehlerInFolge++;
      if (fehlerInFolge >= FEHLER_GRENZE) {
        log(`cachly: embedding service unavailable — ${themen.length - geschrieben} lessons wait in the backlog; smart_recall fills them in later.\n`);
        break;
      }
    }
  }
  log(`cachly: search vectors for git lessons: ${geschrieben}/${themen.length}.\n`);
  return geschrieben;
}

// Laufende oder fertige Importe dieses Prozesses, je Instanz.
const _laeufe = new Map<string, Promise<StartwissenErgebnis>>();
// Wie die fertigen ausgegangen sind. Fehlt der Eintrag, laeuft der Import
// noch oder hat nie begonnen (leeres-brain.ts fragt das ab).
const _ausgaenge = new Map<string, StartwissenErgebnis['art']>();

/** Wie der Import fuer diese Instanz ausging — undefined, solange er laeuft oder nie lief. */
export function startwissenAusgang(instanzId: string): StartwissenErgebnis['art'] | undefined {
  return _ausgaenge.get(instanzId);
}

/**
 * Startet den Import im Hintergrund, hoechstens einmal je Instanz und Prozess.
 * Der Aufrufer wartet NICHT darauf; das Versprechen gibt es nur fuer Tests.
 */
export function starteStartwissen(u: StartwissenUmfeld): Promise<StartwissenErgebnis> {
  const vorhanden = _laeufe.get(u.instanzId);
  if (vorhanden) return vorhanden;
  const lauf = (async () => {
    await (u.schlafen ?? schlafe)(u.anlaufMs ?? ANLAUF_MS);
    return lerneAusGitGeschichte(u);
  })().catch((e: unknown): StartwissenErgebnis => ({ art: 'fehler', grund: e instanceof Error ? e.message : String(e) }))
    .then((ergebnis) => { _ausgaenge.set(u.instanzId, ergebnis.art); return ergebnis; });
  _laeufe.set(u.instanzId, lauf);
  return lauf;
}

/** Hat dieser Prozess fuer die Instanz schon einen Import gestartet? */
export function startwissenGestartet(instanzId: string): boolean {
  return _laeufe.has(instanzId);
}

/**
 * Beansprucht die Marke fuer einen ANDEREN Import (den synchronen im ersten
 * session_start). true = frei, der Aufrufer darf importieren.
 */
export async function beanspruchStartwissen(redis: Redis, stand: string): Promise<boolean> {
  const antwort = await redis.set(STARTWISSEN_MARKE, JSON.stringify({ stand, seit: new Date().toISOString() }), 'NX');
  return antwort === 'OK';
}

/** Nur fuer Tests. */
export function _startwissenZuruecksetzen(): void {
  _laeufe.clear();
  _ausgaenge.clear();
  _hinweis = '';
}
