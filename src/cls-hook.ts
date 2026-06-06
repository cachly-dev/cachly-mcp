// Shared builder for the CLS (Continuous Learning Stream) git post-commit hook.
//
// History / why this is centralised:
// The previous inline versions interpolated the commit message directly into a
// `node -e "... message:'$MSG' ..."` JS string. Any commit message containing an
// apostrophe (e.g. "don't crash") produced invalid JavaScript, so the hook
// silently ingested nothing — and a crafted message could inject shell/JS.
//
// This version is robust:
//   • Commit message / sha / files are passed to node via ENVIRONMENT VARIABLES,
//     never interpolated into JS source — no quoting or injection breakage.
//   • The JSON payload is handed to the CLI via execFileSync (no shell), so the
//     shell never re-parses quotes, `$`, or backticks from the message.
//   • CACHLY_JWT is embedded only when provided so the `cls-ingest` CLI command
//     can authenticate; absent it, that command exits 0 silently.

import { existsSync } from 'node:fs';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Bumped whenever the hook script changes so installers can upgrade old hooks. */
export const CLS_HOOK_VERSION = 'v2';

/**
 * Matches any previously-installed cachly CLS block (from its marker comment
 * down to the trailing `exit 0`), optionally including an immediately-preceding
 * standalone shebang. Used to upgrade old hooks in place rather than skipping
 * them (the v1 block was a silent no-op).
 */
const CLS_BLOCK_RE = /(?:#!\/bin\/sh\n)?# cachly CLS[\s\S]*?\nexit 0\n?/;

export type ClsHookResult = 'written' | 'upgraded' | 'appended' | 'unchanged' | 'skipped-no-git';

/**
 * Idempotently install/upgrade the CLS post-commit hook in `projectDir`.
 * Never throws — returns a status the caller can log. Shared by `init`, `setup`
 * and `autopilot` so all paths stay in lock-step.
 */
export async function installClsPostCommitHook(
  projectDir: string,
  instanceId: string,
  apiKey?: string,
): Promise<ClsHookResult> {
  if (!existsSync(resolve(projectDir, '.git'))) return 'skipped-no-git';
  const hookDir = resolve(projectDir, '.git', 'hooks');
  const hookPath = resolve(hookDir, 'post-commit');
  await mkdir(hookDir, { recursive: true });
  const script = buildClsPostCommitHook(instanceId, apiKey);

  let existing = '';
  try { existing = await readFile(hookPath, 'utf-8'); } catch { /* no existing hook */ }

  if (!existing) {
    await writeFile(hookPath, script + '\n', 'utf-8');
    await chmod(hookPath, 0o755).catch(() => {});
    return 'written';
  }
  if (existing.includes(`cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION}`)) {
    return 'unchanged';
  }
  if (CLS_BLOCK_RE.test(existing)) {
    // Upgrade an older cachly block in place, preserving any surrounding hook.
    const replaced = existing.replace(CLS_BLOCK_RE, script);
    await writeFile(hookPath, replaced.endsWith('\n') ? replaced : replaced + '\n', 'utf-8');
    await chmod(hookPath, 0o755).catch(() => {});
    return 'upgraded';
  }
  // Foreign hook with no cachly block → append ours.
  await writeFile(hookPath, existing.trimEnd() + '\n\n' + script + '\n', 'utf-8');
  await chmod(hookPath, 0o755).catch(() => {});
  return 'appended';
}

/** The node `-e` program — reads commit data from env, ingests via the CLI. */
const CLS_NODE_PROGRAM =
  "try{" +
  "var p={instance_id:process.env.CACHLY_BRAIN_INSTANCE_ID,source:'git_commit'," +
  "payload:{message:process.env.CLS_MSG||'',sha:process.env.CLS_SHA||''," +
  "files:(process.env.CLS_FILES||'').split(',').filter(Boolean)}};" +
  "require('child_process').execFileSync('npx',['@cachly-dev/mcp-server@latest','cls-ingest',JSON.stringify(p)]," +
  "{stdio:'ignore',timeout:8000});" +
  "}catch(e){}";

/**
 * Build the `.git/hooks/post-commit` shell script.
 * @param instanceId  Cachly Brain instance to ingest into.
 * @param apiKey      Optional cky_… key embedded for authentication.
 */
export function buildClsPostCommitHook(instanceId: string, apiKey?: string): string {
  return [
    `#!/bin/sh`,
    `# cachly CLS — Continuous Learning Stream ${CLS_HOOK_VERSION}`,
    `# Runs silently on every commit to keep your brain up to date.`,
    `export CACHLY_BRAIN_INSTANCE_ID="${instanceId}"`,
    ...(apiKey ? [`export CACHLY_JWT="${apiKey}"`] : []),
    `CLS_SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
    // No `tr`/quote-mangling — the message is passed verbatim via env.
    `CLS_MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1 | cut -c1-200)`,
    `CLS_FILES=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | tr '\\n' ',' | sed 's/,$//')`,
    `export CLS_SHA CLS_MSG CLS_FILES`,
    `node -e "${CLS_NODE_PROGRAM}" 2>/dev/null &`,
    `exit 0`,
  ].join('\n');
}
