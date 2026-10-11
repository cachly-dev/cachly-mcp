// Neue Fassung — wer eine alte Fassung benutzt, erfaehrt es einmal je Sitzung.
//
// ── Warum es das gibt (11.10.2026) ──────────────────────────────────────────
//
// Claude Code aktualisiert Plugins aus fremden Marktplaetzen von sich aus
// NICHT (Auto-Update ist dort aus). Auch ein npx-Aufruf mit festem Stand oder
// eine Installation in ~/.cachly-mcp holt nie von selbst nach. Wer einmal
// installiert hat, bleibt stehen: auf dem Rechner des Gruenders lief seit dem
// 28.08. die Fassung 0.10.138, waehrend auf npm schon 0.10.178 lag.
//
// Einen Hinweis gab es zwar (index.ts, "Update nudge"), aber nur auf stderr.
// Das ist das Protokoll des Editors, das niemand liest. Er verglich ausserdem
// mit `!==`, meldete also auch eine KLEINERE Fassung als "Update", und fragte
// bei jedem Start neu bei npm an.
//
// ── Was jetzt gilt ──────────────────────────────────────────────────────────
//
//   1. Hoechstens EINE Anfrage an npm je 24 Stunden. Das Ergebnis steht in
//      ~/.cachly/update-check.json; jeder Start innerhalb von 24 Stunden liest
//      nur diese Datei und fragt das Netz nicht.
//   2. Die Anfrage laeuft im Hintergrund, hoechstens 2 Sekunden. Weder der
//      Start noch ein Werkzeugaufruf wartet darauf. Fehlt das Netz oder dauert
//      es laenger, bleibt alles still und die Datei unveraendert.
//   3. Die Zeile erscheint EINMAL je Prozess (= je Editor-Sitzung), am Ende der
//      Antwort von session_start — ausserhalb des Rahmens um gespeicherten Text
//      (antwort-rahmen.ts), denn sie ist eine Meldung des Servers.
//   4. Nur wenn die neueste Fassung nach Semver GROESSER ist. Gleich oder
//      kleiner (zum Beispiel eine Vorabfassung) bleibt stumm.
//   5. Abschalten: CACHLY_UPDATE_CHECK=false (oder 0 / off / no). Der aeltere
//      Schalter CACHLY_NO_UPDATE_CHECK=1 gilt weiter.
//
// Was ausdruecklich NICHT passiert: Es wird nichts installiert, nichts
// heruntergeladen und nichts ueber den Nutzer an npm geschickt ausser der
// Anfrage selbst. Der Server aktualisiert sich nicht selbst.

import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Wo die neueste Fassung steht. Feld `version`. */
export const REGISTER_URL = 'https://registry.npmjs.org/@cachly-dev/mcp-server/latest';
/** Hoechstens eine Anfrage in dieser Zeit. */
export const ABFRAGE_ABSTAND_MS = 24 * 60 * 60 * 1000;
/** So lange wartet die Anfrage hoechstens. */
export const ZEITGRENZE_MS = 2000;
/** Der Hinweis haengt nur an diesen Werkzeugen: dem Beginn einer Sitzung. */
export const SITZUNGSBEGINN_WERKZEUGE: ReadonlySet<string> = new Set(['session_start', 'session_start_summary']);

// ── Semver ───────────────────────────────────────────────────────────────────

interface Fassung {
  kern: [number, number, number];
  vorab: string[];
}

const SEMVER = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

function lies(text: unknown): Fassung | null {
  if (typeof text !== 'string' || text.length > 64) return null;
  const m = SEMVER.exec(text.trim());
  if (!m) return null;
  return {
    kern: [Number(m[1]), Number(m[2]), Number(m[3])],
    vorab: m[4] ? m[4].split('.') : [],
  };
}

/** Ist `text` eine Fassungsnummer, die wir ungeprueft in einen Satz setzen duerfen? */
export function istFassung(text: unknown): text is string {
  return lies(text) !== null;
}

