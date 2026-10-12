/**
 * Gueltigkeit nach Version — "diese Lektion gilt fuer next@<15".
 *
 * ── Wozu (Abhakliste 4.5) ───────────────────────────────────────────────────
 *
 * `gilt_ab` / `gilt_bis` binden eine Tatsache an ein DATUM. Viele Tatsachen
 * haengen aber an einer VERSION: "Der Cache wird beim Navigieren nie
 * verworfen" stimmte fuer next 14 und stimmt fuer next 15 nicht mehr. Wer in
 * einem next-15-Projekt sucht, bekam die alte Lektion gleichberechtigt neben
 * die neue gelegt — und nichts am Text verriet, dass sie nur fuer 14 gilt.
 *
 * Eine Lektion kann deshalb `gilt_fuer` tragen, eine Liste von Angaben:
 *
 *     next@<15                  npm-Paket, jede Version unter 15
 *     react@>=18 <19            beide Grenzen muessen passen
 *     go@>=1.22                 die Go-Sprachversion (go.mod, Zeile "go")
 *     python:fastapi@<0.110     Praefix npm: / go: / python: ist freiwillig
 *     @types/react@^18          Paketnamen mit Gruppe (@gruppe/name) gehen
 *     next@<14 || >=16          "oder" innerhalb EINER Angabe
 *
 * Mehrere Angaben in der Liste gelten zusammen ("und"): die Lektion passt nur,
 * wenn jede Angabe, deren Version das Projekt kennt, passt.
 *
 * ── Was beim Abruf passiert ─────────────────────────────────────────────────
 *
 * Passt eine Lektion nicht zum installierten Stand, wird sie NICHT versteckt.
 * Sie rutscht hinter alle passenden und unbekannten Treffer und traegt einen
 * Hinweis: "gilt fuer next@<15, hier 15.2.0". Wer die alte Fassung trotzdem
 * braucht (Migration, Altprojekt im Monorepo), findet sie weiter.
 *
 * AUSDRUECKLICH KEIN Altersverfall: das ist keine Aussage ueber das Alter einer
 * Lektion, sondern ueber den Geltungsbereich ihrer Tatsache. Alter im Ranking
 * riss am 19.08.2026 alle Bench-Floors; hier aendert sich nur etwas fuer
 * Lektionen, die `gilt_fuer` tragen UND deren Bereich das Projekt verletzt.
 *
 * Unbekannt heisst "keine Aenderung": kennt das Projekt die Version nicht (kein
 * Manifest, Paket nicht gelistet, Angabe unlesbar), bleibt alles wie vorher.
 *
 * ── Woher die Versionen kommen ──────────────────────────────────────────────
 *
 *   npm      node_modules/<paket>/package.json   (installiert, genau)
 *            package-lock.json                    (aufgeloest, genau)
 *            package.json                         (deklariert: untere Grenze)
 *   go       go.mod                               ("go 1.22", require-Zeilen)
 *   python   requirements.txt, pyproject.toml     (== genau, sonst untere Grenze)
 *
 * Gelesen wird nur, wenn unter den Kandidaten WENIGSTENS EINE Lektion
 * `gilt_fuer` traegt. Das Ergebnis liegt je Arbeitsordner im Speicher des
 * Prozesses UND auf der Platte (jeder Hook-Aufruf ist ein neuer Prozess) und
 * gilt, solange Aenderungszeit und Groesse der Manifeste gleich bleiben. Ein
 * warmer Aufruf kostet fuenf stat-Aufrufe und eine kleine JSON-Datei. Ein
 * kalter hat ein Zeitbudget (LESE_BUDGET_MS): ist es aufgebraucht, bleibt der
 * Rest unbekannt — das Ergebnis gilt dann nur kurz (UNVOLLSTAENDIG_MS).
 *
 * Nur Node-Bordmittel — die Datei wird in den abhaengigkeitsfreien Hook
 * gebuendelt (einblendung.ts, ambient-hook-start.ts).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Versionen und Bereiche
// ═══════════════════════════════════════════════════════════════════════════

export type Oekosystem = 'npm' | 'go' | 'python';

/** Hauptzahl, Nebenzahl, Fehlerzahl. Vorabkennungen und Bauangaben zaehlen nicht. */
export type Tripel = readonly [number, number, number];

/** Laengster Bereichstext, den eine Angabe tragen darf. */
export const BEREICH_MAX_ZEICHEN = 120;
/** So viele Angaben speichert eine Lektion hoechstens. */
export const GILT_FUER_MAX = 8;

/**
 * Eine Versionsnummer lesen: "15.2.0", "v1.9.1", "3.11", "1.2.3rc1", "2.0.0-beta.1".
 * Fehlende Teile sind 0, alles hinter der dritten Zahl wird ignoriert.
 * Vorabkennungen zaehlen nicht mit: 15.0.0-rc.1 verhaelt sich wie 15.0.0 —
 * ein Projekt auf dem Kandidaten laeuft schon mit dem neuen Verhalten.
 */
export function liesVersion(roh: unknown): Tripel | null {
  const m = /^[vV=\s]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(roh ?? ''));
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function vergleiche(a: Tripel, b: Tripel): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/** Ein Stueck Zahlenstrahl: von (einschliesslich) bis bis (ausschliesslich). `nicht` kehrt um. */
interface Intervall { von?: Tripel; bis?: Tripel; nicht?: boolean }
/** Alle Intervalle einer Alternative muessen passen. */
type Alternative = Intervall[];
/** Eine Alternative genuegt ("||"). */
export type Bereich = Alternative[];

