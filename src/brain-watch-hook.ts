// Ambient git post-commit hook builder for Brain auto-learning.
//
// Installs a .git/hooks/post-commit script that POSTs the commit data
// directly to the cachly API via curl — no Node required at hook runtime,
// so it works even without npx or the MCP server installed locally.
//
// Safety contract:
//   • exit 0 is ALWAYS the last line — the hook never blocks a commit.
//   • All network calls run in the background (&) with 2>/dev/null.
//   • Commit message / sha / files are never interpolated into JS source;
//     they're passed as shell variables in the JSON body (curl --data-raw).

import { existsSync } from 'node:fs';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Bumped whenever the hook script changes so installers can upgrade old hooks. */
export const BRAIN_WATCH_HOOK_VERSION = 'v1';

/**
 * Matches any previously-installed cachly brain_watch block (from its marker
 * comment down to the trailing `exit 0`), optionally including a shebang.
 * Used to upgrade old hooks in place rather than duplicating them.
 */
const BRAIN_WATCH_BLOCK_RE = /(?:#!\/bin\/sh\n)?# cachly brain_watch[\s\S]*?\nexit 0\n?/;

export type BrainWatchHookResult = 'written' | 'upgraded' | 'appended' | 'unchanged' | 'skipped-no-git';

/**
 * Idempotently install/upgrade the brain_watch post-commit hook in `projectDir`.
 * Never throws — returns a status string the caller can report. Safe to run
 * repeatedly; a second call with the same version returns 'unchanged'.
 */
export async function installBrainWatchHook(
  projectDir: string,
  instanceId: string,
  apiKey?: string,
): Promise<{ result: BrainWatchHookResult; hookPath: string }> {
  if (!existsSync(resolve(projectDir, '.git'))) {
    return { result: 'skipped-no-git', hookPath: '' };
  }
  const hookDir = resolve(projectDir, '.git', 'hooks');
  const hookPath = resolve(hookDir, 'post-commit');
  await mkdir(hookDir, { recursive: true });
  const script = buildBrainWatchHook(instanceId, apiKey);

  let existing = '';
  try { existing = await readFile(hookPath, 'utf-8'); } catch { /* no existing hook */ }

  if (!existing) {
    await writeFile(hookPath, script + '\n', 'utf-8');
    await chmod(hookPath, 0o755).catch(() => {});
    return { result: 'written', hookPath };
  }
  if (existing.includes(`cachly brain_watch — Auto-Learn ${BRAIN_WATCH_HOOK_VERSION}`)) {
    return { result: 'unchanged', hookPath };
  }
  if (BRAIN_WATCH_BLOCK_RE.test(existing)) {
    const replaced = existing.replace(BRAIN_WATCH_BLOCK_RE, script);
    await writeFile(hookPath, replaced.endsWith('\n') ? replaced : replaced + '\n', 'utf-8');
    await chmod(hookPath, 0o755).catch(() => {});
    return { result: 'upgraded', hookPath };
  }
  // Foreign hook with no brain_watch block → append ours.
  await writeFile(hookPath, existing.trimEnd() + '\n\n' + script + '\n', 'utf-8');
  await chmod(hookPath, 0o755).catch(() => {});
  return { result: 'appended', hookPath };
}

/**
 * Build the `.git/hooks/post-commit` shell script for brain_watch.
 * Uses curl (not Node) so it works without npx. Runs in the background and
 * always exits 0 — never blocks a commit.
 *
 * @param instanceId  Cachly Brain instance to learn into.
 * @param apiKey      Optional cky_… key; if absent, the script reads $CACHLY_JWT from env.
 */
export function buildBrainWatchHook(instanceId: string, apiKey?: string): string {
  return [
    `#!/bin/sh`,
    `# cachly brain_watch — Auto-Learn ${BRAIN_WATCH_HOOK_VERSION}`,
    `# Silently teaches your Brain after every commit — no manual brain_from_git needed.`,
    ...(apiKey ? [`CACHLY_JWT="${apiKey}"`] : []),
    `_BW_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
    `_BW_MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1 | cut -c1-200)`,
    `_BW_FILES=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | tr '\\n' '\\t' | sed 's/\\t$//')`,
    `(curl -s -o /dev/null -m 8 \\`,
    `  -X POST "https://api.cachly.dev/api/v1/instances/${instanceId}/learn" \\`,
    `  -H "Authorization: Bearer \${CACHLY_JWT}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  --data-raw "{\\"message\\":\\"$(echo "$_BW_MSG" | sed 's/"/\\\\"/g')\\",\\"sha\\":\\"$_BW_SHA\\",\\"files\\":[$(echo "$_BW_FILES" | tr '\\t' '\\n' | grep -v '^$' | sed 's/.*/\\"&\\"/' | tr '\\n' ',' | sed 's/,$//')],\\"source\\":\\"brain_watch\\"}" \\`,
    `) 2>/dev/null &`,
    `exit 0`,
  ].join('\n');
}
