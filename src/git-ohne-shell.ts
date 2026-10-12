/**
 * Git aufrufen, ohne dass ein Wert aus einer Werkzeugeingabe durch eine Shell geht.
 *
 * Warum es diese Datei gibt: `workspace_path`, `repo_path`, `branch` und `since`
 * kommen vom Modell. Das Modell liest Dateien, Issues und Lektionen, und in
 * jedem dieser Texte kann ein Satz stehen, der es zu einem bestimmten
 * Werkzeugaufruf bewegt. Wer solche Werte in eine Befehlszeile einsetzt
 * (`execSync(\`git -C "${pfad}" log\`)`), laesst die Shell des Nutzers Zeichen
 * deuten, die als Pfad gemeint waren: Semikolon, Backtick, `$(…)`, Zeilenumbruch.
 *
 * Hier gilt deshalb eine Regel: Der Programmname und jedes Argument stehen
 * getrennt in einer Liste, und es gibt keine Shell. `execFileSync` startet
 * `git` direkt; ein Argument bleibt ein Argument, was immer darin steht.
 *
 * Der Pfad geht als Arbeitsordner (`cwd`) hinein, nicht als `git -C <pfad>`.
 * `resolve()` macht ihn absolut, er kann also nie mit `-` beginnen und als
 * Option gelesen werden.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Werkzeugeingabe -> absoluter Pfad eines vorhandenen Ordners, sonst `null`.
 *
 * Geprueft wird: ist es ein Text, ist er nicht leer, enthaelt er kein NUL-Zeichen
 * (das kappt Pfade in manchen Schichten), und gibt es den Ordner wirklich.
 * Leerzeichen und andere Sonderzeichen im Pfad sind erlaubt — ohne Shell sind
 * sie nur Teil des Namens (unter Windows ist "C:\Users\Max Mustermann\..." normal).
 */
export function pruefeOrdner(roh: unknown): string | null {
  if (typeof roh !== 'string' || roh === '' || roh.includes('\0')) return null;
  const absolut = resolve(roh);
  try {
    return statSync(absolut).isDirectory() ? absolut : null;
  } catch {
    return null;
  }
}

/** Ein Commit-Hash, wie Git ihn ausgibt: 7 bis 64 Hex-Zeichen. */
export function istCommitHash(wert: unknown): wert is string {
  return typeof wert === 'string' && /^[0-9a-f]{7,64}$/i.test(wert);
}

/**
 * Beginnt der Wert mit `-`? Dann wuerde Git ihn als Option lesen
 * (`--output=<datei>` schreibt zum Beispiel eine Datei). Fuer Werte, die als
 * eigenes Argument stehen, vor dem Aufruf pruefen.
 */
export function beginntMitBindestrich(wert: string): boolean {
  return wert.startsWith('-');
}

// ── Werte, die in einen Skripttext geschrieben werden ────────────────────────
//
// Hook-Skripte (`.git/hooks/post-commit`) und die Befehlsbloecke von
// `cls_install_hooks` sind Shell-Text, der spaeter ausgefuehrt wird. Ein Wert aus
// einer Werkzeugeingabe darf dort nur stehen, wenn er kein Zeichen mit
// Bedeutung fuer die Shell enthaelt. Statt zu maskieren, wird abgelehnt.

const INSTANZ_ID_MUSTER = /^[A-Za-z0-9_-]{1,64}$/;
const SCHLUESSEL_MUSTER = /^[A-Za-z0-9._~-]{1,4096}$/;

/** Instanz-ID fuer einen Skripttext: Buchstaben, Ziffern, `_` und `-`. Sonst Fehler. */
export function instanzIdFuerSkript(wert: unknown): string {
  if (typeof wert !== 'string' || !INSTANZ_ID_MUSTER.test(wert)) {
    throw new Error('instance_id fehlt oder enthaelt Zeichen, die nicht in ein Hook-Skript gehoeren (erlaubt: Buchstaben, Ziffern, _ und -).');
  }
  return wert;
}

/** API-Schluessel oder JWT fuer einen Skripttext: Buchstaben, Ziffern, `.`, `_`, `~`, `-`. Sonst Fehler. */
export function schluesselFuerSkript(wert: unknown): string {
  if (typeof wert !== 'string' || !SCHLUESSEL_MUSTER.test(wert)) {
    throw new Error('Der API-Schluessel enthaelt Zeichen, die nicht in ein Hook-Skript gehoeren (erlaubt: Buchstaben, Ziffern, ., _, ~ und -).');
  }
  return wert;
}

/**
 * Text als EIN Wort fuer eine POSIX-Shell: in einfache Anfuehrungszeichen,
 * ein `'` im Text wird zu `'\''`. Nur fuer Befehlstexte, die ein Mensch oder
 * Assistent abtippt oder einfuegt — nie als Ersatz fuer eine Argumentliste.
 */
export function alsShellWort(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export interface GitLesenOptionen {
  /** Zeitdeckel in Millisekunden. Standard 5000. */
  timeoutMs?: number;
  /** Fehlerausgabe von Git auffangen (`pipe`, Standard `ignore`). Bei `pipe` steht sie in der Fehlermeldung. */
  stderr?: 'pipe' | 'ignore';
}

/**
 * `git <args>` im Ordner `ordner` ausfuehren und die Ausgabe als Text liefern.
 * Wirft, wenn Git fehlt, der Ordner kein Repo ist oder der Zeitdeckel greift.
 */
export function gitLesen(ordner: string, args: readonly string[], optionen: GitLesenOptionen = {}): string {
  return execFileSync('git', [...args], {
    cwd: ordner,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', optionen.stderr ?? 'ignore'],
    timeout: optionen.timeoutMs ?? 5000,
    windowsHide: true,
  });
}
