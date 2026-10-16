import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ANWEISUNGS_DATEIEN, CLAUDE_MD_MARKER_END, CLAUDE_MD_MARKER_START, EDITOR_FILES, blockMuster,
} from './projektdateien.js';
import { PROJEKT_HOOK_MARKE, istCachlyEintrag } from './hook-zugang.js';
import { CLS_BLOCK_RE } from './cls-hook.js';
import { BRAIN_WATCH_BLOCK_RE } from './brain-watch-hook.js';
import {
  CLAUDE_HOOK_DIR, CLAUDE_SETTINGS_DATEI, CODEX_HOOKS_DATEI, CODEX_HOOK_DIR, COPILOT_HOOKS_DATEI, COPILOT_HOOK_DIR,
  CURSOR_HOOKS_DATEI, CURSOR_HOOK_DIR, GEMINI_HOOK_DIR, GEMINI_SETTINGS_DATEI,
} from './ambient-hooks.js';
import { CURSOR_ABLAGE_ORDNER } from './cursor-hook.js';
import { COPILOT_ABLAGE_ORDNER } from './copilot-hook.js';
import { credentialsPath } from './credentials.js';
import { defaultLedgerPath, readLedger } from './ambient-ledger.js';
import { defaultMilestonePath } from './funnel-milestones.js';
import { defaultKostprobePath } from './kostprobe.js';
import { standPfad } from './neue-fassung.js';
import { AUFTRAG, FEHLSCHLAG, SPERRE } from './konto-anlegen.js';
import { netBalance } from './ambient-recall.js';
import { istTestSchluessel } from './uebernahme.js';

export type Stufe = 'projekt' | 'global';

export type Aktion =
  | 'datei-loeschen'
  | 'ordner-loeschen'
  | 'ordner-entfernen'
  | 'eintrag-entfernen'
  | 'block-entfernen'
  | 'melden';

export interface Fund {
  stufe: Stufe;
  aktion: Aktion;
  pfad: string;
  was: string;
  /** Inhalt der Datei beim Planen. Beim Ausfuehren muss er noch derselbe sein. */
  vorher?: string;
  /** Neuer Inhalt bei `eintrag-entfernen` und `block-entfernen`. */
  nachher?: string;
}

export interface VonHand {
  stufe: Stufe;
  text: string;
}

export interface Plan {
  funde: Fund[];
  vonHand: VonHand[];
  /** Die Instanz aus einer Konfiguration, die der Rueckbau entfernt (fuer die Bestandsanzeige). */
  instanz: string;
}

export interface PlanEingabe {
  projekt: string;
  heim: string;
  tmp: string;
}

export interface Zeile {
  fund: Fund;
  status: 'entfernt' | 'uebersprungen';
  grund?: string;
}

type Json = Record<string, unknown>;

/** Der Name eines Hooks aus `setup_ai_memory`, der nie lief: einen Befehl `checkpoint` gibt es nicht. */
export const KAPUTTER_STOP_HOOK = 'broken Stop hook from setup_ai_memory ("checkpoint" is not a command)';

const KONTO_LOESCHEN =
  'Your lessons stay in your cachly account. uninstall never deletes cloud data. '
  + 'To erase your account and everything in it (GDPR Art. 17), write to privacy@cachly.dev '
  + '(https://cachly.dev/legal/datenschutz).';

const HEIM_DATEIEN: readonly string[] = [
  credentialsPath({ home: '' }),
  defaultLedgerPath(),
  defaultMilestonePath(),
  defaultKostprobePath(),
  standPfad(''),
  SPERRE,
  FEHLSCHLAG,
  AUFTRAG,
].map((p) => basename(p));

