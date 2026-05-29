/**
 * Cachly-Bench fixture corpus.
 *
 * A small but realistic corpus of engineering "lessons" plus a set of labeled
 * natural-language queries. Each query declares which lesson topics are *truly*
 * relevant — the answer an agent actually wants.
 *
 * The corpus is deliberately adversarial in a fair way: for several queries there
 * is a text-similar but LOW-QUALITY distractor (a failed attempt, an unverified
 * note) competing with the proven success lesson. This is exactly the situation
 * where raw text ranking (and a flat-file memory) goes wrong, and where Cachly's
 * quality-aware reranking should win. The labels reward the lesson that solves the
 * problem, not the one that merely shares vocabulary.
 */

export interface BenchLesson {
  /** Stored under cachly:lesson:best:{topic} */
  topic: string;
  outcome: 'success' | 'partial' | 'failure';
  what_worked: string;
  what_failed?: string;
  context?: string;
  severity?: 'critical' | 'major' | 'minor';
  confidence?: number;
  recall_count?: number;
  reviewed_by?: string;
  review_level?: 'senior' | 'peer';
  endorsements?: number;
  tags?: string[];
  ts?: string;
}

export interface BenchQuery {
  query: string;
  /** Topics that genuinely answer the query (the gold set). */
  relevant: string[];
}

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86400_000).toISOString();

