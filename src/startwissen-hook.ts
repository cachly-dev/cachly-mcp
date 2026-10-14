// Start-Import aus dem SessionStart-Hook — ein neues Brain lernt, ohne auf den
// MCP-Server zu warten.
//
// ── Warum (14.10.2026) ──────────────────────────────────────────────────────
//
// Echte Probe am 13.10. (Plugin 0.10.194, Claude Code 2.1.292, leeres Heim, kein
// Werkzeugaufruf): Das Konto stand nach 2,6 s, der erste Block kam aber erst nach
// 58 s. Den Import machte der MCP-Server, und der startet per npx kalt in ~27 s.
// Erst danach nahm er den Auftrag des Hooks entgegen (konto-anlegen.ts).
//
// Jetzt startet der SessionStart-Hook, der das Konto angelegt hat, einen
// abgekoppelten Nebenlauf: `node <buendel> startwissen-import <ordner>`. Der liest
// `git log` selbst (git-lektionen.ts, dieselben Regeln wie brain_from_git) und
// schickt je Thema eine Lektion ueber POST /learn. Die API schreibt sie sofort
// und rechnet vec und vecname selbst (lesson_vector.go). Ohne Git-Repo schickt
// er den Startvorrat (starter-corpus.ts), wie der Server. Danach schreibt er den
// Bestand auf der Platte neu: der naechste Prompt hat ihn ohne Abruf.
//
// Vorab-Bestand (14.10.2026, Live-Probe mit 0.10.195): Der erste Block kam ab
// 11 s, weil die neue Instanz so lange startet und /learn erst danach annimmt.
// Die Lektionen kennt der Nebenlauf aber nach rund 0,3 s. Er legt sie deshalb
// sofort als Bestand auf die Platte (einblendung.ts schreibeVorabBestand),
// bevor er auf die Instanz wartet. Bis der Import fertig ist, ergaenzt dieser
// Vorab-Bestand jeden Stand, den ein Prompt vom Server holt; danach gilt der
// Stand des Servers allein (Live-Probe 0.10.196: bei 12 s sonst 13 statt 30).
//
// Was der Server danach noch tut: Er nimmt den Auftrag mit `vomHook` entgegen,
// setzt die Marke `cachly:startwissen:git`, haengt den Satz an die erste Antwort
// und rechnet die Zweitvektoren (vec2), die die API nicht schreibt.
// Scheitert der Nebenlauf, hinterlaesst er den gewoehnlichen Auftrag. Dann
// importiert der Server wie bisher.

import { resolve } from 'node:path';
import { STARTER_CORPUS } from './starter-corpus.js';
import { gitLesen } from './git-ohne-shell.js';
import { gitLogArgumente, leseCommits, lektionenJeThema, type GitCommit } from './git-lektionen.js';
import { STARTWISSEN_COMMITS, ausschlussGrund, echteGitWurzel, startvorratErlaubt } from './startwissen.js';
import { startwissenEingeschaltet, type HookImport } from './konto-anlegen.js';
import { holeBestand, schreibeVorabBestand, type EinblendConfig } from './einblendung.js';
import type { EinblendLektion } from './einblendung-kern.js';

/** Unterbefehl des Hook-Buendels fuer den Nebenlauf. */
export const STARTWISSEN_IMPORT = 'startwissen-import';
/** So lange wartet der Nebenlauf, bis die neue Instanz laeuft. */
export const BEREIT_FRIST_MS = 90_000;
/** So oft fragt er nach. */
export const BEREIT_TAKT_MS = 1_000;
/** Hoechstens so viele /learn-Anfragen gleichzeitig. Die API rechnet je Lektion zwei Vektoren. */
export const LERN_PARALLEL = 3;
/** Frist je /learn-Anfrage. */
export const LERN_FRIST_MS = 8_000;
/** Versuche je Lektion bei 409 (Instanz startet), 429 und 5xx. */
export const LERN_VERSUCHE = 3;

/** Der Rumpf fuer POST /api/v1/instances/:id/learn (LearnRequest in instance_handler.go). */
export interface Lernanfrage {
  topic: string;
  outcome: 'success' | 'failure' | 'partial';
  what_worked: string;
  what_failed: string;
  context: string;
  severity?: string;
  tags: string[];
  commands: string[];
  file_paths: string[];
  /** Die API erkennt daran einen Import: kein Nutzer-Ereignis, eigenes Vertrauen. */
  source: 'brain_from_git' | 'starter';
  author?: string;
}

