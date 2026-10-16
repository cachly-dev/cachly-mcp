// brain_watch: der git-Hook, der aus jedem Commit lernt.
//
// Seit 0.10.206 richtet brain_watch DENSELBEN Hook ein wie init, setup und
// autopilot (cls-hook.ts, CLS v3). Der Hook schreibt keinen Schluessel ins
// Projekt; `cls-ingest` holt ihn beim Lauf aus $CACHLY_JWT oder
// ~/.cachly/credentials.json.
//
// Bis 0.10.205 schrieb brain_watch einen eigenen curl-Block. Mit `api_key`
// stand der Schluessel im Klartext in .git/hooks/post-commit. Ohne `api_key`
// las der Block nur $CACHLY_JWT und lief seit #784 (Schluessel in
// credentials.json) meist still ins Leere. Stand zusaetzlich der CLS-Hook in
// der Datei, kam jeder Commit doppelt im Brain an. Diesen alten Block entfernt
// installBrainWatchHook, bevor es den CLS-Hook einrichtet.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { installClsPostCommitHook, type ClsHookResult } from './cls-hook.js';
import { instanzIdFuerSkript } from './git-ohne-shell.js';

/**
 * Erkennt einen alten brain_watch-Block (bis 0.10.205), vom Marker bis zum
 * `exit 0`, mit einem Shebang direkt davor. `uninstall` nutzt ihn ebenfalls.
 */
export const BRAIN_WATCH_BLOCK_RE = /(?:#!\/bin\/sh\n)?# cachly brain_watch[\s\S]*?\nexit 0\n?/;

export type BrainWatchHookResult = ClsHookResult;

/**
 * Text ohne alte brain_watch-Bloecke, fremde Zeilen bleiben. `null`, wenn keiner
 * drin war; '' wenn nach dem Entfernen nur ein Shebang uebrig bliebe.
 */
export function ohneBrainWatchBlock(text: string): string | null {
  if (!BRAIN_WATCH_BLOCK_RE.test(text)) return null;
  let rest = text;
  for (let m = BRAIN_WATCH_BLOCK_RE.exec(rest); m; m = BRAIN_WATCH_BLOCK_RE.exec(rest)) {
    const davor = rest.slice(0, m.index).replace(/\s+$/, '');
    const danach = rest.slice(m.index + m[0].length).replace(/^\s*\n/, '');
    rest = davor + (davor && danach.trim() ? '\n\n' : '') + danach;
  }
  const t = rest.trim();
  if (t === '' || (t.startsWith('#!') && !t.includes('\n'))) return '';
  return rest.replace(/\s+$/, '') + '\n';
}

/**
 * Richtet den Commit-Hook ein (CLS v3, wie `init`) und raeumt einen alten
 * brain_watch-Block weg. Wirft nur bei einer instance_id mit Shell-Zeichen —
 * und zwar bevor eine Datei angefasst wird.
 */
export async function installBrainWatchHook(
  projectDir: string,
  instanceId: string,
): Promise<{ result: BrainWatchHookResult; hookPath: string; alterBlockEntfernt: boolean }> {
  instanzIdFuerSkript(instanceId);
  if (!existsSync(resolve(projectDir, '.git'))) {
    return { result: 'skipped-no-git', hookPath: '', alterBlockEntfernt: false };
  }
  const hookPath = resolve(projectDir, '.git', 'hooks', 'post-commit');
  let vorher = '';
  try { vorher = await readFile(hookPath, 'utf-8'); } catch { /* kein Hook */ }
  const bereinigt = ohneBrainWatchBlock(vorher);
  if (bereinigt !== null) await writeFile(hookPath, bereinigt, 'utf-8');

  const result = await installClsPostCommitHook(projectDir, instanceId);
  const alterBlockEntfernt = bereinigt !== null;
  return { result: alterBlockEntfernt && result === 'unchanged' ? 'upgraded' : result, hookPath, alterBlockEntfernt };
}