export const BENCH_LESSONS: BenchLesson[] = [
  // ── Deploy domain ──────────────────────────────────────────────────────────
  {
    topic: 'deploy:k8s:rollout-stuck',
    outcome: 'success',
    what_worked: 'Set a readinessProbe with a longer initialDelaySeconds and a higher failureThreshold so the liveness probe stopped terminating the container before startup completed. The pod then reached ready and traffic flowed.',
    context: 'Production release never became healthy.',
    severity: 'critical', confidence: 0.95, recall_count: 12,
    tags: ['kubernetes', 'deploy', 'probe'], ts: daysAgo(8),
  },
  {
    topic: 'deploy:k8s:rollout-attempt-restart',
    outcome: 'failure',
    what_worked: '',
    what_failed: 'The kubernetes deploy was stuck, the rollout was not finishing, so I restarted the deploy. The kubernetes deploy stayed stuck and the rollout still was not finishing. Restarted the stuck rollout again, deploy still stuck.',
    context: 'Kubernetes deploy stuck, rollout not finishing.',
    severity: 'major', confidence: 0.3, recall_count: 0,
    tags: ['kubernetes', 'deploy'], ts: daysAgo(9),
  },
  {
    topic: 'deploy:docker:image-too-large',
    outcome: 'success',
    what_worked: 'Reduced Docker image size dramatically with a multi-stage build and a slim base image, moving build-only deps out of the final layer.',
    context: 'CI pushes were slow due to a 1.8GB image.',
    severity: 'minor', confidence: 0.9, recall_count: 6,
    tags: ['docker', 'deploy', 'optimization'], ts: daysAgo(20),
  },

  // ── Database domain ────────────────────────────────────────────────────────
  {
    topic: 'db:postgres:connection-pool-exhausted',
    outcome: 'success',
    what_worked: 'Added PgBouncer in transaction pooling mode and lowered the per-service max pool size so backends were shared. Peak traffic stopped exhausting backends.',
    context: 'API returned 500s at peak traffic.',
    severity: 'critical', confidence: 0.92, recall_count: 9,
    tags: ['postgres', 'database', 'pool'], ts: daysAgo(15),
  },
  {
    topic: 'db:postgres:slow-query-missing-index',
    outcome: 'success',
    what_worked: 'A slow Postgres query was fixed by adding a composite index on (tenant_id, created_at); query dropped from 4s to 12ms.',
    context: 'Dashboard timed out loading recent events.',
    severity: 'major', confidence: 0.88, recall_count: 4,
    tags: ['postgres', 'database', 'index', 'performance'], ts: daysAgo(30),
  },
  {
    topic: 'db:postgres:pool-raise-limit-attempt',
    outcome: 'failure',
    what_worked: '',
    what_failed: 'Postgres had too many connections under load, so I raised max_connections. Postgres still had too many connections under load and the load made it worse — too many connections again under load.',
    context: 'Postgres too many connections under load.',
    severity: 'major', confidence: 0.25, recall_count: 0,
    tags: ['postgres', 'database', 'pool'], ts: daysAgo(16),
  },

  // ── Auth domain ────────────────────────────────────────────────────────────
  {
    topic: 'auth:jwt:expired-on-restart',
    outcome: 'success',
    what_worked: 'JWT was lost on server restart because it was only kept in memory; persisting the token to disk after the device flow fixed recall counts staying at zero.',
    context: 'Telemetry showed zero authenticated calls after restarts.',
    severity: 'critical', confidence: 0.93, recall_count: 7,
    tags: ['jwt', 'auth', 'persistence'], ts: daysAgo(3),
  },
  {
    topic: 'auth:pkce:keycloak-rejects-exchange',
    outcome: 'success',
    what_worked: 'Keycloak rejected the PKCE code exchange because the verifier used non-URL-safe Base64; switching to RFC 7636 Base64URL random bytes fixed the login.',
    context: 'Mobile login failed at the token exchange step.',
    severity: 'major', confidence: 0.9, recall_count: 3,
    tags: ['pkce', 'auth', 'keycloak', 'oauth'], ts: daysAgo(2),
  },

  // ── Redis / cache domain ───────────────────────────────────────────────────
  {
    topic: 'redis:noauth-on-every-call',
    outcome: 'success',
    what_worked: 'The connection endpoint omitted the password field, so the client connected unauthenticated; returning the credential explicitly in the response let the client authenticate and the calls succeeded.',
    context: 'Hosted Valkey requires a credential.',
    severity: 'critical', confidence: 0.94, recall_count: 11,
    tags: ['redis', 'valkey', 'auth'], ts: daysAgo(4),
  },
  {
    topic: 'redis:noauth-disable-auth-attempt',
    outcome: 'failure',
    what_worked: '',
    what_failed: 'Redis threw NOAUTH on every call, so I tried disabling auth on Redis. Redis still threw NOAUTH on every call. Tried again to stop the NOAUTH error on every Redis call — no luck.',
    context: 'Redis NOAUTH error on every call.',
    severity: 'major', confidence: 0.2, recall_count: 0,
    tags: ['redis', 'auth'], ts: daysAgo(5),
  },
  {
    topic: 'redis:keys-no-ttl-memory-leak',
    outcome: 'success',
    what_worked: 'Redis memory grew unbounded because dependency-index and history keys had no TTL; adding a 90-day expire and an ltrim bounded the memory.',
    context: 'Instance memory crept up over weeks of use.',
    severity: 'major', confidence: 0.85, recall_count: 2,
    tags: ['redis', 'ttl', 'memory'], ts: daysAgo(1),
  },

  // ── CI / build domain ──────────────────────────────────────────────────────
  {
    topic: 'ci:npm-ci-lockfile-mismatch',
    outcome: 'success',
    what_worked: 'CI "npm ci" failed because a dependency was added to package.json but the lockfile was never regenerated; running npm install to update package-lock.json fixed the build.',
    context: 'GitHub Actions install step failed after adding a dep.',
    severity: 'major', confidence: 0.91, recall_count: 5,
    tags: ['ci', 'npm', 'lockfile'], ts: daysAgo(0),
  },
  {
    topic: 'ci:golangci-lint-errcheck',
    outcome: 'success',
    what_worked: 'golangci-lint failed on an unchecked recover() return value; assigning it to _ satisfied errcheck.',
    context: 'Go lint job blocked the deploy pipeline.',
    severity: 'minor', confidence: 0.8, recall_count: 1,
    tags: ['ci', 'go', 'lint'], ts: daysAgo(1),
  },

  // ── Frontend domain ────────────────────────────────────────────────────────
  {
    topic: 'frontend:cors-preflight-blocked',
    outcome: 'success',
    what_worked: 'Dashboard mutations failed because the CORS middleware did not allow PUT/PATCH; adding them to AllowMethods fixed the preflight.',
    context: 'BYOK and webhook settings could not be saved from the browser.',
    severity: 'major', confidence: 0.87, recall_count: 4,
    tags: ['cors', 'frontend', 'api'], ts: daysAgo(6),
  },
  {
    topic: 'frontend:hydration-mismatch',
    outcome: 'partial',
    what_worked: 'A Next.js hydration mismatch was reduced by guarding a date render with a client-only effect, though the root cause (locale formatting) still needs work.',
    context: 'Console hydration warnings on the landing page.',
    severity: 'minor', confidence: 0.6, recall_count: 1,
    tags: ['nextjs', 'frontend', 'hydration'], ts: daysAgo(25),
  },

  // ── Governance adversarial pair: two similar-text success lessons ──────────
  // Only the reviewed one should win; baseline cannot distinguish them by text.
  {
    topic: 'auth:csrf:double-submit-cookie',
    outcome: 'success',
    what_worked: 'CSRF protection was added via the double-submit cookie pattern: the server sets a random CSRF token cookie; the client echoes it as a request header. Requests with a mismatched or absent header are rejected.',
    context: 'API mutations lacked CSRF protection; security audit required a fix.',
    severity: 'critical', confidence: 0.91, recall_count: 2,
    reviewed_by: 'senior-alice', review_level: 'senior', endorsements: 2,
    tags: ['csrf', 'auth', 'security', 'cookie'], ts: daysAgo(12),
  },
  {
    topic: 'auth:csrf:origin-header-check',
    outcome: 'success',
    what_worked: 'CSRF mitigation attempted by checking the Origin header on API requests, but this was bypassed in a penetration test because same-site requests from subdomains also sent the header.',
    context: 'API mutations lacked CSRF protection; origin header check was insufficient.',
    severity: 'major', confidence: 0.55, recall_count: 1,
    tags: ['csrf', 'auth', 'security'], ts: daysAgo(14),
  },
];

