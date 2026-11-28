/**
 * Eine Lektion gegen den heutigen Code halten.
 *
 * ── Wozu ────────────────────────────────────────────────────────────────────
 *
 * Golem, 28.11.2026 ("Wenn das Gedaechtnis von Coding-Agenten zum Problem
 * wird"): eine Projektnotiz sagt "fuehrende Nullen entfernen", der Partner
 * unterscheidet inzwischen 17 und 0017. Der Agent folgt der alten Notiz, weil
 * sie wie eine gueltige aussieht.
 *
 * Bis hierher sah cachly so etwas nur, wenn jemand es eintrug: `ersetzt=`,
 * Zurueckziehen oder `lesson_verified(haelt=false)`. Eine Aenderung NUR im
 * Code loeste nichts aus — die alte Lektion blieb ein normaler Treffer.
 *
 * GitHub Copilot Memory loest das, indem jede Erinnerung Code-Stellen nennt
 * und der Agent sie beim Lesen prueft. Unsere Lektionen tragen `file_paths`
 * schon. Der MCP-Server laeuft lokal im Projekt und kann Git lesen. Also
 * fragt dieses Modul Git: wurden diese Dateien seit dem Schreiben der Lektion
 * geaendert? Wenn ja, steht das VOR dem Inhalt, mit dem letzten Commit.
 *
 * ── Kosten ───────────────────────────────────────────────────────────────────
 *
 * Gemessen 28.11.2026 im cachly-Repo (2.125 Commits, Windows): ein Git-Aufruf
 * kostet rund 250 ms, fast alles Prozessstart. Deshalb EIN `git log` fuer alle
 * Treffer einer Antwort (ab dem aeltesten Datum, ueber alle Pfade) und EIN
 * `git status`, beide gleichzeitig. Die Zuordnung zu den Lektionen passiert
 * danach im Speicher. Acht Treffer kosten so dasselbe wie einer.
 *
 * ── Was es NICHT tut ─────────────────────────────────────────────────────────
 *
 * - Es urteilt nicht, ob die Aenderung die Lektion umstoesst. Das entscheidet
 *   der Agent, der den Commit-Betreff und die Datei lesen kann.
 * - Es aendert keine Rangfolge. Alter im Ranking riss am 19.08.2026 alle
 *   Bench-Floors; das hier ist reine Anzeige.
 * - Es schreibt nichts in die Lektion.
 * - Im HTTP-Betrieb (mcp.cachly.dev) ist der Arbeitsordner der des Servers,
 *   nicht der des Nutzers: dort laeuft die Pruefung nicht.
 *
 * Jeder Fehler heisst "unbekannt": kein Git, kein Repo, Zeitdeckel, Pfad
 * ausserhalb des Repos. Unbekannt zeigt nichts an.
 *
 * Abschalten: CACHLY_AENDERUNGS_HINWEIS=aus (auch 0, false, off).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { arbeitsordner } from './gueltigkeit-version.js';
import { istMehrmandant } from './remote-zugang.js';

/** Hoechstens so viele Pfade je Lektion. */
const MAX_PFADE = 5;
/** Hoechstens so viele Lektionen je Antwort. */
const MAX_LEKTIONEN = 12;
/** Mehr Commits je Lektion werden nicht gezaehlt, die Zeile sagt dann "50+". */
const MAX_COMMITS = 50;
/** Obergrenze fuer den gemeinsamen Log ueber alle Pfade. */
const MAX_LOG = 1000;
/** Zeitdeckel je Git-Aufruf. */
const ZEITDECKEL_MS = 2000;
/** Ein Git-Ergebnis gilt so lange, dann wird neu gefragt. */
const ABLAGE_MS = 60_000;
/** So viel frueher sucht `git log`, damit verstellte Commit-Daten nichts verdecken. */
const SPIELRAUM_MS = 30 * 86_400_000;

export interface LetzterCommit {
  kurz: string;
  datum: string;
  betreff: string;
}