export type HookImportErgebnis =
  | { art: 'git' | 'startvorrat'; lektionen: number; gesendet: number }
  | { art: 'aus' | 'kein-repo' | 'ausgeschlossen' | 'hat-lektionen' | 'nicht-bereit' | 'fehler'; grund?: string };

export interface HookImportUmfeld {
  cfg: EinblendConfig;
  /** Projektordner der Sitzung (CLAUDE_PROJECT_DIR). */
  projekt: string;
  env: Record<string, string | undefined>;
  fetchFn?: typeof fetch;
  /** Nur Tests. Standard: git rev-parse --show-toplevel. */
  gitWurzel?: (ordner: string) => Promise<string>;
  /** Nur Tests. Standard: `git log` mit gitLogArgumente. */
  gitLog?: (wurzel: string) => string;
  schlafen?: (ms: number) => Promise<void>;
  jetzt?: () => number;
  bereitFristMs?: number;
}

const schlafe = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Je Thema eine Lernanfrage aus den Commits, die neueste zuerst. */
export function gitAnfragen(commits: readonly GitCommit[]): Lernanfrage[] {
  return lektionenJeThema(commits).map((l) => ({
    topic: l.topic,
    outcome: l.outcome,
    what_worked: l.what_worked,
    what_failed: l.what_failed,
    context: l.context,
    severity: l.severity,
    tags: l.tags,
    commands: l.commands,
    file_paths: l.file_paths,
    source: 'brain_from_git',
    ...(l.author ? { author: l.author } : {}),
  }));
}

/** Der Startvorrat als Lernanfragen (dieselben Lektionen wie brain_seed_starter). */
export function startvorratAnfragen(): Lernanfrage[] {
  return STARTER_CORPUS.map((l) => ({
    topic: l.topic,
    outcome: l.outcome,
    what_worked: l.what_worked,
    what_failed: l.what_failed,
    context: l.ctx,
    tags: l.tags,
    commands: [],
    file_paths: [],
    source: 'starter',
  }));
}

function standardGitLog(wurzel: string): string {
  return gitLesen(wurzel, gitLogArgumente('HEAD', STARTWISSEN_COMMITS), { timeoutMs: 20_000 });
}

/** Vertrauen wie in der API (importVertrauen, lesson_write.go). */
const VERTRAUEN: Record<Lernanfrage['source'], number> = { brain_from_git: 0.55, starter: 0.9 };

/**
 * Die Anfragen in der Form, in der /export sie spaeter liefert (writeLesson in
 * lesson_write.go) — fuer den Vorab-Bestand auf der Platte.
 */
export function alsBestand(anfragen: readonly Lernanfrage[], jetzt: Date = new Date()): EinblendLektion[] {
  const ts = jetzt.toISOString();
  return anfragen.map((a) => ({
    ...a,
    severity: a.severity || 'major',
    recall_count: 0,
    confidence: VERTRAUEN[a.source],
    ts,
    verified_at: ts,
  }));
}

/**
 * Wartet, bis die Instanz laeuft, und sieht nach, ob sie leer ist. Eine
 * startende Instanz antwortet auf /export mit 200, leerer Liste und `note`
 * (export_handler.go) — das zaehlt als "noch nicht bereit", nicht als leer.
 */
async function bereitUndLeer(u: HookImportUmfeld): Promise<'leer' | 'hat-lektionen' | 'nicht-bereit'> {
  const holen = u.fetchFn ?? fetch;
  const jetzt = u.jetzt ?? Date.now;
  const schlafen = u.schlafen ?? schlafe;
  const ende = jetzt() + (u.bereitFristMs ?? BEREIT_FRIST_MS);
  for (;;) {
    try {
      const res = await holen(`${u.cfg.apiUrl}/api/v1/instances/${u.cfg.instanceId}/export`, {
        headers: { Authorization: `Bearer ${u.cfg.jwt}` },
        signal: AbortSignal.timeout(LERN_FRIST_MS),
      });
      if (res.status === 401 || res.status === 403) return 'nicht-bereit';
      if (res.ok) {
        const j = await res.json() as { lessons?: unknown; note?: unknown };
        if (Array.isArray(j?.lessons) && j.lessons.length > 0) return 'hat-lektionen';
        if (Array.isArray(j?.lessons) && !j.note) return 'leer';
      }
    } catch { /* Netz oder Frist: noch einmal */ }
    if (jetzt() >= ende) return 'nicht-bereit';
    await schlafen(BEREIT_TAKT_MS);
  }
}

