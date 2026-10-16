// Konto anlegen — EINE Stelle fuer den Sofort-Test, mit Sperre.
//
// ── Warum es das gibt (12.10.2026) ──────────────────────────────────────────
//
// Probe mit dem echten Plugin (cachly-brain 0.10.184, Claude Code 2.1.292,
// leerer Heimordner): Beim ersten Prompt lieferten SessionStart und
// UserPromptSubmit beide 0 Zeichen. Das Konto entstand erst im MCP-Server beim
// ersten WERKZEUGAUFRUF (zugang.ts). Ruft das Modell kein Werkzeug, bekommt
// der Nutzer nie eine Einblendung, und der Start-Import (startwissen.ts)
// beginnt nie.
//
// Jetzt legt schon der SessionStart-Hook das Konto an (ambient-hook.ts). Damit
// gibt es zwei Prozesse, die gleichzeitig "kein Schluessel" sehen koennen:
// den Hook und den MCP-Server. Beide gehen durch DIESE Funktion. Sie sorgt
// dafuer, dass daraus hoechstens EIN Konto wird:
//
//   1. Liegt schon ein Schluessel in ~/.cachly/credentials.json, ist er
//      der Schluessel. Kein neues Konto.
//   2. Sonst nimmt der Prozess die Sperrdatei ~/.cachly/anlegen.lock
//      (O_EXCL: das Betriebssystem laesst genau einen gewinnen).
//   3. Wer die Sperre nicht bekommt, wartet auf credentials.json — er legt
//      NIE selbst an, solange ein anderer es tut. Ist die Frist um, gibt er
//      auf (lieber kein Konto als zwei).
//   4. Wer sie hat, prueft noch einmal (Schluessel da?), holt den Sofort-Test
//      (sofort-test.ts), schreibt Schluessel UND Instanz und gibt die Sperre
//      erst DANACH frei. Der Wartende sieht also nie einen halben Stand.
//   5. Eine Sperre, die aelter als SPERRE_VERALTET_MS ist, stammt von einem
//      abgestuerzten Prozess und wird uebernommen.
//
// Nach einem Fehlschlag (kein Netz, Grenze erreicht) legt der Hook eine
// Marke ab und versucht es 10 Minuten nicht wieder: SessionStart feuert auch
// bei resume, clear und compact, und die Gegenstelle laesst nur 5 Versuche je
// IP und Stunde zu. Der MCP-Server ignoriert die Marke — er versucht es beim
// ersten Werkzeugaufruf, wie bisher.
//
// ── Der Start-Import ────────────────────────────────────────────────────────
//
// Der Import aus der Git-Geschichte braucht die Valkey-Verbindung, die
// Einbettung und die Zweitvektoren — alles im MCP-Server. Das Hook-Buendel
// ist bewusst abhaengigkeitsfrei und kann das nicht. Der Hook legt deshalb
// einen AUFTRAG ab (~/.cachly/startwissen-auftrag.json); der laufende MCP-
// Server nimmt ihn mit einem atomaren Umbenennen entgegen (nur einer
// gewinnt) und startet denselben Import wie nach einem Sofort-Test
// (startwissen.ts: nur Git-Repo, nur leeres Brain, einmal je Instanz).
//
// Seit dem 14.10.2026 importiert ein Nebenlauf des Hooks die Lektionen selbst
// ueber die API (startwissen-hook.ts) und schreibt den Auftrag erst danach,
// mit `vomHook`. Der Server rechnet dann nur noch, was die API nicht kann.

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  credentialsPath, readInstanceId, readSavedApiKey, saveApiKey, saveInstanceId, type CredentialsHomeOptions,
} from './credentials.js';
import { holeSofortTest, SOFORT_TEST_FRIST_MS, type SofortTest } from './sofort-test.js';