export interface AenderungSeitLektion {
  /** Datum, ab dem gezaehlt wurde: verified_at, sonst ts. */
  seit: string;
  /** Commits seit `seit`, die einen der Pfade beruehren (gedeckelt auf MAX_COMMITS). */
  commits: number;
  /** Der neueste dieser Commits. */
  letzter?: LetzterCommit;
  /** Pfade mit nicht eingecheckten Aenderungen (relativ zur Repo-Wurzel). */
  offen: string[];
}

export type GitAufruf = (ordner: string, args: readonly string[]) => Promise<string>;

export interface PruefOptionen {
  /** Arbeitsordner; Standard: CACHLY_WORKSPACE, CLAUDE_PROJECT_DIR, cwd. */
  ordner?: string;
  /** Fuer Tests: Git ersetzen. */
  git?: GitAufruf;
  /** Fuer Tests: Umgebung ersetzen. */
  env?: NodeJS.ProcessEnv;
}

export interface LektionMitPfaden {
  ts?: unknown;
  verified_at?: unknown;
  file_paths?: unknown;
}

interface LogEintrag { kurz: string; datum: string; ms: number; betreff: string; dateien: string[] }
interface GitStand { log: LogEintrag[]; offen: string[] }

const ablage = new Map<string, { at: number; wert: Promise<GitStand | null> }>();
const wurzeln = new Map<string, Promise<string | null>>();

/** Nur fuer Tests: Ablagen leeren. */
export function leereAenderungsAblage(): void {
  ablage.clear();
  wurzeln.clear();
}

export function aenderungsHinweisAn(env: NodeJS.ProcessEnv = process.env): boolean {
  const w = String(env.CACHLY_AENDERUNGS_HINWEIS ?? '').trim().toLowerCase();
  return !['aus', '0', 'false', 'off', 'no', 'nein'].includes(w);
}

/**
 * Einen gespeicherten Pfad saeubern: Zeilenangaben ("datei.ts:42",
 * "datei.ts#L10", "datei.ts ~5527") weg, Backslashes zu Schraegstrichen.
 */
