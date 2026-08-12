#!/usr/bin/env node
import { jwtExpiryMs, checkJwt, handleApiError, diagnoseAuth, planAuthHeal,
         readClientCredentialsFromEnv, buildClientCredentialsBody, clientCredentialsTokenUrl } from './auth.js';
import { cachlyUrl } from './cachly-url.js';
import type { FunnelEventName, DashboardMetrics } from './telemetry-types.js';
import { notify } from './notifier.js';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

// True only when this file is the entry point (not imported by tests or other modules).
const _isMain = process.argv[1] != null &&
  (process.argv[1] === fileURLToPath(import.meta.url) ||
   process.argv[1].endsWith('/dist/index.js') ||
   process.argv[1].endsWith('/src/index.ts'));
/**
 * cachly MCP Server v0.4.0
 *
 * Exposes cachly.dev as MCP tools so any AI assistant
 * (GitHub Copilot, Claude, Cursor, Windsurf, Continue.dev …) can:
 *
 * ── Instance Management ─────────────────────────────────────────────────────
 *   • list_instances        – list all your cache instances
 *   • create_instance       – provision a new instance (free or paid)
 *   • get_instance          – get details + connection string
 *   • get_connection_string – get the redis:// URL
 *   • delete_instance       – permanently delete an instance
 *
 * ── Live Cache Operations ────────────────────────────────────────────────────
 *   • cache_get             – get a value by key
 *   • cache_set             – set a key-value pair with optional TTL
 *   • cache_delete          – delete one or more keys
 *   • cache_exists          – check if keys exist
 *   • cache_ttl             – inspect TTL of a key
 *   • cache_keys            – list keys matching a glob pattern
 *   • cache_stats           – memory, hit rate, ops/sec, keyspace info
 *   • semantic_search       – find semantically similar cached entries
 *                             (needs OPENAI_API_KEY or other embed provider in .env)
 *
 * ── Auth & Status ────────────────────────────────────────────────────────────
 *   • get_api_status        – check API health + JWT auth info (Keycloak)
 *
 *
 * Configuration (env vars):
 *   CACHLY_API_URL      – default https://api.cachly.dev
 *   CACHLY_JWT          – your JWT (Keycloak access token)
 *   CACHLY_EMBED_PROVIDER – embedding backend: openai (default), gemini, mistral, cohere, ollama, cachly (server fallback)
 *   CACHLY_EMBED_MODEL  – override embedding model (optional)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Redis } from 'ioredis';

// ── Config ────────────────────────────────────────────────────────────────────

// Mutable so the `setup`/`init` CLI can honor a `--api-url` flag for self-hosting.
// Reassigned (if at all) before any network call is made.
let API_URL = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
let JWT = process.env.CACHLY_JWT ?? '';
const _EMBED_MODEL = process.env.CACHLY_EMBED_MODEL ?? '';

// Resolve the package version at runtime from package.json so the telemetry
// `version` field always matches the published npm version. A hardcoded constant
// silently drifted (0.10.88 vs published 0.10.98), making release adoption
// impossible to track. Paths cover both prod (dist/src/index.js → ../../) and
// dev (src/index.ts → ../). Falls back to a literal if resolution fails.
const CURRENT_VERSION: string = (() => {
  try {
    const req = createRequire(import.meta.url);
    for (const rel of ['../../package.json', '../package.json']) {
      try {
        const pkg = req(rel) as { name?: string; version?: string };
        if (pkg.name === '@cachly-dev/mcp-server' && pkg.version) return pkg.version;
      } catch { /* try next candidate */ }
    }
  } catch { /* fall through to literal */ }
  return '0.10.100';
})();

// Max time to wait for a freshly-provisioned instance to become "running" before
// giving up. Free-tier provisioning in high-latency regions can take 45–90s, so the
// old hard-coded 25s caused spurious "instance_not_reachable" on first run.
// Override via CACHLY_PROVISION_TIMEOUT_MS.
const PROVISION_TIMEOUT_MS = Number(process.env.CACHLY_PROVISION_TIMEOUT_MS ?? 90_000);

// ── Default Instance Resolution (for Smithery & single-credential setups) ────
// When CACHLY_BRAIN_INSTANCE_ID is set, tools can omit the instance_id parameter.
// When neither is set, we auto-fetch the first running instance once per process.
let _defaultInstanceId: string = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';
// Timestamp of last failed fetch — retries after 30 s (not permanently blocked).
let _defaultInstanceLastAttempt = 0;
// In-flight resolution guard: a burst of parallel tool calls on startup must not
// each list-and-provision (which would race and create duplicate instances).
let _resolveInFlight: Promise<string> | null = null;

/**
 * Auto-provision a Brain instance via the idempotent find-or-create endpoint.
 * Returns the instance id, or '' on failure. Fires auto_provision_failed telemetry
 * on a non-2xx response so the activation funnel can spot free-tier breakage.
 */
async function autoProvisionInstance(): Promise<string> {
  if (!JWT) return '';
  try {
    const autoRes = await fetch(`${API_URL}/api/v1/instances/auto`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (autoRes.ok) {
      const body = await autoRes.json() as {
        instance?: { id: string; status?: string };
        instance_id?: string;
      };
      const id = body.instance?.id ?? body.instance_id;
      if (id) return id;
    } else {
      void fetch(`${API_URL}/api/v1/telemetry/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` },
        body: JSON.stringify({ event: 'auto_provision_failed', status: autoRes.status, version: CURRENT_VERSION }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    }
  } catch {
    // Network unreachable — fire telemetry so silent provision failures are visible in the funnel.
    void fetch(`${API_URL}/api/v1/telemetry/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'auto_provision_failed', status: 0, reason: 'network_error', version: CURRENT_VERSION }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
  return '';
}

async function resolveDefaultInstanceId(): Promise<string> {
  if (_defaultInstanceId) return _defaultInstanceId;
  if (!JWT) return '';
  // Coalesce concurrent resolutions so parallel tool calls share one round-trip.
  if (_resolveInFlight) return _resolveInFlight;
  // Cooldown: don't hammer the API on every tool call after a transient failure.
  const now = Date.now();
  if (_defaultInstanceLastAttempt > 0 && now - _defaultInstanceLastAttempt < 30_000) return '';
  _defaultInstanceLastAttempt = now;
  _resolveInFlight = (async (): Promise<string> => {
    try {
      const res = await fetch(`${API_URL}/api/v1/instances`, {
        headers: { Authorization: `Bearer ${JWT}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ id: string; status: string }> };
        const instances = (data?.data ?? []) as Array<{ id: string; status: string }>;
        // Prefer running, fall back to provisioning so the ID resolves even during startup.
        const best = instances.find(i => i.status === 'running') ?? instances.find(i => i.status === 'provisioning');
        if (best) {
          _defaultInstanceId = best.id;
          _defaultInstanceLastAttempt = 0;
          return _defaultInstanceId;
        }
        // Authenticated but zero instances → auto-provision so the user is never
        // stuck. This self-heals the silent failure mode where device-flow
        // provisioning failed once and every later tool call then ran with an
        // empty instance_id (no recalls, never counted as an active instance).
        const provisioned = await autoProvisionInstance();
        if (provisioned) {
          _defaultInstanceId = provisioned;
          _defaultInstanceLastAttempt = 0;
          void persistInstanceIdToConfig(provisioned);
          return _defaultInstanceId;
        }
      }
    } catch { /* transient error — will retry after cooldown */ }
    return '';
  })();
  try { return await _resolveInFlight; }
  finally { _resolveInFlight = null; }
}

// ── Self-Healing Auth ─────────────────────────────────────────────────────────
// Prevents the silent "0 recalls because the token quietly died" failure mode.
// When the credential is near expiry we mint a fresh long-lived API key *while the
// current one is still valid* (no user interaction). When it is already dead we
// surface a single, actionable instruction instead of degrading silently.

// Cooldown so a burst of tool calls can't trigger repeated mint attempts.
let _authHealAttemptedAt = 0;
const AUTH_HEAL_COOLDOWN_MS = 60_000;
// Surfaced in session_start / get_api_status so the user is never left guessing.
let _authDegradedNotice = '';

/** Persist a (possibly refreshed) API key to ~/.claude/mcp.json so restarts keep it.
 * Also updates CACHLY_JWT in Cursor and Windsurf configs when they already have a cachly entry,
 * so users who auth via one editor don't lose their session in the others.
 */
async function persistApiKeyToConfig(apiKey: string): Promise<void> {
  try {
    const { writeFile, mkdir, readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.APPDATA ?? '';
    if (!home) return;

    // Primary config: create or update ~/.claude/mcp.json
    const claudePath = resolve(home, '.claude', 'mcp.json');
    let cfg: { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> } = {};
    if (existsSync(claudePath)) {
      try { cfg = JSON.parse(await readFile(claudePath, 'utf-8')) as typeof cfg; } catch { /* corrupt — start fresh */ }
    }
    cfg.mcpServers ??= {};
    const existing = cfg.mcpServers['cachly'];
    if (existing) {
      existing.env ??= {};
      existing.env['CACHLY_JWT'] = apiKey;
    } else {
      cfg.mcpServers['cachly'] = {
        command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'],
        env: { CACHLY_JWT: apiKey },
      };
    }
    await mkdir(dirname(claudePath), { recursive: true });
    await writeFile(claudePath, JSON.stringify(cfg, null, 2), 'utf-8');

    // Secondary configs: update CACHLY_JWT wherever cachly is already configured.
    // Never create from scratch — only update existing entries (the user set these up).
    const secondaryPaths = [
      resolve(home, '.cursor', 'mcp.json'),
      resolve(home, '.codeium', 'windsurf', 'mcp_config.json'),
    ];
    await Promise.allSettled(secondaryPaths.map(async (p) => {
      if (!existsSync(p)) return;
      try {
        const raw = await readFile(p, 'utf-8');
        const sc = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
        const entry = sc?.mcpServers?.['cachly'];
        if (entry?.env) {
          entry.env['CACHLY_JWT'] = apiKey;
          await writeFile(p, JSON.stringify(sc, null, 2), 'utf-8');
        }
      } catch { /* corrupt or unwriteable — skip */ }
    }));
  } catch { /* non-critical — never break a tool call on a filesystem error */ }
}

/**
 * Persist the resolved instance id to ~/.claude/mcp.json so restarts reuse it
 * (avoids a list/provision round-trip on every startup). Only updates an
 * existing cachly entry — does not create config from scratch.
 */
async function persistInstanceIdToConfig(instanceId: string): Promise<void> {
  if (!instanceId) return;
  try {
    const { writeFile, readFile } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.APPDATA ?? '';
    if (!home) return;
    const configPaths = [
      resolve(home, '.claude', 'mcp.json'),
      resolve(home, '.cursor', 'mcp.json'),
      resolve(home, '.codeium', 'windsurf', 'mcp_config.json'),
    ];
    await Promise.allSettled(configPaths.map(async (p) => {
      if (!existsSync(p)) return;
      try {
        const cfg = JSON.parse(await readFile(p, 'utf-8')) as { mcpServers?: Record<string, { env?: Record<string, string> }> };
        const entry = cfg?.mcpServers?.['cachly'];
        if (entry?.env) {
          entry.env['CACHLY_BRAIN_INSTANCE_ID'] = instanceId;
          await writeFile(p, JSON.stringify(cfg, null, 2), 'utf-8');
        }
      } catch { /* corrupt or unwriteable — skip */ }
    }));
  } catch { /* non-critical */ }
}

/**
 * Exchange the current (still-valid) token for a fresh long-lived API key.
 * Returns true on success. Used by self-healing when a token is near expiry.
 */
async function refreshApiKey(): Promise<boolean> {
  try {
    const keyRes = await fetch(`${API_URL}/api/v1/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` },
      body: JSON.stringify({ name: 'cachly-mcp-selfheal', scope: 'read_write' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!keyRes.ok) return false;
    const body = await keyRes.json() as { key?: string };
    if (!body.key) return false;
    JWT = body.key;
    setEmbedJwt(body.key);
    void persistApiKeyToConfig(body.key);
    sendFunnelEvent('auth_self_healed', { reason: 'near_expiry_refresh' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a self-healing pass on the current credential. Returns true if the
 * credential is usable afterwards. Cheap to call (diagnosis is local); only does
 * network work when a refresh is actually warranted, and not more than once per
 * cooldown window.
 */
async function selfHealAuth(): Promise<boolean> {
  const d = diagnoseAuth(JWT);
  const action = planAuthHeal(d);

  if (action === 'none') { _authDegradedNotice = ''; return true; }

  if (action === 'refresh') {
    const now = Date.now();
    if (now - _authHealAttemptedAt >= AUTH_HEAL_COOLDOWN_MS) {
      _authHealAttemptedAt = now;
      const ok = await refreshApiKey();
      if (ok) { _authDegradedNotice = ''; return true; }
    }
    // Refresh failed/cooled down but token is still technically usable.
    _authDegradedNotice = d.message;
    return d.usable;
  }

  // action === 'reauth' — credential is dead/missing; can't heal without the user.
  _authDegradedNotice = d.message;
  return false;
}

// Open a URL in the user's default browser, cross-platform.
// IMPORTANT (Windows): the cmd `start` builtin treats the FIRST quoted token as the
// window *title*, so `start "https://…"` opens an empty console window instead of the
// browser. The fix is to pass an empty title first: `start "" "https://…"`. We run it
// through `cmd /c` so the builtin resolves regardless of the parent shell (pwsh/cmd).
function openInBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      // Empty-string title arg is required so `start` does not treat the URL as the title.
      execFile('cmd', ['/c', 'start', '', url], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      execFile('open', [url]);
    } else {
      execFile('xdg-open', [url]);
    }
  } catch { /* non-critical — the URL is always printed for manual open */ }
}

// ── Zero-Credential Device Flow (for Smithery & zero-config installs) ─────────
// When no CACHLY_JWT is set, the server starts an OAuth Device Flow on first tool
// call. The user visits a short URL, enters a code, and the server polls for the
// token in the background. After auth, it auto-provisions an instance if needed.
// State is kept in-memory (works because Smithery keeps one process per session).
interface DeviceFlowState {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  pollInterval: number; // ms
  deadline: number;     // epoch ms
  polling: boolean;
}
let _deviceFlow: DeviceFlowState | null = null;

async function startDeviceFlow(): Promise<DeviceFlowState | null> {
  // Try the cachly API device flow first. It returns a long-lived API key directly
  // on poll (no separate JWT→key exchange needed) and is served at the ROOT paths
  // /auth/device + /auth/device/token (NOT under /api/v1). Requires VALKEY_L1_URL on
  // the API; when unset the API returns 503 and we fall through to Keycloak below.
  try {
    const res = await fetch(`${API_URL}/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json() as {
        device_code: string; user_code: string;
        verification_uri: string; interval: number;
      };
      // Append the user_code so the web page (cachly.dev/device?code=…) auto-submits.
      const base = data.verification_uri || cachlyUrl('/device', 'ambient-signin');
      const verifyUrl = `${base}${base.includes('?') ? '&' : '?'}code=${encodeURIComponent(data.user_code)}`;
      return {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verifyUrl,
        pollInterval: (data.interval ?? 5) * 1000,
        deadline: Date.now() + 10 * 60 * 1000,
        polling: false,
      };
    }
  } catch { /* fall through to Keycloak */ }
  // Fallback: direct Keycloak endpoint
  try {
    const AUTH_BASE = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
    const res = await fetch(`${AUTH_BASE}/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=cachly-cli&scope=openid`,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as {
      device_code: string; user_code: string;
      verification_uri_complete: string; interval: number;
    };
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verifyUrl: data.verification_uri_complete,
      pollInterval: (data.interval ?? 5) * 1000,
      deadline: Date.now() + 10 * 60 * 1000,
      polling: false,
    };
  } catch { return null; }
}

async function pollDeviceFlow(flow: DeviceFlowState): Promise<'pending' | 'expired' | 'done'> {
  if (Date.now() > flow.deadline) return 'expired';
  // Try the cachly API device flow first, then direct Keycloak as fallback.
  const tryProxy = async () => {
    const res = await fetch(`${API_URL}/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: flow.deviceCode }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return res.json() as Promise<{ access_token?: string; error?: string }>;
  };
  const tryKeycloak = async () => {
    const AUTH_BASE = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
    const res = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=cachly-cli&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${flow.deviceCode}`,
      signal: AbortSignal.timeout(8000),
    });
    return res.json() as Promise<{ access_token?: string; error?: string }>;
  };
  try {
    let data = await tryProxy().catch(() => null);
    if (!data) data = await tryKeycloak().catch(() => null);
    if (!data) return 'pending';
    if (data.access_token) {
      // Exchange Keycloak JWT → long-lived API key
      let apiKey = data.access_token;
      try {
        const keyRes = await fetch(`${API_URL}/api/v1/api-keys`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ name: 'cachly-mcp-smithery', scope: 'read_write' }),
          signal: AbortSignal.timeout(8000),
        });
        if (keyRes.ok) {
          const keyBody = await keyRes.json() as { key: string };
          if (keyBody.key) apiKey = keyBody.key;
        }
      } catch { /* use raw JWT as fallback */ }
      JWT = apiKey;
      setEmbedJwt(apiKey); // keep embeddings.ts in sync
      _deviceFlow = null;
      sendFunnelEvent('device_flow_completed');
      // Persist the API key to ~/.claude/mcp.json so subsequent MCP server restarts
      // keep the token. Without this, JWT is lost on restart and brain_recall_count
      // is never incremented (telemetry has no api_key → no tenant resolution).
      void persistApiKeyToConfig(apiKey);
      // Auto-provision: find or create the user's brain instance. resolveDefaultInstanceId
      // now lists existing instances and auto-provisions when the account has none,
      // so a single call covers both paths (and self-heals on every later tool call
      // if provisioning is briefly unavailable here).
      _defaultInstanceLastAttempt = 0;
      await resolveDefaultInstanceId();
      // Give a provisioning instance a head-start so getConnection's wait is shorter.
      // The instance is almost always ready by the time the user's tool re-enters.
      if (_defaultInstanceId) {
        try {
          const checkRes = await fetch(`${API_URL}/api/v1/instances/${_defaultInstanceId}`, {
            headers: { Authorization: `Bearer ${JWT}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(4000),
          });
          if (checkRes.ok) {
            const checkInst = await checkRes.json() as { status?: string };
            if (checkInst.status === 'provisioning') {
              // Wait up to 20s here so the re-entered tool call lands on a running instance.
              const pDeadline = Date.now() + 20_000;
              while (checkInst.status === 'provisioning' && Date.now() < pDeadline) {
                await new Promise(r => setTimeout(r, 3000));
                const rr = await fetch(`${API_URL}/api/v1/instances/${_defaultInstanceId}`, {
                  headers: { Authorization: `Bearer ${JWT}`, Accept: 'application/json' },
                  signal: AbortSignal.timeout(4000),
                }).catch(() => null);
                if (rr?.ok) {
                  const ri = await rr.json() as { status?: string };
                  (checkInst as { status?: string }).status = ri.status;
                } else { break; }
              }
            }
          }
        } catch { /* non-fatal — getConnection will handle the wait if still provisioning */ }
      }
      // Persist instance_id to ~/.claude/mcp.json after it's known, so every
      // restart reuses it instead of making an extra list call on startup.
      if (_defaultInstanceId) void persistInstanceIdToConfig(_defaultInstanceId);
      return 'done';
    }
    if (data.error === 'slow_down') flow.pollInterval = Math.min(flow.pollInterval + 2000, 15000);
    return 'pending';
  } catch { return 'pending'; }
}

/**
 * Mutex wrapper so the background poller (below) and a user-triggered tool call
 * never poll the same device code concurrently — a double poll can race the
 * one-time JWT→API-key exchange.
 */
async function pollDeviceFlowGuarded(flow: DeviceFlowState): Promise<'pending' | 'expired' | 'done'> {
  if (flow.polling) return 'pending'; // another poll owns this tick
  flow.polling = true;
  try {
    return await pollDeviceFlow(flow);
  } finally {
    flow.polling = false;
  }
}

/**
 * Once the device code is issued, poll in the BACKGROUND on the flow's interval
 * so browser sign-in self-completes. Without this, the flow only advanced when
 * the user manually triggered ANOTHER tool call — the #1 onboarding drop-off
 * (report: device flow 36→1 = 3%). Now the user signs in and their Brain
 * activates on its own; their next natural request just works instead of
 * showing "still waiting". Bounded by the flow deadline, timer unref'd so it
 * never keeps the process alive, fully fail-safe (never throws). `poll` and
 * `isCurrent` are injectable for testing.
 */
export function startBackgroundDevicePoll(
  flow: DeviceFlowState,
  poll: (f: DeviceFlowState) => Promise<'pending' | 'expired' | 'done'> = pollDeviceFlowGuarded,
  isCurrent: (f: DeviceFlowState) => boolean = (f) => _deviceFlow === f,
  schedule: (fn: () => void, ms: number) => void = defaultUnrefTimeout,
): void {
  const tick = async () => {
    if (!isCurrent(flow)) return; // superseded or already completed → stop
    let status: 'pending' | 'expired' | 'done' = 'pending';
    try {
      status = await poll(flow);
    } catch {
      /* keep polling — a transient network error must not abort sign-in */
    }
    if (status === 'done') return; // poll already set JWT + persisted the key
    if (status === 'expired') {
      if (isCurrent(flow)) _deviceFlow = null;
      return;
    }
    if (isCurrent(flow)) schedule(tick, flow.pollInterval);
  };
  schedule(tick, flow.pollInterval);
}

function defaultUnrefTimeout(fn: () => void, ms: number): void {
  const t = setTimeout(fn, ms);
  if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
}
// ── Embeddings (imported from embeddings.ts) ────────────────────────────────
import { setEmbedJwt } from './embeddings.js';

// ── Search Engine (imported from search.ts) ─────────────────────────────────
import { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS,
         katakanaToRomaji, arabicLightStem, expandCrossLingual, CROSS_LINGUAL_MAP,
         ZERO_RESULTS_LOG, zeroResultsTotal } from './search.js';

// ── Exported for testing (re-export from search.ts) ─────────────────────────
export { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS,
         katakanaToRomaji, arabicLightStem, expandCrossLingual, CROSS_LINGUAL_MAP };

// ── Connection pool ───────────────────────────────────────────────────────────

/** Reuse Redis connections across tool calls (keyed by instance_id). */
const pool = new Map<string, Redis>();

