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
import type { HookImport } from './konto-anlegen.js';
import { STARTER_CORPUS_SIZE } from './starter-corpus.js';
import {
  NAME_VEKTOR_PRAEFIX, VEKTOR_NACHTRAG, VEKTOR_PRAEFIX, ZWEIT_VEKTOR_PRAEFIX, packe, textFuerNamensVektor,
  textFuerVektor,
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

/** Wie viele Lektionen der Startvorrat bringt (brain_seed_starter). */
export const STARTVORRAT_LEKTIONEN = STARTER_CORPUS_SIZE;

/**
 * Darf ein neues Brain in einem Ordner ohne Git den Startvorrat laden?
 * CACHLY_STARTVORRAT=false schaltet nur das ab, CACHLY_STARTWISSEN=false
 * schaltet das ganze Startwissen ab (index.ts).
 */
export function startvorratErlaubt(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|off|no|nein)$/i.test((env.CACHLY_STARTVORRAT ?? '').trim());
}

export type StartwissenErgebnis =
  | { art: 'kein-repo'; ordner: string }
  | { art: 'startvorrat'; ordner: string; lektionen: number; vektoren: number }
  | { art: 'ausgeschlossen'; ordner: string; grund: string }
  | { art: 'hat-lektionen' }
  | { art: 'schon-erledigt' }
  | { art: 'fertig'; ordner: string; lektionen: number; vektoren: number }
  | { art: 'fehler'; grund: string };

