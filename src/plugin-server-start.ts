/**
 * Starter des MCP-Servers fuer das Claude-Code-Plugin.
 *
 * ── Warum es das gibt (10.11.2026) ──────────────────────────────────────────
 *
 * Das Plugin startete den Server mit `npx -y @cachly-dev/mcp-server`. Bei
 * einem Paketnamen ohne Fassung fragt npx bei JEDEM Start npm nach der
 * neuesten Fassung (libnpmexec: preferOnline). Gemessen auf Windows bis zur
 * Antwort auf `initialize`: 4,5 s warm, 13,6 s mit Nachladen. Der Server
 * selbst braucht 0,9 s. Am 09.11.2026 um 23:49 starteten drei Sitzungen in
 * derselben Sekunde; eine lief in die 30-s-Grenze von Claude Code
 * (CONNECT_TIMEOUT), und das Plugin fehlte ihr die ganze Sitzung.
 *
 * Jetzt laedt der Starter eine fertige Kopie aus ~/.cachly/server direkt in
 * diesen Prozess, ohne npm und ohne Netz. Ob es eine neuere Fassung gibt,
 * prueft ein abgetrennter Nebenlauf hoechstens einmal je Stunde. Er legt die
 * neue Fassung neben die alte und stellt den Zeiger (stand.json) erst um,
 * wenn sie vollstaendig da ist. Wirksam wird sie beim naechsten Start.
 * Ohne Kopie (erster Start) laeuft npx wie bisher; der Nebenlauf legt die
 * Kopie fuer das naechste Mal an.
 *
 * Abschalten: CACHLY_PLUGIN_NPX=1 startet immer ueber npx wie vor 0.10.241.
 *
 * Erzeugnis: hooks/cachly-server-start.mjs (scripts/plugin-hooks-schreiben.mjs).
 * Waechter:  src/__tests__/plugin-server-start.test.ts
 */

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PAKET = '@cachly-dev/mcp-server';
/** Aufrufschalter des Nebenlaufs: `node cachly-server-start.mjs --auffrischen`. */
export const AUFFRISCHEN = '--auffrischen';
/** Hoechstens eine Anfrage an npm je Stunde, ueber alle Sitzungen. */
export const PRUEF_ABSTAND_MS = 60 * 60 * 1000;
/** Eine Sperre, die so alt ist, gehoert zu einem abgebrochenen Nebenlauf. */
export const SPERRE_VERFALL_MS = 10 * 60 * 1000;
/** Wartezeit des Nebenlaufs, damit er nicht mit dem Sitzungsstart um die Maschine ringt. */
export const NEBENLAUF_PAUSE_MS = 20_000;

const FASSUNG = /^\d+\.\d+\.\d+$/;
const WINDOWS = process.platform === 'win32';

type Umgebung = Record<string, string | undefined>;

/** Wo die Kopien liegen. CACHLY_SERVER_ORDNER fuer Tests und Sonderfaelle. */
export function serverOrdner(env: Umgebung = process.env): string {
  const eigen = env.CACHLY_SERVER_ORDNER?.trim();
  if (eigen) return eigen;
  return join(env.HOME || env.USERPROFILE || homedir(), '.cachly', 'server');
}

function fassungsOrdner(ordner: string, fassung: string): string {
  return join(ordner, 'fassungen', fassung);
}

/**
 * Die Startdatei einer installierten Fassung, oder null, wenn sie fehlt oder
 * nicht die erwartete Fassung ist. Der Pfad kommt aus dem package.json der
 * Kopie (bin), nicht aus stand.json — dort steht nur die Nummer.
 */
export function einstieg(paketOrdner: string, fassung: string): string | null {
  try {
    const paket = JSON.parse(readFileSync(join(paketOrdner, 'package.json'), 'utf8')) as {
      version?: string; bin?: Record<string, string> | string; main?: string;
    };
    if (paket.version !== fassung) return null;
    const bin = typeof paket.bin === 'string' ? paket.bin : paket.bin?.['cachly-mcp'];
    const datei = resolve(paketOrdner, bin ?? paket.main ?? 'dist/src/index.js');
    return existsSync(datei) ? datei : null;
  } catch {
    return null;
  }
}

function paketIn(installOrdner: string): string {
  return join(installOrdner, 'node_modules', '@cachly-dev', 'mcp-server');
}

export interface Stand { fassung: string; datei: string }

/** Die Kopie, die beim Start geladen wird — oder null (dann npx). */
export function liesStand(ordner: string): Stand | null {
  try {
    const roh = JSON.parse(readFileSync(join(ordner, 'stand.json'), 'utf8')) as { fassung?: unknown };
    if (typeof roh.fassung !== 'string' || !FASSUNG.test(roh.fassung)) return null;
    const datei = einstieg(paketIn(fassungsOrdner(ordner, roh.fassung)), roh.fassung);
    return datei ? { fassung: roh.fassung, datei } : null;
  } catch {
    return null;
  }
}

/**
 * Umbenennen mit Wiederholung. Unter Windows halten Virenscanner und Indexer
 * frisch geschriebene Dateien kurz fest; dann scheitert rename mit EPERM/EBUSY.
 */