async function getConnection(instance_id: string): Promise<Redis> {
  if (!instance_id) {
    // With auto-provisioning, this only happens when the API was briefly
    // unreachable during resolution. The next tool call self-heals, so lead
    // with "retry" rather than asking the user to configure anything.
    throw new McpError(
      ErrorCode.InvalidRequest,
      '⏳ Your Brain instance is still being set up.\n\n' +
      'This usually resolves in a few seconds — just call the tool again and it ' +
      'will connect automatically.\n\n' +
      'If it keeps happening:\n' +
      '• Run `list_instances` to check your instances, or\n' +
      '• Set CACHLY_BRAIN_INSTANCE_ID in your MCP config, or\n' +
      '• Reach us at support@cachly.dev.'
    );
  }

  if (pool.has(instance_id)) return pool.get(instance_id)!;

  // Fetch instance, waiting up to PROVISION_TIMEOUT_MS if it is still provisioning.
  // This covers the zero-friction path: device-flow auth → auto-provision → first tool call
  // all happen in quick succession and the instance isn't running yet.
  let inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
  if (inst.status === 'provisioning') {
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;
    while (inst.status === 'provisioning' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 3000));
      inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
    }
  }

  if (inst.status !== 'running') {
    // Telemetry: unreachable instance so the team can proactively investigate
    void fetch(`${API_URL}/api/v1/telemetry/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(JWT ? { Authorization: `Bearer ${JWT}` } : {}) },
      body: JSON.stringify({ event: 'instance_not_reachable', instance_id, status: inst.status, version: CURRENT_VERSION }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    let hint: string;
    if (inst.status === 'provisioning') {
      hint = `⏳ Brain instance "${inst.name}" is still starting up.\n\nFirst-time provisioning typically takes 1–3 minutes. Please retry in a moment — the instance will be ready soon.`;
    } else if (inst.status === 'failed') {
      hint = `❌ Brain instance "${inst.name}" failed to start.\n\n` +
        `Our system will retry automatically. Check status at: ${cachlyUrl('/instances', 'instance-error')}\n` +
        `If this persists, contact support@cachly.dev.`;
    } else if (inst.status === 'suspended') {
      hint = `⏸ Brain instance "${inst.name}" is suspended (billing issue).\n\n` +
        `Update your payment method at: ${cachlyUrl('/billing', 'upgrade')}`;
    } else if (inst.status === 'pending_payment') {
      hint = `💳 Brain instance "${inst.name}" is waiting for payment.\n\n` +
        `Complete your checkout at: ${cachlyUrl('/instances', 'upgrade')}`;
    } else {
      hint = `Brain instance "${inst.name}" is not reachable (status: ${inst.status}).\n\n` +
        `• View your instance at: ${cachlyUrl('/instances', 'instance-error')}\n` +
        `• Run \`get_api_status\` for a full diagnostic.`;
    }
    throw new McpError(ErrorCode.InvalidRequest, hint);
  }
  if (!inst.host || !inst.port) {
    throw new McpError(ErrorCode.InternalError,
      `Instance "${inst.name}" is running but has no host/port — contact support@cachly.dev.`);
  }

  // Fetch connection details (includes password) from the dedicated endpoint.
  let password: string | undefined;
  let tlsEnabled = inst.tls_enabled !== false; // default true
  try {
    const conn = await apiFetch<{ password?: string; tls_enabled?: boolean }>(
      `/api/v1/instances/${instance_id}/connection`
    );
    password = conn.password ?? undefined;
    tlsEnabled = conn.tls_enabled !== false;
  } catch (connErr) {
    // If the connection endpoint fails and the instance has a password, we cannot connect.
    // Surface the error so the user knows why Redis auth will fail rather than getting a cryptic NOAUTH.
    const msg = connErr instanceof Error ? connErr.message : String(connErr);
    if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
      throw new McpError(ErrorCode.InvalidRequest,
        `API key rejected — run \`cachly setup\` to refresh your credentials.`);
    }
    // Other failures (timeout, 500): proceed without password, Redis will surface NOAUTH if needed
  }

  const client = new Redis({
    host: inst.host,
    port: inst.port,
    password: password || undefined,
    commandTimeout: 8000,
    ...(tlsEnabled ? { tls: {} } : {}),
    lazyConnect: true,
    enableReadyCheck: true,
    connectTimeout: 8000,
    retryStrategy: () => null,  // fail fast, no reconnect loops in MCP context
  });

  // Drop the client from the pool AND close its socket on error/end, so a
  // mid-session Redis drop doesn't leak sockets across reconnects. disconnect()
  // is idempotent and safe to call from these handlers. The next tool call
  // rebuilds the connection (self-healing).
  const evict = () => {
    pool.delete(instance_id);
    client.disconnect();
  };
  client.on('error', evict);
  client.on('end', evict);

  try {
    await client.connect();
  } catch (err: unknown) {
    client.disconnect();
    const msg = err instanceof Error ? err.message : String(err);
    void fetch(`${API_URL}/api/v1/telemetry/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(JWT ? { Authorization: `Bearer ${JWT}` } : {}) },
      body: JSON.stringify({ event: 'redis_connect_failed', instance_id, host: inst.host, port: inst.port, error: msg, version: CURRENT_VERSION }),
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
    throw new McpError(
      ErrorCode.InternalError,
      `Could not reach Brain instance "${inst.name}" (${inst.host}:${inst.port}).\n\n` +
      `• Check your network connection\n` +
      `• Run \`get_api_status\` to verify instance status\n` +
      `• Technical detail: ${msg}`
    );
  }

  pool.set(instance_id, client);
  return client;
}

// ── API helper ────────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, options: RequestInit = {}, _isRetry = false): Promise<T> {
  // Self-healing pass: proactively refresh a near-expiry token into a long-lived
  // key *before* it can fail. On the first call only (the heal is internally
  // cooldown-guarded, so this is cheap on the hot path).
  if (!_isRetry) {
    const action = planAuthHeal(diagnoseAuth(JWT));
    if (action !== 'none') await selfHealAuth();
  }
  checkJwt(JWT);
  const timeoutMs = Number(process.env.CACHLY_API_TIMEOUT_MS ?? 15_000);
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${JWT}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    // A 401 means the token was rejected server-side (e.g. revoked or expired
    // between diagnosis and the call). Try to self-heal once, then retry — so a
    // recoverable credential never silently turns into "0 recalls".
    if (res.status === 401 && !_isRetry) {
      _authHealAttemptedAt = 0; // force the heal to run despite the cooldown
      const healed = await selfHealAuth();
      if (healed) return apiFetch<T>(path, options, true);
    }
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const detail = (body as { error?: string }).error ?? res.statusText;
    handleApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

import { handleBrainTool } from './handlers/brain.js';
import { handleContextTool } from './handlers/context.js';
import { handleInstanceTool } from './handlers/instances.js';
import { handleCacheTool } from './handlers/cache.js';
import { handleTeamTool } from './handlers/team.js';
import { handleRoadmapTool } from './handlers/roadmap.js';
import { handleAdvancedTool } from './handlers/advanced.js';
import { handleSyndicateTool } from './handlers/syndicate.js';
import { handleFedbrainTool, _lastBrainFromGitCounts } from './handlers/fedbrain.js';
import { buildClsPostCommitHook, installClsPostCommitHook, CLS_HOOK_VERSION } from './cls-hook.js';
import { installAmbientHooks, AMBIENT_HOOK_VERSION } from './ambient-hooks.js';
import { runAmbient, parseHookPayload, stopObservation } from './ambient-cli.js';
import { appendLedgerEntry, readLedger, defaultLedgerPath } from './ambient-ledger.js';
import { loadAmbientMemory, saveAmbientMemory } from './ambient-memory.js';
import { buildAmbientDeps } from './ambient-deps.js';
import { detectEditor as detectEditorImpl } from './editor.js';
import { milestoneSent, markMilestoneSent } from './funnel-milestones.js';
import {
  kostprobeUebrig,
  kostprobeVerbrauchen,
  kostprobeHinweis,
  schrankeNachKostproben,
} from './kostprobe.js';
import { netBalance, shouldBackoff } from './ambient-recall.js';
import { handleShareTool } from './handlers/share.js';
import { handleVizTool } from './handlers/viz.js';
import type { Instance } from './handlers/brain.js';

// ── Tools (imported from tools.ts) ─────────────────────────────────────────
import { TOOLS } from './tools.js';


// ── Handlers ──────────────────────────────────────────────────────────────────

// Fires once per process when no JWT is set (anonymous, opt-out via CACHLY_NO_TELEMETRY=1)
let _telemetryPingSent = false;
// Fires once per process on the first successful Brain tool call — key activation metric
let _firstCallSuccessSent = false;

// Host detection lives in editor.ts (pure + unit-tested). Kept as a thin
// wrapper so the many call sites here stay unchanged.
function detectEditor(): string {
  return detectEditorImpl();
}

/** Derive an anonymous, non-reversible fingerprint from the JWT sub claim. */
function _jwtUserFingerprint(jwt: string): string | undefined {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { sub?: string };
    if (!payload.sub) return undefined;
    // First 16 hex chars of a deterministic hash — no PII, not reversible.
    let h = 0x811c9dc5;
    for (let i = 0; i < payload.sub.length; i++) {
      h ^= payload.sub.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0') + payload.sub.length.toString(16).padStart(4, '0');
  } catch { return undefined; }
}

function sendFunnelEvent(event: FunnelEventName, extra?: Record<string, unknown>, metrics?: DashboardMetrics): void {
  if (process.env.CACHLY_NO_TELEMETRY === '1') return;
  const fingerprint = JWT ? _jwtUserFingerprint(JWT) : undefined;
  void fetch(`${API_URL}/api/v1/telemetry/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event, version: CURRENT_VERSION, editor: detectEditor(),
      ...(JWT ? { jwt: JWT } : {}),
      ...(fingerprint ? { user_fingerprint: fingerprint } : {}),
      ...(metrics ? { metrics } : {}),
      ...extra,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {/* fire-and-forget */});
}

// Mirrors one ambient net-token ledger entry to the API (Phase 4 v2: the
// org-wide dashboard aggregates these per team). Best-effort fire-and-forget —
// the local JSONL ledger stays authoritative; this never throws and never
// blocks a hook. Returns the fetch promise so short-lived CLI paths can flush
// (bounded) before process.exit kills the socket.
function reportAmbientLedgerEvent(
  instanceId: string | undefined,
  entry: { ts: string; event: string; injected: number; prevented: number; note?: string },
): Promise<void> {
  if (!instanceId || !JWT || process.env.CACHLY_NO_TELEMETRY === '1') return Promise.resolve();
  return fetch(`${API_URL}/api/v1/instances/${instanceId}/ambient-events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` },
    body: JSON.stringify({ events: [entry] }),
    signal: AbortSignal.timeout(3000),
  }).then(
    () => undefined,
    () => undefined,
  );
}

async function sendAnonymousTelemetry(toolName: string): Promise<void> {
  if (_telemetryPingSent) return;
  if (process.env.CACHLY_NO_TELEMETRY === '1') return;
  _telemetryPingSent = true;
  try {
    await fetch(`${API_URL}/api/v1/telemetry/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'first_call_no_jwt', version: CURRENT_VERSION, editor: detectEditor(), tool: toolName }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* fire-and-forget, never block the user */ }
}

// ── Feature-Gate (premium tools) ────────────────────────────────────────────
// Free tier delivers the magic moment: keyword + CKG recall, learn, sessions.
// The deeper intelligence layers — causal root-cause tracing, predictive risk,
// and the shared Team Brain — are Premium. Value through depth, not volume. A
// free user who reaches for one of these gets the value pitched at the exact
// moment of need, never a silent failure.
const PREMIUM_TOOLS = new Set<string>([
  // Predictive + causal intelligence
  'causal_trace', 'brain_predict', 'brain_plan', 'brain_predict_failures',
  // Team Brain (shared, multi-author knowledge)
  'team_learn', 'team_confirm', 'team_recall', 'team_synthesize', 'team_crystallize',
  'global_learn', 'global_recall',
]);

const PREMIUM_PITCH: Record<string, string> = {
  causal_trace: 'Causal root-cause tracing — follow the failure chain to the real cause, not just the symptom.',
  brain_predict: 'Predictive risk — your Brain warns you what will break *before* you run it.',
  brain_plan: 'Generative planning — turn a goal into an ordered, risk-aware plan from your own history.',
  brain_predict_failures: 'Failure prediction — catch CI/build breakage before it happens.',
  team_learn: 'Team Brain — one shared memory across your whole team.',
  team_confirm: 'Team Brain — peer + senior review that raises lesson trust.',
  team_recall: 'Team Brain — recall everything your teammates have already solved.',
  team_synthesize: 'Team Brain — synthesize collective knowledge across authors.',
  team_crystallize: "Team Brain — compress your team's wisdom into a shareable crystal.",
  global_learn: "Team Brain — contribute to your organization's shared memory.",
  global_recall: 'Team Brain — recall across your entire organization.',
};

const UPGRADE_URL_FG = cachlyUrl('/billing', 'upgrade');

interface TierInfo { tier: string; isFree: boolean }
const _tierCache = new Map<string, { info: TierInfo; expiresAt: number }>();

async function getTierInfo(instanceId: string): Promise<TierInfo> {
  const cached = _tierCache.get(instanceId);
  if (cached && cached.expiresAt > Date.now()) return cached.info;
  try {
    const inst = await apiFetch<Instance>(`/api/v1/instances/${instanceId}`);
    const tier = (inst?.tier ?? 'free').toLowerCase();
    const info: TierInfo = { tier, isFree: tier === 'free' || tier === '' };
    _tierCache.set(instanceId, { info, expiresAt: Date.now() + 60_000 });
    return info;
  } catch {
    // Tier unknown → fail open (never block on a stats hiccup).
    return { tier: 'unknown', isFree: false };
  }
}

/**
 * Entscheidet, was mit einem gesperrten Werkzeug auf der Gratis-Stufe
 * passiert. Drei Ausgänge:
 *
 *   null        → durchlassen (kein Premium-Werkzeug, oder bezahlte Stufe,
 *                 oder es sind noch Kostproben übrig)
 *   {sperre}    → Text zurückgeben, Werkzeug NICHT ausführen
 *   {kostprobe} → durchlassen UND nach dem Ergebnis einen Hinweis anhängen
 *
 * Warum überhaupt Kostproben: Gemessen am 11.08.2026 ist `premium_gate_hit`
 * 36-mal gefeuert — von einer einzigen Person, dem Entwickler selbst, über
 * fünf Wochen. Er hat nicht aufgerüstet. Die Schranke gab eine
 * Verkaufsansage, nie eine Kostprobe; man vermisst nicht, was man nie hatte.
 * Einzelheiten in kostprobe.ts.
 */