/** Eine Sperre, die so alt ist, stammt von einem abgestuerzten Prozess. */
export const SPERRE_VERALTET_MS = 15_000;
/** So oft sieht ein Wartender nach. */
export const WARTE_TAKT_MS = 100;
/** Nach einem Fehlschlag versucht der Hook es so lange nicht wieder. */
export const ABKUEHLUNG_HOOK_MS = 10 * 60 * 1000;
/** Ein Auftrag, der aelter ist, wird verworfen: der Nutzer ist laengst woanders. */
export const AUFTRAG_VERFAELLT_MS = 24 * 60 * 60 * 1000;

export const SPERRE = 'anlegen.lock';
export const FEHLSCHLAG = 'anlegen.fehler';
export const AUFTRAG = 'startwissen-auftrag.json';

/**
 * Darf nach dem Anlegen eines Brains aus der Git-Geschichte gelernt werden?
 * CACHLY_STARTWISSEN=false (auch 0, off, no, nein) schaltet es ab. Der MCP-
 * Server (index.ts) und der Hook fragen hier — eine Liste, nicht zwei.
 */
export function startwissenEingeschaltet(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|false|off|no|nein)$/i.test((env.CACHLY_STARTWISSEN ?? '').trim());
}

function ordner(opt: CredentialsHomeOptions): string {
  return dirname(credentialsPath(opt));
}

const schlafe = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface KontoOptionen extends CredentialsHomeOptions {
  apiUrl: string;
  version: string;
  env?: Record<string, string | undefined>;
  /** Gesamtfrist: Warten auf die Sperre UND die Anfrage. */
  fristMs: number;
  /** Frist der Anfrage selbst. Standard: die des MCP-Servers (8 s). */
  anfrageMs?: number;
  /** > 0: nach einem Fehlschlag so lange nicht erneut versuchen (nur der Hook). */
  abkuehlungMs?: number;
  /** Zum Einspeisen in Tests. */
  holen?: typeof fetch;
  jetzt?: () => number;
  schlafen?: (ms: number) => Promise<void>;
}

export type KontoErgebnis =
  /** Dieser Prozess hat das Konto angelegt. */
  | { art: 'angelegt'; test: SofortTest }
  /** Ein Schluessel lag schon da (oder ein anderer Prozess war schneller). */
  | { art: 'vorhanden'; apiKey: string; instanzId?: string }
  /** Kein Konto: `grund` sagt warum. Es wurde nichts angelegt, das nicht gespeichert ist. */
  | { art: 'gescheitert'; grund: 'kein-test' | 'sperre-belegt' | 'kein-schreibzugriff' | 'abgekuehlt' };

function vorhandenes(opt: CredentialsHomeOptions): { apiKey?: string; instanzId?: string } {
  return { apiKey: readSavedApiKey(opt), instanzId: readInstanceId(opt) };
}

function nimmSperre(pfad: string, jetzt: number): 'ja' | 'belegt' | 'kein-zugriff' {
  // Der Ordner zuerst und fuer sich: ein EEXIST von mkdir (ein Datei steht im
  // Weg) ist keine belegte Sperre.
  try { mkdirSync(dirname(pfad), { recursive: true }); } catch { return 'kein-zugriff'; }
  try {
    const fd = openSync(pfad, 'wx', 0o600);
    try { writeSync(fd, `${process.pid} ${jetzt}`); } finally { closeSync(fd); }
    return 'ja';
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'belegt' : 'kein-zugriff';
  }
}

function dateiAlter(pfad: string, jetzt: number): number | null {
  try { return jetzt - statSync(pfad).mtimeMs; } catch { return null; }
}

function gibFrei(pfad: string): void {
  try { unlinkSync(pfad); } catch { /* schon weg */ }
}

/** Liegt gerade eine frische Sperre (jemand legt an)? */
export function sperreLiegt(opt: CredentialsHomeOptions, jetzt: number = Date.now()): boolean {
  const alter = dateiAlter(join(ordner(opt), SPERRE), jetzt);
  return alter !== null && alter < SPERRE_VERALTET_MS;
}

