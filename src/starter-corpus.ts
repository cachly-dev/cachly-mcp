/**
 * Curated starter corpus — universal, high-value engineering lessons.
 *
 * Loaded on demand via `brain_seed_starter` (or offered in the empty-brain
 * session_start welcome). The goal is to drop **time-to-first-recall** below
 * two minutes: a brand-new Brain (fresh repo, shallow clone, no fix-commits in
 * git history) would otherwise return nothing on the user's first query.
 *
 * Every lesson here is:
 *   - stack-agnostic or broadly applicable (no project-specific paths)
 *   - a real, common failure mode with a proven fix
 *   - free of secrets / PII
 *   - tagged `source: 'starter'` so it can be identified, filtered, or removed
 *
 * These ship inside the package — no network call needed to seed.
 */

export interface StarterLesson {
  topic: string;
  outcome: 'success';
  what_worked: string;
  what_failed: string;
  ctx: string;
  tags: string[];
  confidence: number;
}

export const STARTER_CORPUS: StarterLesson[] = [
  {
    topic: 'docker:layer-cache',
    outcome: 'success',
    what_worked: 'Copy package manifests (package.json/lock, go.mod, requirements.txt) and install deps BEFORE copying the rest of the source. Dependency layers then stay cached across code-only changes.',
    what_failed: 'Build re-downloads all dependencies on every code change because `COPY . .` came before the install step, busting the cache.',
    ctx: 'Slow Docker builds in CI — every commit reinstalls dependencies even when only app code changed.',
    tags: ['docker', 'ci', 'build', 'cache', 'performance'],
    confidence: 0.9,
  },
  {
    topic: 'git:force-push-safety',
    outcome: 'success',
    what_worked: 'Use `git push --force-with-lease` instead of `--force`. It refuses to overwrite if the remote moved since your last fetch, protecting teammates\' commits.',
    what_failed: 'A plain `git push --force` silently clobbered a colleague\'s commits that had landed after the last local fetch.',
    ctx: 'Rebasing a shared feature branch and force-pushing the result.',
    tags: ['git', 'rebase', 'collaboration', 'safety'],
    confidence: 0.92,
  },
  {
    topic: 'ci:flaky-tests-timing',
    outcome: 'success',
    what_worked: 'Pin time and randomness: use fake/frozen timers (e.g. vi.useFakeTimers, freezegun) and a fixed RNG seed. Replace arbitrary sleeps with explicit awaits on a condition.',
    what_failed: 'Tests passed locally but failed ~10% of the time in CI due to real wall-clock timing and unseeded random data.',
    ctx: 'Intermittent CI failures that disappear on re-run — classic flaky test.',
    tags: ['ci', 'testing', 'flaky', 'timers', 'determinism'],
    confidence: 0.85,
  },
  {
    topic: 'node:esm-cjs-interop',
    outcome: 'success',
    what_worked: 'Set `"type": "module"` in package.json for ESM, use explicit `.js` extensions in relative imports, and `import { createRequire }` if you must load a CJS-only module.',
    what_failed: '"ReferenceError: exports is not defined" / "Cannot use import statement outside a module" after mixing ESM and CommonJS.',
    ctx: 'Migrating a Node project to ES modules or adding an ESM-only dependency.',
    tags: ['node', 'esm', 'commonjs', 'modules', 'typescript'],
    confidence: 0.85,
  },
  {
    topic: 'jwt:clock-skew',
    outcome: 'success',
    what_worked: 'Allow a small leeway (30–60s) when validating `exp`/`nbf` claims, and keep server clocks synced with NTP. Most JWT libraries accept a `clockTolerance` option.',
    what_failed: 'Valid tokens were rejected as expired because the auth server and API server clocks differed by a few seconds.',
    ctx: 'Intermittent 401s right around token expiry across multiple services.',
    tags: ['jwt', 'auth', 'clock', 'security', 'tokens'],
    confidence: 0.88,
  },
  {
    topic: 'postgres:migration-lock',
    outcome: 'success',
    what_worked: 'Set a short `lock_timeout` before DDL and add indexes with `CREATE INDEX CONCURRENTLY`. This avoids a migration blocking on a long-held table lock and stalling the whole deploy.',
    what_failed: 'A migration hung indefinitely waiting for an ACCESS EXCLUSIVE lock while a long-running query held the table, blocking the deploy.',
    ctx: 'Production deploy froze during a schema migration under live traffic.',
    tags: ['postgres', 'database', 'migration', 'deploy', 'locking'],
    confidence: 0.87,
  },
  {
    topic: 'redis:eviction-policy',
    outcome: 'success',
    what_worked: 'Set `maxmemory` and an explicit `maxmemory-policy` (e.g. `allkeys-lru` for a cache, `noeviction` for a datastore). Always set TTLs on cache keys.',
    what_failed: 'Redis silently evicted keys (or OOM-errored on writes) because no maxmemory policy was configured and keys never expired.',
    ctx: 'Cache hit-rate cratered / writes started failing as Redis filled up.',
    tags: ['redis', 'cache', 'memory', 'eviction', 'ttl'],
    confidence: 0.86,
  },
  {
    topic: 'k8s:oom-limits',
    outcome: 'success',
    what_worked: 'Set both memory `requests` and `limits` on every container. For JVM/Node, also cap the runtime heap below the container limit so the GC reclaims before the kernel OOM-kills.',
    what_failed: 'Pods were OOMKilled (exit 137) and restarted in a loop because no memory limit was set and the node was overcommitted.',
    ctx: 'Pod restarting repeatedly with OOMKilled status in kubectl describe.',
    tags: ['kubernetes', 'oom', 'memory', 'limits', 'infra'],
    confidence: 0.85,
  },
  {
    topic: 'cors:preflight',
    outcome: 'success',
    what_worked: 'Handle the OPTIONS preflight explicitly and return the right Access-Control-Allow-{Origin,Methods,Headers}. For credentialed requests, echo a specific origin (never `*`) and set Allow-Credentials: true.',
    what_failed: 'Browser blocked requests with "No \'Access-Control-Allow-Origin\' header" — the server never answered the preflight OPTIONS request.',
    ctx: 'Frontend on a different origin gets CORS errors only in the browser (curl works fine).',
    tags: ['cors', 'http', 'api', 'browser', 'preflight'],
    confidence: 0.84,
  },
  {
    topic: 'env:dotenv-precedence',
    outcome: 'success',
    what_worked: 'Know the precedence: real environment variables (and Docker `-e`/compose `environment`) override a `.env` file. Most loaders will NOT overwrite an already-set var. Audit with a startup log of effective config.',
    what_failed: 'A value in `.env` was silently ignored in the container because an environment variable of the same name was already set by Docker.',
    ctx: 'Config works locally but the container picks up the wrong value.',
    tags: ['env', 'dotenv', 'docker', 'config'],
    confidence: 0.83,
  },
  {
    topic: 'async:unhandled-rejection',
    outcome: 'success',
    what_worked: 'Await or `.catch()` every promise. Add a process-level `unhandledRejection` handler that logs and exits non-zero, so a dropped rejection is loud, not silent.',
    what_failed: 'A fire-and-forget promise rejected, the error vanished, and the process kept running in a broken state with no log.',
    ctx: 'Mysterious missing data / silent failures with no stack trace in a Node service.',
    tags: ['async', 'node', 'promises', 'error-handling'],
    confidence: 0.84,
  },
  {
    topic: 'sql:n-plus-one',
    outcome: 'success',
    what_worked: 'Eager-load related rows in one query (JOIN or the ORM\'s include/preload/select_related) instead of looping and querying per row. Verify with query logging or an APM trace.',
    what_failed: 'An endpoint issued one query per item in a list (N+1), making latency scale linearly with result count.',
    ctx: 'List endpoint gets slow as data grows; DB shows a flood of near-identical small queries.',
    tags: ['sql', 'database', 'orm', 'performance', 'n+1'],
    confidence: 0.86,
  },
  {
    topic: 'http:retry-idempotency',
    outcome: 'success',
    what_worked: 'Only auto-retry idempotent requests (GET/PUT/DELETE) or POSTs guarded by an idempotency key. Use exponential backoff with jitter and a cap on attempts.',
    what_failed: 'A retried POST created duplicate records because the first request actually succeeded but the response was lost.',
    ctx: 'Duplicate charges / duplicate rows after adding naive retry logic to an HTTP client.',
    tags: ['http', 'retry', 'idempotency', 'reliability', 'backoff'],
    confidence: 0.85,
  },
  {
    topic: 'cache:stampede',
    outcome: 'success',
    what_worked: 'Prevent thundering-herd recomputation on cache expiry with a short lock (single-flight) or early-recompute-with-jitter so only one request rebuilds the value while others serve the stale one.',
    what_failed: 'When a hot cache key expired, hundreds of concurrent requests all missed and hammered the database simultaneously.',
    ctx: 'Periodic DB load spikes that line up exactly with cache TTL expiry.',
    tags: ['cache', 'stampede', 'performance', 'concurrency', 'redis'],
    confidence: 0.83,
  },
  {
    topic: 'security:no-secrets-in-logs',
    outcome: 'success',
    what_worked: 'Redact tokens, passwords, and full auth headers before logging. Log a token\'s prefix + length, never the value. Add a log scrubber/filter so it cannot regress.',
    what_failed: 'A bearer token was written to application logs and ended up in the log aggregator, where it was searchable by anyone with log access.',
    ctx: 'Security review found credentials in centralized logs.',
    tags: ['security', 'logging', 'secrets', 'pii', 'compliance'],
    confidence: 0.9,
  },
  {
    topic: 'tls:cert-expiry',
    outcome: 'success',
    what_worked: 'Automate renewal (ACME/cert-manager) and alert at least 14 days before expiry. Monitor the leaf AND intermediate chain — clients fail if the chain is incomplete even when the leaf is valid.',
    what_failed: 'A production outage hit when a TLS certificate silently expired over a weekend with no alerting in place.',
    ctx: 'Sudden "certificate has expired" errors from clients; site unreachable over HTTPS.',
    tags: ['tls', 'ssl', 'certificates', 'monitoring', 'infra'],
    confidence: 0.88,
  },
];

/** Stable count for changelog / docs. */
export const STARTER_CORPUS_SIZE = STARTER_CORPUS.length;
