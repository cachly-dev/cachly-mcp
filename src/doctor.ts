// `cachly doctor` — one-command setup diagnosis.
//
// The activation funnel dies silently: a missing JWT, an unreachable API, a
// half-installed hook set or a stale v1 shell hook all look identical from the
// editor ("the brain just doesn't answer"). doctor makes every link of the
// chain visible in one run: environment → credential → API → instance → hooks
// → ledger. Pure check functions with injected effects so the whole module is
// unit-testable; the CLI shell in index.ts only wires and prints.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AMBIENT_HOOK_VERSION } from './ambient-hooks.js';
import { netBalance, shouldBackoff, type TurnRecord } from './ambient-recall.js';
import { cachlyUrl } from './cachly-url.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  /** Short stable label, e.g. "Node.js", "Credential", "Hooks". */
  name: string;
  status: DoctorStatus;
  /** One line of what was found. */
  detail: string;
  /** Actionable next step — only set when status is not ok. */
  hint?: string;
}

const MIN_NODE_MAJOR = 18;

/** Node runtime new enough for fetch/AbortSignal (>= 18). */
export function checkNodeVersion(version: string = process.version): DoctorCheck {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  if (Number.isFinite(major) && major >= MIN_NODE_MAJOR) {
    return { name: 'Node.js', status: 'ok', detail: `${version}` };
  }
  return {
    name: 'Node.js',
    status: 'fail',
    detail: `${version} — too old`,
    hint: `cachly needs Node ${MIN_NODE_MAJOR}+ (built-in fetch). Install a current LTS from nodejs.org.`,
  };
}