/*
 * Das Alter der Fehlermarke kommt aus ihrem INHALT (dieselbe Uhr wie `jetzt`),
 * die Dateizeit ist nur Rueckfall fuer Marken ohne lesbare Zahl.
 *
 * Warum (13.10.2026): `mtimeMs` traegt Bruchteile einer Millisekunde,
 * `Date.now()` nur ganze. Kam der zweite Versuch in derselben Millisekunde,
 * war das Alter leicht negativ — und `alter >= 0` liess ihn durch. Der Test
 * "Abkuehlung (Hook)" wurde so beim Veroeffentlichen von 0.10.192 rot.
 */
function abgekuehlt(pfad: string, abkuehlungMs: number, jetzt: number): boolean {
  if (abkuehlungMs <= 0) return false;
  let seit: number | null = null;
  try {
    const n = Number(readFileSync(pfad, 'utf8').trim());
    if (Number.isFinite(n) && n > 0) seit = n;
  } catch { /* keine Marke */ }
  const alter = seit !== null ? jetzt - seit : dateiAlter(pfad, jetzt);
  return alter !== null && alter >= 0 && alter < abkuehlungMs;
}

function merkeFehlschlag(pfad: string, jetzt: number): void {
  try {
    mkdirSync(dirname(pfad), { recursive: true });
    writeFileSync(pfad, String(jetzt), { mode: 0o600 });
  } catch { /* die Marke ist bestes Bemuehen */ }
}

/**
 * Stellt sicher, dass es ein Konto gibt — hoechstens eines, auch wenn Hook
 * und MCP-Server gleichzeitig kommen. Wirft nie.
 */
export async function sichereKonto(opt: KontoOptionen): Promise<KontoErgebnis> {
  const jetzt = opt.jetzt ?? Date.now;
  const schlafen = opt.schlafen ?? schlafe;
  const ende = jetzt() + opt.fristMs;
  const dir = ordner(opt);
  const sperre = join(dir, SPERRE);
  const fehlerMarke = join(dir, FEHLSCHLAG);

  try {
    for (;;) {
      // 1. Ein Schluessel, der schon da ist, ist der Schluessel. Steht die
      //    Instanz noch aus und jemand haelt die Sperre, wird sie gleich
      //    nachgetragen: darauf warten wir.
      const da = vorhandenes(opt);
      if (da.apiKey && (da.instanzId || !sperreLiegt(opt, jetzt()))) {
        return { art: 'vorhanden', apiKey: da.apiKey, instanzId: da.instanzId };
      }

      if (!da.apiKey) {
        const stand = nimmSperre(sperre, jetzt());
        if (stand === 'kein-zugriff') return { art: 'gescheitert', grund: 'kein-schreibzugriff' };
        if (stand === 'ja') {
          try {
            // 2. Noch einmal pruefen, jetzt unter der Sperre: zwischen dem
            //    ersten Blick und dem Nehmen kann ein anderer fertig geworden sein.
            const nochmal = vorhandenes(opt);
            if (nochmal.apiKey) return { art: 'vorhanden', apiKey: nochmal.apiKey, instanzId: nochmal.instanzId };
            if (abgekuehlt(fehlerMarke, opt.abkuehlungMs ?? 0, jetzt())) return { art: 'gescheitert', grund: 'abgekuehlt' };

            const rest = Math.max(500, ende - jetzt());
            const test = await holeSofortTest({
              apiUrl: opt.apiUrl,
              version: opt.version,
              holen: opt.holen,
              env: opt.env,
              fristMs: Math.min(rest, opt.anfrageMs ?? SOFORT_TEST_FRIST_MS),
              speichern: (key) => saveApiKey(key, opt),
            });
            if (!test) {
              merkeFehlschlag(fehlerMarke, jetzt());
              return { art: 'gescheitert', grund: 'kein-test' };
            }
            saveInstanceId(test.instanzId, { ...opt, apiKey: test.apiKey });
            gibFrei(fehlerMarke);
            return { art: 'angelegt', test };
          } finally {
            // 3. Erst jetzt, nach Schluessel UND Instanz.
            gibFrei(sperre);
          }
        }
        // Belegt. Eine Sperre aus einem abgestuerzten Prozess uebernehmen.
        const alter = dateiAlter(sperre, jetzt());
        if (alter !== null && alter >= SPERRE_VERALTET_MS) gibFrei(sperre);
      }

      if (jetzt() >= ende) {
        return da.apiKey
          ? { art: 'vorhanden', apiKey: da.apiKey, instanzId: da.instanzId }
          : { art: 'gescheitert', grund: 'sperre-belegt' };
      }
      await schlafen(WARTE_TAKT_MS);
    }
  } catch {
    return { art: 'gescheitert', grund: 'kein-test' };
  }
}