async function featureGate(
  name: string,
  instanceId: string | undefined,
): Promise<{ sperre: string } | { kostprobe: string } | null> {
  if (!PREMIUM_TOOLS.has(name) || !instanceId) return null;
  const { isFree } = await getTierInfo(instanceId);
  if (!isFree) return null;

  const pitch = PREMIUM_PITCH[name] ?? 'A Premium intelligence feature.';

  if (kostprobeUebrig(name)) {
    // Durchlassen und danach kurz sagen, was das war. Der Zähler wird erst
    // HIER erhöht, also nur wenn wirklich ausgeführt wird — ein abgebrochener
    // Aufruf darf keine Kostprobe kosten.
    const verbraucht = kostprobeVerbrauchen(name);
    return { kostprobe: kostprobeHinweis(name, verbraucht, UPGRADE_URL_FG) };
  }

  return { sperre: schrankeNachKostproben(name, pitch, UPGRADE_URL_FG) };
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  // Guard: if no JWT, return actionable onboarding message instead of HTTP 401
  if (!JWT) {
    void sendAnonymousTelemetry(name);

    // ── Zero-credential device flow ─────────────────────────────────────
    // 1st call: start device flow, return code + URL
    // 2nd+ calls: poll for token; once authenticated, proceed transparently
    if (_deviceFlow) {
      const result = await pollDeviceFlowGuarded(_deviceFlow);
      if (result === 'done') {
        // Auth complete — re-enter handleTool with now-valid JWT
        return handleTool(name, args);
      }
      if (result === 'expired') {
        sendFunnelEvent('device_flow_failed', { reason: 'timeout' });
        _deviceFlow = null;
        return '⌛ **Authentication timed out.** Please call any tool again to restart the sign-in flow.';
      }
      // Still pending — the background poller will complete sign-in on its own.
      return [
        '⏳ **Signing you in…**',
        '',
        `Finish in your browser: **${_deviceFlow.verifyUrl}**`,
        `Code: **${_deviceFlow.userCode}**`,
        '',
        'This completes automatically once you sign in — no need to come back here.',
      ].join('\n');
    }

    // No pending flow — start a new one
    const flow = await startDeviceFlow();
    if (flow) {
      _deviceFlow = flow;
      sendFunnelEvent('device_flow_started', { tool: name });
      // Try to open the browser automatically — fire-and-forget, never block
      openInBrowser(flow.verifyUrl);
      // Poll in the background so sign-in self-completes — the user no longer
      // has to trigger another tool call to drive the flow (the #1 drop-off).
      startBackgroundDevicePoll(flow);
      return [
        '🧠 **cachly AI Brain — sign in to activate** (browser opening...)',
        '',
        `👉 **${flow.verifyUrl}**`,
        '',
        `Code: **${flow.userCode}** (pre-filled if browser opened automatically)`,
        '',
        'That’s it — your Brain activates automatically the moment you finish',
        'signing in. Just keep working; your next request arrives brain-powered.',
        '',
        '✨ Free forever · No credit card · 122 MCP tools · GDPR · EU servers',
      ].join('\n');
    }

    // Device flow unavailable (network issue) — fall back to manual setup
    return [
      '🧠 **cachly AI Brain — Setup required**',
      '',
      'Run the setup wizard once in your terminal:',
      '   ```',
      '   npx @cachly-dev/mcp-server@latest autopilot',
      '   ```',
      '',
      `Or get your API key at: ${cachlyUrl('/setup-ai', 'ambient-signin')}`,
      '',
      '✨ Free tier includes: 1 Brain instance, persistent memory, semantic search.',
    ].join('\n');
  }

  // Auto-resolve instance_id from env / API when not provided in args
  if (!args.instance_id) {
    const defaultId = await resolveDefaultInstanceId();
    if (defaultId) args = { ...args, instance_id: defaultId };
  }

  // Feature-Gate mit Kostprobe: die ersten Läufe eines Premium-Werkzeugs
  // laufen auf der Gratis-Stufe echt durch, erst danach kommt die Schranke.
  // Der Hinweis wird an das ECHTE Ergebnis angehängt, nicht davorgesetzt —
  // wirken soll die Antwort, nicht der Text.
  const gate = await featureGate(name, args.instance_id as string | undefined);
  let kostprobeHinweisText = '';
  if (gate !== null) {
    if ('sperre' in gate) {
      sendFunnelEvent('premium_gate_hit', { tool: name, instance_id: (args.instance_id as string) ?? '' });
      return gate.sperre;
    }
    kostprobeHinweisText = gate.kostprobe;
    sendFunnelEvent('premium_taste_used', { tool: name, instance_id: (args.instance_id as string) ?? '' });
  }

  // Delegate brain tools (learn, recall, session, etc.)
  const brainResult = await handleBrainTool(name, args, getConnection, apiFetch);
  if (brainResult !== null) {
    if (!_firstCallSuccessSent && JWT) {
      _firstCallSuccessSent = true;
      // Persistent guard: ambient hooks spawn a fresh process per prompt, so the
      // in-memory flag alone re-sent "first call" on every hook invocation.
      if (!milestoneSent('first_call_success')) {
        markMilestoneSent('first_call_success');
        sendFunnelEvent('first_call_success', { tool: name, instance_id: args.instance_id ?? _defaultInstanceId ?? '' });
      }
    }
    // Per-tool telemetry — fires after every successful brain tool call.
    // api_key carries the cky_live_... token so the backend can resolve tenant + increment counters.
    const instanceId = (args.instance_id as string | undefined) ?? _defaultInstanceId ?? '';
    const telemetryExtra = JWT ? { api_key: JWT, instance_id: instanceId } : { instance_id: instanceId };
    if (name === 'recall_best_solution') {
      // recall_best_solution → increments BrainRecallCount + triggers level-up logic
      sendFunnelEvent('recall_best_solution', telemetryExtra);
    } else if (name === 'learn_from_attempts') {
      sendFunnelEvent('learn_from_attempts', telemetryExtra);
    } else if (name === 'session_start') {
      sendFunnelEvent('session_start', telemetryExtra, { born_at: undefined, recalls_total: undefined, starter_seeded: false });
      const resultText = typeof brainResult === 'object' && brainResult !== null && 'content' in brainResult
        ? JSON.stringify(brainResult)
        : String(brainResult ?? '');
      const isFirstSession = resultText.includes('Welcome! Your AI Brain is live.');

      if (!isFirstSession && resultText.length > 100) {
        // Existing brain — session_start acts as implicit recall → increment counter.
        sendFunnelEvent('recall_best_solution', telemetryExtra);
      } else if (isFirstSession && args.workspace_path) {
        // First session with a known workspace: auto-bootstrap from git history.
        // Runs synchronously so the user sees the result in the same response.
        try {
          const gitBootstrap = await handleFedbrainTool('brain_from_git', {
            instance_id: instanceId,
            repo_path: args.workspace_path as string,
            limit: 50,
          }, getConnection, apiFetch);
          if (gitBootstrap !== null) {
            const gitCounts = _lastBrainFromGitCounts;
            sendFunnelEvent('brain_from_git', { ...telemetryExtra, ...(gitCounts ?? {}) });
            sendFunnelEvent('recall_best_solution', telemetryExtra);

            // If git history yielded nothing usable (fresh/shallow/no-fix repo),
            // seed the curated starter corpus so the very first smart_recall hits.
            // This is the key lever on time-to-first-recall for new/empty repos.
            let starterText = '';
            if ((_lastBrainFromGitCounts?.total ?? 0) === 0) {
              try {
                const seed = await handleShareTool('brain_seed_starter', { instance_id: instanceId }, getConnection, apiFetch);
                if (seed) {
                  sendFunnelEvent('brain_seed_starter', { ...telemetryExtra, auto: true },
                    { seeded_count: 16, auto: true });
                  starterText = '\n---\n' + String(seed);
                }
              } catch { /* seeding errors must never break session_start */ }
            }

            // Append bootstrap summary to the session_start briefing.
            // brainResult is always a string here (handleBrainTool returns string for session_start).
            const bootstrapText = String(gitBootstrap);
            // Show a concrete count so the user knows what was seeded (the WOW moment).
            const totalSeeded = _lastBrainFromGitCounts?.total ?? 0;
            const seedBanner = totalSeeded > 0
              ? `\n✅ **Brain bootstrapped from git — ${totalSeeded} lesson${totalSeeded === 1 ? '' : 's'} loaded.** Your AI already knows your history.`
              : '';
            if (bootstrapText || starterText || seedBanner) {
              return String(brainResult) + seedBanner + '\n---\n' + bootstrapText + starterText;
            }
          }
        } catch (gitErr) {
          // Bootstrap failed — fire telemetry so we can investigate and tell the user
          // what happened (don't leave them wondering why the brain is empty).
          sendFunnelEvent('brain_from_git_failed', { ...telemetryExtra,
            reason: gitErr instanceof Error ? gitErr.message.slice(0, 120) : 'unknown' });
          return String(brainResult) +
            '\n\n> ⚠️ **Auto-bootstrap from git history failed** — your Brain is live but starts empty.\n' +
            '> Run `brain_from_git(instance_id="' + instanceId + '", repo_path="' + String(args.workspace_path) + '")` manually to seed it.\n' +
            '> Or try `brain_seed_starter` to load 16 universal engineering lessons instantly.';
        }
      }
    } else if (name === 'session_end') {
      sendFunnelEvent('session_end', telemetryExtra);
    } else if (name === 'smart_recall') {
      const srText = typeof brainResult === 'object' && brainResult !== null && 'content' in brainResult
        ? JSON.stringify(brainResult)
        : String(brainResult ?? '');
      const srHit = srText.length > 50 && !srText.includes('No lessons found') && !srText.includes('no lessons') && !srText.includes('No matches found');
      sendFunnelEvent('smart_recall', telemetryExtra, { hit: srHit, topic: String(args.query ?? '').slice(0, 80) });
      // smart_recall is the primary recall tool in CLAUDE.md — it retrieves brain lessons
      // just like recall_best_solution. Count it toward BrainRecallCount so the dashboard
      // nudge clears and the first-recall email fires for users following CLAUDE.md.
      if (srHit) {
        sendFunnelEvent('recall_best_solution', telemetryExtra);
      }
      // Self-healing: if the credential is degraded, the briefing may be thin or
      // empty ("0 recalls"). Tell the user why, up front, instead of silently.
      if (_authDegradedNotice && typeof brainResult === 'string') {
        return `> ⚠️ **Brain auth degraded** — ${_authDegradedNotice.split('\n')[0]}\n\n${brainResult}`;
      }
    }
    return brainResult;
  }

  // Delegate context tools (remember/recall/list/forget)
  const contextResult = await handleContextTool(name, args, getConnection, apiFetch);
  if (contextResult !== null) {
    if (!_firstCallSuccessSent && JWT) {
      _firstCallSuccessSent = true;
      // Persistent guard: ambient hooks spawn a fresh process per prompt, so the
      // in-memory flag alone re-sent "first call" on every hook invocation.
      if (!milestoneSent('first_call_success')) {
        markMilestoneSent('first_call_success');
        sendFunnelEvent('first_call_success', { tool: name, instance_id: args.instance_id ?? _defaultInstanceId ?? '' });
      }
    }
    return contextResult;
  }

  // Delegate instance + cache tools
  const instanceResult = await handleInstanceTool(name, args, getConnection, apiFetch);
  if (instanceResult !== null) return instanceResult;

  const cacheResult = await handleCacheTool(name, args, getConnection, apiFetch);
  if (cacheResult !== null) return cacheResult;

  // Der Kostproben-Hinweis wird NUR hier angehaengt — an den drei Handlern,
  // die die gesperrten Werkzeuge bedienen: team.ts (team_*, global_*),
  // advanced.ts (causal_trace) und syndicate.ts (brain_predict und die
  // uebrigen Vorhersagen). Er kommt ans ENDE, hinter das echte Ergebnis:
  // wirken soll die Antwort, nicht der Text. Bei allen anderen Werkzeugen ist
  // kostprobeHinweisText leer und die Zeile aendert nichts.
  const mitHinweis = (r: string): string => (kostprobeHinweisText ? r + kostprobeHinweisText : r);

  // Delegate team/brain advanced tools
  const teamResult = await handleTeamTool(name, args, getConnection, apiFetch);
  if (teamResult !== null) return mitHinweis(teamResult);

  const roadmapResult = await handleRoadmapTool(name, args, getConnection, apiFetch);
  if (roadmapResult !== null) return roadmapResult;

  const advancedResult = await handleAdvancedTool(name, args, getConnection, apiFetch);
  if (advancedResult !== null) return mitHinweis(advancedResult);

  const syndicateResult = await handleSyndicateTool(name, args, getConnection, apiFetch);
  if (syndicateResult !== null) {
    // brain_predict is in syndicate handler — track telemetry here.
    if (name === 'brain_predict') {
      const instanceId = (args.instance_id as string | undefined) ?? _defaultInstanceId ?? '';
      const telemetryExtra = JWT ? { api_key: JWT, instance_id: instanceId } : { instance_id: instanceId };
      sendFunnelEvent('brain_predict', telemetryExtra);
    }
    return mitHinweis(syndicateResult);
  }

  const shareResult = await handleShareTool(name, args, getConnection, apiFetch);
  if (shareResult !== null) return shareResult;

  const vizResult = await handleVizTool(name, args, getConnection, apiFetch);
  if (vizResult !== null) return vizResult;

  const fedbrainResult = await handleFedbrainTool(name, args, getConnection, apiFetch);
  if (fedbrainResult !== null) {
    // brain_from_git and brain_predict_failures are in fedbrain handler.
    const instanceId = (args.instance_id as string | undefined) ?? _defaultInstanceId ?? '';
    const telemetryExtra = JWT ? { api_key: JWT, instance_id: instanceId } : { instance_id: instanceId };
    if (name === 'brain_from_git') {
      const gitCounts = _lastBrainFromGitCounts;
      sendFunnelEvent('brain_from_git', { ...telemetryExtra, ...(gitCounts ?? {}) },
        gitCounts ? { fixes: gitCounts.fixes, features: gitCounts.features, refactors: gitCounts.refactors, total: gitCounts.total } : undefined);
    } else if (name === 'brain_predict_failures') {
      sendFunnelEvent('brain_predict_failures', telemetryExtra);
    }
    return fedbrainResult;
  }

  switch (name) {
    // ── Instance management ──────────────────────────────────────────────
    case 'get_api_status': {
      // Check health
      let healthStatus = 'unknown';
      try {
        const healthRes = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(8000) });
        if (healthRes.ok) {
          const body = await healthRes.json() as { status?: string; db?: string };
          healthStatus = `${body.status ?? 'ok'} (db: ${body.db ?? '?'})`;
        } else {
          healthStatus = `HTTP ${healthRes.status}`;
        }
      } catch (e) {
        healthStatus = `unreachable: ${(e as Error).message}`;
      }

      // Check JWT / auth
      if (!JWT) {
        return [
          `📡 **cachly API Status**`,
          ``,
          `  🌐 API:      ${API_URL}`,
          `  💓 Health:   ${healthStatus}`,
          `  🔑 Auth:     ❌ CACHLY_JWT not set`,
          ``,
          `💡 Get your API token at ${cachlyUrl('/instances', 'api-status')} → Settings → API Token`,
        ].join('\n');
      }

      // Decode JWT claims (inspection only, no verification)
      let authInfo = '❌ invalid JWT format';
      try {
        const parts = JWT.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
            sub?: string; exp?: number; iss?: string;
          };
          const sub = payload.sub ?? '(unknown)';
          const iss = payload.iss ?? '(unknown)';
          const provider = iss.includes('keycloak') ? 'Keycloak' : 'OIDC';
          const expTs = payload.exp ? new Date(payload.exp * 1000) : null;
          const expired = expTs ? expTs < new Date() : false;
          authInfo = [
            `✅ JWT decoded`,
            `  Sub (user ID): ${sub}`,
            `  Provider:      ${provider}`,
            `  Issuer:        ${iss}`,
            `  Expires:       ${expTs ? expTs.toISOString() : 'never'} ${expired ? '⚠️  EXPIRED – get a new token!' : '✅'}`,
          ].join('\n');
        }
      } catch {
        authInfo = '❌ JWT decode failed – check CACHLY_JWT format';
      }

      // List instances + connectivity
      let instanceInfo = '';
      try {
        const listRes = await apiFetch<{ data: Instance[] }>('/api/v1/instances');
        const instances = listRes.data ?? [];
        if (instances.length === 0) {
          instanceInfo = `\n\n🧠 **Brain Instances:** none — create one at ${cachlyUrl('/instances', 'api-status')}`;
        } else {
          const lines: string[] = ['\n\n🧠 **Brain Instances:**'];
          for (const inst of instances) {
            const badge = inst.status === 'running' ? '🟢' : inst.status === 'provisioning' ? '🟡' : '🔴';
            const defaultMark = inst.id === _defaultInstanceId ? ' ← active' : '';
            lines.push(`  ${badge} **${inst.name}** (\`${inst.id}\`) · ${inst.status}${defaultMark}`);
            if (inst.status === 'running' && inst.host) {
              // Try a quick ping on the cached connection
              const pooled = pool.get(inst.id);
              if (pooled) {
                try {
                  await pooled.ping();
                  lines.push(`     💓 Redis: connected`);
                } catch {
                  lines.push(`     ⚠️  Redis: pooled but ping failed — will reconnect on next use`);
                }
              } else {
                lines.push(`     💤 Redis: not connected yet (connects on first tool use)`);
              }
            } else if (inst.status === 'provisioning') {
              lines.push(`     ⏳ Still provisioning — check back in ~30 s`);
            } else if (inst.status !== 'running') {
              lines.push(`     ❌ Not reachable (status: ${inst.status})`);
            }
          }
          instanceInfo = lines.join('\n');
        }
      } catch (e) {
        instanceInfo = `\n\n🧠 **Brain Instances:** could not fetch — ${(e as Error).message}`;
      }

      // Self-healing diagnosis: a status check is a natural moment to refresh a
      // near-expiry token, and to tell the user plainly if the credential is dying.
      await selfHealAuth();
      const diag = diagnoseAuth(JWT);
      const selfHealLine =
        diag.state === 'long_lived' ? `🛡️ Self-healing: ✅ long-lived API key (won't expire silently)`
        : diag.state === 'healthy' ? `🛡️ Self-healing: ✅ token valid${diag.expiresInMs ? ` (${Math.round(diag.expiresInMs / 3_600_000)}h left)` : ''}`
        : diag.state === 'near_expiry' ? `🛡️ Self-healing: ♻️ token near expiry — auto-refresh attempted`
        : `🛡️ Self-healing: ⚠️ ${diag.message.split('\n')[0]}`;

      return [
        `📡 **cachly API Status**`,
        ``,
        `  🌐 API:    ${API_URL}`,
        `  💓 Health: ${healthStatus}`,
        `  ${selfHealLine}`,
        ``,
        `🔑 **Auth:**`,
        authInfo,
        instanceInfo,
      ].join('\n');
    }

    default:
      throw new UnknownToolError(`Unknown tool: ${name}`);
  }
}

/**
 * Thrown by handleTool for a tool name that matches none of the delegated
 * handlers and none of the explicit switch cases. Caught by the top-level
 * request handler and turned into an `isError` result — never a silent
 * success — so a client can no longer mistake a missing handler for a
 * completed call.
 */
class UnknownToolError extends Error {}

// Pushed to every MCP host at connect time (initialize response). This is the
// "SessionStart-equivalent" for harnesses without a per-prompt hook — Cursor,
// Windsurf, Cline, Copilot agent-mode all surface `instructions`. It's a one-time
// nudge (not per-prompt recall), so it stays short and behavior-focused.
const CACHLY_MCP_INSTRUCTIONS = `This project has a Cachly AI Brain — persistent, cross-session memory of past fixes, decisions, and gotchas for THIS codebase. Use it proactively; it makes you faster and stops you repeating known mistakes.

- BEFORE a non-trivial task: call smart_recall with a short description of what you're about to do. If it returns lessons, apply them before researching from scratch.
- WHEN debugging an error: call causal_trace with the exact error first — a known fix may already exist.
- AFTER a fix, deploy, or discovery: call learn_from_attempts so the knowledge persists.
- BEFORE a risky op (deploy, migration, dependency bump): call brain_predict.

The Brain instance id comes from the CACHLY_BRAIN_INSTANCE_ID environment variable.`;

const server = new Server(
  { name: 'cachly-mcp', version: CURRENT_VERSION },
  { capabilities: { tools: {} }, instructions: CACHLY_MCP_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ── Auto-session management ───────────────────────────────────────────────────
// Transparently starts a Brain session on the first tool call of a process
// and saves a session_end summary on SIGTERM/exit so users never have to call
// session_start/session_end manually.

let _autoSessionInstanceId: string | null = null;
let _autoSessionStarted = false;
let _autoSessionStarting: Promise<void> | null = null; // guard against double-start race
let _autoSessionToolCount = 0;

// ── brain_from_git concurrency limiter ────────────────────────────────────────
// Spawning many `git log` subprocesses in parallel can fork-bomb the host.
// This simple semaphore caps concurrent brain_from_git calls to 10 per process.
async function autoStartSession(instanceId: string): Promise<void> {
  if (_autoSessionStarted) return;
  // If another call already started the session, await it instead of double-starting.
  if (_autoSessionStarting) { await _autoSessionStarting; return; }
  _autoSessionStarting = (async () => {
    _autoSessionStarted = true;
    _autoSessionInstanceId = instanceId;
    try {
      await handleTool('session_start', { instance_id: instanceId, focus: 'auto (MCP session)', workspace_path: process.cwd() });
    } catch { /* non-fatal — session tracking is a best-effort feature */ } finally {
      _autoSessionStarting = null;
    }
  })();
  await _autoSessionStarting;

  // Auto-index the project if it hasn't been indexed in the last 24h.
  // This is the main lever for growing token savings: more indexed code →
  // more semantic cache hits → fewer LLM calls for repeated questions.
  if (process.env.CACHLY_AUTO_INDEX !== 'false') {
    try {
      const redis = await getConnection(instanceId);
      const lastIndexed = await redis.get(`cachly:index:last_indexed:${instanceId}`);
      const staleMs = 24 * 60 * 60 * 1000;
      const isStale = !lastIndexed || (Date.now() - parseInt(lastIndexed, 10)) > staleMs;
      if (isStale) {
        // Mark as indexing now to prevent concurrent re-runs.
        await redis.set(`cachly:index:last_indexed:${instanceId}`, String(Date.now()), 'EX', 90000);
        // Run in background — don't block the first tool call.
        handleTool('index_project', {
          instance_id: instanceId,
          dir: process.cwd(),
          max_files: 150,
          ttl: 86400 * 7, // cache for 7 days
          namespace: 'cachly:sem:code',
        }).catch(() => undefined);
      }
    } catch { /* never block the session on indexing errors */ }
  }
}

async function autoEndSession(): Promise<void> {
  if (!_autoSessionStarted || !_autoSessionInstanceId) return;
  _autoSessionStarted = false;
  try {
    await handleTool('session_end', {
      instance_id: _autoSessionInstanceId,
      summary: `Auto-ended after ${_autoSessionToolCount} tool call(s). Session was started automatically.`,
      files_changed: [],
      lessons_learned: 0,
    });
  } catch { /* non-fatal */ }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Auto-start brain session on first tool call that has an instance_id.
  // Skip session management tools to avoid recursion.
  const sessionTools = new Set(['session_start', 'session_start_summary', 'session_end', 'auto_learn_session']);
  if (!sessionTools.has(name) && !_autoSessionStarted && !_autoSessionStarting) {
    const instanceId = ((args as Record<string, unknown>)?.instance_id as string | undefined)
      || _defaultInstanceId
      || process.env.CACHLY_BRAIN_INSTANCE_ID;
    if (instanceId) {
      await autoStartSession(instanceId).catch(() => undefined);
    }
  } else if (_autoSessionStarting) {
    // Another concurrent call is mid-start — wait for it before proceeding.
    await _autoSessionStarting.catch(() => undefined);
  }
  if (!sessionTools.has(name)) _autoSessionToolCount++;

  try {
    const text = await handleTool(name, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (err instanceof UnknownToolError) {
      return { content: [{ type: 'text', text: err.message }], isError: true };
    }
    if (err instanceof McpError) throw err;
    const msg = (err as Error).message ?? String(err);
    notify('cachly', 'tool_error', { tool: name, error: msg }).catch(() => undefined);
    throw new McpError(ErrorCode.InternalError, msg);
  }
});

// Graceful shutdown – close all Redis connections + auto-end brain session
process.on('SIGTERM', async () => {
  await autoEndSession().catch(() => undefined);
  for (const [, client] of pool) await client.quit().catch(() => undefined);
  process.exit(0);
});

process.on('SIGINT', async () => {
  await autoEndSession().catch(() => undefined);
  for (const [, client] of pool) await client.quit().catch(() => undefined);
  process.exit(0);
});

// Safety net: log unhandled rejections instead of crashing the MCP process.
// The MCP server must stay alive even if a single tool call hits an unexpected error.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  // Write to stderr only (stdout is the JSON-RPC channel)
  process.stderr.write(`[cachly-mcp] unhandledRejection: ${msg}\n`);
});

// Symmetric net for synchronous/async *exceptions* thrown outside a try/catch
// (a timer or stream callback, the background device poller, ioredis internals).
// Without this the process exits hard and the editor reports "Connection is
// closed" mid-session. Log to stderr and stay alive — never exit here.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[cachly-mcp] uncaughtException: ${(err as Error)?.stack ?? String(err)}\n`);
});

// The single most common stdio-MCP killer: the editor closes the read side of
// our stdout pipe (window closed, server restart, client reconnect) and the
// next JSON-RPC write throws EPIPE — an async stream error that would otherwise
// crash the process. Swallow stream errors on both stdio ends so a client that
// closes its pipe can never take the server down with it.
process.stdout.on('error', () => {});
process.stdin.on('error', () => {});

// ── CLI helpers ───────────────────────────────────────────────────────────────

export const EDITOR_FILES: Record<string, string> = {
  claude:   '.mcp.json',
  cursor:   '.cursor/mcp.json',
  windsurf: '.windsurf/mcp.json',
  copilot:  '.vscode/mcp.json',
  continue: '.continue/config.json',
  cline:    '.vscode/mcp.json',              // Cline respects VS Code project MCP config
  zed:      '.zed/settings.json',            // Zed project-level context_servers
};

export const CLAUDE_MD_MARKER_START = '<!-- cachly-brain-start -->';
export const CLAUDE_MD_MARKER_END   = '<!-- cachly-brain-end -->';

const DEFAULT_API_URL = 'https://api.cachly.dev';

// Build the env block written into an editor's MCP config. Self-hosting is
// first-class: if the operator runs setup/init against their own backend
// (CACHLY_API_URL set to a non-default URL), that URL is baked into the config so
// the editor-launched server talks to the self-hosted instance — not api.cachly.dev.
// For the default cloud backend we OMIT CACHLY_API_URL to keep configs clean (the
// binary already defaults to it).
export function buildServerEnv(apiKey: string, instanceId: string): Record<string, string> {
  const env: Record<string, string> = { CACHLY_JWT: apiKey, CACHLY_BRAIN_INSTANCE_ID: instanceId };
  if (API_URL && API_URL !== DEFAULT_API_URL) env.CACHLY_API_URL = API_URL;
  return env;
}

