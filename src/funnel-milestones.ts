// Persistent once-per-machine funnel milestones.
//
// Milestones like first_call_success were guarded by an in-memory flag only —
// but ambient hooks spawn a FRESH server process per prompt, so every hook
// invocation re-sent "first call" and the backend saw 66 "first" calls from
// one user (and Telegram pinged the founder on every one). Persisting the
// marker in ~/.cachly/ makes "first" mean first-on-this-machine across
// process restarts. Best-effort: any filesystem problem degrades to the old
// in-memory behaviour (the backend now dedupes too), never throws.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function defaultMilestonePath(): string {
  return join(homedir(), '.cachly', 'funnel-milestones.json');
}

function readAll(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    return {}; // corrupt file → treat as empty, next mark rewrites it
  }
}

/** True when this milestone was already sent from this machine. */
export function milestoneSent(name: string, path: string = defaultMilestonePath()): boolean {
  return name in readAll(path);
}

/** Record a milestone (idempotent). Never throws. */
export function markMilestoneSent(name: string, path: string = defaultMilestonePath()): void {
  try {
    const all = readAll(path);
    if (name in all) return;
    all[name] = new Date().toISOString();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all, null, 2) + '\n', 'utf-8');
  } catch {
    /* best-effort — the server-side dedup is the safety net */
  }
}