// ── Der Auftrag fuer den Start-Import ────────────────────────────────────────

/** Was der Nebenlauf des Hooks schon ueber die API importiert hat (startwissen-hook.ts). */
export interface HookImport {
  art: 'git' | 'startvorrat';
  /** So viele Lektionen hat die API angenommen. */
  lektionen: number;
}

export interface StartwissenAuftrag {
  instanzId: string;
  /** Projektordner des Hooks (CLAUDE_PROJECT_DIR). Der Import liest dessen Git-Geschichte. */
  projekt: string;
  am: string;
  /** Gesetzt: die Lektionen sind schon da, der Server rechnet nur noch nach. */
  vomHook?: HookImport;
}

function leseHookImport(roh: unknown): HookImport | undefined {
  const h = roh as Partial<HookImport> | null | undefined;
  if (!h || (h.art !== 'git' && h.art !== 'startvorrat')) return undefined;
  const lektionen = Number(h.lektionen);
  return Number.isInteger(lektionen) && lektionen > 0 ? { art: h.art, lektionen } : undefined;
}

/** Hinterlaesst den Auftrag fuer den MCP-Server. Wirft nie. */
export function schreibeAuftrag(
  a: { instanzId: string; projekt: string; vomHook?: HookImport },
  opt: CredentialsHomeOptions = {},
): void {
  try {
    const pfad = join(ordner(opt), AUFTRAG);
    mkdirSync(dirname(pfad), { recursive: true });
    const tmp = `${pfad}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...a, am: new Date().toISOString() }), { mode: 0o600 });
    renameSync(tmp, pfad);
  } catch { /* ohne Auftrag laeuft der Hook trotzdem; nur der Import fehlt */ }
}

/** Liegt ein Auftrag da? (Ohne ihn zu nehmen.) */
export function auftragLiegt(opt: CredentialsHomeOptions = {}): boolean {
  return existsSync(join(ordner(opt), AUFTRAG));
}

/**
 * Nimmt den Auftrag entgegen — atomar: wer ihn umbenennt, hat ihn. Zwei
 * MCP-Server (zwei Sitzungen) starten den Import so nie beide. Gibt null
 * zurueck, wenn keiner da ist, er einem anderen gehoert oder verfallen ist.
 */
export function nimmAuftrag(opt: CredentialsHomeOptions = {}, jetzt: number = Date.now()): StartwissenAuftrag | null {
  const pfad = join(ordner(opt), AUFTRAG);
  const meiner = `${pfad}.${process.pid}.genommen`;
  try { renameSync(pfad, meiner); } catch { return null; }
  try {
    const roh = JSON.parse(readFileSync(meiner, 'utf8')) as Partial<StartwissenAuftrag> | null;
    const am = Date.parse(String(roh?.am ?? ''));
    if (!roh || typeof roh.instanzId !== 'string' || !roh.instanzId) return null;
    if (!Number.isFinite(am) || jetzt - am > AUFTRAG_VERFAELLT_MS) return null;
    const vomHook = leseHookImport(roh.vomHook);
    return {
      instanzId: roh.instanzId,
      projekt: typeof roh.projekt === 'string' ? roh.projekt : '',
      am: String(roh.am),
      ...(vomHook ? { vomHook } : {}),
    };
  } catch {
    return null;
  } finally {
    try { unlinkSync(meiner); } catch { /* weg */ }
  }
}