export function buildMcpConfig(apiKey: string, instanceId: string, editor: string): string {
  if (editor === 'continue') {
    return JSON.stringify({
      experimental: {
        modelContextProtocolServers: [{
          transport: { type: 'stdio', command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'] },
          env: buildServerEnv(apiKey, instanceId),
        }],
      },
    }, null, 2);
  }
  if (editor === 'zed') {
    return JSON.stringify({
      context_servers: {
        cachly: {
          command: {
            path: 'npx',
            args: ['-y', '@cachly-dev/mcp-server@latest'],
            env: buildServerEnv(apiKey, instanceId),
          },
          settings: {},
        },
      },
    }, null, 2);
  }
  return JSON.stringify({
    mcpServers: {
      cachly: {
        command: 'npx',
        args: ['-y', '@cachly-dev/mcp-server@latest'],
        env: buildServerEnv(apiKey, instanceId),
      },
    },
  }, null, 2);
}

// mergeMcpConfig reads an existing config file (if any), merges the cachly entry,
// and returns the updated JSON string — preserving all other MCP servers and settings.
export async function mergeMcpConfig(
  configPath: string,
  apiKey: string,
  instanceId: string,
  editor: string,
  fsOps: { readFile: (p: string, enc: BufferEncoding) => Promise<string>; existsSync: (p: string) => boolean },
): Promise<string> {
  const cachlyEntry = {
    command: 'npx',
    args: ['-y', '@cachly-dev/mcp-server@latest'],
    env: buildServerEnv(apiKey, instanceId),
  };

  if (!fsOps.existsSync(configPath)) return buildMcpConfig(apiKey, instanceId, editor);

  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fsOps.readFile(configPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    // Corrupt or unreadable JSON — back it up by appending .bak, then start fresh
    try {
      const { rename } = await import('node:fs/promises');
      await rename(configPath, configPath + '.bak');
      process.stderr.write(`⚠️  ${configPath} was not valid JSON — backed up to ${configPath}.bak\n`);
    } catch { /* backup failed — still safe to overwrite with valid config */ }
  }

  if (editor === 'continue') {
    // Merge into experimental.modelContextProtocolServers array — replace cachly entry if present
    const exp = (existing['experimental'] ?? {}) as Record<string, unknown>;
    const servers = (exp['modelContextProtocolServers'] ?? []) as Array<Record<string, unknown>>;
    const filtered = servers.filter((s) => {
      const env = (s['env'] ?? {}) as Record<string, string>;
      return !env['CACHLY_JWT'] && !env['CACHLY_BRAIN_INSTANCE_ID'];
    });
    filtered.push({ transport: { type: 'stdio', command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'] }, env: cachlyEntry.env });
    existing['experimental'] = { ...exp, modelContextProtocolServers: filtered };
    return JSON.stringify(existing, null, 2);
  }

  if (editor === 'zed') {
    // Merge only context_servers.cachly — preserve all other Zed settings
    const cs = (existing['context_servers'] ?? {}) as Record<string, unknown>;
    cs['cachly'] = { command: { path: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'], env: cachlyEntry.env }, settings: {} };
    existing['context_servers'] = cs;
    return JSON.stringify(existing, null, 2);
  }

  // Standard mcpServers format (Claude Code, Cursor, Windsurf, Copilot, Cline)
  const servers = (existing['mcpServers'] ?? {}) as Record<string, unknown>;
  servers['cachly'] = cachlyEntry;
  existing['mcpServers'] = servers;
  return JSON.stringify(existing, null, 2);
}

export function buildClaudeMdBlock(instanceId: string): string {
  return `${CLAUDE_MD_MARKER_START}
## Cachly AI Brain — Always Active

The Brain MCP server runs automatically. Instance: \`${instanceId}\`

---

### AT THE START of every new conversation (mandatory — first thing, before anything else):
\`\`\`
session_start(instance_id="${instanceId}", workspace_path="<absolute path to this project>", focus="<first topic the user mentioned>")
\`\`\`
Show the full briefing output to the user. If the response says the brain is empty or has 0 lessons, immediately seed it:
\`\`\`
brain_from_git(instance_id="${instanceId}", repo_path="<workspace_path>", limit=100)
\`\`\`
Then tell the user: "Your brain just learned from your git history. You're now pre-briefed."

### BEFORE every task (mandatory — no exceptions):
\`\`\`
smart_recall(instance_id="${instanceId}", query="<what you are about to do>")
\`\`\`
If relevant lessons are found, say: "Your brain knows this pattern — [lesson]." Then proceed.

### BEFORE editing any file (mandatory):
\`\`\`
remember_context(instance_id="${instanceId}", key="wip:<filename>", content="EDITING: <file:line> — <goal>", ttl=86400)
\`\`\`
When done: update content to \`"DONE: <file> — <summary>"\`.

### AFTER every fix, deploy, or discovery (mandatory):
\`\`\`
learn_from_attempts(instance_id="${instanceId}", topic="<category:keyword>", outcome="success"|"failure",
  what_worked="...", what_failed="...", severity="critical"|"major"|"minor",
  file_paths=["..."], commands=["..."], tags=["..."])
\`\`\`

### AT THE END of every conversation (mandatory):
\`\`\`
session_end(instance_id="${instanceId}", summary="<one sentence: what was done>", files_changed=["..."])
\`\`\`

### WHEN debugging any error (mandatory before grepping/reading files):
\`\`\`
causal_trace(instance_id="${instanceId}", problem="<exact error or symptom>")
\`\`\`
If a known fix exists in the Brain, use it directly. Skip research if Brain has the answer.

### BEFORE any risky operation (deploy, migration, dependency upgrade):
\`\`\`
brain_predict(instance_id="${instanceId}", context="<what you are about to do>")
\`\`\`
Report predicted failure risks to the user before proceeding.

### Half-finished code rule:
Never commit code that does not compile. Run \`tsc --noEmit\` / \`go build ./...\` before every commit.
${CLAUDE_MD_MARKER_END}`;
}


// Cursor loads rules from .cursor/rules/*.mdc with YAML frontmatter. alwaysApply
// makes the block active in every request (the closest Cursor gets to a
// SessionStart briefing). The frontmatter sits OUTSIDE the brain markers so
// idempotent marker-replacement leaves it intact.
const CURSOR_MDC_FRONTMATTER =
  '---\n' +
  'description: Cachly AI Brain — persistent memory protocol (recall before tasks, learn after fixes)\n' +
  'alwaysApply: true\n' +
  '---\n\n';

/**
 * Schreibt das Brain-Protokoll in alle relevanten Instruction-/Rules-Dateien:
 * - CLAUDE.md                        (Claude Code)
 * - AGENTS.md                        (Codex / generic agents)
 * - .github/copilot-instructions.md  (GitHub Copilot)
 * - .cursor/rules/cachly.mdc         (Cursor — frontmatter + alwaysApply)
 * - .windsurfrules                   (Windsurf / Cascade)
 * - .clinerules                      (Cline)
 * Idempotent, Marker-basiert. Cross-Harness Tier A (siehe make_cachly_great_again.md §6.7).
 */
export async function writeInstructions(projectDir: string, instanceId: string): Promise<Record<string, 'written'|'updated'|'appended'>> {
  const { writeFile, appendFile, readFile, mkdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');

  // `prefix` is written only when the file is created fresh (Cursor .mdc needs it);
  // on marker-update/append the prefix is left untouched.
  const files: Array<{ path: string; prefix?: string }> = [
    { path: resolve(projectDir, 'CLAUDE.md') },
    { path: resolve(projectDir, 'AGENTS.md') },
    { path: resolve(projectDir, '.github', 'copilot-instructions.md') },
    { path: resolve(projectDir, '.cursor', 'rules', 'cachly.mdc'), prefix: CURSOR_MDC_FRONTMATTER },
    { path: resolve(projectDir, '.windsurfrules') },
    { path: resolve(projectDir, '.clinerules') },
  ];
  const block = '\n' + buildClaudeMdBlock(instanceId) + '\n';
  const results: Record<string, 'written'|'updated'|'appended'> = {};

  for (const { path: file, prefix } of files) {
    await mkdir(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const existing = await readFile(file, 'utf-8');
      if (existing.includes(CLAUDE_MD_MARKER_START)) {
        // Idempotent update: replace existing block ([\s\S] must keep its
        // backslashes so it matches any char — a bare [\s\S] in the template
        // literal collapses to [sS] and the replace silently no-ops).
        const updated = existing.replace(
          new RegExp(`${CLAUDE_MD_MARKER_START}[\\s\\S]*?${CLAUDE_MD_MARKER_END}`),
          buildClaudeMdBlock(instanceId)
        );
        await writeFile(file, updated, 'utf-8');
        results[file] = 'updated';
        continue;
      }
      await appendFile(file, block, 'utf-8');
      results[file] = 'appended';
      continue;
    }
    await writeFile(file, (prefix ?? '') + block.trimStart(), 'utf-8');
    results[file] = 'written';
  }
  return results;
}



// ── CLI: cachly digest ────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest digest
// Weekly brain summary — what your AI learned this week. Shareable output.

if (process.argv[2] === 'digest') {
  const apiKey = process.env.CACHLY_JWT ?? '';
  const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';

  if (!apiKey || !instanceId) {
    console.log('\n⚠️  CACHLY_JWT and CACHLY_BRAIN_INSTANCE_ID must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest autopilot\n');
    process.exit(1);
  }

  process.stdout.write('\n🧠 Fetching your weekly Brain digest...\n\n');

  try {
    // Fetch current stats
    const statsRes = await fetch(`${API_URL}/api/v1/instances/${instanceId}/brain/stats`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!statsRes.ok) throw new Error(`stats HTTP ${statsRes.status}`);
    const stats = await statsRes.json() as {
      lesson_count?: number; context_count?: number; quality_score?: number;
      total_recall_count?: number; top_lessons?: Array<{ topic: string; recall_count: number; what_worked: string }>;
      team_authors?: string[];
    };

    const lessons      = stats.lesson_count ?? 0;
    const recalls      = stats.total_recall_count ?? 0;
    const score        = Math.round((stats.quality_score ?? 0) * 100);
    const topLessons   = (stats.top_lessons ?? []).slice(0, 5);
    const teamAuthors  = stats.team_authors ?? [];
    const tokensSaved  = recalls * 1200;
    const costSaved    = (tokensSaved * 0.000003).toFixed(2);

    const level = lessons < 10 ? 'Junior Dev 🔧' : lessons < 30 ? 'Mid Dev ⚡' :
      lessons < 60 ? 'Senior Dev 🧠' : lessons < 100 ? 'Staff Eng 🚀' : 'Principal Eng 🏆';

    const now = new Date();
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
    const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log(`│  \x1b[1m🧠 Brain Weekly Digest\x1b[0m  \x1b[90m${fmt(weekStart)} – ${fmt(now)}\x1b[0m                 │`);
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  Total lessons  : \x1b[33m${String(lessons).padEnd(8)}\x1b[0m  Brain level : \x1b[32m${level.padEnd(18)}\x1b[0m│`);
    console.log(`│  Total recalls  : \x1b[36m${String(recalls).padEnd(8)}\x1b[0m  Quality score: \x1b[32m${String(score).padEnd(3)}%\x1b[0m              │`);
    console.log(`│  Tokens saved   : \x1b[32m${String(Math.round(tokensSaved / 1000) + 'K').padEnd(8)}\x1b[0m  Cost saved   : \x1b[32m$${costSaved.padEnd(20)}\x1b[0m│`);

    if (teamAuthors.length > 0) {
      console.log('├─────────────────────────────────────────────────────────────┤');
      console.log(`│  \x1b[36m👥 Team contributors:\x1b[0m ${teamAuthors.slice(0, 5).join(', ').slice(0, 42).padEnd(42)} │`);
    }

    if (topLessons.length > 0) {
      console.log('├─────────────────────────────────────────────────────────────┤');
      console.log('│  \x1b[33m🔥 Most recalled lessons this week:\x1b[0m                         │');
      for (const l of topLessons) {
        const line = `${l.topic}: ${l.what_worked}`.slice(0, 57);
        console.log(`│  \x1b[90m• ${line.padEnd(58)}\x1b[0m│`);
      }
    }

    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    // ── Shareable tweet card ────────────────────────────────────────────────
    const topLesson = topLessons[0];
    const tweetLines = [
      `🧠 My AI Brain weekly digest (${fmt(weekStart)} – ${fmt(now)}):`,
      ``,
      `  📚 ${lessons} lessons learned`,
      `  🔁 ${recalls} recalls · ~${Math.round(tokensSaved / 1000)}K tokens saved`,
      `  🎯 Brain Level: ${level}`,
      topLesson ? `  🔥 Top lesson: "${topLesson.topic}: ${topLesson.what_worked.slice(0, 60)}${topLesson.what_worked.length > 60 ? '…' : ''}"` : '',
      ``,
      `Built with @cachly_dev — AI that actually remembers 🚀`,
      `cachly.dev`,
    ].filter(Boolean).join('\n');

    const tweetUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(tweetLines);

    console.log('\x1b[1m📣 Share your digest:\x1b[0m');
    console.log('');
    console.log('\x1b[90m' + '─'.repeat(63) + '\x1b[0m');
    for (const line of tweetLines.split('\n')) {
      console.log(`  ${line}`);
    }
    console.log('\x1b[90m' + '─'.repeat(63) + '\x1b[0m');
    console.log('');
    console.log('  \x1b[36m🐦 Tweet this:\x1b[0m');
    console.log(`  \x1b[4m${tweetUrl.slice(0, 90)}...\x1b[0m`);
    console.log('');
    console.log('  \x1b[2m💡 Invite your team: npx @cachly-dev/mcp-server@latest invite\x1b[0m');
    console.log('  \x1b[2m   Cron: 0 9 * * 1 npx @cachly-dev/mcp-server@latest digest\x1b[0m');
    console.log('');
  } catch (e) {
    console.log(`\n❌ Could not fetch digest: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly invite ────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest invite [email]
// Invites a teammate to share your Brain. Fastest referral loop.

if (process.argv[2] === 'invite') {
  // ── invite: fetch the user's unique referral link and show shareable messages ──
  const apiKey = process.env.CACHLY_JWT ?? '';

  if (!apiKey) {
    console.log('\n⚠️  CACHLY_JWT must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest autopilot\n');
    process.exit(1);
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/referral/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { code?: string; url?: string; referral_count?: number };
    const referralUrl = data.url ?? cachlyUrl(`/r/${data.code}`, 'invite');
    const count = data.referral_count ?? 0;

    const slackMsg = `Hey, I've been using cachly to give my AI persistent memory across sessions — no more re-explaining my stack every morning.\n\nYou get a free Brain: ${referralUrl}`;
    const tweetText = encodeURIComponent(`I gave my AI persistent memory. It remembers fixes, patterns, and context across every session — no more re-explaining.\n\nTry it free: ${referralUrl}\n\n@cachlydev`);

    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│  🧠 Your cachly Brain invite link                            │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  ${referralUrl.padEnd(61)}│`);
    console.log('├─────────────────────────────────────────────────────────────┤');
    if (count > 0) {
      console.log(`│  \x1b[32m✓  ${count} developer${count === 1 ? '' : 's'} joined via your link so far\x1b[0m`.padEnd(72) + '│');
      console.log('├─────────────────────────────────────────────────────────────┤');
    }
    console.log('│  \x1b[33mSlack / DM message:\x1b[0m                                         │');
    console.log('│                                                              │');
    for (const line of slackMsg.split('\n')) {
      console.log(`│  \x1b[90m${line.slice(0, 58).padEnd(58)}\x1b[0m  │`);
    }
    console.log('│                                                              │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  \x1b[36m𝕏 Tweet:\x1b[0m https://twitter.com/intent/tweet?text=${tweetText.slice(0, 10)}...  │`);
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('\x1b[2m  Each developer who signs up via your link earns you 1 month Pro.\x1b[0m');
    console.log('');
  } catch (e) {
    console.log(`\n❌ Could not fetch invite link: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly join <token> ──────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest join <token>
// Accepts a Brain invite link — writes the shared instance ID into all
// detected editor MCP configs and the global ~/.claude/mcp.json.
// No account needed if CACHLY_JWT is already set; otherwise prompts for auth.

if (process.argv[2] === 'join') {
  const { writeFile: wfJ, readFile: rfJ, mkdir: mkJ } = await import('node:fs/promises');
  const { existsSync: exJ } = await import('node:fs');
  const { resolve: resJ, dirname: dirJ } = await import('node:path');
  const { homedir } = await import('node:os');
  const { createInterface: ciJ } = await import('node:readline');

  const token = process.argv[3] ?? '';
  if (!token) {
    console.log('\n❌ Usage: npx @cachly-dev/mcp-server@latest join <token>\n');
    console.log('   Get a token from a teammate: npx @cachly-dev/mcp-server@latest invite\n');
    process.exit(1);
  }

  console.log('\n⏳ Looking up invite...');

  // ── Step 1: Fetch invite info (public, no auth) ───────────────────────────
  let inviteInfo: { instance_id: string; instance_name: string; tier: string; expires_at: string; label?: string };
  try {
    const res = await fetch(`${API_URL}/api/invite/${token}`, { signal: AbortSignal.timeout(8000) });
    if (res.status === 404) { console.log('\n❌ Invite not found — the link may be invalid.\n'); process.exit(1); }
    if (res.status === 410) { console.log('\n❌ This invite link has expired (7-day limit).\n'); process.exit(1); }
    if (!res.ok) { console.log(`\n❌ Could not fetch invite: HTTP ${res.status}\n`); process.exit(1); }
    inviteInfo = await res.json() as typeof inviteInfo;
  } catch (e) {
    console.log(`\n❌ Network error: ${(e as Error).message}\n`);
    process.exit(1);
  }

  const { instance_id, instance_name, tier, label } = inviteInfo;
  const expires = new Date(inviteInfo.expires_at).toLocaleDateString();

  console.log('');
  console.log('  \x1b[35m╔══════════════════════════════════════════════════════╗\x1b[0m');
  console.log('  \x1b[35m║\x1b[0m  \x1b[1m🧠 Brain Invite\x1b[0m                                  \x1b[35m║\x1b[0m');
  console.log('  \x1b[35m╚══════════════════════════════════════════════════════╝\x1b[0m');
  console.log('');
  console.log(`  Brain   : \x1b[1m${instance_name}\x1b[0m`);
  console.log(`  Tier    : ${tier}`);
  if (label) console.log(`  Note    : ${label}`);
  console.log(`  Expires : ${expires}`);
  console.log('');

  // ── Step 2: Confirm ───────────────────────────────────────────────────────
  const rlJ = ciJ({ input: process.stdin, output: process.stdout });
  const confirmJ = await new Promise<string>((resolve) => {
    rlJ.question('  Join this Brain? [Y/n] ', (a) => { rlJ.close(); resolve(a.trim().toLowerCase() || 'y'); });
  });
  if (confirmJ !== 'y' && confirmJ !== 'yes') {
    console.log('\n  Cancelled.\n');
    process.exit(0);
  }

  // ── Step 3: Ensure JWT ────────────────────────────────────────────────────
  let joinJwt = JWT;
  if (!joinJwt) {
    console.log('\n  No API key found — starting sign-in (10 seconds)...\n');
    try {
      const dcRes = await fetch(`${API_URL}/api/v1/auth/device/code`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'cachly-mcp-cli' }),
        signal: AbortSignal.timeout(10000),
      });
      if (dcRes.ok) {
        const dc = await dcRes.json() as { verification_uri: string; user_code: string; device_code: string; interval: number };
        console.log(`  👉 Open: \x1b[36m${dc.verification_uri}\x1b[0m`);
        console.log(`     Code: \x1b[1m${dc.user_code}\x1b[0m\n`);
        // Poll for token
        const pollInterval = (dc.interval ?? 5) * 1000;
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, pollInterval));
          try {
            const tokRes = await fetch(`${API_URL}/api/v1/auth/device/token`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ device_code: dc.device_code, client_id: 'cachly-mcp-cli' }),
              signal: AbortSignal.timeout(8000),
            });
            if (tokRes.ok) {
              const tok = await tokRes.json() as { access_token?: string };
              if (tok.access_token) { joinJwt = tok.access_token; break; }
            }
          } catch { /* polling — keep going */ }
        }
        if (!joinJwt) { console.log('\n❌ Sign-in timed out. Run the command again.\n'); process.exit(1); }
        console.log('  ✅ Signed in!\n');
      }
    } catch (e) {
      console.log(`\n  ⚠️  Could not start sign-in: ${(e as Error).message}`);
      console.log(`   Set CACHLY_JWT manually from ${cachlyUrl('/setup-ai', 'join')}\n`);
      process.exit(1);
    }
  }

  // ── Step 4: Write instance ID into all editor MCP configs ────────────────
  const cwd  = process.cwd();
  const home = homedir();

  const editorFiles: Array<{ label: string; path: string; global?: boolean }> = [
    { label: '.mcp.json (Claude Code project)',    path: resJ(cwd, '.mcp.json') },
    { label: '.cursor/mcp.json',                   path: resJ(cwd, '.cursor', 'mcp.json') },
    { label: '.windsurf/mcp.json',                 path: resJ(cwd, '.windsurf', 'mcp.json') },
    { label: '.vscode/mcp.json (Copilot/Cline)',   path: resJ(cwd, '.vscode', 'mcp.json') },
    { label: '~/.claude/mcp.json (global)',         path: resJ(home, '.claude', 'mcp.json'), global: true },
  ];

  let written = 0;
  for (const { label: eLabel, path: ePath, global: isGlobal } of editorFiles) {
    // Only write project configs if the directory exists (or global)
    const dir = dirJ(ePath);
    if (!isGlobal && !exJ(dir) && !exJ(ePath)) continue;
    try {
      await mkJ(dir, { recursive: true });
      let cfg: Record<string, unknown> = {};
      if (exJ(ePath)) {
        try {
          cfg = JSON.parse(await rfJ(ePath, 'utf-8')) as Record<string, unknown>;
        } catch {
          try { await (await import('node:fs/promises')).rename(ePath, ePath + '.bak'); } catch { /* backup failed */ }
        }
      }
      // Update or create the cachly entry with the shared instance ID
      const servers = (cfg['mcpServers'] ?? {}) as Record<string, unknown>;
      const existing = (servers['cachly'] ?? {}) as Record<string, unknown>;
      const env = (existing['env'] ?? {}) as Record<string, string>;
      env['CACHLY_BRAIN_INSTANCE_ID'] = instance_id;
      if (joinJwt && !env['CACHLY_JWT']) env['CACHLY_JWT'] = joinJwt;
      // Only persist a self-hosted backend URL; leave default-cloud configs clean.
      if (API_URL !== DEFAULT_API_URL) env['CACHLY_API_URL'] = API_URL;
      servers['cachly'] = { ...existing, command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'], env };
      cfg['mcpServers'] = servers;
      await wfJ(ePath, JSON.stringify(cfg, null, 2), 'utf-8');
      console.log(`  ✅ ${eLabel}`);
      written++;
    } catch (joinWriteErr) {
      // Only surface unexpected errors — missing editor dirs are expected and silently skipped above
      if ((joinWriteErr as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.log(`  ⚠️  ${eLabel}: ${(joinWriteErr as Error).message}`);
      }
    }
  }

  console.log('');
  if (written === 0) {
    console.log('  ⚠️  No editor configs found — run `cachly setup` first.\n');
  } else {
    console.log(`  🧠 You're now sharing Brain: \x1b[1m${instance_name}\x1b[0m`);
    console.log('     Restart your editor — your AI arrives pre-briefed from the team Brain.\n');
    console.log('  📛 Add the badge to your README:');
    console.log(`     npx @cachly-dev/mcp-server@latest badge\n`);
  }
  process.exit(0);
}

// ── CLI: cachly upgrade ───────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest upgrade
// Checks npm for the latest version and prints upgrade instructions if outdated.

if (process.argv[2] === 'upgrade') {
  process.stdout.write('\n⏳ Checking for updates...\n');
  try {
    const res = await fetch('https://registry.npmjs.org/@cachly-dev/mcp-server/latest', {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const pkg = await res.json() as { version?: string };
    const latest = pkg.version;
    if (!latest || !/^\d+\.\d+\.\d+/.test(latest)) throw new Error('npm registry returned unexpected response');

    if (latest === CURRENT_VERSION) {
      console.log(`\n✅ Already on the latest version: \x1b[32mv${CURRENT_VERSION}\x1b[0m\n`);
    } else {
      console.log('');
      console.log('\x1b[35m  ╔══════════════════════════════════════════════════════╗\x1b[0m');
      console.log('\x1b[35m  ║\x1b[0m  \x1b[1m🧠 cachly update available\x1b[0m                       \x1b[35m║\x1b[0m');
      console.log('\x1b[35m  ╚══════════════════════════════════════════════════════╝\x1b[0m');
      console.log('');
      console.log(`  Current : \x1b[31mv${CURRENT_VERSION}\x1b[0m`);
      console.log(`  Latest  : \x1b[32mv${latest}\x1b[0m`);
      console.log('');
      console.log('  Update your editor configs to pick up the new version:');
      console.log('');
      console.log('  \x1b[32m  npx @cachly-dev/mcp-server@latest autopilot\x1b[0m');
      console.log('');
      console.log('  \x1b[2m(npx always fetches the latest when @latest is specified)\x1b[0m');
      console.log('');
    }
  } catch (e) {
    console.log(`\n❌ Could not check for updates: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly bench ─────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest bench [--json] [corpus.json]
// Runs the three-ranker recall quality benchmark (cachly vs BM25 vs flat-file)
// on the bundled external corpus. No auth required. One shareable headline.
if (process.argv[2] === 'bench') {
  const { fileURLToPath } = await import('node:url');
  const { dirname: _bd, resolve: _br } = await import('node:path');
  const { loadExternalCorpus, runExternalBenchmark } = await import('./bench/external-corpus.js');
  const asJson = process.argv.includes('--json');
  const customPath = process.argv.slice(3).find(a => !a.startsWith('--'));
  const here = _bd(fileURLToPath(import.meta.url));
  const corpusPath = customPath
    ? _br(process.cwd(), customPath)
    : _br(here, 'bench', 'external', 'sample-corpus.json');

  try {
    const corpus = await loadExternalCorpus(corpusPath);
    const r = await runExternalBenchmark(corpus);

    if (asJson) {
      console.log(JSON.stringify({
        corpus: corpus.name,
        lessons: r.corpusSize,
        queries: r.queryCount,
        cachly_p1:    Math.round(r.cachly.precisionAt1  * 1000) / 10,
        flatfile_p1:  Math.round(r.flatfile.precisionAt1 * 1000) / 10,
        cachly_mrr:   Math.round(r.cachly.mrr  * 1000) / 10,
        flatfile_mrr: Math.round(r.flatfile.mrr * 1000) / 10,
        p1_lift_vs_flatfile_pct: Math.round((r.cachly.precisionAt1 - r.flatfile.precisionAt1) * 1000) / 10,
        mrr_lift_vs_flatfile_pct: Math.round((r.cachly.mrr - r.flatfile.mrr) * 1000) / 10,
      }, null, 2));
      process.exit(0);
    }

    const p1Lift   = ((r.cachly.precisionAt1 - r.flatfile.precisionAt1) * 100).toFixed(1);
    const mrrLift  = ((r.cachly.mrr          - r.flatfile.mrr)          * 100).toFixed(1);
    const p1Bm25   = ((r.cachly.precisionAt1 - r.baseline.precisionAt1) * 100).toFixed(1);
    const p1Sign   = r.cachly.precisionAt1 >= r.flatfile.precisionAt1 ? '\x1b[32m+' : '\x1b[31m';
    const mrrSign  = r.cachly.mrr          >= r.flatfile.mrr          ? '\x1b[32m+' : '\x1b[31m';

    console.log('');
    console.log('\x1b[35m  ╔══════════════════════════════════════════════════════════════╗\x1b[0m');
    console.log('\x1b[35m  ║\x1b[0m  \x1b[1m🧠 cachly recall quality benchmark\x1b[0m                       \x1b[35m║\x1b[0m');
    console.log('\x1b[35m  ╚══════════════════════════════════════════════════════════════╝\x1b[0m');
    console.log('');
    console.log(`  Corpus : ${corpus.name ?? corpusPath}`);
    console.log(`  Dataset: ${r.corpusSize} lessons · ${r.queryCount} queries · 10 engineering domains`);
    console.log(`           (k8s, DB, auth, CI, frontend, API, payments, observability, Node.js, infra)`);
    console.log('');
    console.log('  \x1b[1mPrecision@1\x1b[0m (finds the right lesson at rank #1):');
    console.log(`    flat-file memory : \x1b[33m${(r.flatfile.precisionAt1 * 100).toFixed(1)}%\x1b[0m  (naive keyword overlap — no quality signal)`);
    console.log(`    raw BM25         : \x1b[33m${(r.baseline.precisionAt1 * 100).toFixed(1)}%\x1b[0m  (keyword ranking)`);
    console.log(`    cachly           : \x1b[1m\x1b[32m${(r.cachly.precisionAt1 * 100).toFixed(1)}%\x1b[0m  (BM25 + quality reranking)`);
    console.log('');
    console.log('  \x1b[1mMean Reciprocal Rank\x1b[0m (average rank of the right answer):');
    console.log(`    flat-file memory : \x1b[33m${(r.flatfile.mrr * 100).toFixed(1)}%\x1b[0m`);
    console.log(`    raw BM25         : \x1b[33m${(r.baseline.mrr * 100).toFixed(1)}%\x1b[0m`);
    console.log(`    cachly           : \x1b[1m\x1b[32m${(r.cachly.mrr * 100).toFixed(1)}%\x1b[0m`);
    console.log('');
    console.log('  \x1b[1mLift vs flat-file memory\x1b[0m (what you get by switching from plain memory files):');
    console.log(`    Precision@1 : ${p1Sign}${p1Lift}%\x1b[0m`);
    console.log(`    MRR         : ${mrrSign}${mrrLift}%\x1b[0m`);
    console.log(`    vs BM25     : \x1b[32m+${p1Bm25}%\x1b[0m Precision@1 (quality reranking on top of keyword search)`);
    console.log('');
    console.log('  \x1b[2mFlat-file = lexical overlap over raw text files (how Anthropic/Claude Memory works).\x1b[0m');
    console.log('  \x1b[2mAdversarial distractors included — failure lessons that share the exact query vocabulary.\x1b[0m');
    console.log('  \x1b[2mcachly ignores them because they have low confidence / failed outcome.\x1b[0m');
    console.log('');
    console.log('  Share your results:');
    console.log(`  \x1b[36m"My Brain: Precision@1 ${(r.cachly.precisionAt1 * 100).toFixed(1)}% (${p1Sign}${p1Lift}% vs flat-file memory, ${r.queryCount} queries)"\x1b[0m`);
    console.log('');
    console.log('  Run on a custom corpus:');
    console.log('  \x1b[2m  npx @cachly-dev/mcp-server@latest bench my-incidents.json\x1b[0m');
    console.log('  \x1b[2m  npx @cachly-dev/mcp-server@latest bench --json   # machine-readable\x1b[0m');
    console.log('');
    console.log('  \x1b[1m→ Give your AI this recall quality on your own work (free, 1–5 min):\x1b[0m');
    console.log('  \x1b[32m$ npx @cachly-dev/mcp-server@latest autopilot\x1b[0m');
    console.log('  \x1b[90m  Signs in, configures every editor, bootstraps from your git history.\x1b[0m');
    console.log(`  \x1b[90m  Or create your Brain at: \x1b[36m${cachlyUrl('/setup-ai', 'bench')}\x1b[0m`);
    console.log('');
  } catch (e) {
    console.error(`\n❌ bench failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly demo ──────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest demo
// Zero-signup. Reads local git history and shows what the AI Brain would know.
// The fastest path from "what is this?" to "I need this".

if (process.argv[2] === 'demo') {
  const { execSync } = await import('node:child_process');
  const { existsSync, readFileSync } = await import('node:fs');
  const { resolve, basename } = await import('node:path');
  const cwd = process.cwd();

  console.log('\n\x1b[35m🧠 cachly Brain — Live Demo\x1b[0m');
  console.log('\x1b[90mNo account needed. Reading your git history...\x1b[0m\n');

  // Verify git repo
  if (!existsSync(resolve(cwd, '.git'))) {
    console.log('⚠️  No git repository found here.');
    console.log('   Run this command inside a project directory with git history.\n');
    console.log('   Example: cd ~/my-project && npx @cachly-dev/mcp-server@latest demo\n');
    process.exit(0);
  }

  // Get developer name from git config
  let devName = '';
  try {
    devName = execSync('git config user.name', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim().split(' ')[0] ?? '';
  } catch { /* ignore */ }

  // Get project name from package.json or directory name
  let projectName = basename(cwd);
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf-8')) as { name?: string };
    if (pkg.name) projectName = pkg.name.replace(/^@[^/]+\//, '');
  } catch { /* ignore */ }

  // Read git log
  let logOutput = '';
  try {
    logOutput = execSync(
      'git log HEAD --pretty=format:"%H|||%s|||%ad|||%an" --date=short --no-merges -n 200',
      { cwd, encoding: 'utf-8', stdio: 'pipe' }
    );
  } catch {
    console.log('⚠️  Could not read git log. Make sure you have commits.\n');
    process.exit(0);
  }

  const commits = logOutput.trim().split('\n').filter(Boolean).map(line => {
    const [sha, subject, date, author] = line.split('|||');
    return { sha: (sha ?? '').trim().slice(0, 8), subject: (subject ?? '').trim(), date: (date ?? '').trim(), author: (author ?? '').trim() };
  });

  if (commits.length === 0) {
    console.log('⚠️  No commits found.\n');
    process.exit(0);
  }

  // Classify commits (same logic as brain_from_git)
  const classify = (s: string) => {
    const t = s.toLowerCase();
    if (/\b(fix|fixed|bug|hotfix|patch|revert|resolve)\b/.test(t)) return 'fix';
    if (/\b(feat|feature|add|implement|new|introduce)\b/.test(t)) return 'feat';
    if (/\b(perf|optim|speed|cache|latency)\b/.test(t)) return 'perf';
    if (/\b(security|cve|auth|csrf|xss|inject|sanitize)\b/.test(t)) return 'security';
    if (/\b(deploy|ci|cd|docker|k8s|infra)\b/.test(t)) return 'deploy';
    if (/\b(refactor|clean|simplify|extract)\b/.test(t)) return 'refactor';
    return 'chore';
  };

  // Count categories
  const cats = new Map<string, number>();
  const fixes: string[] = [];
  const feats: string[] = [];
  const security: string[] = [];
  const authors = new Set<string>();

  for (const c of commits) {
    const cat = classify(c.subject);
    cats.set(cat, (cats.get(cat) ?? 0) + 1);
    if (cat === 'fix' && fixes.length < 5) fixes.push(c.subject.slice(0, 72));
    if (cat === 'feat' && feats.length < 5) feats.push(c.subject.slice(0, 72));
    if (cat === 'security' && security.length < 3) security.push(c.subject.slice(0, 72));
    if (c.author) authors.add(c.author.split(' ')[0]!);
  }

  const totalLessons = commits.length - (cats.get('chore') ?? 0);
  const dateRange = `${commits[commits.length - 1]?.date ?? '?'} → ${commits[0]?.date ?? '?'}`;

  // Estimate time wasted re-explaining (45 min/day * workdays since first commit)
  const firstDate = commits[commits.length - 1]?.date;
  let daysActive = 0;
  if (firstDate) {
    const ms = Date.now() - new Date(firstDate).getTime();
    daysActive = Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24) * 5 / 7)); // workdays
  }
  const hoursWasted = Math.round(daysActive * 0.75); // 45 min/day

  // Brain Level based on total lessons (matches Go ComputeBrainLevel thresholds)
  const brainLevelName = totalLessons >= 501 ? 'Oracle' : totalLessons >= 201 ? 'Architect' : totalLessons >= 51 ? 'Expert' : totalLessons >= 11 ? 'Explorer' : 'Apprentice';

  // Personalized header
  const greeting = devName ? `Hey ${devName} — ` : '';
  const headerTitle = `${greeting}here's what your AI would know about ${projectName}`;

  // Display the demo
  process.stdout.write('\x1b[2K\r');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log(`│  \x1b[1m🧠 ${headerTitle.slice(0, 58).padEnd(58)}\x1b[0m│`);
  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log(`│  Commits analysed : \x1b[33m${String(commits.length).padEnd(6)}\x1b[0m  Date range: \x1b[90m${dateRange.slice(0, 23).padEnd(23)}\x1b[0m  │`);
  console.log(`│  Lessons extracted: \x1b[32m${String(totalLessons).padEnd(6)}\x1b[0m  Contributors: \x1b[36m${String(authors.size).padEnd(20)}\x1b[0m│`);
  console.log(`│  Brain Level      : \x1b[35m${brainLevelName.padEnd(14)}\x1b[0m  Time wasted re-explaining: \x1b[31m${String(hoursWasted + 'h').padEnd(5)}\x1b[0m│`);
  console.log('├─────────────────────────────────────────────────────────────┤');

  // Category breakdown
  const sorted = [...cats.entries()].filter(([k]) => k !== 'chore').sort((a, b) => b[1] - a[1]);
  const bar = (n: number, max: number) => '█'.repeat(Math.round((n / max) * 20)).padEnd(20);
  const maxVal = Math.max(...sorted.map(([, v]) => v), 1);
  console.log('│  \x1b[90mCategory breakdown:\x1b[0m                                         │');
  for (const [cat, count] of sorted) {
    const emoji = { fix: '🔧', feat: '✨', perf: '⚡', security: '🔒', deploy: '🚀', refactor: '🔄' }[cat] ?? '•';
    console.log(`│  ${emoji} \x1b[36m${cat.padEnd(10)}\x1b[0m \x1b[35m${bar(count, maxVal)}\x1b[0m \x1b[33m${String(count).padStart(3)}\x1b[0m  │`);
  }

  if (security.length > 0) {
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log('│  \x1b[31m🔒 Security fixes your AI would know:\x1b[0m                       │');
    for (const s of security) console.log(`│  \x1b[90m• ${s.slice(0, 58).padEnd(58)}\x1b[0m │`);
  }

  if (fixes.length > 0) {
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log('│  \x1b[33m🔧 Bug fixes your AI would never repeat:\x1b[0m                    │');
    for (const f of fixes.slice(0, 4)) console.log(`│  \x1b[90m• ${f.slice(0, 58).padEnd(58)}\x1b[0m │`);
  }

  if (feats.length > 0) {
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log('│  \x1b[32m✨ Features & decisions it would recall:\x1b[0m                    │');
    for (const f of feats.slice(0, 3)) console.log(`│  \x1b[90m• ${f.slice(0, 58).padEnd(58)}\x1b[0m │`);
  }

  console.log('├─────────────────────────────────────────────────────────────┤');
  console.log('│  \x1b[32m💡 With cachly, your AI arrives pre-briefed every session.\x1b[0m  │');
  console.log('│  \x1b[32m   No more re-explaining. No more repeated mistakes.\x1b[0m         │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  // Generate shareable preview URL with encoded stats
  const previewParams = new URLSearchParams({
    repo: projectName,
    commits: String(commits.length),
    lessons: String(totalLessons),
    level: brainLevelName,
    authors: String(authors.size),
    hours: String(hoursWasted),
  });
  const previewURL = cachlyUrl(`/preview?${previewParams.toString()}`, 'demo');

  console.log('  \x1b[1mMake this permanent (free, 1–5 minutes):\x1b[0m');
  console.log('  \x1b[32m$ npx @cachly-dev/mcp-server@latest autopilot\x1b[0m');
  console.log('');
  console.log(`  \x1b[90m🔗 Shareable preview:\x1b[0m \x1b[36m${previewURL}\x1b[0m`);
  console.log('');
  console.log('  Works with: Claude Code · Cursor · Windsurf · Copilot · Cline · Zed');
  console.log('  Free forever · GDPR · German servers · No credit card');
  console.log('');
  process.exit(0);
}

// ── CLI: cachly share ─────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest share
// Generates a shareable ASCII card + tweet text with your Brain stats.

if (process.argv[2] === 'share') {
  const apiKey = process.env.CACHLY_JWT ?? '';
  const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';

  if (!apiKey || !instanceId) {
    console.log('\n⚠️  CACHLY_JWT and CACHLY_BRAIN_INSTANCE_ID must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest autopilot  (takes 1–5 minutes)\n');
    process.exit(1);
  }

  process.stdout.write('\n🧠 Fetching your Brain stats...\n');

  try {
    const statsRes = await fetch(`${API_URL}/api/v1/instances/${instanceId}/brain/stats`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!statsRes.ok) throw new Error(`HTTP ${statsRes.status}`);
    const stats = await statsRes.json() as {
      lesson_count?: number; context_count?: number;
      quality_score?: number; total_recall_count?: number;
    };

    const lessons  = stats.lesson_count ?? 0;
    const recalls  = stats.total_recall_count ?? 0;
    const score    = Math.round((stats.quality_score ?? 0) * 100);
    const tokensSaved = recalls * 1200;
    const costSaved = (tokensSaved * 0.000003).toFixed(2);

    const level = lessons === 0 ? 'Intern 🌱' :
      lessons < 10  ? 'Junior Dev 🔧' :
      lessons < 30  ? 'Mid Dev ⚡' :
      lessons < 60  ? 'Senior Dev 🧠' :
      lessons < 100 ? 'Staff Eng 🚀' : 'Principal Eng 🏆';

    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│  🧠 My AI Brain  ·  powered by \x1b[35mcachly.dev\x1b[0m                   │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  Lessons stored : \x1b[33m${String(lessons).padEnd(8)}\x1b[0m  Brain level: \x1b[32m${level.padEnd(18)}\x1b[0m│`);
    console.log(`│  Total recalls  : \x1b[36m${String(recalls).padEnd(8)}\x1b[0m  Quality score: \x1b[32m${String(score).padEnd(3)}%\x1b[0m              │`);
    console.log(`│  Tokens saved   : \x1b[32m${String((tokensSaved / 1000).toFixed(0) + 'K').padEnd(8)}\x1b[0m  Cost saved: \x1b[32m$${costSaved.padEnd(20)}\x1b[0m│`);
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log('│  Works with: Claude Code · Cursor · Windsurf · Copilot      │');
    console.log('│  Free · GDPR · German servers                                │');
    console.log('│  \x1b[35mnpx @cachly-dev/mcp-server@latest autopilot\x1b[0m                 │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    // Tweet text
    const shareUrl = cachlyUrl('/', 'share');
    const tweet = `🧠 My AI coding assistant now has persistent memory.\n\n${lessons} lessons stored · ${recalls} recalls · ${level}\n\nFix a bug once → AI remembers forever. Across Claude Code, Cursor, Windsurf, Copilot.\n\n${shareUrl}\n\n#AIMemory #ClaudeCode #Cursor #DeveloperTools`;

    console.log('  \x1b[1m📋 Share on Twitter/X (copy this):\x1b[0m');
    console.log('  ─────────────────────────────────────');
    console.log(tweet.split('\n').map(l => `  ${l}`).join('\n'));
    console.log('  ─────────────────────────────────────');
    console.log('');
    console.log('  \x1b[2mPro tip: add a screenshot of your Brain panel for 3x more engagement\x1b[0m');
    console.log('  \x1b[2mAlso add a live badge to your README:\x1b[0m');
    console.log(`  \x1b[90m  npx @cachly-dev/mcp-server@latest badge\x1b[0m`);
    console.log('');
  } catch (e) {
    console.log(`\n❌ Could not fetch stats: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly publish ───────────────────────────────────────────────────────
// Creates a publicly importable Brain snapshot and prints the share URL + card.
// Usage: npx @cachly-dev/mcp-server@latest publish [--public] [--title "My Patterns"]

if (process.argv[2] === 'publish') {
  const apiKey    = process.env.CACHLY_JWT ?? '';
  const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';

  if (!apiKey || !instanceId) {
    console.log('\n⚠️  CACHLY_JWT and CACHLY_BRAIN_INSTANCE_ID must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest autopilot\n');
    process.exit(1);
  }

  const titleIdx = process.argv.indexOf('--title');
  const publishTitle = titleIdx !== -1 ? (process.argv[titleIdx + 1] ?? 'My Brain Snapshot') : 'My Brain Snapshot';
  const isPublic = process.argv.includes('--public');

  process.stdout.write('\n🧠 Publishing Brain snapshot...\n');

  try {
    // Fetch stats for the card
    const statsRes = await fetch(`${API_URL}/api/v1/instances/${instanceId}/brain/stats`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });

    let lessons = 0, recalls = 0;
    if (statsRes.ok) {
      const stats = await statsRes.json() as { lesson_count?: number; total_recall_count?: number };
      lessons = stats.lesson_count ?? 0;
      recalls = stats.total_recall_count ?? 0;
    }

    // Create the public share via API
    const shareRes = await fetch(`${API_URL}/api/v1/brains/share`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: publishTitle, visibility: isPublic ? 'public' : 'unlisted', instance_id: instanceId }),
      signal: AbortSignal.timeout(15000),
    });

    if (!shareRes.ok) throw new Error(`HTTP ${shareRes.status}`);
    const share = await shareRes.json() as { share_id?: string };
    const shareId = share.share_id ?? 'unavailable';
    const shareUrl = cachlyUrl(`/brain/share/${shareId}`, 'publish');

    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│  📤 Brain Published  ·  powered by \x1b[35mcachly.dev\x1b[0m                │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  Title     : \x1b[33m${publishTitle.slice(0, 44).padEnd(44)}\x1b[0m│`);
    console.log(`│  Lessons   : \x1b[32m${String(lessons).padEnd(10)}\x1b[0m  Recalls: \x1b[36m${String(recalls).padEnd(26)}\x1b[0m│`);
    console.log(`│  Visibility: \x1b[${isPublic ? '32' : '33'}m${(isPublic ? 'public (discoverable)' : 'unlisted (link only)').padEnd(44)}\x1b[0m│`);
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  \x1b[1mShare URL:\x1b[0m \x1b[36m${shareUrl.padEnd(51)}\x1b[0m│`);
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log('│  \x1b[2mAnyone can import with:\x1b[0m                                     │');
    console.log(`│  \x1b[90m  brain_import(instance_id="...", share_id="${shareId.slice(0, 17)}")\x1b[0m│`);
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');
    console.log(`  \x1b[1m📋 Share this with your team:\x1b[0m`);
    console.log(`  ${shareUrl}`);
    console.log('');
    console.log(`  \x1b[2mTo list all your shares:\x1b[0m  brain_share_list(instance_id="${instanceId.slice(0, 24)}...")`);
    console.log(`  \x1b[2mTo revoke this share:\x1b[0m     brain_unshare(share_id="${shareId.slice(0, 24)}...")`);
    console.log('');
  } catch (e) {
    console.log(`\n❌ Could not publish Brain: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly tool-specs / openapi ───────────────────────────────────────────
// Emit the 120-tool surface in any agent framework's dialect, derived from the
// single TOOLS source of truth. Lets OpenAI Assistants, the Anthropic Messages
// API, LangChain, CrewAI and AutoGen wrap cachly without hand-written glue.
//   npx @cachly-dev/mcp-server tool-specs --format=openai   > cachly.openai.json
//   npx @cachly-dev/mcp-server openapi                      > cachly.openapi.json
if (process.argv[2] === 'tool-specs' || process.argv[2] === 'openapi') {
  const { renderToolSpecs } = await import('./toolspecs.js');
  // Accept both "--format openai" and "--format=openai".
  let format = 'openapi';
  if (process.argv[2] !== 'openapi') {
    const eqArg = process.argv.find(a => a.startsWith('--format='));
    if (eqArg) {
      format = eqArg.slice('--format='.length);
    } else {
      const fmtFlag = process.argv.indexOf('--format');
      if (fmtFlag !== -1) format = process.argv[fmtFlag + 1] ?? 'openapi';
    }
  }
  const valid = ['openapi', 'openai', 'anthropic', 'langchain'];
  if (!valid.includes(format)) {
    process.stderr.write(`\n❌ Unknown format "${format}". Use one of: ${valid.join(', ')}\n\n`);
    process.exit(1);
  }
  // Exit only after stdout has fully flushed — on a pipe, write() is async and an
  // immediate process.exit() truncates large payloads (~64KB) mid-flush.
  process.stdout.write(
    renderToolSpecs(TOOLS as unknown as Parameters<typeof renderToolSpecs>[0], format as 'openapi' | 'openai' | 'anthropic' | 'langchain', CURRENT_VERSION) + '\n',
    () => process.exit(0),
  );
}

// ── CLI: cachly badge ─────────────────────────────────────────────────────────
// Outputs the Markdown + HTML snippet for embedding a live Brain lesson-count
// badge in any README or website. Badge SVG served by cachly API (public, no auth).

if (process.argv[2] === 'badge') {
  const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';

  if (!instanceId) {
    console.log('\n⚠️  CACHLY_BRAIN_INSTANCE_ID must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest autopilot  (takes 1–5 minutes)\n');
    process.exit(1);
  }

  const badgeUrl   = `${API_URL}/api/v1/badge/${instanceId}`;
  const targetUrl  = cachlyUrl('/', 'badge');
  const markdown   = `[![cachly Brain](${badgeUrl})](${targetUrl})`;
  const htmlBadge  = `<a href="${targetUrl}"><img src="${badgeUrl}" alt="cachly Brain" /></a>`;

  console.log('');
  console.log('\x1b[35m  ╔═══════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[35m  ║\x1b[0m  \x1b[1m🧠 cachly Brain Badge\x1b[0m                              \x1b[35m║\x1b[0m');
  console.log('\x1b[35m  ╚═══════════════════════════════════════════════════════╝\x1b[0m');
  console.log('');
  console.log('  Paste into your README.md:');
  console.log('');
  console.log(`  \x1b[32m${markdown}\x1b[0m`);
  console.log('');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  Or paste into HTML:');
  console.log('');
  console.log(`  \x1b[36m${htmlBadge}\x1b[0m`);
  console.log('');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  Badge URL (live, updates every hour):');
  console.log(`  \x1b[90m${badgeUrl}\x1b[0m`);
  console.log('');
  console.log('  \x1b[2mThe badge shows your current lesson count — no auth required,');
  console.log('  safe to embed in public repos. Updates hourly.\x1b[0m');
  console.log('');
  process.exit(0);
}

// ── CLI: no-args splash screen ────────────────────────────────────────────────
// When run with no recognized subcommand, show a compelling pitch + help.

if (!process.argv[2] && process.stdout.isTTY) {
  console.log('');
  console.log('\x1b[35m  ╔═══════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[35m  ║\x1b[0m  \x1b[1m🧠 cachly — Persistent AI Memory for Developers\x1b[0m   \x1b[35m║\x1b[0m');
  console.log('\x1b[35m  ╚═══════════════════════════════════════════════════════╝\x1b[0m');
  console.log('');
  console.log('  Stop re-teaching your AI every morning.');
  console.log('  cachly gives it a permanent brain — pre-briefed every session.');
  console.log('');
  console.log('  \x1b[1mCommands:\x1b[0m');
  console.log('  \x1b[1m\x1b[32m  npx @cachly-dev/mcp-server@latest autopilot\x1b[0m ← \x1b[1mOne command, fully ready\x1b[0m');
  console.log('  \x1b[32m  npx @cachly-dev/mcp-server@latest demo\x1b[0m     ← Try it first (no account)');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest setup\x1b[0m    ← Interactive setup (pick editors)');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest health\x1b[0m   ← Check everything works');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest doctor\x1b[0m   ← Diagnose a broken or missing install');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest digest\x1b[0m   ← Weekly Brain summary');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest share\x1b[0m    ← Share your Brain stats');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest badge\x1b[0m    ← README badge for your Brain');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest invite\x1b[0m   ← Invite a teammate');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest join <token>\x1b[0m ← Accept a Brain invite');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest bench\x1b[0m     ← Recall quality vs flat-file memory');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest upgrade\x1b[0m  ← Check for updates');
  console.log('');
  console.log('  \x1b[90mWorks with: Claude Code · Cursor · Windsurf · GitHub Copilot · Cline · Zed\x1b[0m');
  console.log('  \x1b[90mFree forever · GDPR · German servers · 122 MCP tools\x1b[0m');
  console.log('');
  process.exit(0);
}

// ── CLI: cachly init ──────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server init --instance-id <id> --api-key <key> [--editor claude|cursor|windsurf|copilot|continue] [--project-dir /path]

if (process.argv[2] === 'init') {
  const initStart = Date.now();
  const { writeFile, mkdir, readFile } = await import('node:fs/promises');
  const { resolve, dirname } = await import('node:path');

  const argv = process.argv.slice(3);
  const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined; };

  let instanceId = flag('instance-id') ?? process.env.CACHLY_BRAIN_INSTANCE_ID;
  let apiKey     = flag('api-key')     ?? process.env.CACHLY_JWT;
  const editor     = (flag('editor') ?? 'claude').toLowerCase();
  const projectDir = resolve(flag('project-dir') ?? '.');
  // Self-hosting: --api-url overrides the backend baked into the written config.
  const apiUrlFlag = flag('api-url');
  if (apiUrlFlag) { API_URL = apiUrlFlag.replace(/\/+$/, ''); }

  // Zero-arg path: fall back to credentials saved by a previous `setup`
  // (~/.claude/mcp.json). Makes `init` a fast, idempotent re-configuration command
  // you can run in any project without copy-pasting tokens.
  if (!instanceId || !apiKey) {
    try {
      const { existsSync } = await import('node:fs');
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
      const savedPath = home ? resolve(home, '.claude', 'mcp.json') : '';
      if (savedPath && existsSync(savedPath)) {
        const saved = JSON.parse(await readFile(savedPath, 'utf-8')) as {
          mcpServers?: Record<string, { env?: Record<string, string> }>;
        };
        const env = saved.mcpServers?.['cachly']?.env ?? {};
        apiKey ??= env['CACHLY_JWT'];
        instanceId ??= env['CACHLY_BRAIN_INSTANCE_ID'];
        if (apiKey && instanceId) {
          console.log('✓  Reusing credentials from ~/.claude/mcp.json (saved by a prior setup)');
        }
      }
    } catch { /* fall through to the usage error below */ }
  }

  if (!instanceId || !apiKey) {
    console.error('\nUsage: npx @cachly-dev/mcp-server@latest init --instance-id <uuid> --api-key <cky_live_...> [--editor claude|cursor|windsurf|copilot|continue] [--project-dir /path] [--api-url https://your-self-hosted-backend]\n');
    console.error('First time? Run the zero-config wizard (signs you in, auto-provisions): npx @cachly-dev/mcp-server@latest autopilot\n');
    console.error(`Get your credentials from: ${cachlyUrl('/setup-ai', 'init')}\n`);
    process.exit(1);
  }

  const configFile = EDITOR_FILES[editor] ?? '.mcp.json';
  const configPath = resolve(projectDir, configFile);
  await mkdir(dirname(configPath), { recursive: true });
  const { existsSync: exInit } = await import('node:fs');
  const configExisted = exInit(configPath);
  const prevConfig = configExisted ? await readFile(configPath, 'utf-8').catch(() => '') : '';
  const merged = await mergeMcpConfig(configPath, apiKey, instanceId, editor, { readFile, existsSync: exInit });
  // Idempotent: only write when the content actually changes.
  if (merged !== prevConfig) {
    await writeFile(configPath, merged, 'utf-8');
    console.log(`\n✅ ${configExisted ? 'Updated' : 'Written'}: ${configFile}`);
  } else {
    console.log(`\n✓  Already configured: ${configFile} (no change)`);
  }

  // Always write the brain protocol to all instruction files (idempotent —
  // safe to run multiple times). Covers CLAUDE.md, AGENTS.md and Copilot so any
  // agent the user runs arrives pre-briefed.
  const results = await writeInstructions(projectDir, instanceId);
  for (const [path, action] of Object.entries(results)) {
    const verb = action === 'updated' ? '✅ Updated' : action === 'appended' ? '✅ Appended to' : '✅ Written';
    const name = path.split(/[\\/]/).pop() ?? path;
    console.log(`${verb}: ${name}`);
  }

  // ── CLS Phase 4: Auto-install git post-commit hook ─────────────────────────
  try {
    const r = await installClsPostCommitHook(projectDir, instanceId, JWT || undefined);
    if (r === 'written')        console.log(`✅ Written: .git/hooks/post-commit (CLS hook)`);
    else if (r === 'upgraded')  console.log(`✅ Upgraded: .git/hooks/post-commit (CLS hook → ${CLS_HOOK_VERSION})`);
    else if (r === 'appended')  console.log(`✅ Appended: .git/hooks/post-commit (CLS hook)`);
    else if (r === 'unchanged') console.log(`✓  CLS hook already current in .git/hooks/post-commit`);
  } catch { /* non-critical — git hook is a best-effort feature */ }

  // ── Ambient Recall Phase 4: auto-install SessionStart + UserPromptSubmit hooks ─
  // Only for Claude Code (the hooks config lives in .claude/settings.json).
  if (editor === 'claude') {
    try {
      const a = await installAmbientHooks(projectDir, instanceId, JWT || undefined);
      const scriptVerb = a.scripts === 'written' ? '✅ Written' : a.scripts === 'upgraded' ? `✅ Upgraded (→ ${AMBIENT_HOOK_VERSION})` : '✓  Unchanged';
      console.log(`${scriptVerb}: .claude/hooks/ (Ambient Recall — session briefing, per-prompt recall, file briefing, auto-learn)`);
      if (a.settings === 'written')      console.log(`✅ Written: .claude/settings.json (Ambient Recall hooks wired)`);
      else if (a.settings === 'merged')  console.log(`✅ Merged: .claude/settings.json (Ambient Recall hooks wired)`);
      else                               console.log(`✓  Ambient Recall hooks already wired in .claude/settings.json`);
    } catch { /* non-critical — ambient hooks are a best-effort feature */ }
  }

  const initSecs = ((Date.now() - initStart) / 1000).toFixed(1);
  console.log(`\n🧠 Cachly AI Brain configured for ${editor === 'claude' ? 'Claude Code' : editor}! (${initSecs}s)`);
  console.log(`   Restart your editor — the \`cachly\` MCP tools will appear.`);
  console.log(`   Re-run \`init\` anytime — it's idempotent (only writes what changed).`);
  console.log(`\n   📛 Add a live badge to your README:`);
  console.log(`      npx @cachly-dev/mcp-server@latest badge\n`);
  process.exit(0);
}

// ── CLI: cachly health ────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest health
// Checks: JWT valid, Brain API reachable, editor configs found, git hook present.

// ── CLI: cachly status ────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest status
// Shows Brain health, team size, and quick stats at a glance.

if (process.argv[2] === 'status') {
  const apiKey = process.env.CACHLY_JWT ?? '';
  const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';

  if (!apiKey || !instanceId) {
    console.log('\n⚠️  CACHLY_JWT and CACHLY_BRAIN_INSTANCE_ID must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest autopilot\n');
    process.exit(1);
  }

  try {
    const [statsRes, referralRes] = await Promise.all([
      fetch(`${API_URL}/api/v1/instances/${instanceId}/brain/stats`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      }),
      fetch(`${API_URL}/api/v1/referral/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      }),
    ]);

    if (!statsRes.ok) throw new Error(`stats HTTP ${statsRes.status}`);
    const stats = await statsRes.json() as {
      lesson_count?: number; total_recall_count?: number;
      quality_score?: number; team_authors?: string[];
    };
    const referral = referralRes.ok
      ? await referralRes.json() as { url?: string; referral_count?: number }
      : null;

    const lessons = stats.lesson_count ?? 0;
    const recalls = stats.total_recall_count ?? 0;
    const score   = Math.round((stats.quality_score ?? 0) * 100);
    const team    = stats.team_authors ?? [];
    const refCount = referral?.referral_count ?? 0;
    const refUrl   = referral?.url ?? '';

    const level = lessons === 0 ? 'Intern 🌱' :
      lessons < 10  ? 'Junior Dev 🔧' :
      lessons < 30  ? 'Mid Dev ⚡' :
      lessons < 60  ? 'Senior Dev 🧠' :
      lessons < 100 ? 'Staff Eng 🚀' : 'Principal Eng 🏆';

    const statusIcon = lessons > 0 ? '\x1b[32m●\x1b[0m' : '\x1b[33m●\x1b[0m';

    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log(`│  ${statusIcon} \x1b[1mBrain status\x1b[0m · instance ${instanceId.slice(0, 8)}...              │`);
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  Lessons       : \x1b[33m${String(lessons).padEnd(8)}\x1b[0m  Level        : \x1b[32m${level.padEnd(18)}\x1b[0m│`);
    console.log(`│  Recalls       : \x1b[36m${String(recalls).padEnd(8)}\x1b[0m  Quality score: \x1b[32m${String(score).padEnd(3)}%\x1b[0m              │`);

    if (team.length > 0) {
      console.log('├─────────────────────────────────────────────────────────────┤');
      const teamStr = team.slice(0, 4).join(', ');
      console.log(`│  \x1b[36m👥 Team Brain\x1b[0m · ${String(team.length).padEnd(2)} developer${team.length === 1 ? ' ' : 's'} sharing lessons${' '.repeat(Math.max(0, 19 - teamStr.length))} │`);
      console.log(`│     ${teamStr.slice(0, 56).padEnd(56)} │`);
    }

    if (refUrl) {
      console.log('├─────────────────────────────────────────────────────────────┤');
      const refLine = `${refUrl.slice(0, 44)}${refUrl.length > 44 ? '…' : ''}`;
      console.log(`│  \x1b[35m🔗 Invite link\x1b[0m · ${refCount > 0 ? `\x1b[32m${refCount} joined\x1b[0m` : 'share to grow your team'}${' '.repeat(Math.max(0, 35 - String(refCount).length))} │`);
      console.log(`│     \x1b[2m${refLine.padEnd(56)}\x1b[0m │`);
    }

    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');
    if (lessons === 0) {
      console.log('  \x1b[33m💡 No lessons yet.\x1b[0m Run a session with cachly connected to start learning.');
      console.log('');
    }
  } catch (e) {
    console.log(`\n❌ Could not fetch status: ${(e as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[2] === 'health') {
  const { existsSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');

  const cwd = process.cwd();
  let passed = 0;
  let failed = 0;

  const ok  = (msg: string) => { console.log(`  ✅ ${msg}`); passed++; };
  const warn = (msg: string) => { console.log(`  ⚠️  ${msg}`); };
  const fail = (msg: string) => { console.log(`  ❌ ${msg}`); failed++; };

  console.log('\n🧠 cachly health check\n');

  // ── 1. JWT token ────────────────────────────────────────────────────────────
  console.log('🔑 Auth token');
  const jwt = process.env.CACHLY_JWT ?? '';
  if (!jwt) {
    fail('CACHLY_JWT not set — run: npx @cachly-dev/mcp-server@latest autopilot');
  } else if (jwt.startsWith('cky_')) {
    // Long-lived API key (the credential `setup` provisions). It is not a JWT and
    // never expires client-side — treat a well-formed key as healthy.
    ok('Long-lived API key set (cky_…) — no client-side expiry');
  } else {
    try {
      const parts = jwt.split('.');
      if (parts.length !== 3) throw new Error('not a JWT');
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as {
        sub?: string; exp?: number;
      };
      const expMs = payload.exp ? payload.exp * 1000 : null;
      const minsLeft = expMs ? Math.floor((expMs - Date.now()) / 60_000) : null;
      if (expMs && expMs < Date.now()) {
        fail(`JWT expired ${Math.abs(minsLeft!)} minute(s) ago — get a new one: ${cachlyUrl('/setup-ai', 'health')}`);
      } else if (minsLeft !== null && minsLeft < 30) {
        warn(`JWT expires in ${minsLeft} minute(s) — refresh soon at ${cachlyUrl('/setup-ai', 'health')}`);
      } else {
        ok(`JWT valid${minsLeft !== null ? ` (expires in ${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m)` : ''}`);
      }
    } catch {
      fail('CACHLY_JWT format invalid (expected a cky_ API key or a 3-part JWT)');
    }
  }

  // ── 2. Brain API reachability ───────────────────────────────────────────────
  console.log('\n🌐 Brain API');
  const apiUrl = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
  try {
    const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const body = await res.json() as { status?: string };
      ok(`${apiUrl} reachable (status: ${body.status ?? 'ok'})`);
    } else if (res.status === 401 || res.status === 403) {
      ok(`${apiUrl} reachable (auth required — expected)`);
    } else {
      fail(`${apiUrl}/health returned HTTP ${res.status}`);
    }
  } catch (e) {
    fail(`${apiUrl} unreachable — ${(e as Error).message}`);
  }

  // ── 3. Brain instance ───────────────────────────────────────────────────────
  console.log('\n🧠 Brain instance');
  const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';
  if (!instanceId) {
    warn('CACHLY_BRAIN_INSTANCE_ID not set — will auto-resolve on first tool call');
  } else if (jwt) {
    try {
      const instRes = await fetch(`${apiUrl}/api/v1/instances/${instanceId}`, {
        headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (instRes.ok) {
        const inst = await instRes.json() as { name?: string; status?: string; host?: string; port?: number; tls_enabled?: boolean };
        if (inst.status === 'running') {
          ok(`Instance "${inst.name}" (${instanceId.slice(0, 8)}…) is running`);
          // Attempt actual Redis PING to verify connectivity end-to-end
          console.log('\n🔌 Redis connectivity');
          if (inst.host && inst.port) {
            try {
              let pingPassword: string | undefined;
              let pingTls = inst.tls_enabled !== false;
              try {
                const connRes = await fetch(`${apiUrl}/api/v1/instances/${instanceId}/connection`, {
                  headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
                  signal: AbortSignal.timeout(5000),
                });
                if (connRes.ok) {
                  const conn = await connRes.json() as { password?: string; tls_enabled?: boolean };
                  pingPassword = conn.password;
                  pingTls = conn.tls_enabled !== false;
                }
              } catch { /* proceed without password */ }
              const pingClient = new Redis({
                host: inst.host, port: inst.port,
                password: pingPassword,
                ...(pingTls ? { tls: {} } : {}),
                lazyConnect: true, connectTimeout: 5000, retryStrategy: () => null,
              });
              await pingClient.connect();
              const pong = await pingClient.ping();
              pingClient.disconnect();
              if (pong === 'PONG') {
                ok(`Redis PING → PONG (${inst.host}:${inst.port})`);
              } else {
                warn(`Redis responded but not PONG: ${pong}`);
              }
            } catch (pingErr) {
              fail(`Redis unreachable — ${(pingErr as Error).message}`);
            }
          } else {
            warn('Instance has no host/port yet');
          }
        } else {
          warn(`Instance "${inst.name}" status: ${inst.status}`);
        }
      } else {
        fail(`Instance ${instanceId.slice(0, 8)}… not found (HTTP ${instRes.status})`);
      }
    } catch (e) {
      fail(`Could not check instance — ${(e as Error).message}`);
    }
  }

  // ── 4. Editor configs ───────────────────────────────────────────────────────
  console.log('\n🛠  Editor configs (project dir)');
  const editorConfigs: Array<{ editor: string; path: string }> = [
    { editor: 'Claude Code',     path: '.mcp.json' },
    { editor: 'Cursor',          path: '.cursor/mcp.json' },
    { editor: 'Windsurf',        path: '.windsurf/mcp.json' },
    { editor: 'Copilot / Cline', path: '.vscode/mcp.json' },
    { editor: 'Zed',             path: '.zed/settings.json' },
    { editor: 'Continue.dev',    path: '.continue/config.json' },
  ];
  let configsFound = 0;
  for (const { editor, path } of editorConfigs) {
    const fullPath = resolve(cwd, path);
    if (existsSync(fullPath)) {
      try {
        const content = await readFile(fullPath, 'utf-8');
        const hasCachly = content.includes('@cachly-dev/mcp-server') || content.includes('cachly');
        if (hasCachly) {
          ok(`${editor}: ${path}`);
          configsFound++;
        } else {
          warn(`${editor}: ${path} exists but cachly not found inside`);
        }
      } catch {
        warn(`${editor}: ${path} exists but could not read`);
      }
    }
  }
  if (configsFound === 0) {
    fail('No editor MCP configs found — run: npx @cachly-dev/mcp-server@latest autopilot');
  }

  // ── 5. Git hook ─────────────────────────────────────────────────────────────
  console.log('\n🪝 Git hook (ambient learning)');
  const hookPath = resolve(cwd, '.git', 'hooks', 'post-commit');
  if (!existsSync(resolve(cwd, '.git'))) {
    warn('Not in a git repository — skip');
  } else if (existsSync(hookPath)) {
    try {
      const hook = await readFile(hookPath, 'utf-8');
      if (hook.includes('cachly')) {
        ok('.git/hooks/post-commit (cachly CLS hook present)');
      } else {
        warn('.git/hooks/post-commit exists but cachly hook not found — run setup to add it');
      }
    } catch {
      warn('.git/hooks/post-commit exists but could not read');
    }
  } else {
    warn('.git/hooks/post-commit not found — run: npx @cachly-dev/mcp-server@latest autopilot');
  }

  // ── 6. Embedding provider (BYOK) ─────────────────────────────────────────────
  console.log('\n🧬 Embedding provider (semantic search)');
  {
    const providerKeys: Array<[string, string]> = [
      ['OPENAI_API_KEY', 'openai'], ['GEMINI_API_KEY', 'gemini'],
      ['MISTRAL_API_KEY', 'mistral'], ['COHERE_API_KEY', 'cohere'],
      ['OLLAMA_BASE_URL', 'ollama'],
    ];
    const explicit = (process.env.CACHLY_EMBED_PROVIDER ?? '').toLowerCase();
    const byok = providerKeys.find(([envVar]) => process.env[envVar]);
    if (explicit && explicit !== 'cachly') {
      const envVar = providerKeys.find(([, p]) => p === explicit)?.[0];
      if (envVar && process.env[envVar]) ok(`BYOK: ${explicit} (key present in ${envVar})`);
      else warn(`CACHLY_EMBED_PROVIDER=${explicit} but its key env var is not set — semantic search will fail`);
    } else if (byok) {
      ok(`BYOK: ${byok[1]} auto-detected (${byok[0]} present)`);
    } else {
      ok('Server-side embeddings (cachly) — no key needed, uses your JWT');
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  if (failed === 0) {
    console.log(`✅ All checks passed (${passed} ok)\n`);
  } else {
    console.log(`❌ ${failed} check(s) failed, ${passed} passed\n`);
    console.log(`💡 Fix issues with: npx @cachly-dev/mcp-server@latest autopilot\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly setup (interactive — no flags required) ───────────────────────
// Usage: npx @cachly-dev/mcp-server setup

// `autopilot` is the one-command entrypoint: it runs the exact same wizard as
// `setup` but fully automatic (no prompts) — auth → instance → all editor
// configs → CLAUDE.md → git/starter bootstrap → health, in a single shot.
const _isAutopilotCli = process.argv[2] === 'autopilot';
// 'autosetup' is the canonical alias; 'setup' kept for backwards compat.
if (process.argv[2] === 'autosetup' || process.argv[2] === 'setup' || _isAutopilotCli) {
  const { writeFile, mkdir, readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { createInterface } = await import('node:readline');

  const setupStartMs = Date.now();
  const cliSource = _isAutopilotCli ? 'autopilot' : 'setup';
  // Self-hosting: `setup --api-url https://cachly.mycorp.internal` points the whole
  // wizard (auth, provisioning, config writes) at a private backend.
  const _apiUrlIdx = process.argv.indexOf('--api-url');
  if (_apiUrlIdx !== -1 && process.argv[_apiUrlIdx + 1]) {
    API_URL = process.argv[_apiUrlIdx + 1].replace(/\/+$/, '');
    console.log(`ℹ️  Using self-hosted backend: ${API_URL}\n`);
  }
  sendFunnelEvent('setup_started');

  // --yes / -y → non-interactive mode (skips all prompts, picks defaults).
  // Also auto-detect a non-interactive stdin (VSCode tasks, CI, piped input):
  // a readline question against a non-TTY stdin never resolves and hangs the
  // wizard forever. Treat that exactly like --yes so we never block.
  const stdinIsInteractive = process.stdin.isTTY === true;
  // `autopilot` is always fully automatic — it IS the one-step onboarding.
  const nonInteractive = _isAutopilotCli || process.argv.includes('--yes') || process.argv.includes('-y') || !stdinIsInteractive;
  if (_isAutopilotCli) {
    console.log('🤖 Autopilot — one-command setup (auth → instance → configs → Brain), zero prompts.\n');
  } else if (!stdinIsInteractive && !process.argv.includes('--yes') && !process.argv.includes('-y')) {
    console.log('ℹ️  Non-interactive terminal detected — running in automatic mode (no prompts).\n');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, defaultVal = ''): Promise<string> => {
    if (nonInteractive) { console.log(`${q}${defaultVal}`); return Promise.resolve(defaultVal); }
    return new Promise(res => rl.question(q, ans => res(ans.trim() || defaultVal)));
  };

  console.log('\n🧠  cachly AI Brain — Setup');
  console.log('────────────────────────────────────────\n');

  // ── Step 1: Authenticate via OAuth Device Flow ────────────────────────────
  let token = process.env.CACHLY_JWT ?? '';
  if (token) {
    console.log('✓  Using token from CACHLY_JWT env var\n');
  } else {
    console.log('Step 1: Sign in to cachly (free, no credit card)\n');
    sendFunnelEvent('setup_auth_started');

    // Start device flow — try API proxy first, fall back to direct Keycloak
    let deviceCode = '', userCode = '', verifyUri = '', pollInterval = 5000;
    let deviceFlowOk = false;

    // Attempt 1: API proxy (recommended path)
    try {
      const deviceRes = await fetch(`${API_URL}/api/v1/auth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'cachly-mcp-cli' }),
        signal: AbortSignal.timeout(8000),
      });
      if (deviceRes.ok) {
        const data = await deviceRes.json() as {
          device_code: string; user_code: string;
          verification_uri: string; interval: number;
        };
        deviceCode   = data.device_code;
        userCode     = data.user_code;
        verifyUri    = data.verification_uri;
        pollInterval = (data.interval ?? 5) * 1000;
        deviceFlowOk = true;
      }
    } catch { /* fall through */ }

    // Attempt 2: Direct Keycloak device flow
    if (!deviceFlowOk) {
      try {
        const AUTH_BASE = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
        const deviceRes = await fetch(`${AUTH_BASE}/auth/device`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `client_id=cachly-cli&scope=openid`,
          signal: AbortSignal.timeout(8000),
        });
        if (deviceRes.ok) {
          const data = await deviceRes.json() as {
            device_code: string; user_code: string;
            verification_uri_complete: string; interval: number;
          };
          deviceCode   = data.device_code;
          userCode     = data.user_code;
          verifyUri    = data.verification_uri_complete;
          pollInterval = (data.interval ?? 5) * 1000;
          deviceFlowOk = true;
        }
      } catch { /* fall through */ }
    }

    if (deviceFlowOk && deviceCode) {
      // Open browser and show code
      console.log(`   Code: \x1b[1;33m${userCode}\x1b[0m`);
      console.log(`   URL:  ${verifyUri}\n`);
      openInBrowser(verifyUri);
      console.log('   ✓  Browser opened — confirm the code above to continue...\n');

      // Poll for token with proper timeouts
      process.stdout.write('   Waiting for authorization');
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval));
        process.stdout.write('.');
        try {
          // Poll via API proxy first, then Keycloak
          type TokenResp = { access_token?: string; error?: string };
          let tokenData: TokenResp | null = null;
          try {
            const proxyRes = await fetch(`${API_URL}/api/v1/auth/device/token`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ device_code: deviceCode, client_id: 'cachly-mcp-cli' }),
              signal: AbortSignal.timeout(8000),
            });
            if (proxyRes.ok) tokenData = await proxyRes.json() as TokenResp;
          } catch { /* try Keycloak */ }
          if (!tokenData) {
            const AUTH_BASE = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
            try {
              const kcRes = await fetch(`${AUTH_BASE}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: `client_id=cachly-cli&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceCode}`,
                signal: AbortSignal.timeout(8000),
              });
              tokenData = await kcRes.json() as TokenResp;
            } catch { /* network hiccup */ }
          }
          if (tokenData?.access_token) {
            token = tokenData.access_token;
            console.log(' \x1b[32m✓ Authorized!\x1b[0m\n');
            sendFunnelEvent('setup_auth_completed');
            sendFunnelEvent('device_flow_completed');
            break;
          }
          if (tokenData?.error === 'slow_down') pollInterval = Math.min(pollInterval + 2000, 15000);
          else if (tokenData?.error && tokenData.error !== 'authorization_pending') {
            sendFunnelEvent('device_flow_failed', { reason: tokenData.error });
            console.error(`\nAuth error: ${tokenData.error}. Aborting.\n`);
            rl.close(); process.exit(1);
          }
        } catch { /* network hiccup — keep polling */ }
      }
      if (!token) {
        sendFunnelEvent('device_flow_failed', { reason: 'timeout' });
        console.error('\nTimed out waiting for authorization. Aborting.\n');
        rl.close(); process.exit(1);
      }
      console.log('');
    } else {
      // Device flow unavailable — web fallback with automatic browser open
      sendFunnelEvent('device_flow_failed', { reason: 'device_flow_unavailable' });
      const signupUrl = cachlyUrl('/setup-ai', cliSource);
      console.log('   ⚠️  Could not start automatic sign-in. Opening browser for web sign-in...\n');
      console.log(`   URL: \x1b[36m${signupUrl}\x1b[0m`);
      console.log('   1. Sign up / log in at the URL above');
      console.log('   2. Go to Settings → API Keys → Create new key');
      console.log('   3. Copy the key (starts with cky_live_...)\n');
      openInBrowser(signupUrl);
      // In a non-interactive terminal (VSCode task, CI) we cannot read a pasted
      // key — exit with clear, actionable instructions instead of hanging.
      if (nonInteractive) {
        sendFunnelEvent('device_flow_failed', { reason: 'non_interactive_no_key' });
        console.error('\n   ⚠️  This terminal is non-interactive, so the key cannot be pasted here.');
        console.error('   Get your key at the URL above, then set it and re-run setup:\n');
        console.error('     \x1b[1mCACHLY_JWT=cky_live_xxx npx @cachly-dev/mcp-server@latest autopilot\x1b[0m\n');
        console.error('   Or add it to your editor\'s MCP config under env.CACHLY_JWT.\n');
        rl.close(); process.exit(1);
      } else {
        token = await ask('   Paste API key (cky_live_...): ');
        if (!token) { console.error('\nAPI key is required. Aborting.\n'); rl.close(); process.exit(1); }
        sendFunnelEvent('setup_auth_completed');
        console.log('');
      }
    }
  }

  // ── Step 1b: Exchange Keycloak JWT → long-lived cky_live_ API key ──────────
  // Only do this when the token looks like a Keycloak JWT (starts with "eyJ"),
  // not when the user already pasted a cky_live_ key directly.
  if (token.startsWith('eyJ')) {
    process.stdout.write('⏳ Generating your API key...');
    try {
      const keyRes = await fetch(`${API_URL}/api/v1/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'cachly-mcp-setup', scope: 'read_write' }),
      });
      if (!keyRes.ok) throw new Error(`HTTP ${keyRes.status}`);
      const keyBody = await keyRes.json() as { key: string };
      if (!keyBody.key) throw new Error('no key in response');
      token = keyBody.key; // swap JWT → cky_live_...
      console.log(' ✓\n');
    } catch {
      console.log(' (skipped)\n');
      // Non-fatal: fall back to using the Keycloak JWT directly.
      // It will expire but setup still works for now.
    }
  }

  // ── Step 2: Fetch & pick instance ─────────────────────────────────────────
  process.stdout.write('⏳ Fetching your instances...');
  let instances: Array<{ id: string; name: string; status: string; tier: string; region: string }> = [];
  try {
    const res = await fetch(`${API_URL}/api/v1/instances`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { data: typeof instances };
    instances = (body.data ?? []).filter(i => i.status === 'running');
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`\n\nFailed to fetch instances: ${msg}`);
    if (msg.includes('401')) {
      console.error(`Token rejected. Get a valid token at ${cachlyUrl('/setup-ai', cliSource)}\n`);
      openInBrowser(cachlyUrl('/setup-ai', cliSource));
    }
    rl.close(); process.exit(1);
  }
  console.log(` found ${instances.length}\n`);

  if (instances.length === 0) {
    // Auto-provision a free Brain instance so users don't have to visit the website.
    process.stdout.write('⏳ Creating your free Brain instance...');
    try {
      const autoRes = await fetch(`${API_URL}/api/v1/instances/auto`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      if (!autoRes.ok) throw new Error(`HTTP ${autoRes.status}`);
      const autoBody = await autoRes.json() as { instance?: { id: string; name: string; status: string; tier: string; region: string }; instance_id?: string; status?: string; created?: boolean };
      if (autoBody.instance) {
        // Returned an existing instance.
        instances = [autoBody.instance];
      } else if (autoBody.instance_id) {
        // Newly created — poll until running or give up after 30 s.
        const newId = autoBody.instance_id;
        console.log(` ✓ created (${newId.slice(0, 8)}…)\n`);
        // 45 attempts × 3s = 135s — generous for free-tier in slow regions.
        process.stdout.write('⏳ Waiting for instance to start');
        for (let attempt = 0; attempt < 45; attempt++) {
          await new Promise(r => setTimeout(r, 3000));
          process.stdout.write('.');
          try {
            const checkRes = await fetch(`${API_URL}/api/v1/instances/${newId}`, { headers: { Authorization: `Bearer ${token}` } });
            if (checkRes.ok) {
              const inst = await checkRes.json() as { id: string; name: string; status: string; tier: string; region: string };
              if (inst.status === 'running') { instances = [inst]; break; }
            }
          } catch { /* keep polling */ }
        }
        console.log('');
      }
    } catch (e) {
      console.log(` failed: ${(e as Error).message}\n`);
    }

    if (instances.length === 0) {
      console.error(`\nCould not create an instance automatically. Opening ${cachlyUrl('/instances', cliSource)} …\n`);
      openInBrowser(cachlyUrl('/instances', cliSource));
      rl.close(); process.exit(1);
    }
  }

  // Auto-pick the most recently created running instance — no prompt.
  const instance = instances[0];
  if (instances.length > 1) {
    console.log(`ℹ️  Multiple instances found — using most recent: ${instance.name}`);
    console.log(`   (Run with --instance-id <id> to use a different one)\n`);
  }
  console.log(`✓  Instance: ${instance.name} (${instance.id.slice(0, 8)}…)\n`);
  sendFunnelEvent('setup_instance_ready', { instance_id: instance.id });

  // ── Step 3: Detect editors ────────────────────────────────────────────────
  const cwd = process.cwd();
  const detected: string[] = [];
  const { homedir } = await import('node:os');
  const home = homedir();
  // Claude Code: always include (CLAUDE.md is universal)
  detected.push('claude');
  if (existsSync(resolve(cwd, '.cursor')))   detected.push('cursor');
  if (existsSync(resolve(cwd, '.windsurf'))) detected.push('windsurf');
  if (existsSync(resolve(cwd, '.vscode')))   detected.push('copilot');
  if (existsSync(resolve(cwd, '.continue'))) detected.push('continue');
  // Cline: VS Code extension — detect via globalStorage on the machine
  const clineGlobalDir = process.platform === 'darwin'
    ? resolve(home, 'Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev')
    : resolve(home, '.vscode/extensions');
  if (existsSync(clineGlobalDir) && !detected.includes('copilot')) detected.push('cline');
  else if (existsSync(clineGlobalDir)) detected.push('cline'); // both copilot + cline share .vscode/mcp.json — fine
  // Zed editor — detect via app data dir
  const zedDir = process.platform === 'darwin'
    ? resolve(home, 'Library/Application Support/Zed')
    : resolve(home, '.config/zed');
  if (existsSync(zedDir)) detected.push('zed');

  const editorLabel = (e: string) =>
    ({ claude: 'Claude Code', cursor: 'Cursor', windsurf: 'Windsurf', copilot: 'GitHub Copilot', continue: 'Continue.dev', cline: 'Cline (VSCode)', zed: 'Zed' })[e] ?? e;

  // Auto-configure all detected editors — no prompt needed.
  const editorsToSetup = detected;
  console.log(`Step 3: Configuring for: ${editorsToSetup.map(editorLabel).join(', ')}\n`);

  // ── Step 4: Write editor configs (project-level) ─────────────────────────
  // Uses mergeMcpConfig to preserve all existing MCP servers — only adds/updates
  // the cachly entry without touching filesystem, github, or other servers.
  const { existsSync: exSetup } = await import('node:fs');
  // Track config-write failures so the final summary tells the truth instead of
  // always claiming "Brain is ready" even when a config never got written.
  const configWriteFailures: Array<{ file: string; reason: string }> = [];
  let configWriteSuccesses = 0;
  for (const editor of editorsToSetup) {
    const configFile = EDITOR_FILES[editor] ?? '.mcp.json';
    const configPath = resolve(cwd, configFile);
    try {
      await mkdir(dirname(configPath), { recursive: true });
      const wasExisting = exSetup(configPath);
      const merged = await mergeMcpConfig(configPath, token, instance.id, editor, { readFile, existsSync: exSetup });
      await writeFile(configPath, merged, 'utf-8');
      console.log(`✅ ${wasExisting ? 'Updated' : 'Written'}: ${configFile}`);
      configWriteSuccesses++;
    } catch (writeErr) {
      const reason = (writeErr as Error).message;
      console.log(`⚠️  Could not write ${configFile}: ${reason}`);
      console.log(`   Fix permissions or run with sudo, then re-run setup.`);
      configWriteFailures.push({ file: configFile, reason });
    }
  }

  // ── Step 4b: Write global Claude Code config (~/.claude/mcp.json) ─────────
  // Merges cachly into the existing global config so it works in every project,
  // without removing other MCP servers the user may have configured.
  const globalClaudePath = resolve(home, '.claude', 'mcp.json');
  try {
    await mkdir(dirname(globalClaudePath), { recursive: true });
    let globalConfig: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(globalClaudePath)) {
      try {
        globalConfig = JSON.parse(await readFile(globalClaudePath, 'utf-8')) as typeof globalConfig;
      } catch { /* corrupt — start fresh */ }
    }
    globalConfig.mcpServers ??= {};
    globalConfig.mcpServers['cachly'] = {
      command: 'npx',
      args: ['-y', '@cachly-dev/mcp-server@latest'],
      env: buildServerEnv(token, instance.id),
    };
    await writeFile(globalClaudePath, JSON.stringify(globalConfig, null, 2), 'utf-8');
    console.log(`✅ Written: ~/.claude/mcp.json  (global — works in every project)`);
    configWriteSuccesses++;
  } catch (e) {
    const reason = (e as Error).message;
    console.log(`⚠️  Could not write ~/.claude/mcp.json: ${reason}`);
    configWriteFailures.push({ file: '~/.claude/mcp.json', reason });
  }


  // ── Step 5: Instructions für alle Vendors (immer, idempotent) ─────────────
  const instrResults = await writeInstructions(cwd, instance.id);
  for (const [file, res] of Object.entries(instrResults)) {
    const label = res === 'updated' ? '✅ Updated' : res === 'appended' ? '✅ Appended to' : '✅ Written';
    console.log(`${label}: ${file}`);
  }

  // ── Step 5b: Bootstrap Brain from git history ─────────────────────────────
  // Pre-populates the Brain with real lessons so the first session_start shows
  // actual project knowledge instead of an empty brain.
  JWT = token; // set global JWT so handleTool can authenticate
  let gitLessonCount = 0;
  if (existsSync(resolve(cwd, '.git'))) {
    process.stdout.write('⏳ Bootstrapping Brain from git history (~10s)...');
    try {
      const gitResult = await handleTool('brain_from_git', {
        instance_id: instance.id,
        repo_path: cwd,
        limit: 100,
      });
      const match = gitResult.match(/(\d+) lesson/);
      gitLessonCount = match ? parseInt(match[1], 10) : 0;
      console.log(` ✓  ${match ? match[1] + ' lessons' : 'done'} extracted from git history`);
    } catch (e) {
      console.log(` (skipped: ${(e as Error).message.slice(0, 80)})`);
    }
  }

  // ── Step 5c: Seed the starter corpus when git yielded nothing ─────────────
  // Closes the empty-brain gap: a fresh repo (no .git, shallow clone, or no
  // fix-shaped commits) would otherwise leave the Brain empty and the very first
  // smart_recall returning nothing. Seeding 16 curated universal lessons makes
  // the single setup command produce an immediately-useful Brain — true 1-step
  // onboarding. Idempotent; never overwrites real lessons.
  if (gitLessonCount === 0) {
    process.stdout.write('🌱 Seeding 16 universal engineering lessons (first recall works instantly)...');
    try {
      await handleTool('brain_seed_starter', { instance_id: instance.id });
      console.log(' ✓');
    } catch (e) {
      console.log(` (skipped: ${(e as Error).message.slice(0, 60)})`);
    }
  }

  // ── Step 6: Show Brain health (Aha moment) ────────────────────────────────
  // Fetch brain health from the API to show the user what their agent will see.
  process.stdout.write('\n⏳ Fetching your Brain health preview...');
  try {
    const brainRes = await fetch(`${API_URL}/api/v1/instances/${instance.id}/brain/stats`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(6000),
    });
    if (brainRes.ok) {
      const brainData = await brainRes.json() as {
        lesson_count?: number; context_count?: number;
        open_failures?: number; quality_score?: number;
      };
      const lessons = brainData.lesson_count ?? 0;
      const contexts = brainData.context_count ?? 0;
      const score = brainData.quality_score ?? 0;
      const level = lessons === 0 ? 'Intern 🌱' :
        lessons < 10  ? 'Junior Dev 🔧' :
        lessons < 30  ? 'Mid Dev ⚡' :
        lessons < 60  ? 'Senior Dev 🧠' :
        lessons < 100 ? 'Staff Eng 🚀' : 'Principal Eng 🏆';
      console.log(' ✓\n');
      console.log('┌──────────────────────────────────────────────────────┐');
      console.log(`│  🧠  Brain Health Report                            │`);
      console.log('├──────────────────────────────────────────────────────┤');
      console.log(`│  Lessons stored    : ${String(lessons).padEnd(6)} │  Level: ${level.padEnd(20)}│`);
      console.log(`│  Context entries   : ${String(contexts).padEnd(6)} │  Quality score: ${String(Math.round(score * 100)).padEnd(3)}%       │`);
      if (lessons === 0) {
        console.log('├──────────────────────────────────────────────────────┤');
        console.log('│  Your Brain is empty and ready to learn.            │');
        console.log('│  After your first coding session it will contain:   │');
        console.log('│    • Lessons from every bug you fixed               │');
        console.log('│    • Your project\'s indexed files                   │');
        console.log('│    • A session summary for next time                │');
      }
      console.log('└──────────────────────────────────────────────────────┘');

      // ── Step 6b: brain_predict preview (only if we have real lessons) ───────
      if (lessons >= 5) {
        process.stdout.write('\n⏳ Running predictive risk scan...');
        try {
          const predictResult = await handleTool('brain_predict', {
            instance_id: instance.id,
            context: 'starting a new development session',
          });
          const predictLines = predictResult
            .split('\n')
            .filter((l: string) => l.trim())
            .slice(0, 6);
          if (predictLines.length > 0) {
            console.log(' ✓\n');
            console.log('┌──────────────────────────────────────────────────────┐');
            console.log('│  🔮  Brain Risk Preview (brain_predict)              │');
            console.log('├──────────────────────────────────────────────────────┤');
            for (const pl of predictLines) {
              console.log(`│  ${pl.slice(0, 51).padEnd(51)} │`);
            }
            console.log('└──────────────────────────────────────────────────────┘');
          } else {
            console.log(' (no risks found — clean slate!)');
          }
        } catch { console.log(' (skipped)'); }
      }
    } else {
      console.log(' (skipped)');
    }
  } catch { console.log(' (skipped)'); }

  console.log(`\n🎉  Your AI just got a permanent brain.`);
  console.log(`   Restart your editor — from this session on, it arrives pre-briefed.\n`);
  console.log(`   No more re-explaining your stack. No repeated mistakes.\n`);
  console.log(`   Dashboard: ${cachlyUrl(`/instances/${instance.id}`, cliSource)}`);
  console.log(`\n   📛 Add a live badge to your README:`);
  console.log(`      npx @cachly-dev/mcp-server@latest badge\n`);

  // ── Step 6c: Governance bootstrap — assign the first admin role ─────────────
  // Optional nudge: ask once whether the user wants to establish the role model.
  // team_assign_role handles idempotency (first call is free; later calls need admin).
  if (!nonInteractive) {
    try {
      console.log('\n👑  Governance (optional — role model: admin · reviewer · contributor · viewer)');
      console.log('────────────────────────────────────────');
      const addAdmin = await ask('   Set yourself as the first admin? (y/N): ', 'N');
      if (addAdmin.toLowerCase() === 'y') {
        const adminHandle = await ask('   Your handle (e.g. "alice"): ');
        if (adminHandle.trim()) {
          const assignOut = await handleTool('team_assign_role', {
            instance_id: instance.id, handle: adminHandle.trim(), role: 'admin',
          }).catch(() => '');
          if (assignOut) {
            console.log(`   ✅  ${adminHandle.trim()} is now admin. Invite teammates:\n`);
            console.log(`   team_assign_role(instance_id="${instance.id}", handle="<teammate>", role="contributor", assigned_by="${adminHandle.trim()}")\n`);
          }
        }
      } else {
        console.log('   Skipped — run team_assign_role at any time.\n');
      }
    } catch { /* non-critical */ }
  }

  // ── Step 7: Email opt-in (non-blocking — at the very end) ────────────────
  if (!nonInteractive) {
    const email = await ask('   📬 Stay in the loop? Email for release notes [Enter to skip]: ');
    if (email && email.includes('@')) {
      try {
        await fetch(`${API_URL}/api/newsletter/subscribe`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim().toLowerCase(), source: 'mcp-setup' }),
          signal: AbortSignal.timeout(5000),
        });
        console.log('   ✅ Subscribed — you\'ll only hear from us when it matters.\n');
      } catch { /* fire and forget */ }
    }
  }

  // ── CLS Phase 4: Auto-install git post-commit hook in setup flow ─────────
  try {
    const r = await installClsPostCommitHook(process.cwd(), instance.id, token || undefined);
    if (r === 'written')        console.log(`\n✅  CLS git hook installed — your brain will learn from every commit.`);
    else if (r === 'upgraded')  console.log(`\n✅  CLS git hook upgraded to ${CLS_HOOK_VERSION}.`);
    else if (r === 'appended')  console.log(`\n✅  CLS git hook appended to existing post-commit.`);
  } catch { /* non-critical */ }

  // ── Ambient Recall Phase 4: auto-install SessionStart + UserPromptSubmit hooks ─
  // Only for Claude Code (the hooks config lives in .claude/settings.json). Without
  // this call, setup/autosetup/autopilot never install the hooks that make the
  // Brain speak up on its own — only `init` did (the bug POL-034 fixes).
  if (editorsToSetup.includes('claude')) {
    try {
      const a = await installAmbientHooks(process.cwd(), instance.id, token || undefined);
      const scriptVerb = a.scripts === 'written' ? '✅  Written' : a.scripts === 'upgraded' ? `✅  Upgraded (→ ${AMBIENT_HOOK_VERSION})` : '✓  Unchanged';
      console.log(`${scriptVerb}: .claude/hooks/ (Ambient Recall — session briefing, per-prompt recall, file briefing, auto-learn)`);
      if (a.settings === 'written')      console.log(`✅  Written: .claude/settings.json (Ambient Recall hooks wired)`);
      else if (a.settings === 'merged')  console.log(`✅  Merged: .claude/settings.json (Ambient Recall hooks wired)`);
      else                               console.log(`✓  Ambient Recall hooks already wired in .claude/settings.json`);
    } catch { /* non-critical — ambient hooks are a best-effort feature */ }
  }

  // Setup reached the end — close the funnel. Report config-write outcome so the
  // weekly funnel can spot permission/path problems blocking activation.
  JWT = token;
  const setupElapsedS = Math.round((Date.now() - setupStartMs) / 1000);
  if (configWriteFailures.length > 0) {
    sendFunnelEvent('setup_config_write_failed', {
      instance_id: instance.id,
      failed: configWriteFailures.length,
      succeeded: configWriteSuccesses,
    });
  }
  sendFunnelEvent('setup_completed', {
    instance_id: instance.id,
    elapsed_s: setupElapsedS,
    config_failures: configWriteFailures.length,
  });

  if (configWriteFailures.length > 0 && configWriteSuccesses === 0) {
    // Nothing got written — be honest, this is NOT "ready".
    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║  ⚠️   Setup incomplete — no editor config was written ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('\n   Your Brain instance exists, but no editor knows about it yet.');
    console.log('   Failed writes:');
    for (const f of configWriteFailures) console.log(`     • ${f.file} — ${f.reason}`);
    console.log('\n   Fix the permissions above and re-run, or configure manually:');
    console.log(`     CACHLY_JWT=${token.slice(0, 12)}… CACHLY_BRAIN_INSTANCE_ID=${instance.id}`);
    console.log(`   Docs: ${cachlyUrl('/docs/mcp', cliSource)}\n`);
    rl.close();
    await new Promise(r => setTimeout(r, 300));
    process.exit(1);
  }

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  🚀  Brain is ready.                                 ║');
  console.log(`║  ⏱️   Setup completed in ${String(setupElapsedS + 's').padEnd(5)} — restart your editor  ║`);
  console.log('║      and your AI arrives pre-briefed every session.  ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  if (configWriteFailures.length > 0) {
    // Partial success — some editors configured, some not. Tell the truth.
    console.log('\n   ⚠️  Some editor configs could not be written (others succeeded):');
    for (const f of configWriteFailures) console.log(`     • ${f.file} — ${f.reason}`);
    console.log('   Fix the permissions above and re-run setup to configure them too.');
  }
  console.log('');

  rl.close();
  // Give the fire-and-forget telemetry a moment to flush before exit.
  await new Promise(r => setTimeout(r, 300));
  process.exit(0);
}

// ── CLI: cachly index <dir> ───────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest index [./path/to/project]
// Indexes the project directory into the Brain — perfect for CI/CD cron jobs.

if (process.argv[2] === 'index') {
  const { resolve } = await import('node:path');
  const argv = process.argv.slice(3);
  const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined; };

  const dir        = resolve(flag('dir') ?? argv.find(a => !a.startsWith('--')) ?? '.');
  const instanceId = flag('instance-id') ?? process.env.CACHLY_BRAIN_INSTANCE_ID;
  const maxFiles   = parseInt(flag('max-files') ?? '500', 10);
  const namespace  = flag('namespace') ?? 'cachly:sem:code';

  if (!instanceId || !JWT) {
    console.error('\n❌  CACHLY_BRAIN_INSTANCE_ID and CACHLY_JWT must be set\n');
    console.error('   export CACHLY_BRAIN_INSTANCE_ID=<uuid>');
    console.error('   export CACHLY_JWT=<cky_live_...>');
    console.error('   npx @cachly-dev/mcp-server@latest index ./my-project\n');
    process.exit(1);
  }

  console.log(`\n📂  Indexing: ${dir}`);
  console.log(`    Instance: ${instanceId.slice(0, 8)}…  Max files: ${maxFiles}\n`);

  try {
    const result = await handleTool('index_project', {
      instance_id: instanceId,
      dir,
      max_files: maxFiles,
      ttl: 86400 * 7,
      namespace,
    });
    console.log(result);
    console.log('\n✅  Indexing complete.\n');
  } catch (err) {
    console.error(`\n❌  Indexing failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly learn-git ─────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest learn-git [./repo] [--max-commits 50]
// Auto-learns brain lessons from recent git commits — ideal for CI on PR merge.
// Each meaningful commit becomes a lesson, so the Brain grows with zero manual work.

if (process.argv[2] === 'learn-git') {
  const { resolve } = await import('node:path');
  const argv = process.argv.slice(3);
  const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined; };

  const repoDir    = resolve(flag('dir') ?? argv.find(a => !a.startsWith('--')) ?? '.');
  const instanceId = flag('instance-id') ?? process.env.CACHLY_BRAIN_INSTANCE_ID;
  const maxCommits = parseInt(flag('max-commits') ?? '50', 10);

  if (!instanceId || !JWT) {
    console.error('\n❌  CACHLY_BRAIN_INSTANCE_ID and CACHLY_JWT must be set\n');
    console.error('   export CACHLY_BRAIN_INSTANCE_ID=<uuid>');
    console.error('   export CACHLY_JWT=<cky_live_...>');
    console.error('   npx @cachly-dev/mcp-server@latest learn-git .\n');
    process.exit(1);
  }

  console.log(`\n🧠  Learning from git history: ${repoDir}`);
  console.log(`    Instance: ${instanceId.slice(0, 8)}…  Max commits: ${maxCommits}\n`);

  try {
    const result = await handleTool('brain_from_git', {
      instance_id: instanceId,
      repo_path: repoDir,
      limit: maxCommits,
    });
    console.log(result);
    sendFunnelEvent('brain_from_git', { api_key: JWT, instance_id: instanceId });
    console.log('\n✅  Brain learned from your commits.\n');
    // Let fire-and-forget telemetry flush before exit.
    await new Promise(r => setTimeout(r, 300));
  } catch (err) {
    console.error(`\n❌  learn-git failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── ambient-recall: CLI entrypoint for the Claude Code hooks ──────────────────
// Invoked as: <hook payload JSON on stdin> | cachly ambient-recall
// SessionStart/UserPromptSubmit/PreToolUse payloads recall through the §6.3
// relevance gate (ambient-cli.ts) and print the `hookSpecificOutput` JSON that
// Claude Code injects as additionalContext — or nothing. Stop payloads instead
// feed a fix-signal observation to auto_learn_session (the automatic
// `learn_from_attempts`). Injections are booked into the net-token ledger
// (§6.2) and auto-backoff kicks in when the recent window is net-negative.
// Best-effort: no JWT, no stdin, a slow brain or any error → prints nothing and
// exits 0 so a hook can NEVER block or corrupt the agent's turn.
if (process.argv[2] === 'ambient-recall') {
  try {
    if (process.stdin.isTTY) process.exit(0); // no piped payload → nothing to do
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');
    if (!JWT) process.exit(0); // not authenticated → silent no-op
    const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? _defaultInstanceId;

    // Stop event → auto-learn, never inject (roadmap §6.1 PostToolUse/Stop row).
    const stopPayload = parseHookPayload(raw);
    if (stopPayload?.hook_event_name === 'Stop') {
      const obs = stopObservation(stopPayload);
      if (obs && instanceId) {
        await handleTool('auto_learn_session', { instance_id: instanceId, observations: [obs] });
      }
      process.exit(0);
    }

    let reported: Promise<void> | undefined;
    const out = await runAmbient(raw, buildAmbientDeps({
      instanceId,
      smartRecall: async (query) => String((await handleTool('smart_recall', { instance_id: instanceId, query })) ?? ''),
      loadMemory: () => loadAmbientMemory(),
      saveMemory: (m) => saveAmbientMemory(m),
      backoff: async () => shouldBackoff(await readLedger()),
      onInject: (tokens, event) => {
        const entry = { ts: new Date().toISOString(), event, injected: tokens, prevented: 0 };
        void appendLedgerEntry(entry);
        reported = reportAmbientLedgerEvent(instanceId, entry); // org dashboard mirror
      },
    }));
    if (out) process.stdout.write(out);
    // Bounded flush so the dashboard mirror survives process.exit — never more
    // than 500ms on top of a turn that already injected.
    if (reported) await Promise.race([reported, new Promise((r) => setTimeout(r, 500))]);
  } catch {
    // Swallow everything — an ambient hook must never break the agent.
  }
  process.exit(0);
}

// ── ambient-credit: agent-reported prevented-token credit (§6.2) ──────────────
// Invoked as: cachly ambient-credit <tokens> [note…] — the injected context's
// footer invites the agent to call this when a recalled lesson changed its path.
// This is the client-side signal that makes the net ledger (and auto-backoff)
// meaningful before the server-side dashboard exists. Silent + exit 0 always.
if (process.argv[2] === 'ambient-credit') {
  try {
    const tokens = Math.round(Number(process.argv[3]));
    if (Number.isFinite(tokens) && tokens > 0) {
      // Cap a single credit: self-reported savings should never let one
      // enthusiastic claim mask weeks of negative balance.
      const capped = Math.min(tokens, 20_000);
      const note = process.argv.slice(4).join(' ').slice(0, 200) || undefined;
      const entry = { ts: new Date().toISOString(), event: 'credit', injected: 0, prevented: capped, note };
      await appendLedgerEntry(entry);
      await reportAmbientLedgerEvent(process.env.CACHLY_BRAIN_INSTANCE_ID ?? _defaultInstanceId, entry); // org dashboard mirror
      console.log(`✅ ambient credit recorded: ${capped} tokens${note ? ` (${note})` : ''}`);
    } else {
      console.error('Usage: npx @cachly-dev/mcp-server@latest ambient-credit <tokens-saved> [note]');
    }
  } catch { /* telemetry — never fail loudly */ }
  process.exit(0);
}

// ── ambient-stats: the honest net-token readout (§6.2) ────────────────────────
// Shows injected vs prevented and the NET — even when it is negative — plus
// whether auto-backoff is currently pausing injection.
if (process.argv[2] === 'ambient-stats') {
  const entries = await readLedger();
  const bal = netBalance(entries);
  const backing = shouldBackoff(entries);
  const recent = entries.slice(-5);
  console.log('\n🧠 Ambient Recall — net-token ledger\n');
  console.log(`   Turns recorded:   ${entries.length}`);
  console.log(`   Injected tokens:  ${bal.injected}`);
  console.log(`   Prevented tokens: ${bal.prevented} (agent-reported via ambient-credit)`);
  console.log(`   NET:              ${bal.net >= 0 ? '+' : ''}${bal.net} tokens`);
  console.log(`   Auto-backoff:     ${backing ? '🔴 ACTIVE — recent window is net-negative, injection paused' : '🟢 inactive'}`);
  if (recent.length > 0) {
    console.log('\n   Last entries:');
    for (const e of recent) {
      const what = e.prevented > 0 ? `+${e.prevented} prevented` : `-${e.injected} injected`;
      console.log(`   • ${e.ts.slice(0, 19)} ${e.event}: ${what}${e.note ? ` (${e.note})` : ''}`);
    }
  }
  console.log('');
  process.exit(0);
}

// ── doctor: one-command setup diagnosis ───────────────────────────────────────
// Walks the whole activation chain — runtime → credential → API → auth →
// instance → hooks → ledger — and prints one ✅/⚠️/❌ report with a concrete
// next step per finding. Exit 1 only on hard failures (warnings stay 0).
if (process.argv[2] === 'doctor') {
  const {
    checkNodeVersion,
    checkCredential,
    checkApiReachable,
    checkAuthAccepted,
    checkInstance,
    inspectAmbientHooks,
    checkHooks,
    checkLedger,
    renderDoctorReport,
    doctorExitCode,
  } = await import('./doctor.js');
  const checks = [
    checkNodeVersion(),
    checkCredential(JWT),
    await checkApiReachable(API_URL),
    await checkAuthAccepted(API_URL, JWT),
    checkInstance(process.env.CACHLY_BRAIN_INSTANCE_ID ?? _defaultInstanceId),
    checkHooks(inspectAmbientHooks(process.cwd())),
    checkLedger(await readLedger(), defaultLedgerPath()),
  ];
  console.log(renderDoctorReport(checks));
  process.exit(doctorExitCode(checks));
}

// ── cls-ingest: CLI entrypoint for the git post-commit hook ───────────────────
// Invoked as: cachly cls-ingest '<json>'  where json = { instance_id, source, payload }.
// Auth comes from CACHLY_JWT (embedded in the generated hook). This is a silent,
// best-effort sink: ANY problem (no JWT, bad JSON, network) exits 0 so a commit
// is never blocked or noisy. Without this command the hook was a no-op.
if (process.argv[2] === 'cls-ingest') {
  try {
    const raw = process.argv[3];
    if (!raw || !JWT) process.exit(0); // nothing to do / not authenticated → silent
    let parsed: { instance_id?: string; source?: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      process.exit(0); // malformed payload → never block the commit
    }
    const instanceId = parsed.instance_id ?? _defaultInstanceId;
    if (!instanceId || !parsed.source) process.exit(0);
    await handleTool('cls_ingest', {
      instance_id: instanceId,
      source: parsed.source,
      payload: parsed.payload ?? {},
    });
  } catch {
    // Swallow everything — a learning sink must never break `git commit`.
  }
  process.exit(0);
}

// ── Start ─────────────────────────────────────────────────────────────────────

// M2M / headless auth: if no JWT but client credentials are present, run the
// OAuth2 client_credentials grant before any credential-missing handling. This
// makes cachly fully non-interactive for CI runners, agent orchestrators and
// AI-to-AI pipelines — no device flow, no human, no browser.
if (!JWT) {
  const creds = readClientCredentialsFromEnv();
  if (creds) {
    try {
      const res = await fetch(clientCredentialsTokenUrl(creds), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildClientCredentialsBody(creds),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const tok = await res.json() as { access_token?: string };
        if (tok.access_token) {
          JWT = tok.access_token;
          setEmbedJwt(tok.access_token);
          sendFunnelEvent('m2m_auth_completed', { grant: 'client_credentials', client_id: creds.clientId });
          process.stderr.write('🤖 cachly: authenticated via client_credentials (M2M, headless).\n');
        }
      } else {
        process.stderr.write(`⚠️  cachly: client_credentials auth failed (${res.status}). Check CACHLY_CLIENT_ID / CACHLY_CLIENT_SECRET.\n`);
        sendFunnelEvent('m2m_auth_failed', { status: res.status });
      }
    } catch (err) {
      process.stderr.write(`⚠️  cachly: client_credentials auth error: ${(err as Error).message}\n`);
      sendFunnelEvent('m2m_auth_failed', { reason: 'network' });
    }
  }
}

// Credential-missing handling at startup. The critical distinction is HOW we were
// launched, because writing anything to stdout in stdio-MCP mode corrupts the
// JSON-RPC stream and exiting kills the zero-credential device-flow onboarding.
//   • Human in a real terminal (TTY), no args  → show the setup banner, exit 0.
//   • Editor as an MCP stdio server (non-TTY)  → ONE stderr hint, then KEEP RUNNING
//     so tools/list works and the first tool call starts the browser sign-in.
// Skip entirely for CLI subcommands that intentionally run without credentials.
const _cliNoAuthCommands = ['demo', 'share', 'publish', 'health', 'autosetup', 'setup', 'autopilot', 'init', 'digest', 'invite', 'badge', 'join', 'upgrade', 'bench', 'tool-specs', 'openapi', 'ambient-credit', 'ambient-stats', 'doctor'];
if (!JWT && !_cliNoAuthCommands.includes(process.argv[2] ?? '')) {
  const runningInTerminal = !process.argv[2] && process.stdout.isTTY === true && _isMain;
  if (runningInTerminal) {
    // A human ran `npx @cachly-dev/mcp-server` directly with no credentials.
    // Show them how to set up, then exit cleanly.
    const bannerSetupUrl = cachlyUrl('/setup-ai', 'first-run');
    const bannerSetupLine = `║    👉  ${bannerSetupUrl}`.padEnd(66) + '║\n';
    const banner =
      '\n' +
      '╔══════════════════════════════════════════════════════════════════╗\n' +
      '║  🧠  cachly AI Brain — Setup required                           ║\n' +
      '╠══════════════════════════════════════════════════════════════════╣\n' +
      '║                                                                  ║\n' +
      '║  CACHLY_JWT is not set. Get your free credentials at:           ║\n' +
      '║                                                                  ║\n' +
      bannerSetupLine +
      '║                                                                  ║\n' +
      '║  Then run the one-command setup wizard:                         ║\n' +
      '║                                                                  ║\n' +
      '║    npx @cachly-dev/mcp-server@latest autopilot                  ║\n' +
      '║                                                                  ║\n' +
      '║  Free tier — no credit card required.                           ║\n' +
      '╚══════════════════════════════════════════════════════════════════╝\n' +
      '\n';
    process.stdout.write(banner);
    process.exit(0);
  } else {
    // Launched as an MCP stdio server (or HTTP) without credentials. NEVER touch
    // stdout here — it carries the JSON-RPC protocol. Emit a single actionable
    // hint to stderr (shown in the editor's MCP log) and fall through so the
    // server starts and the zero-credential device flow can run on first tool call.
    process.stderr.write(
      '\n🧠 cachly: no CACHLY_JWT set yet — call any cachly tool and a 10-second browser sign-in starts automatically.\n' +
      '   (Or run once: npx @cachly-dev/mcp-server@latest autopilot)\n\n',
    );
  }
} else {
  // Warn if the JWT is already expired or expiring within the hour.
  const expMs = jwtExpiryMs(JWT);
  if (expMs !== null) {
    const minsLeft = Math.floor((expMs - Date.now()) / 60_000);
    if (minsLeft <= 0) {
      process.stderr.write(
        `\n⚠️  cachly: CACHLY_JWT expired ${Math.abs(minsLeft)} minute(s) ago.\n` +
        `   All tool calls will fail. Get a fresh token at ${cachlyUrl('/setup-ai', 'jwt-expiry')}\n\n`,
      );
    } else if (minsLeft < 60) {
      process.stderr.write(
        `\n⚠️  cachly: CACHLY_JWT expires in ${minsLeft} minute(s).\n` +
        `   Refresh it soon at ${cachlyUrl('/setup-ai', 'jwt-expiry')} to avoid interruptions.\n\n`,
      );
    }
  }
}

// ── Update nudge (non-blocking, fire-and-forget) ─────────────────────────────
// Check npm registry once per process start; if outdated, log to stderr so
// the editor's MCP log shows an actionable one-liner. Skipped if opted out.
if (!process.env.CACHLY_NO_UPDATE_CHECK) {
  (async () => {
    try {
      const res = await fetch(
        `https://registry.npmjs.org/@cachly-dev/mcp-server/latest`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (res.ok) {
        const data = await res.json() as { version: string };
        const latest = data?.version ?? '';
        if (latest && latest !== CURRENT_VERSION) {
          process.stderr.write(
            `\n⚡ cachly update available: ${CURRENT_VERSION} → ${latest}\n` +
            `   Run: npx @cachly-dev/mcp-server@latest autopilot\n\n`,
          );
        }
      }
    } catch { /* ignore – network unavailable or timeout */ }
  })();
}

const httpPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

if (httpPort) {
  // ── HTTP mode (Streamable HTTP transport) ───────────────────────────────
  // Used for Smithery URL deployment: PORT=3000 node dist/src/index.js
  const { createServer } = await import('node:http');
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const httpServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${httpPort}`);
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: CURRENT_VERSION,
        zeroResults: {
          total: zeroResultsTotal,
          last10: ZERO_RESULTS_LOG.slice(-10).map(e => ({ query: e.query, ts: new Date(e.ts).toISOString() })),
        },
      }));
      return;
    }
    if (url.pathname === '/mcp' || url.pathname === '/') {
      transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  httpServer.listen(httpPort, () => {
    process.stderr.write(`cachly-mcp HTTP server listening on :${httpPort}\n`);
  });
} else {
  // ── stdio mode (default for local editor use) ───────────────────────────
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

notify('cachly', 'startup', { version: CURRENT_VERSION, mode: process.env.MCP_HTTP_PORT ? 'http' : 'stdio' }).catch(() => undefined);