export function saeuberePfad(roh: string): string {
  return roh
    .trim()
    .replace(/\\/g, '/')
    .replace(/\s+~?\d+(-\d+)?$/, '')
    .replace(/#L\d+(-L?\d+)?$/i, '')
    .replace(/:\d+(-\d+)?$/, '')
    .replace(/\/+$/, '')
    .trim();
}

/**
 * Den gespeicherten Pfad relativ zur Repo-Wurzel.
 * Reihenfolge: existiert er vom Arbeitsordner aus, dann von der Wurzel aus,
 * sonst (geloescht oder verschoben) als Wurzel-Pfad fuer die Geschichte.
 * Liegt er ausserhalb des Repos: null.
 */
export function alsRepoPfad(pfad: string, ordner: string, wurzel: string, gibt = existsSync): string | null {
  if (!pfad) return null;
  let absolut: string;
  if (isAbsolute(pfad)) absolut = resolve(pfad);
  else if (gibt(join(ordner, pfad))) absolut = resolve(ordner, pfad);
  else absolut = resolve(wurzel, pfad);
  const rel = relative(resolve(wurzel), absolut).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel;
}

/** Datei `datei` (relativ zur Wurzel) gehoert zur Lektionsangabe `pfad`: gleich oder darunter. */
function gehoertZu(datei: string, pfad: string): boolean {
  return datei === pfad || datei.startsWith(`${pfad}/`);
}

const standardGit: GitAufruf = (ordner, args) => new Promise((ok, fehler) => {
  execFile('git', [...args], {
    cwd: ordner,
    encoding: 'utf-8',
    timeout: ZEITDECKEL_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }, (err, stdout) => (err ? fehler(err) : ok(String(stdout))));
});

function repoWurzel(ordner: string, git: GitAufruf): Promise<string | null> {
  let w = wurzeln.get(ordner);
  if (!w) {
    w = git(ordner, ['rev-parse', '--show-toplevel']).then((s) => s.trim() || null, () => null);
    wurzeln.set(ordner, w);
  }
  return w;
}

/** Ausgabe von `git log --format=%x1e%h%x09%cI%x09%s --name-only` zerlegen. */
export function zerlegeLog(roh: string): LogEintrag[] {
  const out: LogEintrag[] = [];
  for (const block of roh.split('\x1e')) {
    const zeilen = block.split('\n').map((z) => z.trim()).filter(Boolean);
    if (zeilen.length === 0) continue;
    const [kurz = '', datum = '', ...betreff] = zeilen[0].split('\t');
    const ms = Date.parse(datum);
    if (!kurz || !Number.isFinite(ms)) continue;
    out.push({ kurz, datum, ms, betreff: betreff.join('\t'), dateien: zeilen.slice(1) });
  }
  return out;
}

/** Ausgabe von `git status --porcelain` zu Pfaden (bei Umbenennung der neue). */
export function zerlegeStatus(roh: string): string[] {
  return roh.split('\n')
    .map((z) => z.replace(/\r$/, ''))
    .filter((z) => z.length > 3)
    .map((z) => {
      const p = z.slice(3);
      const pfeil = p.indexOf(' -> ');
      return (pfeil >= 0 ? p.slice(pfeil + 4) : p).replace(/^"|"$/g, '').trim();
    })
    .filter(Boolean);
}

interface Vorbereitet { seit: string; seitMs: number; pfade: string[] }

/**
 * Fuer mehrere Lektionen auf einmal: wurden ihre Dateien seit dem Schreiben
 * (oder der letzten echten Pruefung) geaendert? Je Lektion null = nein oder
 * unbekannt. Wirft nie.
 */
export async function aenderungenSeitLektionen(
  lektionen: ReadonlyArray<LektionMitPfaden | null | undefined>,
  o: PruefOptionen = {},
): Promise<Array<AenderungSeitLektion | null>> {
  const leer = lektionen.map(() => null);
  try {
    const env = o.env ?? process.env;
    if (!aenderungsHinweisAn(env)) return leer;
    if (!o.git && istMehrmandant()) return leer;

    const roh: Array<{ seit: string; seitMs: number; pfade: string[] } | null> = lektionen.map((l, i) => {
      if (!l || i >= MAX_LEKTIONEN) return null;
      const liste = Array.isArray(l.file_paths) ? l.file_paths : [];
      const pfade = [...new Set(liste.filter((p): p is string => typeof p === 'string').map(saeuberePfad).filter(Boolean))].slice(0, MAX_PFADE);
      if (pfade.length === 0) return null;
      const seitRoh = typeof l.verified_at === 'string' && l.verified_at ? l.verified_at : typeof l.ts === 'string' ? l.ts : '';
      const seitMs = Date.parse(seitRoh);
      if (!Number.isFinite(seitMs)) return null;
      return { seit: new Date(seitMs).toISOString(), seitMs, pfade };
    });
    if (roh.every((r) => r === null)) return leer;

    const git = o.git ?? standardGit;
    const ordner = resolve(o.ordner ?? (env.CACHLY_WORKSPACE || env.CLAUDE_PROJECT_DIR || arbeitsordner()));
    const wurzel = await repoWurzel(ordner, git);
    if (!wurzel) return leer;

    const vorbereitet: Array<Vorbereitet | null> = roh.map((r) => {
      if (!r) return null;
      const pfade = r.pfade.map((p) => alsRepoPfad(p, ordner, wurzel)).filter((p): p is string => !!p);
      return pfade.length > 0 ? { ...r, pfade } : null;
    });
    const alle = [...new Set(vorbereitet.flatMap((v) => v?.pfade ?? []))].sort();
    if (alle.length === 0) return leer;
    const frueheste = Math.min(...vorbereitet.filter((v): v is Vorbereitet => !!v).map((v) => v.seitMs));
    // `git log --since` hoert auf zu suchen, sobald ein Commit aelter ist als
    // das Datum — auch wenn dahinter (Uhr verstellt, Datum von Hand gesetzt)
    // ein neuerer liegt. Gefunden am 28.11.2026 mit dem Zeitzonen-Test: ein
    // Commit 30 Minuten vor der Lektion verdeckte drei Commits danach. Darum
    // sucht Git 30 Tage frueher; der genaue Vergleich je Lektion steht unten
    // (e.ms > v.seitMs). Ganz ohne --since: im cachly-Repo 350 statt 280 ms,
    // in grossen Repos unbegrenzt.
    const seitAlle = new Date(frueheste - SPIELRAUM_MS).toISOString();

    const schluessel = `${wurzel}\n${seitAlle}\n${alle.join('\n')}`;
    let eintrag = ablage.get(schluessel);
    if (!eintrag || Date.now() - eintrag.at >= ABLAGE_MS) {
      const angaben = alle.map((p) => `:(top)${p}`);
      const wert = Promise.all([
        git(wurzel, ['log', `--since=${seitAlle}`, '-n', String(MAX_LOG), '--format=%x1e%h%x09%cI%x09%s', '--name-only', '--', ...angaben]),
        git(wurzel, ['status', '--porcelain', '--', ...angaben]).catch(() => ''),
      ]).then(([log, status]) => ({ log: zerlegeLog(log), offen: zerlegeStatus(status) }), () => null);
      eintrag = { at: Date.now(), wert };
      ablage.set(schluessel, eintrag);
    }
    const stand = await eintrag.wert;
    if (!stand) return leer;

    return vorbereitet.map((v) => {
      if (!v) return null;
      const treffer = stand.log.filter((e) => e.ms > v.seitMs && e.dateien.some((d) => v.pfade.some((p) => gehoertZu(d, p))));
      const offen = stand.offen.filter((d) => v.pfade.some((p) => gehoertZu(d, p))).slice(0, 3);
      if (treffer.length === 0 && offen.length === 0) return null;
      const neuester = treffer[0];
      return {
        seit: v.seit,
        commits: Math.min(treffer.length, MAX_COMMITS),
        letzter: neuester ? { kurz: neuester.kurz, datum: neuester.datum, betreff: neuester.betreff } : undefined,
        offen,
      };
    });
  } catch {
    return leer;
  }
}

/** Die Warnzeile fuer eine Aenderung, oder ''. Englisch wie die uebrigen Recall-Banner. */
export function aenderungsZeile(a: AenderungSeitLektion | null): string {
  if (!a) return '';
  const teile: string[] = [];
  if (a.commits > 0 && a.letzter) {
    const anzahl = a.commits >= MAX_COMMITS ? `${MAX_COMMITS}+ commits` : `${a.commits} commit${a.commits === 1 ? '' : 's'}`;
    const betreff = a.letzter.betreff.length > 90 ? `${a.letzter.betreff.slice(0, 89)}…` : a.letzter.betreff;
    teile.push(`${anzahl} since then, latest ${a.letzter.kurz} on ${a.letzter.datum.slice(0, 10)}: "${betreff}"`);
  }
  if (a.offen.length > 0) {
    teile.push(`uncommitted changes in ${a.offen.map((p) => `\`${p}\``).join(', ')}`);
  }
  if (teile.length === 0) return '';
  return `⚠️ **FILES OF THIS LESSON CHANGED AFTER IT WAS WRITTEN** (${a.seit.slice(0, 10)}): ${teile.join('; ')}. ` +
    `Check the current code before applying it. If the code now says otherwise, the code wins: correct the lesson (learn_from_attempts with grund).`;
}

/** Eine Lektion rein, Warnzeile raus (oder ''). Wirft nie. */
export async function aenderungsHinweis(lektion: LektionMitPfaden | null | undefined, o: PruefOptionen = {}): Promise<string> {
  const [a] = await aenderungenSeitLektionen([lektion], o);
  return aenderungsZeile(a ?? null);
}

/** Mehrere Lektionen rein, je Lektion die Warnzeile (oder ''). Wirft nie. */
export async function aenderungsHinweise(
  lektionen: ReadonlyArray<LektionMitPfaden | null | undefined>,
  o: PruefOptionen = {},
): Promise<string[]> {
  const a = await aenderungenSeitLektionen(lektionen, o);
  return a.map((x) => aenderungsZeile(x));
}