function vergleicheVorab(a: string[], b: string[]): number {
  // Ohne Vorab-Teil ist GROESSER als mit (1.0.0 > 1.0.0-beta).
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // Zahlen sind kleiner als Text
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** true nur, wenn `neu` nach Semver echt GROESSER ist als `alt`. Unlesbares ist nie neuer. */
export function istNeuer(neu: string, alt: string): boolean {
  const n = lies(neu);
  const a = lies(alt);
  if (!n || !a) return false;
  for (let i = 0; i < 3; i++) {
    if (n.kern[i] !== a.kern[i]) return n.kern[i] > a.kern[i];
  }
  return vergleicheVorab(n.vorab, a.vorab) > 0;
}

// ── Schalter ─────────────────────────────────────────────────────────────────

/** true = der Nutzer hat die Pruefung abgeschaltet. */
export function pruefungAus(env: Record<string, string | undefined> = process.env): boolean {
  const neu = (env.CACHLY_UPDATE_CHECK ?? '').trim().toLowerCase();
  if (neu === 'false' || neu === '0' || neu === 'off' || neu === 'no') return true;
  // Der aeltere Schalter: jeder nichtleere Wert schaltet ab.
  return Boolean(env.CACHLY_NO_UPDATE_CHECK);
}

// ── Zwischenspeicher ─────────────────────────────────────────────────────────

interface Stand {
  /** Wann zuletzt bei npm nachgefragt wurde (ISO 8601). */
  checkedAt: string;
  /** Die neueste Fassung, die npm damals nannte. */
  latest: string;
}

/** `<heim>/.cachly/update-check.json` */
export function standPfad(heim: string): string {
  return join(heim, '.cachly', 'update-check.json');
}

async function leseStand(pfad: string): Promise<{ zeit: number; latest: string } | null> {
  try {
    const roh = JSON.parse(await readFile(pfad, 'utf8')) as Partial<Stand> | null;
    if (!roh || typeof roh !== 'object') return null;
    const zeit = Date.parse(String(roh.checkedAt));
    if (!Number.isFinite(zeit) || !istFassung(roh.latest)) return null;
    return { zeit, latest: roh.latest };
  } catch {
    return null;
  }
}

async function schreibeStand(pfad: string, stand: Stand): Promise<void> {
  try {
    await mkdir(dirname(pfad), { recursive: true });
    // Erst daneben schreiben, dann umbenennen: ein Absturz hinterlaesst nie eine halbe Datei.
    const tmp = `${pfad}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(stand, null, 2) + '\n', 'utf8');
    await rename(tmp, pfad);
  } catch { /* ohne Zwischenspeicher fragen wir eben beim naechsten Start wieder */ }
}

// ── Die Anfrage ──────────────────────────────────────────────────────────────

/** Fragt npm. Gibt die Fassung zurueck oder wirft — der Aufrufer macht daraus Stille. */
async function frageNpm(holen: typeof fetch, zeitgrenzeMs: number): Promise<string> {
  let uhr: ReturnType<typeof setTimeout> | undefined;
  const abbruch = new AbortController();
  const frist = new Promise<never>((_, nein) => {
    uhr = setTimeout(() => { abbruch.abort(); nein(new Error('timeout')); }, zeitgrenzeMs);
    uhr.unref?.();
  });
  try {
    const lauf = (async () => {
      const res = await holen(REGISTER_URL, { signal: abbruch.signal, headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
      const daten = await res.json() as { version?: unknown } | null;
      const v = daten?.version;
      if (!istFassung(v)) throw new Error('registry returned no version');
      return v.trim();
    })();
    lauf.catch(() => undefined); // verliert die Frist, soll kein unbehandeltes Versprechen bleiben
    return await Promise.race([lauf, frist]);
  } finally {
    if (uhr) clearTimeout(uhr);
  }
}

// ── Zustand dieses Prozesses ─────────────────────────────────────────────────

let _aktuelle = '';
let _neueste = '';
let _gezeigt = false;

export interface PruefUmfeld {
  /** Die laufende Fassung (CURRENT_VERSION aus index.ts). */
  aktuelle: string;
  env?: Record<string, string | undefined>;
  /** Heimordner; Standard: HOME / USERPROFILE / os.homedir(). */
  heim?: string;
  /** Zum Einspeisen in Tests. */
  holen?: typeof fetch;
  jetzt?: () => number;
  zeitgrenzeMs?: number;
  /** Zeile fuer das Editor-Protokoll. Standard: stderr. */
  protokoll?: (zeile: string) => void;
}

export type PruefErgebnis =
  | { art: 'aus' }
  | { art: 'zwischenspeicher'; neueste: string; neuer: boolean }
  | { art: 'abgefragt'; neueste: string; neuer: boolean }
  /** Netz weg, Zeitgrenze, kaputte Antwort: kein Laut, kein Schaden. */
  | { art: 'still'; grund: string; neuer: boolean };

function heimordner(env: Record<string, string | undefined>): string {
  return (env.HOME || env.USERPROFILE || '').trim() || homedir() || '';
}

/**
 * Prueft im Hintergrund, ob es eine neuere Fassung gibt, und merkt sie sich fuer
 * `holeNeueFassungHinweis`. Wirft NIE. Der Aufrufer wartet nicht darauf; das
 * Versprechen gibt es nur fuer Tests.
 */
export async function pruefeNeueFassung(u: PruefUmfeld): Promise<PruefErgebnis> {
  const env = u.env ?? process.env;
  _aktuelle = u.aktuelle;
  _neueste = '';
  if (pruefungAus(env)) return { art: 'aus' };

  const log = u.protokoll ?? ((z: string) => { process.stderr.write(z); });
  const merke = (neueste: string): boolean => {
    const neuer = istNeuer(neueste, u.aktuelle);
    if (neuer) {
      _neueste = neueste;
      try { log(`\n⚡ cachly update available: ${u.aktuelle} → ${neueste}\n`); } catch { /* Protokoll stoert nie */ }
    }
    return neuer;
  };

  const heim = u.heim ?? heimordner(env);
  const pfad = heim ? standPfad(heim) : '';
  const jetzt = (u.jetzt ?? Date.now)();
  const alt = pfad ? await leseStand(pfad) : null;

  // Frisch genug (und nicht aus der Zukunft): das Netz bleibt in Ruhe.
  if (alt && jetzt - alt.zeit >= 0 && jetzt - alt.zeit < ABFRAGE_ABSTAND_MS) {
    return { art: 'zwischenspeicher', neueste: alt.latest, neuer: merke(alt.latest) };
  }

  try {
    const neueste = await frageNpm(u.holen ?? fetch, u.zeitgrenzeMs ?? ZEITGRENZE_MS);
    if (pfad) await schreibeStand(pfad, { checkedAt: new Date(jetzt).toISOString(), latest: neueste });
    return { art: 'abgefragt', neueste, neuer: merke(neueste) };
  } catch (e) {
    // Die alte Antwort aus der Datei war einmal wahr: Fassungen werden nur groesser.
    const neuer = alt ? merke(alt.latest) : false;
    return { art: 'still', grund: e instanceof Error ? e.message : String(e), neuer };
  }
}

// ── Als Plugin zaehlt die Fassung des PLUGINS ───────────────────────────────
//
// Das Claude-Code-Plugin startet den Server mit `npx -y @cachly-dev/mcp-server`,
// ohne Fassung. npx holt dabei die neueste (gemessen 11.10.2026 mit npm
// 10.9.2: der npx-Ordner sprang beim Start von 0.10.174 auf 0.10.180). Der
// Server ist also immer neu. Die Hooks aber liegen IM Plugin (hooks/), und das
// Plugin aktualisiert Claude Code bei fremden Marktplaetzen nur mit
// eingeschaltetem Auto-Update — Vorgabe: aus.
//
// Der Vergleich "Server gegen npm" meldete Plugin-Nutzern deshalb nie etwas.
// Beim Gruender stand das Plugin seit dem 28.08. auf 0.10.138, 42 Fassungen
// zurueck, ohne einen einzigen Hinweis. Als Plugin wird darum die Fassung des
// Plugins verglichen:
//   1. ${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json — Claude Code gibt den
//      Pfad laut Doku jedem stdio-Server des Plugins mit.
//   2. sonst ~/.claude/plugins/installed_plugins.json, Eintrag
//      `cachly-brain@cachly` (aeltere Claude-Code-Fassungen).
// Findet sich nichts Lesbares, bleibt es bei der Fassung des Servers.

/** Name des Plugins im Marktplatz, wie ihn installed_plugins.json fuehrt. */
export const PLUGIN_SCHLUESSEL = 'cachly-brain@cachly';

type Leser = (pfad: string) => string;
const leseDatei: Leser = (pfad) => readFileSync(pfad, 'utf8');

function alsPlugin(env: Record<string, string | undefined>): boolean {
  return env.CACHLY_QUELLE?.trim() === 'claude-code-plugin';
}

/** Die Fassung des installierten Plugins, oder null. Wirft nie. */
export function pluginFassung(
  env: Record<string, string | undefined> = process.env,
  heim: string = heimordner(env),
  lese: Leser = leseDatei,
): string | null {
  const wurzel = env.CLAUDE_PLUGIN_ROOT?.trim();
  if (wurzel) {
    try {
      const v = (JSON.parse(lese(join(wurzel, '.claude-plugin', 'plugin.json'))) as { version?: unknown }).version;
      if (istFassung(v)) return v.trim();
    } catch { /* weiter mit der Liste */ }
  }
  if (!heim) return null;
  try {
    const liste = JSON.parse(lese(join(heim, '.claude', 'plugins', 'installed_plugins.json'))) as {
      plugins?: Record<string, Array<{ version?: unknown }>>;
    };
    const eintraege = liste?.plugins?.[PLUGIN_SCHLUESSEL];
    if (!Array.isArray(eintraege)) return null;
    // Mehrere Eintraege (Nutzer- und Projektebene): die hoechste zaehlt, damit
    // niemand einen Hinweis bekommt, der fuer ihn nicht stimmt.
    let beste: string | null = null;
    for (const e of eintraege) {
      const v = e?.version;
      if (istFassung(v) && (beste === null || istNeuer(v, beste))) beste = v.trim();
    }
    return beste;
  } catch {
    return null;
  }
}

/** Welche Fassung mit npm verglichen wird: als Plugin die des Plugins, sonst die des Servers. */
export function eigeneFassung(
  serverFassung: string,
  env: Record<string, string | undefined> = process.env,
  heim?: string,
  lese?: Leser,
): string {
  if (!alsPlugin(env)) return serverFassung;
  return pluginFassung(env, heim ?? heimordner(env), lese) ?? serverFassung;
}

/** Der Satz fuer den Assistenten. Er richtet sich an den Nutzer und sagt, wie man aktualisiert. */
export function hinweisSatz(
  neueste: string,
  aktuelle: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const plugin = alsPlugin(env);
  const lauf = plugin ? `your cachly plugin is ${aktuelle}` : `you run ${aktuelle}`;
  const wie = plugin
    ? 'Claude Code keeps plugin auto-update off for this marketplace. Turn it on once: '
      + '/plugin → Marketplaces → cachly → Enable auto-update. Or update now: '
      + '/plugin → Marketplaces → cachly → Update marketplace, then /reload-plugins.'
    : 'npx users: restart your editor. If your config pins a version, run `npx @cachly-dev/mcp-server@latest upgrade` for the steps.';
  return [
    '',
    '',
    '---',
    `ℹ️ **cachly:** version ${neueste} is available (${lauf}). ${wie} `
      + 'Mention this to the user once, in one sentence.',
  ].join('\n');
}

/**
 * Der Satz, der an die Antwort von session_start haengt — hoechstens EINMAL je
 * Prozess, nur bei den Werkzeugen am Sitzungsbeginn, nur wenn die Pruefung eine
 * echt neuere Fassung gefunden hat. Sonst ''.
 */
export function holeNeueFassungHinweis(
  werkzeug: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (_gezeigt || !_neueste || !SITZUNGSBEGINN_WERKZEUGE.has(werkzeug)) return '';
  if (!istNeuer(_neueste, _aktuelle)) return '';
  _gezeigt = true;
  return hinweisSatz(_neueste, _aktuelle, env);
}

/** Nur fuer Tests. */
export function _neueFassungZuruecksetzen(): void {
  _aktuelle = '';
  _neueste = '';
  _gezeigt = false;
}