function benenneUm(von: string, nach: string): void {
  for (let versuch = 1; ; versuch++) {
    try {
      renameSync(von, nach);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (versuch >= 6 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * versuch);
    }
  }
}

function schreibeAtomar(datei: string, inhalt: string): void {
  mkdirSync(dirname(datei), { recursive: true });
  const zwischen = `${datei}.${process.pid}.${Date.now()}`;
  writeFileSync(zwischen, inhalt, 'utf8');
  try {
    benenneUm(zwischen, datei);
  } catch (e) {
    rmSync(zwischen, { force: true });
    throw e;
  }
}

/** Ist eine Pruefung bei npm dran? (pruefung.json traegt den letzten Versuch.) */
export function pruefungDran(ordner: string, jetzt: number = Date.now()): boolean {
  try {
    const { at } = JSON.parse(readFileSync(join(ordner, 'pruefung.json'), 'utf8')) as { at?: unknown };
    return typeof at !== 'number' || jetzt - at >= PRUEF_ABSTAND_MS || at > jetzt;
  } catch {
    return true;
  }
}

/** Nur ein Nebenlauf zur Zeit holt. Gibt die Freigabe zurueck oder null. */
function sperre(ordner: string, jetzt: number): (() => void) | null {
  const datei = join(ordner, 'holt.sperre');
  mkdirSync(ordner, { recursive: true });
  for (let versuch = 0; versuch < 2; versuch++) {
    try {
      writeFileSync(datei, String(process.pid), { flag: 'wx' });
      return () => rmSync(datei, { force: true });
    } catch {
      try {
        if (jetzt - statSync(datei).mtimeMs < SPERRE_VERFALL_MS) return null;
        rmSync(datei, { force: true });
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Entfernt alte Fassungen und liegengebliebene Zwischenordner. Fehler zaehlen nicht. */
export function raeumeAuf(ordner: string, behalten: ReadonlyArray<string | undefined>, jetzt: number = Date.now()): void {
  const wurzel = join(ordner, 'fassungen');
  let namen: string[];
  try {
    namen = readdirSync(wurzel);
  } catch {
    return;
  }
  for (const name of namen) {
    if (behalten.includes(name)) continue;
    const pfad = join(wurzel, name);
    try {
      // Ein Zwischenordner, der juenger ist als eine Sperre, gehoert einem laufenden Nebenlauf.
      if (name.startsWith('.neu-') && jetzt - statSync(pfad).mtimeMs < SPERRE_VERFALL_MS) continue;
      rmSync(pfad, { recursive: true, force: true });
    } catch {
      // Unter Windows kann eine Datei belegt sein. Dann beim naechsten Mal.
    }
  }
}

export interface Werkzeuge {
  /** Die neueste Fassung laut npm, oder null. */
  holeNeueste: () => Promise<string | null>;
  /** Installiert PAKET@fassung nach <ordner>/node_modules. */
  installiere: (ordner: string, fassung: string) => Promise<void>;
  jetzt?: () => number;
}

/**
 * Der Nebenlauf: prueft npm und legt eine neue Fassung an. Gibt zurueck, was
 * geschah — fuer die Tests und die Fehlersuche, nicht fuer den Nutzer.
 */
export async function auffrischen(ordner: string, w: Werkzeuge): Promise<string> {
  const jetzt = w.jetzt?.() ?? Date.now();
  if (!pruefungDran(ordner, jetzt)) return 'nicht dran';
  const freigabe = sperre(ordner, jetzt);
  if (!freigabe) return 'ein anderer Nebenlauf holt gerade';
  try {
    // Vor der Anfrage vermerken: auch eine gescheiterte Anfrage zaehlt als Versuch.
    schreibeAtomar(join(ordner, 'pruefung.json'), `${JSON.stringify({ at: jetzt })}\n`);
    const neueste = await w.holeNeueste();
    if (!neueste || !FASSUNG.test(neueste)) return 'npm gab keine Fassung';
    const alt = liesStand(ordner);
    if (alt?.fassung === neueste) return `aktuell (${neueste})`;

    const ziel = fassungsOrdner(ordner, neueste);
    if (!einstieg(paketIn(ziel), neueste)) {
      const zwischen = join(ordner, 'fassungen', `.neu-${neueste}-${process.pid}`);
      rmSync(zwischen, { recursive: true, force: true });
      mkdirSync(zwischen, { recursive: true });
      // Ohne eigenes package.json sucht npm aufwaerts nach einem Projekt und installiert dort.
      writeFileSync(join(zwischen, 'package.json'), '{ "private": true }\n', 'utf8');
      await w.installiere(zwischen, neueste);
      if (!einstieg(paketIn(zwischen), neueste)) {
        rmSync(zwischen, { recursive: true, force: true });
        return `Installation von ${neueste} unvollstaendig`;
      }
      rmSync(ziel, { recursive: true, force: true });
      benenneUm(zwischen, ziel);
    }
    schreibeAtomar(join(ordner, 'stand.json'), `${JSON.stringify({ fassung: neueste })}\n`);
    // Die bisherige Fassung bleibt: eine laufende Sitzung kann sie noch nutzen.
    raeumeAuf(ordner, [neueste, alt?.fassung], jetzt);
    return `geholt (${alt?.fassung ?? 'keine'} -> ${neueste})`;
  } catch (e) {
    return `Fehler: ${(e as Error).message}`;
  } finally {
    freigabe();
  }
}

/** npm im Hintergrund. Ohne Ausgabe: dieser Prozess darf stdout nie beruehren. */
function npm(args: string[], cwd: string, fristMs: number): Promise<string> {
  return new Promise((ok, fehler) => {
    // Unter Windows ist npm eine .cmd-Datei und braucht die Shell. Die Argumente
    // sind feste Schalter und eine gepruefte Fassungsnummer; der Ordner geht als cwd.
    const kind = spawn('npm', args, { cwd, shell: WINDOWS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let aus = '';
    kind.stdout?.on('data', (d) => { aus += String(d); });
    const uhr = setTimeout(() => { kind.kill(); fehler(new Error(`npm ${args[0]}: Zeitgrenze`)); }, fristMs);
    kind.on('error', (e) => { clearTimeout(uhr); fehler(e); });
    kind.on('exit', (code) => {
      clearTimeout(uhr);
      if (code === 0) ok(aus);
      else fehler(new Error(`npm ${args[0]}: Ende mit ${code}`));
    });
  });
}

export const npmWerkzeuge = (ordner: string): Werkzeuge => ({
  holeNeueste: async () => {
    mkdirSync(ordner, { recursive: true });
    // npm statt fetch: so gelten Registry und Proxy aus der .npmrc des Nutzers.
    const aus = (await npm(['view', `${PAKET}@latest`, 'version'], ordner, 30_000)).trim();
    return FASSUNG.test(aus) ? aus : null;
  },
  installiere: async (ziel, fassung) => {
    if (!FASSUNG.test(fassung)) throw new Error('ungueltige Fassung');
    await npm([
      'install', `${PAKET}@${fassung}`,
      '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error',
    ], ziel, 5 * 60_000);
  },
});

/** Startet den Nebenlauf abgetrennt; er ueberlebt diesen Prozess. */
function starteNebenlauf(selbst: string): void {
  try {
    const kind = spawn(process.execPath, [selbst, AUFFRISCHEN], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    kind.on('error', () => undefined);
    kind.unref();
  } catch {
    // Ohne Nebenlauf startet der Server trotzdem; die Kopie altert nur.
  }
}

function starteNpx(): void {
  const kind = spawn('npx', ['-y', PAKET], { stdio: 'inherit', shell: WINDOWS, windowsHide: true });
  kind.on('error', (e) => {
    process.stderr.write(`[cachly-start] npx liess sich nicht starten: ${e.message}\n`);
    process.exit(1);
  });
  kind.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => kind.kill(s));
}

/** Der Normalfall: Kopie laden, sonst npx. Der Nebenlauf startet nur, wenn er dran ist. */
export async function starte(selbst: string, env: Umgebung = process.env): Promise<void> {
  const ordner = serverOrdner(env);
  if (/^(1|true|on|ja|yes)$/i.test((env.CACHLY_PLUGIN_NPX ?? '').trim())) {
    starteNpx();
    return;
  }
  if (pruefungDran(ordner)) starteNebenlauf(selbst);
  const stand = liesStand(ordner);
  if (stand) {
    try {
      await import(pathToFileURL(stand.datei).href);
      return;
    } catch (e) {
      // Hat der Server stdin schon uebernommen, darf kein zweiter starten.
      if (process.stdin.listenerCount('data') > 0) throw e;
      process.stderr.write(`[cachly-start] Kopie ${stand.fassung} laedt nicht (${(e as Error).message}) — starte ueber npx.\n`);
      try { rmSync(join(ordner, 'stand.json'), { force: true }); } catch { /* naechstes Mal */ }
    }
  }
  starteNpx();
}

async function nebenlauf(env: Umgebung = process.env): Promise<void> {
  const pause = Number(env.CACHLY_NEBENLAUF_PAUSE_MS ?? NEBENLAUF_PAUSE_MS);
  await new Promise((r) => setTimeout(r, Number.isFinite(pause) ? pause : NEBENLAUF_PAUSE_MS));
  const ordner = serverOrdner(env);
  const ergebnis = await auffrischen(ordner, npmWerkzeuge(ordner));
  try {
    schreibeAtomar(join(ordner, 'letzter-lauf.json'), `${JSON.stringify({ at: new Date().toISOString(), ergebnis })}\n`);
  } catch { /* nur Fehlersuche */ }
}

const selbst = process.argv[1] ? resolve(process.argv[1]) : '';
const hier = fileURLToPath(import.meta.url);
if (selbst && (selbst === hier || selbst.endsWith('cachly-server-start.mjs'))) {
  if (process.argv[2] === AUFFRISCHEN) {
    await nebenlauf().catch(() => undefined);
    process.exit(0);
  } else {
    await starte(selbst);
  }
}