/** Die naechste Stelle ueber der letzten angegebenen: bump([1,2,0], 2) = 1.3.0. */
function bump(t: Tripel, n: number): Tripel {
  if (n <= 1) return [t[0] + 1, 0, 0];
  if (n === 2) return [t[0], t[1] + 1, 0];
  return [t[0], t[1], t[2] + 1];
}

const OPERATOR = '(<=|>=|===|==|!=|~>|~=|<|>|=|~|\\^)';
// Gruppen: 1 Operator, 2-4 Haupt/Neben/Fehlerzahl, 5 weitere Zahlen (1.2.3.4), 6 Anhang (-rc.1, rc1, .post1, +build).
const ZAHLEN_TOKEN = new RegExp(
  `^${OPERATOR}?[vV]?(\\d+)(?:\\.(\\d+|[xX*]))?(?:\\.(\\d+|[xX*]))?((?:\\.\\d+)*)((?:[-+_.]?[A-Za-z]|[-+])[0-9A-Za-z.+_-]*)?$`,
);
const STERN_TOKEN = new RegExp(`^${OPERATOR}?(\\*|[xX])$`);

function teileLesen(maj: string, min: string | undefined, pat: string | undefined): { t: Tripel; n: number } {
  const zahl = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);
  const a = Number(maj);
  const b = zahl(min);
  const c = b === null ? null : zahl(pat);
  const n = b === null ? 1 : c === null ? 2 : 3;
  return { t: [a, b ?? 0, c ?? 0], n };
}

function tokenZuIntervall(token: string): Intervall | null {
  const stern = STERN_TOKEN.exec(token);
  if (stern) return stern[1] && stern[1] !== '=' && stern[1] !== '==' ? null : {};
  const m = ZAHLEN_TOKEN.exec(token);
  if (!m) return null;
  // Hinter einem Platzhalter (1.x) darf nichts mehr kommen: "1.x.y" ist ein Tippfehler.
  if (/[xX*]/.test(`${m[3] ?? ''}${m[4] ?? ''}`) && (m[5] || m[6])) return null;
  const op = m[1] ?? '';
  const { t, n } = teileLesen(m[2], m[3], m[4]);
  switch (op) {
    case '': case '=': case '==': case '===':
      return { von: t, bis: bump(t, n) };
    case '!=':
      return { von: t, bis: bump(t, n), nicht: true };
    case '<': return { bis: t };
    case '<=': return { bis: bump(t, n) };
    case '>': return { von: bump(t, n) };
    case '>=': return { von: t };
    case '^': {
      if (t[0] > 0) return { von: t, bis: [t[0] + 1, 0, 0] };
      if (n === 1) return { von: t, bis: [1, 0, 0] };
      if (t[1] > 0) return { von: t, bis: [0, t[1] + 1, 0] };
      if (n === 2) return { von: t, bis: [0, 1, 0] };
      return { von: t, bis: [0, 0, t[2] + 1] };
    }
    case '~': return { von: t, bis: n === 1 ? [t[0] + 1, 0, 0] : [t[0], t[1] + 1, 0] };
    case '~>': case '~=': return { von: t, bis: n === 3 ? [t[0], t[1] + 1, 0] : [t[0] + 1, 0, 0] };
    default: return null;
  }
}

function alternativeLesen(text: string): Alternative | null {
  if (!text) return null;
  // "1.2.3 - 2.0.0": beide Enden einschliesslich; ein Teilende (2.0) schliesst 2.0.x ein.
  const strich = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (strich) {
    const a = ZAHLEN_TOKEN.exec(strich[1]);
    const b = ZAHLEN_TOKEN.exec(strich[2]);
    if (!a || !b || a[1] || b[1]) return null;
    const von = teileLesen(a[2], a[3], a[4]);
    const bis = teileLesen(b[2], b[3], b[4]);
    return [{ von: von.t, bis: bump(bis.t, bis.n) }];
  }
  // Kommas (Python: ">=1.0,<2") sind Leerzeichen; ">= 18" ist ">=18".
  const glatt = text
    .replace(/,/g, ' ')
    .replace(new RegExp(`${OPERATOR}\\s+`, 'g'), '$1')
    .trim();
  const tokens = glatt.split(/\s+/);
  if (tokens.length > 8) return null;
  const alt: Alternative = [];
  for (const tok of tokens) {
    const i = tokenZuIntervall(tok);
    if (!i) return null;
    alt.push(i);
  }
  return alt;
}

/**
 * Einen Bereichstext lesen (npm-Schreibweise plus die Python-Formen `,`, `~=`, `==`).
 * `null` bei allem, was nicht eindeutig lesbar ist — geraten wird nicht.
 */
export function liesBereich(roh: unknown): Bereich | null {
  if (typeof roh !== 'string') return null;
  const text = roh.trim();
  if (!text || text.length > BEREICH_MAX_ZEICHEN) return null;
  const bereich: Bereich = [];
  for (const teil of text.split('||')) {
    const alt = alternativeLesen(teil.trim());
    if (!alt) return null;
    bereich.push(alt);
  }
  return bereich;
}