/** Schickt die Anfragen, hoechstens LERN_PARALLEL zugleich. Gibt zurueck, wie viele die API angenommen hat. */
async function sende(u: HookImportUmfeld, anfragen: readonly Lernanfrage[]): Promise<number> {
  const holen = u.fetchFn ?? fetch;
  const schlafen = u.schlafen ?? schlafe;
  let naechste = 0;
  let angenommen = 0;
  const arbeiter = async () => {
    while (naechste < anfragen.length) {
      const anfrage = anfragen[naechste++]!;
      for (let versuch = 1; versuch <= LERN_VERSUCHE; versuch++) {
        try {
          const res = await holen(`${u.cfg.apiUrl}/api/v1/instances/${u.cfg.instanceId}/learn`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.cfg.jwt}` },
            body: JSON.stringify(anfrage),
            signal: AbortSignal.timeout(LERN_FRIST_MS),
          });
          if (res.ok) { angenommen++; break; }
          // 400 und Co.: ein neuer Versuch aendert nichts.
          if (res.status !== 409 && res.status !== 429 && res.status < 500) break;
        } catch { /* Netz oder Frist: noch einmal */ }
        if (versuch < LERN_VERSUCHE) await schlafen(BEREIT_TAKT_MS * versuch);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LERN_PARALLEL, anfragen.length) }, arbeiter));
  return angenommen;
}

/**
 * Der Import des Nebenlaufs. Nur in ein LEERES Brain, nur aus einem Git-Repo
 * des Nutzers (Plugin-, Paket- und Heimordner zaehlen nicht), sonst der
 * Startvorrat. Wirft nie.
 */
export async function importiereStartwissen(u: HookImportUmfeld): Promise<HookImportErgebnis> {
  try {
    if (!startwissenEingeschaltet(u.env)) return { art: 'aus' };
    const ordner = resolve(u.projekt || '.');
    const wurzel = await (u.gitWurzel ?? echteGitWurzel)(ordner);

    let art: 'git' | 'startvorrat';
    let anfragen: Lernanfrage[];
    if (!wurzel) {
      if (!startvorratErlaubt(u.env)) return { art: 'kein-repo' };
      art = 'startvorrat';
      anfragen = startvorratAnfragen();
    } else {
      const grund = ausschlussGrund(wurzel, u.env);
      if (grund) return { art: 'ausgeschlossen', grund };
      art = 'git';
      let aus = '';
      // Ein Repo ohne Commit: git log scheitert. Dann gibt es nichts zu lernen.
      try { aus = (u.gitLog ?? standardGitLog)(wurzel); } catch { /* leer */ }
      anfragen = gitAnfragen(leseCommits(aus));
      if (anfragen.length === 0) return { art, lektionen: 0, gesendet: 0 };
    }

    // Die Instanz startet noch (live gemessen: erster Block erst ab 11 s). Die
    // Lektionen liegen aber schon hier: auf die Platte damit, der naechste
    // Prompt liest sie dort (einblendung.ts schreibeVorabBestand).
    schreibeVorabBestand(u.cfg.instanceId, alsBestand(anfragen));

    const stand = await bereitUndLeer(u);
    // Hat das Brain schon Lektionen, gilt sein Stand, nicht der vorab gebaute.
    // Kam die Instanz nie, bleibt der Vorab-Bestand: der Server importiert
    // dieselben Themen selbst, und nach JUNG_FENSTER_MS endet er ohnehin.
    if (stand === 'hat-lektionen') await holeBestand(u.cfg, { force: true, vorabSchliessen: true, fetchFn: u.fetchFn });
    if (stand !== 'leer') return { art: stand };
    const gesendet = await sende(u, anfragen);
    // Der Bestand auf der Platte zeigt danach die neuen Lektionen, und der
    // Vorab-Bestand endet: Bis hierher ergaenzte er jeden halben Stand, den ein
    // Prompt mitten im Import holte (einblendung.ts schreibeBestand).
    if (gesendet > 0) await holeBestand(u.cfg, { force: true, vorabSchliessen: true, fetchFn: u.fetchFn });
    return { art, lektionen: anfragen.length, gesendet };
  } catch (e) {
    return { art: 'fehler', grund: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Was der Server nach dem Nebenlauf noch tun soll. undefined = gewoehnlicher
 * Auftrag: der Server importiert selbst, wie vor dem 14.10.2026.
 */
export function hookImportFuerAuftrag(e: HookImportErgebnis): HookImport | undefined {
  if ((e.art === 'git' || e.art === 'startvorrat') && e.gesendet > 0) return { art: e.art, lektionen: e.gesendet };
  return undefined;
}