/** Credential present and roughly the right shape (cky_… API key or JWT). */
export function checkCredential(jwt: string): DoctorCheck {
  if (!jwt) {
    return {
      name: 'Credential',
      status: 'fail',
      detail: 'CACHLY_JWT is not set',
      hint: 'Run `npx @cachly-dev/mcp-server@latest autopilot` (browser sign-in) or export CACHLY_JWT=<cky_…>.',
    };
  }
  const looksApiKey = jwt.startsWith('cky_');
  const looksJwt = jwt.split('.').length === 3;
  if (!looksApiKey && !looksJwt) {
    return {
      name: 'Credential',
      status: 'warn',
      detail: 'CACHLY_JWT is set but looks neither like a cky_… key nor a JWT',
      hint: 'Re-copy the key from the dashboard (API Keys) — it may be truncated.',
    };
  }
  return { name: 'Credential', status: 'ok', detail: looksApiKey ? 'API key (cky_…)' : 'JWT' };
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

/** API reachable at all (public /health — no auth involved). */
export async function checkApiReachable(apiUrl: string, fetchFn: FetchLike = fetch): Promise<DoctorCheck> {
  try {
    const res = await fetchFn(`${apiUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { name: 'API', status: 'ok', detail: `${apiUrl} reachable` };
    return {
      name: 'API',
      status: 'fail',
      detail: `${apiUrl}/health returned HTTP ${res.status}`,
      hint: `The API answered but is unhealthy — check ${cachlyUrl('/status', 'doctor')} or your CACHLY_API_URL.`,
    };
  } catch {
    return {
      name: 'API',
      status: 'fail',
      detail: `${apiUrl} not reachable`,
      hint: 'Check your network/proxy. Self-hosted: is CACHLY_API_URL correct and the API running?',
    };
  }
}

/** Credential actually accepted by the API (authenticated list call). */
export async function checkAuthAccepted(apiUrl: string, jwt: string, fetchFn: FetchLike = fetch): Promise<DoctorCheck> {
  if (!jwt) {
    return { name: 'Auth', status: 'fail', detail: 'skipped — no credential', hint: 'Fix the Credential check first.' };
  }
  try {
    const res = await (fetchFn as unknown as typeof fetch)(`${apiUrl}/api/v1/instances`, {
      headers: { Authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(5000),
    } as RequestInit);
    if (res.ok) return { name: 'Auth', status: 'ok', detail: 'credential accepted' };
    if (res.status === 401 || res.status === 403) {
      return {
        name: 'Auth',
        status: 'fail',
        detail: `API rejected the credential (HTTP ${res.status})`,
        hint: 'The key is expired or revoked. Create a new one in the dashboard, or re-run autopilot.',
      };
    }
    return { name: 'Auth', status: 'warn', detail: `unexpected HTTP ${res.status} from /api/v1/instances` };
  } catch {
    return { name: 'Auth', status: 'warn', detail: 'could not verify (network error)' };
  }
}

/**
 * Vektor-Deckung der eigenen Instanz (Karte hcg8neyut0kd).
 *
 * Gemessen am 20.08.2026: der Bedeutungspfad lief in Produktion monatelang
 * stumm aus — 0 Vektoren bei 506 Lektionen, von aussen nicht von "alles in
 * Ordnung" zu unterscheiden. Die Messung gab es nur hinter der Admin-Route;
 * dieser Check fragt den neuen Eigentuemer-Endpunkt.
 */
export async function checkVectorCoverage(
  apiUrl: string,
  jwt: string,
  instanceId: string | undefined,
  fetchFn: FetchLike = fetch,
): Promise<DoctorCheck> {
  if (!jwt || !instanceId) {
    return { name: 'Vektoren', status: 'warn', detail: 'skipped — no credential or instance' };
  }
  try {
    const res = await (fetchFn as unknown as typeof fetch)(
      `${apiUrl}/api/v1/instances/${instanceId}/vector-coverage`,
      { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(12_000) } as RequestInit,
    );
    if (!res.ok) {
      // Der dritte Ausgang: nicht erreichbar heisst NICHT GEMESSEN, nie "0 %".
      return { name: 'Vektoren', status: 'warn', detail: `coverage not measured (HTTP ${res.status})` };
    }
    const j = await res.json() as { lessons: number; vectors: number; percent: number; status: string };
    if (j.status === 'leer') return { name: 'Vektoren', status: 'ok', detail: 'no lessons yet' };
    if (j.status === 'nicht-gemessen') return { name: 'Vektoren', status: 'warn', detail: 'instance not running — not measured' };
    if (j.status === 'aus') {
      return {
        name: 'Vektoren', status: 'fail',
        detail: `semantic search is OFF: ${j.lessons} lessons, 0 vectors`,
        hint: 'Embeddings never ran for this instance. Check the embed provider; recall runs word-only until fixed.',
      };
    }
    if (j.status === 'luecke') {
      return {
        name: 'Vektoren', status: 'warn',
        detail: `${j.vectors}/${j.lessons} lessons have vectors (${j.percent.toFixed(0)}%)`,
        hint: 'Some lessons are invisible to semantic search. Large writes under the rate limit can skip embedding.',
      };
    }
    return { name: 'Vektoren', status: 'ok', detail: `${j.vectors}/${j.lessons} vectors (${j.percent.toFixed(0)}%)` };
  } catch {
    return { name: 'Vektoren', status: 'warn', detail: 'could not verify (network error)' };
  }
}

/** Brain instance configured (env or auto-provisioned default). */
export function checkInstance(instanceId: string | undefined): DoctorCheck {
  if (!instanceId) {
    return {
      name: 'Instance',
      status: 'warn',
      detail: 'no CACHLY_BRAIN_INSTANCE_ID set and no default instance resolved',
      hint: 'Run `npx @cachly-dev/mcp-server@latest init` in your project, or export CACHLY_BRAIN_INSTANCE_ID.',
    };
  }
  const uuidish = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId);
  return uuidish
    ? { name: 'Instance', status: 'ok', detail: instanceId.slice(0, 8) + '…' }
    : {
        name: 'Instance',
        status: 'warn',
        detail: `"${instanceId.slice(0, 24)}" does not look like an instance UUID`,
        hint: 'Copy the instance ID from the dashboard (Instances → your brain).',
      };
}

export interface HookInspection {
  settingsExists: boolean;
  wiredEvents: string[];
  scriptFiles: { path: string; exists: boolean; version: 'current' | 'stale' | 'unknown' }[];
}

/** Read-only look at .claude/ in projectDir — never throws. */
export function inspectAmbientHooks(projectDir: string): HookInspection {
  const out: HookInspection = { settingsExists: false, wiredEvents: [], scriptFiles: [] };
  try {
    const settingsPath = resolve(projectDir, '.claude/settings.json');
    out.settingsExists = existsSync(settingsPath);
    if (out.settingsExists) {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
        hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
      };
      for (const [event, groups] of Object.entries(parsed.hooks ?? {})) {
        // Normalise Windows backslash paths so the marker match and the path
        // extraction below work on every platform (node fs accepts / on Windows).
        const norm = (c: string | undefined) => (c ?? '').replace(/\\/g, '/');
        const ours = (groups ?? []).some((g) =>
          (g.hooks ?? []).some((h) => norm(h.command).includes('.claude/hooks/cachly-ambient-')),
        );
        if (ours) {
          out.wiredEvents.push(event);
          for (const g of groups ?? []) {
            for (const h of g.hooks ?? []) {
              const cmd = norm(h.command);
              const m = cmd.match(/["']?([^"']*\.claude\/hooks\/cachly-ambient-[^"']+)["']?/);
              if (!m) continue;
              const scriptPath = m[1].replace('$CLAUDE_PROJECT_DIR', projectDir);
              const exists = existsSync(scriptPath);
              let version: 'current' | 'stale' | 'unknown' = 'unknown';
              if (exists) {
                try {
                  const body = readFileSync(scriptPath, 'utf-8');
                  version = body.includes(AMBIENT_HOOK_VERSION) ? 'current' : 'stale';
                } catch { /* keep unknown */ }
              }
              out.scriptFiles.push({ path: scriptPath, exists, version });
            }
          }
        }
      }
    }
  } catch { /* corrupt settings → report as not wired */ }
  return out;
}

const AMBIENT_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];

/** Ambient hooks wired, scripts present, version current. */
export function checkHooks(inspection: HookInspection): DoctorCheck {
  if (!inspection.settingsExists || inspection.wiredEvents.length === 0) {
    return {
      name: 'Hooks',
      status: 'warn',
      detail: 'Ambient Recall hooks are not installed in this project',
      hint: 'Run `npx @cachly-dev/mcp-server@latest init` here — memory then injects itself (no hooks = pull-only).',
    };
  }
  const missingEvents = AMBIENT_EVENTS.filter((e) => !inspection.wiredEvents.includes(e));
  const missingFiles = inspection.scriptFiles.filter((f) => !f.exists);
  const stale = inspection.scriptFiles.filter((f) => f.exists && f.version === 'stale');
  if (missingFiles.length > 0) {
    return {
      name: 'Hooks',
      status: 'fail',
      detail: `settings.json wires hooks whose script files are missing (${missingFiles.length})`,
      hint: 'Re-run `npx @cachly-dev/mcp-server@latest init` to rewrite the scripts.',
    };
  }
  if (stale.length > 0) {
    return {
      name: 'Hooks',
      status: 'warn',
      detail: `installed hooks are an older version (current: ${AMBIENT_HOOK_VERSION}); v1/v2 shell hooks never ran on native Windows`,
      hint: 'Re-run `npx @cachly-dev/mcp-server@latest init` to upgrade in place.',
    };
  }
  if (missingEvents.length > 0) {
    return {
      name: 'Hooks',
      status: 'warn',
      detail: `partial install — missing events: ${missingEvents.join(', ')}`,
      hint: 'Re-run `npx @cachly-dev/mcp-server@latest init` to add the missing hooks.',
    };
  }
  return { name: 'Hooks', status: 'ok', detail: `all 4 events wired, scripts ${AMBIENT_HOOK_VERSION}` };
}

/** Net-token ledger readable + backoff state. */
export function checkLedger(entries: TurnRecord[], ledgerPath: string): DoctorCheck {
  const bal = netBalance(entries);
  const backing = shouldBackoff(entries);
  if (entries.length === 0) {
    return {
      name: 'Ledger',
      status: 'ok',
      detail: `empty (${ledgerPath}) — fills up once ambient hooks inject`,
    };
  }
  if (backing) {
    return {
      name: 'Ledger',
      status: 'warn',
      detail: `${entries.length} entries, net ${bal.net} tokens — auto-backoff ACTIVE, injection paused`,
      hint: 'The agent has not reported prevented tokens lately. This self-heals; `ambient-stats` shows details.',
    };
  }
  return {
    name: 'Ledger',
    status: 'ok',
    detail: `${entries.length} entries, net ${bal.net >= 0 ? '+' : ''}${bal.net} tokens`,
  };
}

const ICON: Record<DoctorStatus, string> = { ok: '✅', warn: '⚠️ ', fail: '❌' };

/** Render the report; deterministic, no colors (CI-friendly). */
export function renderDoctorReport(checks: DoctorCheck[]): string {
  const lines: string[] = ['', '🩺 cachly doctor', ''];
  for (const c of checks) {
    lines.push(`   ${ICON[c.status]} ${c.name.padEnd(11)} ${c.detail}`);
    if (c.hint && c.status !== 'ok') lines.push(`      ↳ ${c.hint}`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    fails > 0
      ? `   ${fails} problem${fails > 1 ? 's' : ''} to fix${warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : ''}.`
      : warns > 0
        ? `   No blockers — ${warns} warning${warns > 1 ? 's' : ''}.`
        : '   Everything looks healthy. Your brain is wired.',
  );
  lines.push('');
  return lines.join('\n');
}

/** Exit code contract: 1 only on hard failures (warnings stay 0 for CI use). */
export function doctorExitCode(checks: DoctorCheck[]): 0 | 1 {
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