function imIntervall(v: Tripel, i: Intervall): boolean {
  let drin = true;
  if (i.von && vergleiche(v, i.von) < 0) drin = false;
  if (i.bis && vergleiche(v, i.bis) >= 0) drin = false;
  return i.nicht ? !drin : drin;
}

/** Liegt die Version im Bereich? `null`, wenn eines von beiden unlesbar ist. */
export function passtVersion(version: unknown, bereich: unknown): boolean | null {
  const v = liesVersion(version);
  const b = liesBereich(bereich);
  if (!v || !b) return null;
  return b.some((alt) => alt.every((i) => imIntervall(v, i)));
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Angaben ("next@<15") lesen und beim Schreiben pruefen
// ═══════════════════════════════════════════════════════════════════════════

export interface Angabe {
  /** Die gespeicherte Schreibweise, Leerraum geglaettet. */
  text: string;
  /** `null`: ohne Praefix, in allen Oekosystemen suchen. */
  oekosystem: Oekosystem | null;
  paket: string;
  bereichText: string;
}

const PRAEFIX: Record<string, Oekosystem> = { npm: 'npm', go: 'go', python: 'python', pypi: 'python', pip: 'python' };

/** Eine Angabe lesen. Der Fehlertext sagt, WAS an dieser Angabe nicht stimmt. */
export function liesAngabe(roh: unknown): { angabe: Angabe } | { fehler: string } {
  if (typeof roh !== 'string') return { fehler: 'keine Zeichenkette' };
  const glatt = roh.replace(/\s+/g, ' ').trim();
  if (!glatt) return { fehler: 'leer' };
  if (glatt.length > BEREICH_MAX_ZEICHEN + 80) return { fehler: 'zu lang' };

  let rest = glatt;
  let oekosystem: Oekosystem | null = null;
  const pf = /^(npm|go|python|pypi|pip):/i.exec(rest);
  if (pf) {
    oekosystem = PRAEFIX[pf[1].toLowerCase()];
    rest = rest.slice(pf[0].length);
  }
  const at = rest.indexOf('@', 1);
  if (at < 0) return { fehler: 'es fehlt "@bereich" (Form: paket@bereich)' };
  const paket = rest.slice(0, at).trim();
  const bereichText = rest.slice(at + 1).trim();
  if (!paket || !/^[@A-Za-z0-9._~/+-]+$/.test(paket)) return { fehler: 'Paketname unlesbar' };
  if (!liesBereich(bereichText)) return { fehler: `Bereich "${bereichText.slice(0, 40)}" unlesbar` };
  return { angabe: { text: glatt, oekosystem, paket, bereichText } };
}

export interface GiltFuerPruefung {
  /** Die lesbaren Angaben in der gespeicherten Schreibweise, ohne Doppelte. */
  angaben: string[];
  /** Eine Zeile je verworfener Angabe — fuer die Rueckmeldung an den Schreiber. */
  fehler: string[];
}

/**
 * Die Eingabe `gilt_fuer` beim Schreiben pruefen. Unlesbares wird NICHT
 * gespeichert (kein geratener Bereich), blockiert aber nie das Speichern der
 * Lektion selbst.
 */
export function pruefeGiltFuer(eingabe: unknown): GiltFuerPruefung {
  const roh: unknown[] = Array.isArray(eingabe) ? eingabe : eingabe === undefined || eingabe === null ? [] : [eingabe];
  const angaben: string[] = [];
  const fehler: string[] = [];
  for (const e of roh) {
    const l = liesAngabe(e);
    if ('fehler' in l) {
      fehler.push(`"${String(e).slice(0, 60)}": ${l.fehler}`);
    } else if (!angaben.includes(l.angabe.text)) {
      if (angaben.length >= GILT_FUER_MAX) fehler.push(`"${l.angabe.text.slice(0, 60)}": mehr als ${GILT_FUER_MAX} Angaben`);
      else angaben.push(l.angabe.text);
    }
  }
  return { angaben, fehler };
}

/**
 * Was beim Schreiben gespeichert wird. Fehlt `gilt_fuer` im Aufruf (Update
 * ohne das Feld), bleibt der bisherige Geltungsbereich stehen — sonst wuerde
 * ein Tippfehler-Update die Einschraenkung still weiten. `[]` loescht ihn.
 */
export function loeseGiltFuerAuf(eingabe: unknown, vorher: unknown): GiltFuerPruefung & { uebernommen: boolean } {
  if (eingabe === undefined || eingabe === null) {
    const alt = Array.isArray(vorher) ? pruefeGiltFuer(vorher).angaben : [];
    return { angaben: alt, fehler: [], uebernommen: alt.length > 0 };
  }
  return { ...pruefeGiltFuer(eingabe), uebernommen: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Die Versionen des Projekts
// ═══════════════════════════════════════════════════════════════════════════

export interface PaketStand {
  version: string;
  /** Woher: node_modules | package-lock.json | package.json | go.mod | requirements.txt | pyproject.toml */
  quelle: string;
  /** true: nur eine untere Grenze ("^15.2.0"), nicht die aufgeloeste Version. */
  ab?: boolean;
}

interface Stand {
  npm: Tafel;
  go: Tafel;
  python: Tafel;
}

/** Aus dem Manifest gelesen. Reihenfolge = Reihenfolge des Lesens; das Lockfile zuletzt (das groesste). */
const MANIFESTE = ['package.json', 'go.mod', 'pyproject.toml', 'requirements.txt', 'package-lock.json'] as const;
const MAX_BYTES: Record<(typeof MANIFESTE)[number], number> = {
  'package.json': 1 << 20,
  'go.mod': 1 << 19,
  'pyproject.toml': 1 << 19,
  'requirements.txt': 1 << 19,
  'package-lock.json': 3 << 20,
};
/** So lange darf ein kalter Aufbau lesen und parsen, bevor der Rest unbekannt bleibt. */
export const LESE_BUDGET_MS = 25;
/** So lange gilt ein Ergebnis, dem wegen des Budgets Quellen fehlen. */
export const UNVOLLSTAENDIG_MS = 10 * 60 * 1000;
/** Obergrenze fuer Eintraege je Oekosystem, damit die Ablage klein bleibt. */
const MAX_EINTRAEGE = 4000;

type Tafel = Record<string, PaketStand>;
const gezaehlt = new WeakMap<object, number>();

/** Eintragen, ohne zu zaehlen wie viele schon da sind (Object.keys je Eintrag waere quadratisch). */
function legeAn(ziel: Tafel, name: string, stand: PaketStand, ueberschreiben = false): void {
  if (name === '__proto__') return;
  const da = Object.hasOwn(ziel, name);
  if (da && !ueberschreiben) return;
  if (!da) {
    const n = gezaehlt.get(ziel) ?? 0;
    if (n >= MAX_EINTRAEGE) return;
    gezaehlt.set(ziel, n + 1);
  }
  ziel[name] = stand;
}

function eigen(tafel: Tafel, name: string): PaketStand | null {
  return Object.hasOwn(tafel, name) ? tafel[name] : null;
}

function liesDatei(pfad: string, maxBytes: number): string | null {
  try {
    const st = statSync(pfad, { throwIfNoEntry: false });
    if (!st || !st.isFile() || st.size > maxBytes) return null;
    return readFileSync(pfad, 'utf8').replace(/^\uFEFF/, '');
  } catch { return null; }
}

function normalisierePython(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * Aus einer Versionsangabe ("14.2.3", "^15.2.0", ">=0.100,<1", "~=1.4") die
 * Version machen. Eine nackte Zahl ist genau, ein Operator liefert die untere
 * Grenze. Alles andere (workspace:, git, latest, "a || b") bleibt unbekannt.
 */
function ausAngabe(spez: unknown): { version: string; ab: boolean } | null {
  if (typeof spez !== 'string') return null;
  const s = spez.trim();
  if (!s || s.includes('||') || /[xX*]$/.test(s)) return null;
  const nackt = /^(?:===?|=)?\s*v?(\d+(?:\.\d+){0,2})(?:[-+.]?[0-9A-Za-z.+_-]*)?$/.exec(s);
  if (nackt) return { version: nackt[1], ab: false };
  const m = /(?:\^|~>|~=|~|>=|>)\s*v?(\d+(?:\.\d+){0,2})/.exec(s);
  return m ? { version: m[1], ab: true } : null;
}

function setze(ziel: Tafel, name: string, spez: unknown, quelle: string): void {
  const v = ausAngabe(spez);
  if (v) legeAn(ziel, name, { version: v.version, quelle, ...(v.ab ? { ab: true } : {}) });
}

function liesPackageJson(text: string, ziel: Tafel): void {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return; }
  if (!j || typeof j !== 'object') return;
  // peerDependencies sagen, was UNTERSTUETZT wird, nicht was installiert ist.
  for (const feld of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const tab = (j as Record<string, unknown>)[feld];
    if (!tab || typeof tab !== 'object') continue;
    for (const [name, spez] of Object.entries(tab as Record<string, unknown>)) setze(ziel, name.toLowerCase(), spez, 'package.json');
  }
}

/** Das Lockfile ueberschreibt die deklarierte Grenze: es kennt die aufgeloeste Version. */
function liesPackageLock(text: string, ziel: Tafel): void {
  let j: { packages?: Record<string, { version?: unknown }>; dependencies?: Record<string, { version?: unknown }> };
  try { j = JSON.parse(text); } catch { return; }
  if (!j || typeof j !== 'object') return;
  const lege = (name: string, version: unknown): void => {
    if (typeof version !== 'string' || !liesVersion(version)) return;
    legeAn(ziel, name.toLowerCase(), { version, quelle: 'package-lock.json' }, true);
  };
  if (j.packages && typeof j.packages === 'object') {
    for (const [pfad, p] of Object.entries(j.packages)) {
      // Nur die oberste Ebene: "node_modules/next", nicht "node_modules/x/node_modules/next".
      if (!pfad.startsWith('node_modules/') || pfad.indexOf('node_modules/', 13) >= 0) continue;
      lege(pfad.slice(13), p?.version);
    }
  } else if (j.dependencies && typeof j.dependencies === 'object') {
    for (const [name, p] of Object.entries(j.dependencies)) lege(name, p?.version);
  }
}

function liesGoMod(text: string, ziel: Tafel): void {
  let inRequire = false;
  const modul = (z: string): void => {
    const m = /^(\S+)\s+(v\d\S*)/.exec(z);
    if (m) legeAn(ziel, m[1], { version: m[2].replace(/^v/, ''), quelle: 'go.mod' });
  };
  for (const roh of text.split('\n')) {
    const z = roh.replace(/\/\/.*$/, '').trim();
    if (!z) continue;
    if (inRequire) {
      if (z === ')') inRequire = false;
      else modul(z);
      continue;
    }
    const go = /^go\s+(\d+(?:\.\d+){0,2})\b/.exec(z);
    if (go) { legeAn(ziel, 'go', { version: go[1], quelle: 'go.mod', ab: true }); continue; }
    if (/^require\s*\($/.test(z)) { inRequire = true; continue; }
    const eins = /^require\s+(.+)$/.exec(z);
    if (eins) modul(eins[1]);
  }
}

/** "fastapi[all]>=0.100,<1 ; python_version>'3.8'" -> Name und Version. */
function liesAnforderung(zeile: string, ziel: Tafel, quelle: string): void {
  if (zeile.includes('://')) return;
  const s = zeile.split('#')[0].split(';')[0].trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m || !m[2]) return;
  const teile = m[2].replace(/^\(|\)$/g, '').split(',').map((x) => x.trim());
  const name = normalisierePython(m[1]);
  const genau = teile.map((t) => /^===?\s*(\d+(?:\.\d+){0,2})(?:\.\*)?$/.exec(t)).find(Boolean);
  const untere = teile.map((t) => /^(?:>=|~=|>)\s*(\d+(?:\.\d+){0,2})/.exec(t)).find(Boolean);
  if (genau) legeAn(ziel, name, { version: genau[1], quelle });
  else if (untere) legeAn(ziel, name, { version: untere[1], quelle, ab: true });
}

function liesRequirements(text: string, ziel: Tafel): void {
  for (const z of text.split('\n')) {
    const t = z.trim();
    if (!t || t.startsWith('#') || t.startsWith('-')) continue;
    liesAnforderung(t, ziel, 'requirements.txt');
  }
}

/**
 * pyproject.toml ohne TOML-Leser: nur die Stellen, die Versionen tragen —
 * [project] (dependencies, requires-python), optional-dependencies, die
 * dependency-groups und die [tool.poetry]-Tabellen.
 */
function liesPyproject(text: string, ziel: Tafel): void {
  let abschnitt = '';
  let inFeld = false;
  const zeichenketten = (z: string): string[] =>
    [...z.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
  for (const roh of text.split('\n')) {
    const z = roh.trim();
    if (!z || z.startsWith('#')) continue;
    const kopf = /^\[\[?([^\]]+)\]\]?$/.exec(z);
    if (kopf) { abschnitt = kopf[1].trim(); inFeld = false; continue; }

    const arrayAbschnitt = abschnitt === 'project'
      ? /^dependencies\s*=\s*\[/.test(z)
      : abschnitt === 'project.optional-dependencies' || abschnitt === 'dependency-groups'
        ? /^[\w.-]+\s*=\s*\[/.test(z)
        : false;
    if (arrayAbschnitt || inFeld) {
      for (const a of zeichenketten(z.replace(/^[\w.-]+\s*=\s*\[/, ''))) liesAnforderung(a, ziel, 'pyproject.toml');
      inFeld = !z.includes(']');
      continue;
    }
    if (abschnitt === 'project') {
      const rp = /^requires-python\s*=\s*["']([^"']+)["']/.exec(z);
      if (rp) setze(ziel, 'python', rp[1], 'pyproject.toml');
      continue;
    }
    if (/^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/.test(abschnitt)) {
      const e = /^([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(z);
      if (!e) continue;
      const wert = e[2].trim();
      const spez = /^["']/.test(wert) ? zeichenketten(wert)[0] : /version\s*=\s*["']([^"']+)["']/.exec(wert)?.[1];
      setze(ziel, normalisierePython(e[1]), spez, 'pyproject.toml');
    }
  }
}

function leererStand(): Stand { return { npm: {}, go: {}, python: {} }; }

export interface LeseOptionen {
  /** Zeitbudget fuer einen kalten Aufbau (ms). Vorgabe LESE_BUDGET_MS. */
  budgetMs?: number;
  /** Zeitgeber in ms; nur fuer Tests. */
  jetzt?: () => number;
  /** Wo die Platten-Ablage liegt; `null` schaltet sie ab. Vorgabe: Temp-Ordner. */
  ablageOrdner?: string | null;
  /** Hoechster Ordner, bis zu dem nach einem Manifest gesucht wird (Monorepo). */
  obergrenze?: string;
}

interface Ablage {
  v: 1;
  ordner: string;
  stempel: Record<string, string>;
  stand: Stand;
  unvollstaendig: boolean;
  at: number;
}

const speicher = new Map<string, Ablage>();

function stempelVon(ordner: string): Record<string, string> {
  const s: Record<string, string> = {};
  for (const m of MANIFESTE) {
    try {
      const st = statSync(join(ordner, m), { throwIfNoEntry: false });
      s[m] = st ? `${Math.round(st.mtimeMs)}:${st.size}` : '-';
    } catch { s[m] = '-'; }
  }
  return s;
}

function gleich(a: Record<string, string>, b: Record<string, string>): boolean {
  return MANIFESTE.every((m) => a[m] === b[m]);
}

function ablagePfad(dir: string, ordner: string): string {
  return join(dir, `cachly-projektversionen-${createHash('sha1').update(ordner).digest('hex').slice(0, 12)}.json`);
}

function liesAblage(pfad: string, ordner: string): Ablage | null {
  try {
    const a = JSON.parse(readFileSync(pfad, 'utf8')) as Ablage;
    return a && a.v === 1 && a.ordner === ordner && a.stand && a.stempel ? a : null;
  } catch { return null; }
}

function schreibeAblage(pfad: string, a: Ablage): void {
  try {
    const tmp = `${pfad}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(a), { mode: 0o600 });
    renameSync(tmp, pfad);
  } catch { /* die Ablage ist bestes Bemuehen, kein Muss */ }
}

function baueStand(ordner: string, budgetMs: number, jetzt: () => number): { stand: Stand; unvollstaendig: boolean } {
  const stand = leererStand();
  const t0 = jetzt();
  let unvollstaendig = false;
  let erste = true;
  for (const m of MANIFESTE) {
    if (!erste && jetzt() - t0 > budgetMs) { unvollstaendig = true; break; }
    const text = liesDatei(join(ordner, m), MAX_BYTES[m]);
    if (text === null) continue;
    erste = false;
    switch (m) {
      case 'package.json': liesPackageJson(text, stand.npm); break;
      case 'package-lock.json': liesPackageLock(text, stand.npm); break;
      case 'go.mod': liesGoMod(text, stand.go); break;
      case 'pyproject.toml': liesPyproject(text, stand.python); break;
      case 'requirements.txt': liesRequirements(text, stand.python); break;
    }
  }
  return { stand, unvollstaendig };
}

export interface VersionsLeser {
  readonly ordner: string;
  /** Woher dieser Stand kam: frisch gebaut, aus dem Speicher des Prozesses, von der Platte. */
  readonly herkunft: 'gebaut' | 'speicher' | 'platte';
  /** true: das Zeitbudget war knapp, einzelne Quellen fehlen (= unbekannt). */
  readonly unvollstaendig: boolean;
  /** Die Version eines Pakets, oder `null` (unbekannt). `null` als Oekosystem: in allen suchen. */
  suche(oekosystem: Oekosystem | null, paket: string): PaketStand | null;
}

/** Die installierte Version aus node_modules — genauer als jede Deklaration, und eine kleine Datei. */
function ausNodeModules(ordner: string, paket: string): PaketStand | null {
  if (!/^[@a-z0-9._~/-]+$/.test(paket) || paket.includes('..')) return null;
  let dir = ordner;
  for (let i = 0; i < 4; i++) {
    const text = liesDatei(join(dir, 'node_modules', paket, 'package.json'), 256 * 1024);
    if (text !== null) {
      try {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        if (typeof v === 'string' && liesVersion(v)) return { version: v, quelle: 'node_modules' };
      } catch { /* kaputte Datei = unbekannt */ }
      return null;
    }
    const eltern = dirname(dir);
    if (eltern === dir) break;
    dir = eltern;
  }
  return null;
}

/**
 * Den Ordner mit dem naechsten Manifest finden — nur innerhalb der Obergrenze
 * (Monorepo: eine Kontextdatei in packages/web findet packages/web/package.json).
 * Ohne Obergrenze zaehlt nur der Startordner: nach oben zu raten wuerde die
 * Versionen eines fremden Projekts erwischen.
 */
export function findeProjektOrdner(start: string, obergrenze?: string): string {
  let dir = resolve(start);
  const grenze = obergrenze ? resolve(obergrenze) : null;
  for (let i = 0; grenze && i < 6; i++) {
    if (MANIFESTE.some((m) => existsSync(join(dir, m)))) return dir;
    if (dir === grenze) break;
    const eltern = dirname(dir);
    if (eltern === dir) break;
    dir = eltern;
  }
  return resolve(start);
}

/** Der Arbeitsordner des Aufrufers: ausdrueckliche Angabe, dann Claude Code, dann der Prozess. */
export function arbeitsordner(): string {
  return process.env.CACHLY_WORKSPACE || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Die Versionen eines Projekts lesen — mit Ablage im Speicher und auf der Platte.
 * Wirft nie: jeder Fehler heisst "unbekannt".
 */
export function leseProjektVersionen(start: string = arbeitsordner(), o: LeseOptionen = {}): VersionsLeser {
  const ordner = findeProjektOrdner(start, o.obergrenze);
  const jetzt = o.jetzt ?? (() => performance.now());
  const ablageDir = o.ablageOrdner === undefined ? tmpdir() : o.ablageOrdner;
  let herkunft: VersionsLeser['herkunft'] = 'gebaut';
  let stand: Stand = leererStand();
  let unvollstaendig = false;

  try {
    const stempel = stempelVon(ordner);
    const frisch = (a: Ablage | null | undefined): a is Ablage =>
      !!a && gleich(a.stempel, stempel) && (!a.unvollstaendig || Date.now() - a.at < UNVOLLSTAENDIG_MS);
    const imSpeicher = speicher.get(ordner);
    if (frisch(imSpeicher)) {
      ({ stand, unvollstaendig } = imSpeicher);
      herkunft = 'speicher';
    } else {
      const aufPlatte = ablageDir === null ? null : liesAblage(ablagePfad(ablageDir, ordner), ordner);
      if (frisch(aufPlatte)) {
        speicher.set(ordner, aufPlatte);
        ({ stand, unvollstaendig } = aufPlatte);
        herkunft = 'platte';
      } else {
        const gebaut = baueStand(ordner, o.budgetMs ?? LESE_BUDGET_MS, jetzt);
        ({ stand, unvollstaendig } = gebaut);
        const a: Ablage = { v: 1, ordner, stempel, stand, unvollstaendig, at: Date.now() };
        if (speicher.size > 20) speicher.clear();
        speicher.set(ordner, a);
        if (ablageDir !== null) schreibeAblage(ablagePfad(ablageDir, ordner), a);
      }
    }
  } catch { /* unbekannt statt Absturz */ }

  const gemerkt = new Map<string, PaketStand | null>();
  const suche = (oekosystem: Oekosystem | null, paket: string): PaketStand | null => {
    const schluessel = `${oekosystem ?? '*'}:${paket}`;
    if (gemerkt.has(schluessel)) return gemerkt.get(schluessel) ?? null;
    let fund: PaketStand | null = null;
    if (oekosystem === null || oekosystem === 'npm') {
      const name = paket.toLowerCase();
      fund = ausNodeModules(ordner, name) ?? eigen(stand.npm, name);
    }
    if (!fund && (oekosystem === null || oekosystem === 'python')) fund = eigen(stand.python, normalisierePython(paket));
    if (!fund && (oekosystem === null || oekosystem === 'go')) fund = eigen(stand.go, paket);
    gemerkt.set(schluessel, fund);
    return fund;
  };
  return { ordner, herkunft, unvollstaendig, suche };
}

/** Wo die Platten-Ablage fuer einen Arbeitsordner liegt (Tests pruefen damit, ob gelesen wurde). */
export function ablageDatei(ordner: string, ablageOrdner: string = tmpdir()): string {
  return ablagePfad(ablageOrdner, resolve(ordner));
}

/** Nur fuer Tests: den Speicher des Prozesses leeren. */
export function leereVersionsSpeicher(): void {
  speicher.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Urteil und Herabstufen
// ═══════════════════════════════════════════════════════════════════════════

export interface Abweichung { angabe: string; hier: string }

export type Urteil =
  | { art: 'unbekannt' }
  | { art: 'passt'; geprueft: Array<{ angabe: string; paket: string; hier: string }> }
  | { art: 'passtNicht'; abweichungen: Abweichung[]; text: string };

function anzeige(s: PaketStand): string {
  return s.ab ? `ab ${s.version} laut ${s.quelle}` : s.version;
}

function listeAus(giltFuer: unknown): unknown[] {
  if (Array.isArray(giltFuer)) return giltFuer;
  return typeof giltFuer === 'string' && giltFuer.trim() ? [giltFuer] : [];
}

/** Hat die gespeicherte Lektion eine Einschraenkung, die ueberhaupt einen Abgleich lohnt? */
export function traegtGiltFuer(giltFuer: unknown): boolean {
  return listeAus(giltFuer).length > 0;
}

/**
 * Passt das Projekt zu den Angaben einer Lektion? Jede Angabe, deren Version
 * bekannt ist, muss passen ("und"). Unlesbare Angaben und unbekannte Versionen
 * zaehlen nicht — sie sind kein Beleg gegen die Lektion.
 */
export function beurteileGiltFuer(giltFuer: unknown, leser: Pick<VersionsLeser, 'suche'>): Urteil {
  const abweichungen: Abweichung[] = [];
  const geprueft: Array<{ angabe: string; paket: string; hier: string }> = [];
  for (const roh of listeAus(giltFuer)) {
    const l = liesAngabe(roh);
    if ('fehler' in l) continue;
    const a = l.angabe;
    const stand = leser.suche(a.oekosystem, a.paket);
    if (!stand) continue;
    const passt = passtVersion(stand.version, a.bereichText);
    if (passt === null) continue;
    if (passt) geprueft.push({ angabe: a.text, paket: a.paket, hier: anzeige(stand) });
    else abweichungen.push({ angabe: a.text, hier: anzeige(stand) });
  }
  if (abweichungen.length > 0) {
    return {
      art: 'passtNicht',
      abweichungen,
      text: abweichungen.map((d) => `gilt fuer ${d.angabe}, hier ${d.hier}`).join('; '),
    };
  }
  return geprueft.length > 0 ? { art: 'passt', geprueft } : { art: 'unbekannt' };
}

export interface StufeOptionen<T> {
  giltFuerVon: (t: T) => unknown;
  schluesselVon: (t: T) => string;
  /** Wird hoechstens EINMAL und nur gerufen, wenn ein Treffer `gilt_fuer` traegt. */
  leser?: () => Pick<VersionsLeser, 'suche'>;
}

/**
 * Treffer, die nicht zum Projekt passen, hinter alle anderen stellen — in
 * unveraenderter Reihenfolge untereinander, nichts wird entfernt. Gibt die
 * neue Reihenfolge und je Abweichler einen Hinweistext zurueck.
 */
export function stufeNachVersion<T>(
  treffer: readonly T[],
  o: StufeOptionen<T>,
): { treffer: T[]; hinweise: Map<string, string> } {
  const hinweise = new Map<string, string>();
  const vorn: T[] = [];
  const hinten: T[] = [];
  let leser: Pick<VersionsLeser, 'suche'> | null = null;
  let leserFehlt = false;
  for (const t of treffer) {
    const gf = o.giltFuerVon(t);
    if (!traegtGiltFuer(gf)) { vorn.push(t); continue; }
    if (!leser && !leserFehlt) {
      try { leser = (o.leser ?? (() => leseProjektVersionen()))(); } catch { leserFehlt = true; }
    }
    const urteil = leser ? beurteileGiltFuer(gf, leser) : ({ art: 'unbekannt' } as Urteil);
    if (urteil.art === 'passtNicht') {
      hinweise.set(o.schluesselVon(t), urteil.text);
      hinten.push(t);
    } else {
      vorn.push(t);
    }
  }
  return { treffer: hinten.length > 0 ? [...vorn, ...hinten] : [...vorn], hinweise };
}

// ── Die Anschluesse (jeweils nur wenige Zeilen am Aufrufer) ─────────────────

/** Wo fuer eine Suche mit Kontextdateien gesucht wird: bei der ersten Datei, sonst im Arbeitsordner. */
function sucheStart(kontextDateien: readonly string[]): { start: string; obergrenze?: string } {
  const wurzel = resolve(arbeitsordner());
  const datei = kontextDateien.find((f) => typeof f === 'string' && f.length > 0);
  if (datei) {
    const dir = dirname(resolve(wurzel, datei));
    if (dir === wurzel || dir.startsWith(wurzel + sep)) return { start: dir, obergrenze: wurzel };
  }
  return { start: wurzel };
}

/**
 * smart_recall: stellt Lektionen, die nicht zum Projekt passen, hinter die
 * anderen — DIREKT in `treffer` (gleiche Liste, neue Reihenfolge) — und gibt
 * die Hinweise je Schluessel zurueck. Ohne `gilt_fuer` in der Liste: keine
 * Dateizugriffe, keine Aenderung.
 */
export function stufeSucheNachProjektversion(
  treffer: Array<{ key: string; content: string }>,
  kontextDateien: readonly string[] = [],
  o: LeseOptionen = {},
): Map<string, string> {
  const praefix = 'cachly:lesson:best:';
  const r = stufeNachVersion(treffer, {
    giltFuerVon: (t) => {
      if (!t.key.startsWith(praefix) || typeof t.content !== 'string' || !t.content.includes('"gilt_fuer"')) return undefined;
      try { return (JSON.parse(t.content) as { gilt_fuer?: unknown }).gilt_fuer; } catch { return undefined; }
    },
    schluesselVon: (t) => t.key,
    leser: () => {
      const s = sucheStart(kontextDateien);
      return leseProjektVersionen(s.start, { obergrenze: s.obergrenze, ...o });
    },
  });
  if (r.hinweise.size > 0) treffer.splice(0, treffer.length, ...r.treffer);
  return r.hinweise;
}

/** Die Zeilen fuer die SICHTBAREN Treffer (ein Hinweis fuer einen verdeckten Treffer waere Laerm). */
export function versionsNotizen(sichtbar: ReadonlyArray<{ key: string }>, hinweise: Map<string, string>): string[] {
  const out: string[] = [];
  for (const t of sichtbar) {
    const h = hinweise.get(t.key);
    if (h) {
      out.push(
        `⚠️ \`${t.key.replace('cachly:lesson:best:', '')}\` ${h} — passt nicht zu den Versionen dieses Projekts, steht deshalb hinter den passenden Treffern.`,
      );
    }
  }
  return out;
}

/** recall_best_solution: die Zeile ueber der Lektion, oder ''. */
export function versionsBanner(giltFuer: unknown, o: LeseOptionen & { leser?: Pick<VersionsLeser, 'suche'> } = {}): string {
  if (!traegtGiltFuer(giltFuer)) return '';
  let urteil: Urteil;
  try {
    urteil = beurteileGiltFuer(giltFuer, o.leser ?? leseProjektVersionen(undefined, o));
  } catch { urteil = { art: 'unbekannt' }; }
  const liste = listeAus(giltFuer).filter((x): x is string => typeof x === 'string').join(', ');
  if (urteil.art === 'passtNicht') {
    return `⚠️ **GILT NICHT FUER DIESEN STAND** — ${urteil.text}. Der Text unten bleibt lesbar, ist fuer diese Version aber nicht gesichert.`;
  }
  if (urteil.art === 'passt') {
    return `📦 Gilt fuer ${liste} — passt zu diesem Projekt (${urteil.geprueft.map((g) => `${g.paket} ${g.hier}`).join(', ')}).`;
  }
  return `📦 Gilt fuer ${liste} — die Version in diesem Projekt ist nicht bekannt.`;
}

/**
 * Einblendung: die Kandidaten der Sortierung umordnen. Abweichler stehen
 * hinten und tragen `versionshinweis` (renderLesson zeigt ihn). Ohne
 * `gilt_fuer` unter den Kandidaten kommt dieselbe Liste zurueck.
 */
export function stufeEinblendungNachVersion<B extends { lektion: { topic?: unknown; [feld: string]: unknown } }>(
  sortiert: readonly B[],
  o: LeseOptionen & { leser?: () => Pick<VersionsLeser, 'suche'> } = {},
): B[] {
  const r = stufeNachVersion(sortiert, {
    giltFuerVon: (b) => b.lektion.gilt_fuer,
    schluesselVon: (b) => String(b.lektion.topic ?? ''),
    leser: o.leser ?? (() => leseProjektVersionen(undefined, o)),
  });
  if (r.hinweise.size === 0) return sortiert as B[];
  return r.treffer.map((b) => {
    const h = r.hinweise.get(String(b.lektion.topic ?? ''));
    return h ? { ...b, lektion: { ...b.lektion, versionshinweis: h } } : b;
  });
}