export const BENCH_QUERIES: BenchQuery[] = [
  {
    query: 'kubernetes deploy stuck rollout not finishing',
    relevant: ['deploy:k8s:rollout-stuck'],
  },
  {
    query: 'postgres too many connections under load',
    relevant: ['db:postgres:connection-pool-exhausted'],
  },
  {
    query: 'dashboard query is slow and times out',
    relevant: ['db:postgres:slow-query-missing-index'],
  },
  {
    query: 'jwt lost after restart recall count zero',
    relevant: ['auth:jwt:expired-on-restart'],
  },
  {
    query: 'keycloak rejects pkce token exchange on login',
    relevant: ['auth:pkce:keycloak-rejects-exchange'],
  },
  {
    query: 'redis noauth error on every call',
    relevant: ['redis:noauth-on-every-call'],
  },
  {
    query: 'redis memory keeps growing unbounded',
    relevant: ['redis:keys-no-ttl-memory-leak'],
  },
  {
    query: 'npm ci fails in github actions after adding dependency',
    relevant: ['ci:npm-ci-lockfile-mismatch'],
  },
  {
    query: 'cannot save settings cors preflight blocked',
    relevant: ['frontend:cors-preflight-blocked'],
  },
  {
    query: 'docker image too big slow ci push',
    relevant: ['deploy:docker:image-too-large'],
  },
  {
    query: 'go lint failing on unchecked return value',
    relevant: ['ci:golangci-lint-errcheck'],
  },
  // Multi-relevant: both postgres performance lessons are reasonable answers.
  {
    query: 'postgres performance problem in production',
    relevant: ['db:postgres:connection-pool-exhausted', 'db:postgres:slow-query-missing-index'],
  },
  // Governance adversarial: two CSRF lessons have almost identical text, but only
  // the senior-reviewed canonical one is a proven complete solution. Quality
  // reranking must prefer the reviewed+endorsed lesson over the unreviewed partial.
  {
    query: 'CSRF protection missing on API mutations security',
    relevant: ['auth:csrf:double-submit-cookie'],
  },
];