export interface StartwissenUmfeld {
  instanzId: string;
  /**
   * Gesetzt, wenn der Nebenlauf des SessionStart-Hooks die Lektionen schon ueber
   * die API geschickt hat (startwissen-hook.ts). Dann kein Import, nur noch
   * Marke, Satz, Ereignis und Vektoren (vervollstaendigeHookImport).
   */
  vomHook?: HookImport;
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
  /**
   * Eine Einbettung durch das Zweitmodell (ZWEIT_MODELL, Merkmal 6 der
   * Rangfolge). Fehlt sie oder wirft sie (Anbieter ohne Modellwahl), bleibt
   * vec2 leer, und der Lesepfad laesst das Merkmal wegen ZWEIT_MINDESTDECKUNG
   * von selbst aus.
   */
  einbettenZweit?: (text: string) => Promise<number[]>;
  /** Wird nach dem Import mit der Zahl der neuen Lektionen gerufen (Ereignis). */
  melde?: (lektionen: number) => void;
  /**
   * Laedt den Startvorrat (brain_seed_starter). Fehlt er, bleibt ein Brain in
   * einem Ordner ohne Git leer — wie bis zum 11.10.2026.
   */
  startvorrat?: (args: { instance_id: string }) => Promise<unknown>;
  /** Wird nach dem Startvorrat mit der Zahl seiner Lektionen gerufen (Ereignis). */
  meldeStartvorrat?: (lektionen: number) => void;
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
    if (u.vomHook) return await vervollstaendigeHookImport(u, u.vomHook, log);
    const ordner = resolve(await u.projektOrdner());
    const wurzel = await (u.gitWurzel ?? echteGitWurzel)(ordner);
    if (!wurzel) {
      log(`cachly: ${ordner} is not a git repository — the new Brain starts without git history.\n`);
      if (u.startvorrat && startvorratErlaubt(env)) return await ladeStartvorrat(u, ordner, log);
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

/** Der Satz an der ersten Antwort nach dem Startvorrat. Geht an den Assistenten. */
export function startvorratSatz(lektionen: number): string {
  return [
    '',
    '',
    '---',
    `ℹ️ **cachly:** the project folder is not a git repository, so this new Brain loaded ${lektionen} `
      + `starter lesson${lektionen === 1 ? '' : 's'} (common engineering fixes, tagged \`source: "starter"\`; `
      + 'they never override own lessons). `smart_recall` finds them now. Tell the user once.',
  ].join('\n');
}

/**
 * Ordner ohne Git: der Startvorrat, nach denselben Regeln wie der Import aus
 * Git — nur in ein leeres Brain, einmal je Instanz ueber dieselbe Marke, im
 * Hintergrund. Bis zum 11.10.2026 spielte ihn der ERSTE session_start ein,
 * synchron (index.ts); seit session_start auf ein startendes Brain sofort
 * antwortet (leeres-brain.ts), passiert es hier.
 *
 * Dieselbe Marke wie der Git-Import: ein spaeterer Prozess findet sie und
 * laedt weder den Vorrat noch die Geschichte ein zweites Mal.
 */
async function ladeStartvorrat(
  u: StartwissenUmfeld,
  ordner: string,
  log: (z: string) => void,
): Promise<StartwissenErgebnis> {
  const laden = u.startvorrat;
  if (!laden) return { art: 'kein-repo', ordner };
  const redis = await u.verbindung(u.instanzId);
  if ((await scanKeys(redis, 'cachly:lesson:best:*', { max: 1 })).length > 0) {
    log('cachly: this Brain already has lessons — no starter lessons.\n');
    return { art: 'hat-lektionen' };
  }
  const beansprucht = await redis.set(
    STARTWISSEN_MARKE,
    JSON.stringify({ stand: 'startvorrat', seit: new Date().toISOString(), ordner }),
    'NX',
  );
  if (beansprucht !== 'OK') return { art: 'schon-erledigt' };

  log(`cachly: new Brain without git history — loading ${STARTVORRAT_LEKTIONEN} starter lessons in the background.\n`);
  try {
    await laden({ instance_id: u.instanzId });
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    await redis.set(STARTWISSEN_MARKE, JSON.stringify({ stand: 'abgebrochen', am: new Date().toISOString(), grund: text.slice(0, 200) }))
      .catch(() => undefined);
    log(`cachly: loading starter lessons failed: ${text}\n`);
    return { art: 'fehler', grund: text };
  }

  // Gezaehlt wird, was der Vorrat wirklich angelegt hat (source "starter").
  const themen: Array<{ topic: string; lektion: Record<string, unknown> }> = [];
  for (const schluessel of await scanKeys(redis, 'cachly:lesson:best:*', { max: 1000 })) {
    const lektion = safeJsonParse<Record<string, unknown>>(await redis.get(schluessel), {});
    if (lektion.source !== 'starter') continue;
    themen.push({ topic: schluessel.slice('cachly:lesson:best:'.length), lektion });
  }
  await redis.set(STARTWISSEN_MARKE, JSON.stringify({
    stand: 'fertig', am: new Date().toISOString(), ordner, startvorrat: themen.length,
  })).catch(() => undefined);
  log(`cachly: loaded ${themen.length} starter lessons.\n`);
  if (themen.length > 0) _hinweis = startvorratSatz(themen.length);
  try { u.meldeStartvorrat?.(themen.length); } catch { /* ein Ereignis stoert nie */ }

  const vektoren = await betteNacheinander(redis, themen, u, log);
  return { art: 'startvorrat', ordner, lektionen: themen.length, vektoren };
}

/**
 * Der Nebenlauf des SessionStart-Hooks hat die Lektionen schon ueber POST /learn
 * geschickt (startwissen-hook.ts), und die API rechnet vec und vecname selbst.
 * Hier bleibt, was nur der Server kann: die Marke (kein zweiter Import), der
 * Satz an die erste Antwort, das Ereignis und die Zweitvektoren — die API
 * schreibt vec2 nur beim Anbieter ollama. Fehlt einer Lektion der Erstvektor
 * noch, rechnet ihn der Server nach.
 */
async function vervollstaendigeHookImport(
  u: StartwissenUmfeld,
  vomHook: HookImport,
  log: (z: string) => void,
): Promise<StartwissenErgebnis> {
  const ordner = resolve(await u.projektOrdner());
  const git = vomHook.art === 'git';
  const wurzel = git ? (await (u.gitWurzel ?? echteGitWurzel)(ordner)) || ordner : ordner;
  const redis = await u.verbindung(u.instanzId);
  const am = new Date().toISOString();
  const beansprucht = await redis.set(
    STARTWISSEN_MARKE,
    JSON.stringify(git
      ? { stand: 'fertig', am, ordner: wurzel, lektionen: vomHook.lektionen, quelle: 'hook' }
      : { stand: 'fertig', am, ordner, startvorrat: vomHook.lektionen, quelle: 'hook' }),
    'NX',
  );
  if (beansprucht !== 'OK') return { art: 'schon-erledigt' };

  // Gezaehlt wird, was im Brain steht — nicht, was der Hook meldet.
  const themen: Array<{ topic: string; lektion: Record<string, unknown> }> = [];
  for (const schluessel of await scanKeys(redis, 'cachly:lesson:best:*', { max: 1000 })) {
    const lektion = safeJsonParse<Record<string, unknown>>(await redis.get(schluessel), {});
    const passt = git
      ? Array.isArray(lektion.tags) && lektion.tags.includes('brain_from_git')
      : lektion.source === 'starter';
    if (passt) themen.push({ topic: schluessel.slice('cachly:lesson:best:'.length), lektion });
  }
  if (git) {
    log(`cachly: the session hook learned ${themen.length} lessons from the git history of ${wurzel}.\n`);
    if (themen.length > 0) _hinweis = startwissenSatz(themen.length, wurzel);
    try { u.melde?.(themen.length); } catch { /* ein Ereignis stoert nie */ }
  } else {
    log(`cachly: the session hook loaded ${themen.length} starter lessons.\n`);
    // Dieselben Marken wie brain_seed_starter (handlers/share.ts): kein zweites Saeen.
    await redis.set(`cachly:stats:born_at:${u.instanzId}`, am, 'EX', 365 * 86400, 'NX').catch(() => undefined);
    await redis.set(`cachly:brain:starter_seeded:${u.instanzId}`, am, 'EX', 365 * 86400).catch(() => undefined);
    if (themen.length > 0) _hinweis = startvorratSatz(themen.length);
    try { u.meldeStartvorrat?.(themen.length); } catch { /* ein Ereignis stoert nie */ }
  }

  const vektoren = await betteNacheinander(redis, themen, u, log, { nurFehlende: true });
  return git
    ? { art: 'fertig', ordner: wurzel, lektionen: themen.length, vektoren }
    : { art: 'startvorrat', ordner, lektionen: themen.length, vektoren };
}

/**
 * Vektoren fuer die neuen Lektionen, EINE Anfrage zur Zeit. Gibt zurueck, wie
 * viele Lektionen danach einen Volltext-Vektor haben.
 *
 * `nurFehlende` (Import des Hooks): Die API rechnet vec und vecname nach jedem
 * /learn selbst, im Hintergrund. Steht der Vektor nach der Pause schon da,
 * zaehlt er und wird nicht noch einmal gerechnet; ebenso ein vorhandener vec2.
 */
async function betteNacheinander(
  redis: Redis,
  themen: Array<{ topic: string; lektion: Record<string, unknown> }>,
  u: StartwissenUmfeld,
  log: (z: string) => void,
  { nurFehlende = false }: { nurFehlende?: boolean } = {},
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
      if (nurFehlende && await redis.exists(`${VEKTOR_PRAEFIX}${topic}`)) {
        await redis.srem(VEKTOR_NACHTRAG, topic);
        geschrieben++;
        fehlerInFolge = 0;
        continue;
      }
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
  if (geschrieben > 0) await betteZweitNach(redis, themen, u, log, nurFehlende);
  return geschrieben;
}

/**
 * Zweiter Durchgang: der Zweitvektor (vec2) je Lektion.
 *
 * Bis zum 12.10.2026 schrieb der Start-Import keinen. Gemessen an einem
 * frischen Sofort-Test-Brain (0.10.183, Klon von expressjs/cors): 21
 * Lektionen nach 3,5 Minuten, Zweitvektor-Deckung 6 %. Das Merkmal schaltet
 * erst ab 80 % (ZWEIT_MINDESTDECKUNG) — und smart_recall traegt nur drei je
 * Aufruf nach. Ein neues Brain sortierte also tagelang ohne Merkmal 6.
 *
 * Erst NACH allen Erstvektoren: die Bedeutungssuche soll nicht laenger warten,
 * nur damit ein Rangfolge-Merkmal frueher da ist. Dieselbe Pause wie oben,
 * hoechstens eine Anfrage zur Zeit. Der erste Fehler beendet den Durchgang —
 * ein Anbieter ohne Modellwahl wirft bei jeder Lektion, das waeren sonst
 * Dutzende sinnlose Anfragen.
 */
async function betteZweitNach(
  redis: Redis,
  themen: Array<{ topic: string; lektion: Record<string, unknown> }>,
  u: StartwissenUmfeld,
  log: (z: string) => void,
  nurFehlende = false,
): Promise<number> {
  const einbettenZweit = u.einbettenZweit;
  if (!einbettenZweit) return 0;
  const schlafen = u.schlafen ?? schlafe;
  const pause = u.pauseMs ?? EINBETT_PAUSE_MS;
  let geschrieben = 0;
  for (const { topic, lektion } of themen) {
    try {
      if (nurFehlende && await redis.exists(`${ZWEIT_VEKTOR_PRAEFIX}${topic}`)) { geschrieben++; continue; }
      await schlafen(pause);
      const v2 = await einbettenZweit(textFuerVektor({ ...lektion, topic }));
      if (v2?.length) {
        await redis.set(`${ZWEIT_VEKTOR_PRAEFIX}${topic}`, packe(v2), 'EX', LEBENSDAUER_S);
        geschrieben++;
      }
    } catch {
      break;
    }
  }
  log(`cachly: second-model vectors for git lessons: ${geschrieben}/${themen.length}.\n`);
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