function maskiere(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const HEIM_DATEI_MUSTER = new RegExp(`^(?:${HEIM_DATEIEN.map(maskiere).join('|')})(?:\\.[\\w.-]*(?:tmp|genommen))?$`);

const TMP_DATEI_MUSTER =
  /^cachly-(?:ambient|leser-sicherung|lernen-arme|projektversionen|startwissen-import)-[\w.-]+\.(?:json|jsonl|lock|tmp)$/;

const TMP_ORDNER: readonly string[] = ['cachly-lernen', basename(CURSOR_ABLAGE_ORDNER), basename(COPILOT_ABLAGE_ORDNER)];

/** Ist das eine Datei, die cachly im temporaeren Ordner anlegt? Nur diese Namen werden geloescht. */
export function istCachlyAblage(name: string, istOrdner: boolean): boolean {
  return istOrdner ? TMP_ORDNER.includes(name) : TMP_DATEI_MUSTER.test(name);
}

function istObjekt(x: unknown): x is Json {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function parseObjekt(text: string): Json | null {
  try {
    const p = JSON.parse(text) as unknown;
    return istObjekt(p) ? p : null;
  } catch {
    return null;
  }
}

function schreibeJson(wurzel: Json, roh: string): string {
  const einzug = /^([ \t]+)"/m.exec(roh)?.[1] ?? 2;
  const crlf = roh.includes('\r\n');
  let s = JSON.stringify(wurzel, null, einzug);
  if (crlf) s = s.replace(/\n/g, '\r\n');
  return /\n$/.test(roh) ? s + (crlf ? '\r\n' : '\n') : s;
}

function liesDatei(pfad: string): string | null {
  try {
    if (!lstatSync(pfad).isFile()) return null;
    return readFileSync(pfad, 'utf8');
  } catch {
    return null;
  }
}

function istVerzeichnis(pfad: string): boolean {
  try { return lstatSync(pfad).isDirectory(); } catch { return false; }
}

export type McpFormat = 'mcpServers' | 'vscode' | 'zed' | 'continue';

export type JsonErgebnis =
  | { art: 'nichts' }
  | { art: 'unlesbar' }
  | { art: 'geaendert'; nachher: string | null; entfernt: string[]; instanz: string };

function instanzAus(eintrag: unknown): string {
  if (!istObjekt(eintrag)) return '';
  const env = istObjekt(eintrag.env) ? eintrag.env : istObjekt(eintrag.command) && istObjekt(eintrag.command.env) ? eintrag.command.env : null;
  const id = env?.CACHLY_BRAIN_INSTANCE_ID;
  return typeof id === 'string' ? id : '';
}

function ohneServer(wurzel: Json, feld: string, gefunden: unknown[]): boolean {
  const behaelter = wurzel[feld];
  if (!istObjekt(behaelter) || !('cachly' in behaelter)) return false;
  gefunden.push(behaelter.cachly);
  delete behaelter.cachly;
  if (Object.keys(behaelter).length === 0) delete wurzel[feld];
  return true;
}

function istContinueEintrag(e: unknown): boolean {
  if (!istObjekt(e)) return false;
  if (istObjekt(e.env) && ('CACHLY_JWT' in e.env || 'CACHLY_BRAIN_INSTANCE_ID' in e.env)) return true;
  return JSON.stringify(e).includes('@cachly-dev/mcp-server');
}

/**
 * Nimmt den MCP-Eintrag `cachly` aus dem Text einer Editor-Konfiguration.
 * Fremde Server und Einstellungen bleiben. Bleibt danach nichts uebrig,
 * ist `nachher` null: die Datei war nur fuer cachly da. Ein Text, der kein
 * JSON-Objekt ist (Kommentare, BOM), wird nicht angefasst: `unlesbar`.
 */
export function entferneMcpEintrag(text: string, format: McpFormat): JsonErgebnis {
  const wurzel = parseObjekt(text);
  if (!wurzel) return { art: 'unlesbar' };
  const gefunden: unknown[] = [];
  const entfernt: string[] = [];
  if (format === 'mcpServers' && ohneServer(wurzel, 'mcpServers', gefunden)) entfernt.push('mcpServers.cachly');
  if (format === 'vscode') {
    if (ohneServer(wurzel, 'servers', gefunden)) entfernt.push('servers.cachly');
    if (ohneServer(wurzel, 'mcpServers', gefunden)) entfernt.push('mcpServers.cachly');
  }
  if (format === 'zed' && ohneServer(wurzel, 'context_servers', gefunden)) entfernt.push('context_servers.cachly');
  if (format === 'continue') {
    const exp = wurzel.experimental;
    const liste = istObjekt(exp) ? exp.modelContextProtocolServers : undefined;
    if (istObjekt(exp) && Array.isArray(liste)) {
      const rest = liste.filter((e) => !istContinueEintrag(e));
      if (rest.length < liste.length) {
        gefunden.push(...liste.filter(istContinueEintrag));
        entfernt.push(`experimental.modelContextProtocolServers (${liste.length - rest.length})`);
        if (rest.length === 0) delete exp.modelContextProtocolServers;
        else exp.modelContextProtocolServers = rest;
        if (Object.keys(exp).length === 0) delete wurzel.experimental;
      }
    }
  }
  if (entfernt.length === 0) return { art: 'nichts' };
  const instanz = gefunden.map(instanzAus).find(Boolean) ?? '';
  return {
    art: 'geaendert',
    nachher: Object.keys(wurzel).length === 0 ? null : schreibeJson(wurzel, text),
    entfernt,
    instanz,
  };
}

/** Welche Art cachly-Hook ein Eintrag ist, oder null bei einem fremden. */
export type HookArt = 'ambient' | 'checkpoint';

/**
 * Erkennt die Hooks, die cachly in `.claude/settings.json` schreibt: ein
 * Befehl, der ein `cachly-ambient-`-Skript ruft (mit `/` oder `\` im Pfad,
 * absolut oder `$CLAUDE_PROJECT_DIR`), und den kaputten Stop-Hook aus
 * `setup_ai_memory` (`... @cachly-dev/mcp-server ... checkpoint`).
 */
export function klassifiziereClaudeHook(h: unknown): HookArt | null {
  if (istCachlyEintrag(h)) return 'ambient';
  const befehl = String((h as { command?: unknown } | null)?.command ?? '');
  return befehl.includes('@cachly-dev/mcp-server') && befehl.includes(' checkpoint') ? 'checkpoint' : null;
}

export function klassifiziereAmbientHook(h: unknown): HookArt | null {
  return istCachlyEintrag(h) ? 'ambient' : null;
}

/**
 * Nimmt die cachly-Hooks aus `hooks.<Ereignis>` einer JSON-Datei. Kennt beide
 * Formen: Listen von Eintraegen (Cursor, Copilot) und Listen von Gruppen mit
 * `hooks: [...]` (Claude, Codex, Gemini). Eine Gruppe, ein Ereignis und
 * `hooks`, die dadurch leer werden, fallen weg; fremde Eintraege und alle
 * anderen Schluessel bleiben. `nurSchluessel`: Schluessel, die allein noch
 * keine Datei rechtfertigen (bei Cursor und Copilot `version`).
 */
export function entferneHookEintraege(
  text: string,
  klassifiziere: (h: unknown) => HookArt | null,
  nurSchluessel: readonly string[] = [],
): JsonErgebnis {
  const wurzel = parseObjekt(text);
  if (!wurzel) return { art: 'unlesbar' };
  const hooks = wurzel.hooks;
  if (!istObjekt(hooks)) return { art: 'nichts' };
  const entfernt: string[] = [];
  for (const [ereignis, liste] of Object.entries(hooks)) {
    if (!Array.isArray(liste)) continue;
    const vorher = entfernt.length;
    const neu: unknown[] = [];
    for (const element of liste) {
      const gruppe = istObjekt(element) && Array.isArray(element.hooks) ? element.hooks : null;
      if (!gruppe) {
        const art = klassifiziere(element);
        if (art) entfernt.push(art); else neu.push(element);
        continue;
      }
      const rest = gruppe.filter((h) => {
        const art = klassifiziere(h);
        if (art) entfernt.push(art);
        return !art;
      });
      if (rest.length === gruppe.length) neu.push(element);
      else if (rest.length > 0) neu.push({ ...(element as Json), hooks: rest });
    }
    if (entfernt.length === vorher) continue;
    if (neu.length === 0) delete hooks[ereignis]; else hooks[ereignis] = neu;
  }
  if (entfernt.length === 0) return { art: 'nichts' };
  if (Object.keys(hooks).length === 0) delete wurzel.hooks;
  const uebrig = Object.keys(wurzel).filter((k) => !nurSchluessel.includes(k));
  return { art: 'geaendert', nachher: uebrig.length === 0 ? null : schreibeJson(wurzel, text), entfernt, instanz: '' };
}

export type BlockErgebnis =
  | { art: 'kein-block' }
  | { art: 'kaputt' }
  | { art: 'entfernt'; rest: string };

function schneideBlock(t: string, s: number, e: number): string {
  let von = s;
  if (t[s - 1] === '\n') von = t[s - 2] === '\r' ? s - 2 : s - 1;
  let bis = e;
  if (t[e] === '\n') bis = e + 1;
  else if (t[e] === '\r' && t[e + 1] === '\n') bis = e + 2;
  if (von < s && bis > e && von > 0 && bis < t.length) {
    const wuerdeVerschmelzen = t[von - 1] !== '\n' && t[bis] !== '\n' && t[bis] !== '\r';
    if (wuerdeVerschmelzen) bis = e;
  }
  return t.slice(0, von) + t.slice(bis);
}

/**
 * Nimmt den cachly-Block zwischen den Markern aus einem Text, samt dem
 * Zeilenumbruch, den das Anhaengen davor und danach eingefuegt hat. Was
 * ausserhalb steht, bleibt Zeichen fuer Zeichen gleich. Ein Marker ohne
 * Gegenstueck: `kaputt`, der Text wird nicht angefasst.
 */
export function entferneAnweisungsBlock(text: string): BlockErgebnis {
  if (!text.includes(CLAUDE_MD_MARKER_START) && !text.includes(CLAUDE_MD_MARKER_END)) return { art: 'kein-block' };
  let rest = text;
  let anzahl = 0;
  for (;;) {
    const m = blockMuster().exec(rest);
    if (!m) break;
    rest = schneideBlock(rest, m.index, m.index + m[0].length);
    anzahl++;
  }
  if (anzahl === 0 || rest.includes(CLAUDE_MD_MARKER_START) || rest.includes(CLAUDE_MD_MARKER_END)) return { art: 'kaputt' };
  return { art: 'entfernt', rest };
}

function nurFrontmatter(text: string): boolean {
  const zeilen = text.trim().split(/\r?\n/);
  if (zeilen[0]?.trim() !== '---') return false;
  const ende = zeilen.findIndex((z, i) => i > 0 && z.trim() === '---');
  return ende > 0 && zeilen.slice(ende + 1).every((z) => z.trim() === '');
}

/** Bleibt von einer Anweisungsdatei nach dem Rueckbau nichts, was dem Nutzer gehoert? */
export function istLeerNachRueckbau(rest: string, istMdc: boolean): boolean {
  return rest.trim() === '' || (istMdc && nurFrontmatter(rest));
}

/**
 * Nimmt die Bloecke von cachly aus `.git/hooks/post-commit`: den CLS-Block und
 * den brain_watch-Block. Fremde Befehle bleiben. `rest` ist leer, wenn nur
 * cachly (und eine Shebang-Zeile) in der Datei stand.
 */
export function entferneGitHookBloecke(text: string): { rest: string; entfernt: string[] } {
  let rest = text;
  const entfernt: string[] = [];
  const bloecke: Array<[string, RegExp]> = [['CLS hook', CLS_BLOCK_RE], ['brain_watch hook', BRAIN_WATCH_BLOCK_RE]];
  for (const [name, muster] of bloecke) {
    for (;;) {
      const m = muster.exec(rest);
      if (!m) break;
      const davor = rest.slice(0, m.index).replace(/\s+$/, '');
      const danach = rest.slice(m.index + m[0].length).replace(/^\s*\n/, '');
      rest = davor + (davor && danach.trim() ? '\n\n' : '') + danach;
      entfernt.push(name);
    }
  }
  if (entfernt.length === 0) return { rest: text, entfernt };
  const t = rest.trim();
  if (t === '' || (t.startsWith('#!') && !t.includes('\n'))) return { rest: '', entfernt };
  return { rest: rest.replace(/\s+$/, '') + '\n', entfernt };
}

function innerhalb(pfad: string, wurzel: string): boolean {
  const r = relative(wurzel, pfad);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
}

function leereOrdner(funde: Fund[], stufe: Stufe, wurzel: string, tmp: string): Fund[] {
  const weg = new Set(
    funde.filter((f) => f.stufe === stufe && (f.aktion === 'datei-loeschen' || f.aktion === 'ordner-loeschen')).map((f) => f.pfad),
  );
  const kandidaten = new Set<string>();
  for (const p of weg) {
    for (let d = dirname(p); d !== tmp && innerhalb(d, wurzel) && !d.split(sep).includes('.git'); d = dirname(d)) kandidaten.add(d);
  }
  const ergebnis: Fund[] = [];
  for (const d of [...kandidaten].sort((a, b) => b.length - a.length)) {
    let namen: string[];
    try { namen = readdirSync(d); } catch { continue; }
    if (!namen.every((n) => weg.has(join(d, n)))) continue;
    weg.add(d);
    ergebnis.push({ stufe, aktion: 'ordner-entfernen', pfad: d, was: 'empty folder' });
  }
  return ergebnis;
}

function planeMcp(o: PlanEingabe, plan: Plan): void {
  const dateien = new Map<string, McpFormat>();
  for (const [editor, rel] of Object.entries(EDITOR_FILES)) {
    dateien.set(rel, editor === 'continue' ? 'continue' : editor === 'zed' ? 'zed' : rel === '.vscode/mcp.json' ? 'vscode' : 'mcpServers');
  }
  for (const [rel, format] of dateien) {
    const pfad = resolve(o.projekt, rel);
    const text = liesDatei(pfad);
    if (existsSync(`${pfad}.bak`)) {
      plan.funde.push({ stufe: 'projekt', aktion: 'melden', pfad: `${pfad}.bak`, was: 'your old file is there; uninstall does not restore it' });
    }
    if (text === null) continue;
    const r = entferneMcpEintrag(text, format);
    if (r.art === 'unlesbar') {
      if (text.includes('cachly')) {
        plan.vonHand.push({ stufe: 'projekt', text: `${rel}: cannot be read as plain JSON (comments or another format). Remove the "cachly" entry by hand.` });
      }
      continue;
    }
    if (r.art === 'nichts') continue;
    plan.instanz ||= r.instanz;
    if (r.nachher === null) {
      plan.funde.push({ stufe: 'projekt', aktion: 'datei-loeschen', pfad, was: 'MCP server entry "cachly", the only thing in the file', vorher: text });
    } else {
      plan.funde.push({ stufe: 'projekt', aktion: 'eintrag-entfernen', pfad, was: 'MCP server entry "cachly"; other servers and settings stay', vorher: text, nachher: r.nachher });
    }
  }
}

function planeAnweisungen(o: PlanEingabe, plan: Plan): void {
  for (const d of ANWEISUNGS_DATEIEN) {
    const pfad = resolve(o.projekt, ...d.pfad);
    const text = liesDatei(pfad);
    if (text === null) continue;
    const rel = d.pfad.join('/');
    const r = entferneAnweisungsBlock(text);
    if (r.art === 'kein-block') {
      if (text.startsWith('# cachly AI Brain')) {
        plan.vonHand.push({ stufe: 'projekt', text: `${rel}: looks like the whole file was written by the setup_ai_memory tool (no markers). Check it and remove it by hand if it is not yours.` });
      }
      continue;
    }
    if (r.art === 'kaputt') {
      plan.vonHand.push({ stufe: 'projekt', text: `${rel}: a cachly marker has no partner. Remove the block by hand.` });
      continue;
    }
    if (istLeerNachRueckbau(r.rest, rel.endsWith('.mdc'))) {
      plan.funde.push({ stufe: 'projekt', aktion: 'datei-loeschen', pfad, was: 'only the cachly block was in it', vorher: text });
    } else {
      plan.funde.push({ stufe: 'projekt', aktion: 'block-entfernen', pfad, was: 'cachly block between the markers; your text stays as it is', vorher: text, nachher: r.rest });
    }
  }
}

function planeHookDatei(
  o: PlanEingabe, plan: Plan, rel: string, klassifiziere: (h: unknown) => HookArt | null, nurSchluessel: readonly string[],
): void {
  const pfad = resolve(o.projekt, rel);
  const text = liesDatei(pfad);
  if (text === null) return;
  const r = entferneHookEintraege(text, klassifiziere, nurSchluessel);
  if (r.art === 'unlesbar') {
    if (text.includes(PROJEKT_HOOK_MARKE) || text.includes('@cachly-dev/mcp-server')) {
      plan.vonHand.push({ stufe: 'projekt', text: `${rel}: cannot be read as plain JSON (comments or another format). Remove the cachly hooks by hand.` });
    }
    return;
  }
  if (r.art === 'nichts') return;
  const ambient = r.entfernt.filter((a) => a === 'ambient').length;
  const kaputt = r.entfernt.filter((a) => a === 'checkpoint').length;
  const teile = [
    ...(ambient ? [`${ambient} Ambient Recall hook${ambient === 1 ? '' : 's'}`] : []),
    ...(kaputt ? [`${kaputt} ${KAPUTTER_STOP_HOOK}`] : []),
  ];
  if (r.nachher === null) {
    plan.funde.push({ stufe: 'projekt', aktion: 'datei-loeschen', pfad, was: `${teile.join(' and ')}, the only thing in the file`, vorher: text });
  } else {
    plan.funde.push({ stufe: 'projekt', aktion: 'eintrag-entfernen', pfad, was: `${teile.join(' and ')}; other hooks and settings stay`, vorher: text, nachher: r.nachher });
  }
}

function planeHookSkripte(o: PlanEingabe, plan: Plan, relOrdner: string): void {
  const ordner = resolve(o.projekt, relOrdner);
  let namen: string[];
  try { namen = readdirSync(ordner); } catch { return; }
  for (const n of namen.sort()) {
    const pfad = join(ordner, n);
    if (!n.startsWith(PROJEKT_HOOK_MARKE) || liesDatei(pfad) === null) continue;
    plan.funde.push({ stufe: 'projekt', aktion: 'datei-loeschen', pfad, was: 'Ambient Recall hook script' });
  }
}

function planeHooks(o: PlanEingabe, plan: Plan): void {
  planeHookDatei(o, plan, CLAUDE_SETTINGS_DATEI, klassifiziereClaudeHook, []);
  planeHookDatei(o, plan, CURSOR_HOOKS_DATEI, klassifiziereAmbientHook, ['version']);
  planeHookDatei(o, plan, COPILOT_HOOKS_DATEI, klassifiziereAmbientHook, ['version']);
  planeHookDatei(o, plan, CODEX_HOOKS_DATEI, klassifiziereAmbientHook, []);
  planeHookDatei(o, plan, GEMINI_SETTINGS_DATEI, klassifiziereAmbientHook, []);
  for (const ordner of [CLAUDE_HOOK_DIR, CURSOR_HOOK_DIR, COPILOT_HOOK_DIR, CODEX_HOOK_DIR, GEMINI_HOOK_DIR]) planeHookSkripte(o, plan, ordner);
  const gemini = parseObjekt(liesDatei(resolve(o.projekt, GEMINI_SETTINGS_DATEI)) ?? '');
  if (gemini && istObjekt(gemini.mcpServers) && 'cachly' in gemini.mcpServers) {
    plan.vonHand.push({ stufe: 'projekt', text: `${GEMINI_SETTINGS_DATEI}: the MCP server "cachly" (added by "gemini mcp add") stays. Remove that entry by hand.` });
  }
}

function planeGitHook(o: PlanEingabe, plan: Plan): void {
  const git = join(o.projekt, '.git');
  if (!existsSync(git)) return;
  if (!istVerzeichnis(git)) {
    plan.vonHand.push({ stufe: 'projekt', text: '.git is a file here (a Git worktree). cachly never writes a post-commit hook there. If you set one up in the main repository, check its .git/hooks/post-commit.' });
    return;
  }
  const pfad = join(git, 'hooks', 'post-commit');
  const text = liesDatei(pfad);
  if (text === null) return;
  const r = entferneGitHookBloecke(text);
  if (r.entfernt.length === 0) return;
  const was = r.entfernt.join(' and ');
  if (r.rest === '') plan.funde.push({ stufe: 'projekt', aktion: 'datei-loeschen', pfad, was: `${was}, the only thing in the hook`, vorher: text });
  else plan.funde.push({ stufe: 'projekt', aktion: 'block-entfernen', pfad, was: `${was}; your own commands stay`, vorher: text, nachher: r.rest });
}

function planeGlobal(o: PlanEingabe, plan: Plan): void {
  const claudeMcp = join(o.heim, '.claude', 'mcp.json');
  const text = liesDatei(claudeMcp);
  if (text !== null) {
    const r = entferneMcpEintrag(text, 'mcpServers');
    if (r.art === 'unlesbar' && text.includes('cachly')) {
      plan.vonHand.push({ stufe: 'global', text: '~/.claude/mcp.json: cannot be read as plain JSON. Remove the "cachly" entry by hand.' });
    } else if (r.art === 'geaendert') {
      plan.instanz ||= r.instanz;
      if (r.nachher === null) plan.funde.push({ stufe: 'global', aktion: 'datei-loeschen', pfad: claudeMcp, was: 'MCP server entry "cachly", the only thing in the file (it holds your key)', vorher: text });
      else plan.funde.push({ stufe: 'global', aktion: 'eintrag-entfernen', pfad: claudeMcp, was: 'MCP server entry "cachly" (it holds your key); other servers stay', vorher: text, nachher: r.nachher });
    }
  }
  for (const fremd of [join(o.heim, '.cursor', 'mcp.json'), join(o.heim, '.codeium', 'windsurf', 'mcp_config.json')]) {
    const t = liesDatei(fremd);
    if (t === null) continue;
    const r = entferneMcpEintrag(t, 'mcpServers');
    if (r.art === 'geaendert' || (r.art === 'unlesbar' && t.includes('cachly'))) {
      plan.funde.push({ stufe: 'global', aktion: 'melden', pfad: fremd, was: 'has a "cachly" server entry. You set this file up yourself, so uninstall leaves it. Remove the entry by hand.' });
    }
  }
  const cachlyDir = join(o.heim, '.cachly');
  let namen: string[] = [];
  try { namen = readdirSync(cachlyDir); } catch { /* kein Ordner */ }
  const uebrig: string[] = [];
  for (const n of namen.sort()) {
    const pfad = join(cachlyDir, n);
    if (HEIM_DATEI_MUSTER.test(n) && liesDatei(pfad) !== null) {
      const was = n === basename(credentialsPath({ home: '' }))
        ? 'your key and Brain id; other projects on this computer lose their access'
        : 'cachly data on this computer';
      plan.funde.push({ stufe: 'global', aktion: 'datei-loeschen', pfad, was });
    } else {
      uebrig.push(n);
    }
  }
  if (uebrig.length > 0) {
    plan.vonHand.push({ stufe: 'global', text: `~/.cachly also holds ${uebrig.join(', ')}. Not written by this package, so it stays.${uebrig.includes('vscode-mcp.env') ? ' vscode-mcp.env holds your key (written by the VS Code extension): uninstall the extension, then delete it.' : ''}` });
  }
  let tmpNamen: string[] = [];
  try { tmpNamen = readdirSync(o.tmp); } catch { /* kein Ordner */ }
  for (const n of tmpNamen.sort()) {
    if (!n.startsWith('cachly-')) continue;
    const pfad = join(o.tmp, n);
    const ordner = istVerzeichnis(pfad);
    if (!istCachlyAblage(n, ordner)) continue;
    plan.funde.push({ stufe: 'global', aktion: ordner ? 'ordner-loeschen' : 'datei-loeschen', pfad, was: 'cache in the temp folder' });
  }
}

/**
 * Sammelt alles, was cachly auf diesem Rechner geschrieben hat, und sagt zu
 * jedem Fund, was damit geschaehe. Liest nur, schreibt nichts.
 */
export function plane(eingabe: PlanEingabe): Plan {
  const o: PlanEingabe = { projekt: resolve(eingabe.projekt), heim: resolve(eingabe.heim), tmp: resolve(eingabe.tmp) };
  const plan: Plan = { funde: [], vonHand: [], instanz: '' };
  planeMcp(o, plan);
  planeAnweisungen(o, plan);
  planeHooks(o, plan);
  planeGitHook(o, plan);
  planeGlobal(o, plan);
  plan.funde.push(...leereOrdner(plan.funde, 'projekt', o.projekt, o.tmp));
  plan.funde.push(...leereOrdner(plan.funde, 'global', o.heim, o.tmp));
  return plan;
}

function tiefe(p: string): number {
  return p.split(sep).length;
}

/**
 * Fuehrt die Funde aus. Eine Datei, die sich seit dem Planen geaendert hat,
 * wird uebersprungen. Wirft nie; jeder Fehler wird zur Zeile `uebersprungen`.
 */
export function fuehreAus(funde: Fund[]): Zeile[] {
  const reihenfolge = [...funde].sort((a, b) => {
    const gruppe = (f: Fund) => (f.aktion === 'ordner-entfernen' ? 1 : 0);
    return gruppe(a) - gruppe(b) || (gruppe(a) ? tiefe(b.pfad) - tiefe(a.pfad) : 0);
  });
  return reihenfolge.map((fund): Zeile => {
    if (fund.aktion === 'melden') return { fund, status: 'uebersprungen', grund: 'only reported' };
    try {
      if (fund.vorher !== undefined && liesDatei(fund.pfad) !== fund.vorher) {
        return { fund, status: 'uebersprungen', grund: 'the file changed after the plan was made' };
      }
      if (fund.aktion === 'datei-loeschen') rmSync(fund.pfad, { force: true });
      else if (fund.aktion === 'ordner-loeschen') rmSync(fund.pfad, { recursive: true, force: true });
      else if (fund.aktion === 'ordner-entfernen') rmdirSync(fund.pfad);
      else writeFileSync(fund.pfad, fund.nachher ?? '', 'utf8');
      return { fund, status: 'entfernt' };
    } catch (e) {
      const grund = (e as NodeJS.ErrnoException).code === 'ENOTEMPTY' ? 'the folder is not empty' : (e as Error).message;
      return { fund, status: 'uebersprungen', grund };
    }
  });
}

export interface Bestand {
  schluessel: 'test' | 'konto' | 'keiner';
  turns: number;
  injected: number;
  prevented: number;
  net: number;
  lektionen: number | null;
  /** Warum die Zahl fehlt: 'no-instance' oder 'unreachable'. */
  lektionenFehlt?: 'no-instance' | 'unreachable';
}

export interface BestandEingabe {
  heim: string;
  schluessel: string;
  instanz: string;
  apiUrl: string;
  fetchFn?: typeof fetch;
}

/**
 * Die Zahlen, die jemand sieht, bevor er geht: Art des Schluessels, die Bilanz
 * aus dem Ambient-Ledger und die Zahl der Lektionen im Konto. Die Zahl der
 * Lektionen kommt aus dem Netz (5 s); fehlt sie, steht dort "not reachable".
 */
export async function sammleBestand(e: BestandEingabe): Promise<Bestand> {
  const eintraege = await readLedger(join(e.heim, '.cachly', basename(defaultLedgerPath())));
  const bilanz = netBalance(eintraege);
  const bestand: Bestand = {
    schluessel: !e.schluessel ? 'keiner' : istTestSchluessel(e.schluessel) ? 'test' : 'konto',
    turns: eintraege.length,
    injected: bilanz.injected,
    prevented: bilanz.prevented,
    net: bilanz.net,
    lektionen: null,
  };
  if (!e.schluessel || !e.instanz) {
    bestand.lektionenFehlt = 'no-instance';
    return bestand;
  }
  try {
    const res = await (e.fetchFn ?? fetch)(`${e.apiUrl}/api/v1/instances/${e.instanz}/memory`, {
      headers: { Authorization: `Bearer ${e.schluessel}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const zahl = ((await res.json()) as { lesson_count?: unknown }).lesson_count;
    if (typeof zahl !== 'number') throw new Error('no lesson_count');
    bestand.lektionen = zahl;
  } catch {
    bestand.lektionenFehlt = 'unreachable';
  }
  return bestand;
}

export interface UninstallUmgebung {
  projekt: string;
  heim: string;
  tmp: string;
  schluessel: string;
  instanz: string;
  apiUrl: string;
  istTty: boolean;
  fetchFn?: typeof fetch;
  ausgabe: (zeile: string) => void;
  frage: (text: string) => Promise<boolean>;
}

const ETIKETT: Record<Aktion, string> = {
  'datei-loeschen': 'delete file',
  'ordner-loeschen': 'delete folder',
  'ordner-entfernen': 'remove folder',
  'eintrag-entfernen': 'remove entry',
  'block-entfernen': 'remove block',
  melden: 'note only',
};

function zeigePfad(f: Fund, u: UninstallUmgebung): string {
  const basis = f.stufe === 'projekt' ? u.projekt : u.heim;
  const r = relative(basis, f.pfad);
  const innen = r !== '' && !r.startsWith('..') && !isAbsolute(r);
  const s = (innen ? r : f.pfad).split(sep).join('/');
  return f.stufe === 'global' && innen ? `~/${s}` : s;
}

function zeigeBestand(b: Bestand, u: UninstallUmgebung): void {
  const o = u.ausgabe;
  o('');
  o('What you have right now');
  const schluessel = b.schluessel === 'test'
    ? 'test key (cky_trial_), the Brain behind it is a test Brain'
    : b.schluessel === 'konto' ? 'account key' : 'none found';
  o(`  Key:      ${schluessel}`);
  const lektionen = b.lektionen !== null
    ? `${b.lektionen} in your Brain`
    : b.lektionenFehlt === 'no-instance' ? 'unknown (no key or Brain found here)' : 'not reachable right now';
  o(`  Lessons:  ${lektionen}`);
  o(b.turns > 0
    ? `  Ledger:   ${b.turns} turns, ${b.injected} tokens injected, ${b.prevented} prevented, net ${b.net >= 0 ? '+' : ''}${b.net} tokens`
    : '  Ledger:   no turns recorded');
  o('  To keep your lessons first, write them to disk:');
  o('    npx @cachly-dev/mcp-server@latest export');
}

function zeigeFunde(titel: string, funde: Fund[], u: UninstallUmgebung): void {
  u.ausgabe('');
  u.ausgabe(titel);
  for (const f of funde) u.ausgabe(`  ${ETIKETT[f.aktion].padEnd(14)} ${zeigePfad(f, u)}  (${f.was})`);
}

function zeigeVonHand(plan: Plan, global: boolean, u: UninstallUmgebung): void {
  u.ausgabe('');
  u.ausgabe('By hand (uninstall cannot do these):');
  u.ausgabe('  - Codex and Gemini CLI keep the cachly MCP server in their own settings (~/.codex/config.toml, .gemini/settings.json). If you registered it there, remove the entry named cachly.');
  u.ausgabe('  - Uninstall the JetBrains plugin "Cachly Brain" (Settings, Plugins) and the VS Code extension "cachly Brain" (cachly-dev.cachly-brain), if you installed them.');
  for (const h of plan.vonHand) if (h.stufe === 'projekt' || global) u.ausgabe(`  - ${h.text}`);
}

function zeigeErgebnis(zeilen: Zeile[], u: UninstallUmgebung): void {
  u.ausgabe('');
  for (const z of zeilen) {
    if (z.fund.aktion === 'melden') continue;
    const status = z.status === 'entfernt' ? 'removed' : 'skipped';
    u.ausgabe(`  ${status.padEnd(8)} ${zeigePfad(z.fund, u)}${z.grund ? `  (${z.grund})` : ''}`);
  }
  const echte = zeilen.filter((z) => z.fund.aktion !== 'melden');
  u.ausgabe(`Done: ${echte.filter((z) => z.status === 'entfernt').length} removed, ${echte.filter((z) => z.status === 'uebersprungen').length} skipped.`);
}

function parseFlags(argv: string[]): { dryRun: boolean; ja: boolean; global: boolean } {
  return { dryRun: argv.includes('--dry-run'), ja: argv.includes('--yes') || argv.includes('-y'), global: argv.includes('--global') };
}

/**
 * `uninstall [--dry-run] [--yes] [--global] [--project-dir <pfad>]`.
 * Zeigt erst die Zahlen (Bestandsanzeige), dann den Plan; fragt, wenn kein
 * `--yes` da ist; fuehrt aus. Standard ist nur das Projekt. Der Heimordner
 * kommt nur mit `--global` und hat seine eigene Rueckfrage. Daten im Konto
 * werden nie geloescht. Gibt den Exit-Code zurueck: 0 ok, 1 Abbruch oder
 * uebersprungene Funde.
 */
export async function uninstallBefehl(argv: string[], u: UninstallUmgebung): Promise<number> {
  const flags = parseFlags(argv);
  const plan = plane({ projekt: u.projekt, heim: u.heim, tmp: u.tmp });
  const bestand = await sammleBestand({
    heim: u.heim, schluessel: u.schluessel, instanz: u.instanz || plan.instanz, apiUrl: u.apiUrl, fetchFn: u.fetchFn,
  });
  zeigeBestand(bestand, u);

  const projektFunde = plan.funde.filter((f) => f.stufe === 'projekt');
  const globalFunde = plan.funde.filter((f) => f.stufe === 'global');
  const projektTun = projektFunde.filter((f) => f.aktion !== 'melden');
  const globalTun = globalFunde.filter((f) => f.aktion !== 'melden');

  if (projektFunde.length === 0 && (!flags.global || globalFunde.length === 0)) {
    u.ausgabe('');
    u.ausgabe(`Nothing found in ${u.projekt}${flags.global ? ' or your home folder' : ''}: cachly has not written anything here that uninstall can remove.`);
    if (!flags.global && globalTun.length > 0) {
      u.ausgabe(`Your home folder still holds ${globalTun.length} cachly files (key, ledger, caches). "uninstall --global" removes them.`);
    }
    zeigeVonHand(plan, flags.global, u);
    u.ausgabe('');
    u.ausgabe(KONTO_LOESCHEN);
    return 0;
  }

  if (projektFunde.length > 0) zeigeFunde(`In this project (${u.projekt}):`, projektFunde, u);
  if (flags.global && globalFunde.length > 0) zeigeFunde('In your home folder and temp folder (--global):', globalFunde, u);
  zeigeVonHand(plan, flags.global, u);
  u.ausgabe('');
  u.ausgabe(KONTO_LOESCHEN);

  if (flags.dryRun) {
    u.ausgabe('');
    u.ausgabe('Dry run: nothing was changed.');
    // Die Zahl umfasst Heimordner UND Temp-Ordner (Caches der Hooks) — in einer echten
    // Umgebung (16.10.2026) waren es 416, fast alle im Temp-Ordner. "home folder" allein
    // haette eine Zahl behauptet, die dort nicht liegt.
    if (!flags.global && globalTun.length > 0) {
      u.ausgabe(`Your home and temp folders hold ${globalTun.length} more cachly files (key, ledger, caches); add --global to include them.`);
    }
    return 0;
  }

  const hatEtwas = projektTun.length > 0 || (flags.global && globalTun.length > 0);
  if (!hatEtwas) {
    u.ausgabe('');
    u.ausgabe('Nothing to remove.');
    return 0;
  }
  if (!flags.ja && !u.istTty) {
    u.ausgabe('');
    u.ausgabe('This is not a terminal and --yes is missing: nothing was changed. Run it in a terminal, or add --yes. "--dry-run" only shows the plan.');
    return 1;
  }

  let ausgefuehrt = 0;
  let uebersprungen = 0;
  if (projektTun.length > 0) {
    const ok = flags.ja || await u.frage(`\nRemove these ${projektTun.length} items from this project? [y/N] `);
    if (ok) {
      const zeilen = fuehreAus(projektFunde);
      zeigeErgebnis(zeilen, u);
      ausgefuehrt += zeilen.filter((z) => z.status === 'entfernt').length;
      uebersprungen += zeilen.filter((z) => z.status === 'uebersprungen' && z.fund.aktion !== 'melden').length;
    } else {
      u.ausgabe('Project: nothing was changed.');
    }
  }
  if (flags.global && globalTun.length > 0) {
    u.ausgabe('');
    u.ausgabe('Home folder: this removes your key file. Other projects on this computer lose their access to the Brain.');
    if (bestand.schluessel === 'test') {
      u.ausgabe('It is a test key. Without it you cannot reach the test Brain again. "npx @cachly-dev/mcp-server@latest claim" keeps it in your own account first.');
    }
    const ok = flags.ja || await u.frage(`\nRemove these ${globalTun.length} items from your home and temp folder? [y/N] `);
    if (ok) {
      const zeilen = fuehreAus(globalFunde);
      zeigeErgebnis(zeilen, u);
      ausgefuehrt += zeilen.filter((z) => z.status === 'entfernt').length;
      uebersprungen += zeilen.filter((z) => z.status === 'uebersprungen' && z.fund.aktion !== 'melden').length;
    } else {
      u.ausgabe('Home folder: nothing was changed.');
    }
  } else if (!flags.global && globalTun.length > 0) {
    u.ausgabe('');
    u.ausgabe(`Your home folder still holds ${globalTun.length} cachly files (key, ledger, caches). "uninstall --global" removes them, with its own question.`);
  }
  if (ausgefuehrt === 0 && uebersprungen === 0) u.ausgabe('Nothing was changed.');
  return uebersprungen > 0 ? 1 : 0;
}
