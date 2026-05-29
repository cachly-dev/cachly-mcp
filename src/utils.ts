// Safely parses a JSON string. Returns `fallback` on null, empty, or malformed
// input instead of throwing a SyntaxError that would fail the entire tool call.
export function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Runs a promise with a hard timeout. If it doesn't settle within `ms`, resolves
 * with `fallback` instead of hanging. A memory tool must NEVER block the agent's
 * turn — a slow Redis scan or unreachable backend degrades gracefully to a fallback.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Minimal structural type for the Redis scan API we depend on — avoids importing
// the full ioredis type into a leaf utility module.
interface ScanCapable {
  scanStream(opts: { match: string; count?: number }): {
    on(event: 'data', cb: (batch: string[]) => void): void;
    on(event: 'end', cb: () => void): void;
    on(event: 'error', cb: (err: Error) => void): void;
  };
}

/**
 * Collects keys matching a pattern with a hard cap and timeout. Prevents a tool
 * from hanging on a huge keyspace: stops early at `max` keys, and resolves with
 * whatever was gathered if the scan exceeds `timeoutMs`. Never rejects.
 */
export function scanKeys(
  redis: ScanCapable,
  pattern: string,
  opts: { max?: number; count?: number; timeoutMs?: number } = {},
): Promise<string[]> {
  const max = opts.max ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 3000;
  return new Promise<string[]>((resolve) => {
    const keys: string[] = [];
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(keys); } };
    const timer = setTimeout(finish, timeoutMs);
    try {
      const stream = redis.scanStream({ match: pattern, count: opts.count ?? 200 });
      stream.on('data', (batch: string[]) => {
        for (const k of batch) {
          keys.push(k);
          if (keys.length >= max) { clearTimeout(timer); finish(); return; }
        }
      });
      stream.on('end', () => { clearTimeout(timer); finish(); });
      stream.on('error', () => { clearTimeout(timer); finish(); });
    } catch {
      clearTimeout(timer);
      finish();
    }
  });
}

/**
 * Normalizes a git path that may come from `--name-only` with rename notation,
 * e.g. `src/{old => new}/file.ts` → `src/new/file.ts`, and `a => b` → `b`.
 * Returns the post-rename path so file nodes don't fragment on renames.
 */
export function normalizeGitPath(raw: string): string {
  let p = raw.trim();
  if (!p) return p;
  // Brace rename: dir/{old => new}/file  →  dir/new/file
  p = p.replace(/\{[^}]*=>\s*([^}]*)\}/g, (_m, after: string) => after.trim());
  // Bare rename: old => new  →  new
  const arrow = p.split('=>');
  if (arrow.length === 2) p = arrow[1]!.trim();
  // Collapse any double slashes introduced by an empty rename segment.
  return p.replace(/\/{2,}/g, '/').replace(/^\/|\/$/g, '');
}
