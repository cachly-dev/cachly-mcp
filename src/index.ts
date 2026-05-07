#!/usr/bin/env node
import { jwtExpiryMs, checkJwt, handleApiError } from './auth.js';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
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

const API_URL = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
let JWT = process.env.CACHLY_JWT ?? '';
const EMBED_MODEL = process.env.CACHLY_EMBED_MODEL ?? '';
const CURRENT_VERSION = '0.10.0';

// ── Default Instance Resolution (for Smithery & single-credential setups) ────
// When CACHLY_BRAIN_INSTANCE_ID is set, tools can omit the instance_id parameter.
// When neither is set, we auto-fetch the first running instance once per process.
let _defaultInstanceId: string = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';
// Timestamp of last failed fetch — retries after 30 s (not permanently blocked).
let _defaultInstanceLastAttempt = 0;

async function resolveDefaultInstanceId(): Promise<string> {
  if (_defaultInstanceId) return _defaultInstanceId;
  if (!JWT) return '';
  // Cooldown: don't hammer the API on every tool call after a transient failure.
  const now = Date.now();
  if (_defaultInstanceLastAttempt > 0 && now - _defaultInstanceLastAttempt < 30_000) return '';
  _defaultInstanceLastAttempt = now;
  try {
    const res = await fetch(`${API_URL}/api/v1/instances`, {
      headers: { Authorization: `Bearer ${JWT}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return '';
    const data = await res.json() as { data?: Array<{ id: string; status: string }> };
    const instances = (data?.data ?? []) as Array<{ id: string; status: string }>;
    // Prefer running, fall back to provisioning so the ID is resolved even during startup.
    const best = instances.find(i => i.status === 'running') ?? instances.find(i => i.status === 'provisioning');
    if (best) {
      _defaultInstanceId = best.id;
      _defaultInstanceLastAttempt = 0;
      return _defaultInstanceId;
    }
  } catch { /* transient error — will retry after cooldown */ }
  return '';
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
  const AUTH_BASE = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
  const CLIENT_ID = 'cachly-cli';
  try {
    const res = await fetch(`${AUTH_BASE}/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${CLIENT_ID}&scope=openid`,
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
      deadline: Date.now() + 10 * 60 * 1000, // 10 min
      polling: false,
    };
  } catch { return null; }
}

async function pollDeviceFlow(flow: DeviceFlowState): Promise<'pending' | 'expired' | 'done'> {
  if (Date.now() > flow.deadline) return 'expired';
  const AUTH_BASE = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
  const CLIENT_ID = 'cachly-cli';
  try {
    const res = await fetch(`${AUTH_BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `client_id=${CLIENT_ID}&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${flow.deviceCode}`,
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json() as { access_token?: string; error?: string };
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
      // Auto-provision: find or create the user's brain instance.
      _defaultInstanceLastAttempt = 0;
      await resolveDefaultInstanceId();
      if (!_defaultInstanceId) {
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
              status?: string;
            };
            const id = body.instance?.id ?? body.instance_id;
            if (id) _defaultInstanceId = id;
          }
        } catch { /* non-fatal */ }
      }
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
      return 'done';
    }
    if (data.error === 'slow_down') flow.pollInterval = Math.min(flow.pollInterval + 2000, 15000);
    return 'pending';
  } catch { return 'pending'; }
}
// ── Confidence utils (imported from confidence.ts) ──────────────────────────
import { calculateConfidence, confidenceBadge, STRUCTURED_TEMPLATES,
         CONFIDENCE_WARN_VALUE, CONFIDENCE_STALE_VALUE, CONFIDENCE_WARN_DAYS,
         CONFIDENCE_STALE_DAYS,
         simpleHash } from './confidence.js';


// ── Embeddings (imported from embeddings.ts) ────────────────────────────────
import { embedConfig, setEmbedJwt, EMBED_PROVIDER, computeEmbedding,
         hasEmbedProvider, embedProviderHint } from './embeddings.js';

// ── Search Engine (imported from search.ts) ─────────────────────────────────
import { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS,
         katakanaToRomaji, arabicLightStem, expandCrossLingual, CROSS_LINGUAL_MAP,
         keywordSearch, ZERO_RESULTS_LOG, zeroResultsTotal, indexVocab as _indexVocab } from './search.js';
import type { KeywordMatch } from './search.js';

// ── Exported for testing (re-export from search.ts) ─────────────────────────
export { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS,
         katakanaToRomaji, arabicLightStem, expandCrossLingual, CROSS_LINGUAL_MAP };

// ── Types ─────────────────────────────────────────────────────────────────────
// Instance is imported from handlers/brain.ts

interface CreateResponse {
  instance_id: string;
  checkout_url?: string;
  status: string;
}

interface SemanticSearchResponse {
  found: boolean;
  id?: string;
  similarity?: number;
  prompt?: string;
}

// ── Connection pool ───────────────────────────────────────────────────────────

/** Reuse Redis connections across tool calls (keyed by instance_id). */
const pool = new Map<string, Redis>();

async function getConnection(instance_id: string): Promise<Redis> {
  if (!instance_id) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'No instance_id provided and no running instance could be resolved automatically.\n\n' +
      '• Set CACHLY_BRAIN_INSTANCE_ID in your MCP config, or\n' +
      '• Pass instance_id explicitly to the tool, or\n' +
      '• Run `list_instances` to see your available instances.'
    );
  }

  if (pool.has(instance_id)) return pool.get(instance_id)!;

  // Fetch instance, waiting up to 25 s if it is still provisioning.
  // This covers the zero-friction path: device-flow auth → auto-provision → first tool call
  // all happen in quick succession and the instance isn't running yet.
  let inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
  if (inst.status === 'provisioning') {
    const deadline = Date.now() + 25_000;
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
    const hint = inst.status === 'provisioning'
      ? `⏳ Brain instance "${inst.name}" is still starting up.\n\nThis usually finishes within 30 seconds. Please try again in a moment.`
      : `Brain instance "${inst.name}" is not reachable (status: ${inst.status}).\n\n` +
        `• View your instance at: https://cachly.dev/instances\n` +
        `• Run \`get_api_status\` for a full diagnostic.`;
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
  } catch {
    // Fallback: use TLS flag from instance metadata
  }

  const client = new Redis({
    host: inst.host,
    port: inst.port,
    password: password || undefined,
    ...(tlsEnabled ? { tls: {} } : {}),
    lazyConnect: true,
    enableReadyCheck: true,
    connectTimeout: 8000,
    retryStrategy: () => null,  // fail fast, no reconnect loops in MCP context
  });

  const evict = () => pool.delete(instance_id);
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

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const detail = (body as { error?: string }).error ?? res.statusText;
    handleApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

import { detectNamespace } from './namespace.js';

// ── CKG (imported from ckg.ts) ─────────────────────────────────────────────
import type { CKGEdge, CKGNode } from './ckg.js';
import { ckgSlug, extractProblemConcept, ckgUpsertNode, ckgUpdateEdge } from './ckg.js';
import { handleBrainTool } from './handlers/brain.js';
import { handleContextTool } from './handlers/context.js';
import { handleInstanceTool } from './handlers/instances.js';
import { handleCacheTool } from './handlers/cache.js';
import { handleTeamTool } from './handlers/team.js';
import { handleRoadmapTool } from './handlers/roadmap.js';
import { handleAdvancedTool } from './handlers/advanced.js';
import { handleSyndicateTool } from './handlers/syndicate.js';
import { handleFedbrainTool } from './handlers/fedbrain.js';
import type { Instance } from './handlers/brain.js';

// ── Tools (imported from tools.ts) ─────────────────────────────────────────
import { TOOLS } from './tools.js';


// ── Handlers ──────────────────────────────────────────────────────────────────

// Fires once per process when no JWT is set (anonymous, opt-out via CACHLY_NO_TELEMETRY=1)
let _telemetryPingSent = false;
async function sendAnonymousTelemetry(toolName: string): Promise<void> {
  if (_telemetryPingSent) return;
  if (process.env.CACHLY_NO_TELEMETRY === '1') return;
  _telemetryPingSent = true;
  // Detect editor from common env vars injected by IDE extensions
  const editor = process.env.CURSOR_TRACE_ID ? 'cursor'
    : process.env.WINDSURF_SESSION_ID ? 'windsurf'
    : process.env.GITHUB_COPILOT_WORKSPACE ? 'copilot'
    : process.env.CLAUDE_CODE_ENTRYPOINT ? 'claude'
    : 'unknown';
  try {
    await fetch(`${API_URL}/api/v1/telemetry/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'first_call_no_jwt', version: CURRENT_VERSION, editor, tool: toolName }),
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* fire-and-forget, never block the user */ }
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  // Guard: if no JWT, return actionable onboarding message instead of HTTP 401
  if (!JWT) {
    void sendAnonymousTelemetry(name);

    // ── Zero-credential device flow ─────────────────────────────────────
    // 1st call: start device flow, return code + URL
    // 2nd+ calls: poll for token; once authenticated, proceed transparently
    if (_deviceFlow) {
      const result = await pollDeviceFlow(_deviceFlow);
      if (result === 'done') {
        // Auth complete — re-enter handleTool with now-valid JWT
        return handleTool(name, args);
      }
      if (result === 'expired') {
        _deviceFlow = null;
        return '⌛ **Authentication timed out.** Please call any tool again to restart the sign-in flow.';
      }
      // Still pending
      return [
        '⏳ **Waiting for authentication...**',
        '',
        `Sign in at: **${_deviceFlow.verifyUrl}**`,
        `Enter code: **${_deviceFlow.userCode}**`,
        '',
        'Once you complete sign-in in your browser, call this tool again and it will proceed automatically.',
      ].join('\n');
    }

    // No pending flow — start a new one
    const flow = await startDeviceFlow();
    if (flow) {
      _deviceFlow = flow;
      return [
        '🧠 **cachly AI Brain — One-click sign in**',
        '',
        '1. Open this URL in your browser (it may open automatically):',
        `   **${flow.verifyUrl}**`,
        '',
        `2. Enter this code if prompted: **${flow.userCode}**`,
        '',
        '3. After sign-in, call this tool again — it will proceed automatically.',
        '',
        '✨ Free tier includes: 1 Brain instance, persistent memory, 63 MCP tools.',
        '   No credit card required.',
      ].join('\n');
    }

    // Device flow unavailable (network issue) — fall back to manual setup
    return [
      '🧠 **cachly AI Brain — Setup required**',
      '',
      'Run the setup wizard once in your terminal:',
      '   ```',
      '   npx @cachly-dev/mcp-server@latest setup',
      '   ```',
      '',
      'Or get your API key at: https://cachly.dev/setup-ai',
      '',
      '✨ Free tier includes: 1 Brain instance, persistent memory, semantic search.',
    ].join('\n');
  }

  // Auto-resolve instance_id from env / API when not provided in args
  if (!args.instance_id) {
    const defaultId = await resolveDefaultInstanceId();
    if (defaultId) args = { ...args, instance_id: defaultId };
  }

  // Delegate brain tools (learn, recall, session, etc.)
  const brainResult = await handleBrainTool(name, args, getConnection, apiFetch);
  if (brainResult !== null) return brainResult;

  // Delegate context tools (remember/recall/list/forget)
  const contextResult = await handleContextTool(name, args, getConnection, apiFetch);
  if (contextResult !== null) return contextResult;

  // Delegate instance + cache tools
  const instanceResult = await handleInstanceTool(name, args, getConnection, apiFetch);
  if (instanceResult !== null) return instanceResult;

  const cacheResult = await handleCacheTool(name, args, getConnection, apiFetch);
  if (cacheResult !== null) return cacheResult;

  // Delegate team/brain advanced tools
  const teamResult = await handleTeamTool(name, args, getConnection, apiFetch);
  if (teamResult !== null) return teamResult;

  const roadmapResult = await handleRoadmapTool(name, args, getConnection, apiFetch);
  if (roadmapResult !== null) return roadmapResult;

  const advancedResult = await handleAdvancedTool(name, args, getConnection, apiFetch);
  if (advancedResult !== null) return advancedResult;

  const syndicateResult = await handleSyndicateTool(name, args, getConnection, apiFetch);
  if (syndicateResult !== null) return syndicateResult;

  const fedbrainResult = await handleFedbrainTool(name, args, getConnection, apiFetch);
  if (fedbrainResult !== null) return fedbrainResult;

  switch (name) {
    // ── Instance management ──────────────────────────────────────────────
    case 'get_api_status': {
      // Check health
      let healthStatus = 'unknown';
      try {
        const healthRes = await fetch(`${API_URL}/health`);
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
          `💡 Get your API token at https://cachly.dev/instances → Settings → API Token`,
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
          instanceInfo = '\n\n🧠 **Brain Instances:** none — create one at https://cachly.dev/instances';
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

      return [
        `📡 **cachly API Status**`,
        ``,
        `  🌐 API:    ${API_URL}`,
        `  💓 Health: ${healthStatus}`,
        ``,
        `🔑 **Auth:**`,
        authInfo,
        instanceInfo,
      ].join('\n');
    }

    default:
      return `⚠️ Unknown tool: ${name}`;
  }
}

const server = new Server(
  { name: 'cachly-mcp', version: CURRENT_VERSION },
  { capabilities: { tools: {} } }
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
      await handleTool('session_start', { instance_id: instanceId, focus: 'auto (MCP session)' });
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
  const sessionTools = new Set(['session_start', 'session_end', 'auto_learn_session']);
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
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, (err as Error).message);
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

// ── CLI helpers ───────────────────────────────────────────────────────────────

const EDITOR_FILES: Record<string, string> = {
  claude:   '.mcp.json',
  cursor:   '.cursor/mcp.json',
  windsurf: '.windsurf/mcp.json',
  copilot:  '.vscode/mcp.json',
  continue: '.continue/config.json',
  cline:    '.vscode/mcp.json',              // Cline respects VS Code project MCP config
  zed:      '.zed/settings.json',            // Zed project-level context_servers
};

const CLAUDE_MD_MARKER_START = '<!-- cachly-brain-start -->';
const CLAUDE_MD_MARKER_END   = '<!-- cachly-brain-end -->';

function buildMcpConfig(apiKey: string, instanceId: string, editor: string): string {
  if (editor === 'continue') {
    return JSON.stringify({
      experimental: {
        modelContextProtocolServers: [{
          transport: { type: 'stdio', command: 'npx', args: ['-y', '@cachly-dev/mcp-server@latest'] },
          env: { CACHLY_API_URL: 'https://api.cachly.dev', CACHLY_JWT: apiKey, CACHLY_BRAIN_INSTANCE_ID: instanceId },
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
            env: { CACHLY_API_URL: 'https://api.cachly.dev', CACHLY_JWT: apiKey, CACHLY_BRAIN_INSTANCE_ID: instanceId },
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
        env: { CACHLY_API_URL: 'https://api.cachly.dev', CACHLY_JWT: apiKey, CACHLY_BRAIN_INSTANCE_ID: instanceId },
      },
    },
  }, null, 2);
}

function buildClaudeMdBlock(instanceId: string): string {
  return `${CLAUDE_MD_MARKER_START}
## Cachly AI Brain

The Cachly MCP server is available as tool \`cachly\`.
Your instance ID: \`${instanceId}\`

> **Sessions are fully automatic** (MCP ≥ 0.5.3).
> The Brain starts tracking when you call any tool for the first time and saves a summary when your editor closes. You never need to call \`session_start\` or \`session_end\` manually.

---

### Before editing any file — WIP-registry (prevents half-finished code across sessions):
\`\`\`
remember_context(
  instance_id = "${instanceId}",
  key         = "wip-registry",
  content     = "EDITING: <file:line> — goal: <what you are implementing>",
  category    = "bug",
  ttl         = 86400,
)
\`\`\`
After the edit is complete, update \`content\` to \`"DONE: <file> — <what was completed>"\`.

### After fixing any bug or solving a tricky problem:
\`\`\`
learn_from_attempts(
  instance_id = "${instanceId}",
  topic       = "category:keyword",
  outcome     = "success",
  what_worked = "...",
  what_failed = "...",
  severity    = "critical" | "major" | "minor",
  file_paths  = ["path/to/file"],
  commands    = ["the command that worked"],
  tags        = ["tag1"],
)
\`\`\`

### Before starting any task — recall relevant lessons first:
\`\`\`
smart_recall(
  instance_id = "${instanceId}",
  query       = "<describe what you are about to do>",
)
\`\`\`

### Half-finished code rule:
Never commit code that does not compile. Run \`tsc --noEmit\` / \`go build ./...\` before every commit.
If a session ends mid-task, save the WIP-registry entry so the next session picks up exactly where you left off.
${CLAUDE_MD_MARKER_END}`;
}

async function writeClaudeMd(projectDir: string, instanceId: string): Promise<'written' | 'updated' | 'appended'> {
  const { writeFile, appendFile, readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  const claudeMdPath = resolve(projectDir, 'CLAUDE.md');
  const block = '\n' + buildClaudeMdBlock(instanceId) + '\n';

  if (existsSync(claudeMdPath)) {
    const existing = await readFile(claudeMdPath, 'utf-8');
    if (existing.includes(CLAUDE_MD_MARKER_START)) {
      // Idempotent update: replace existing block (new instance-id, refreshed content)
      const updated = existing.replace(
        new RegExp(`${CLAUDE_MD_MARKER_START}[\\s\\S]*?${CLAUDE_MD_MARKER_END}`),
        buildClaudeMdBlock(instanceId)
      );
      await writeFile(claudeMdPath, updated, 'utf-8');
      return 'updated';
    }
    await appendFile(claudeMdPath, block, 'utf-8');
    return 'appended';
  }
  await writeFile(claudeMdPath, block.trimStart(), 'utf-8');
  return 'written';
}

// ── CLI: cachly init ──────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server init --instance-id <id> --api-key <key> [--editor claude|cursor|windsurf|copilot|continue] [--project-dir /path]

if (process.argv[2] === 'init') {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { resolve, dirname } = await import('node:path');

  const argv = process.argv.slice(3);
  const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i !== -1 ? argv[i + 1] : undefined; };

  const instanceId = flag('instance-id') ?? process.env.CACHLY_BRAIN_INSTANCE_ID;
  const apiKey     = flag('api-key')     ?? process.env.CACHLY_JWT;
  const editor     = (flag('editor') ?? 'claude').toLowerCase();
  const projectDir = resolve(flag('project-dir') ?? '.');

  if (!instanceId || !apiKey) {
    console.error('\nUsage: npx @cachly-dev/mcp-server@latest init --instance-id <uuid> --api-key <cky_live_...> [--editor claude|cursor|windsurf|copilot|continue] [--project-dir /path]\n');
    console.error('Or run interactively (no flags needed): npx @cachly-dev/mcp-server@latest setup\n');
    console.error('Get your credentials from: https://cachly.dev/setup-ai\n');
    process.exit(1);
  }

  const configFile = EDITOR_FILES[editor] ?? '.mcp.json';
  const configPath = resolve(projectDir, configFile);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, buildMcpConfig(apiKey, instanceId, editor), 'utf-8');
  console.log(`\n✅ Written: ${configFile}`);

  // Always write CLAUDE.md (idempotent — safe to run multiple times)
  const result = await writeClaudeMd(projectDir, instanceId);
  const action = result === 'updated' ? '✅ Updated' : result === 'appended' ? '✅ Appended to' : '✅ Written';
  console.log(`${action}: CLAUDE.md`);

  // ── CLS Phase 4: Auto-install git post-commit hook ─────────────────────────
  try {
    const { existsSync } = await import('node:fs');
    const gitHookDir = resolve(projectDir, '.git', 'hooks');
    const hookPath   = resolve(gitHookDir, 'post-commit');
    if (existsSync(resolve(projectDir, '.git'))) {
      await mkdir(gitHookDir, { recursive: true });
      const hookScript = [
        `#!/bin/sh`,
        `# cachly CLS — Continuous Learning Stream (installed by cachly init)`,
        `# Runs silently on every commit to keep your brain up to date.`,
        `CACHLY_INSTANCE="${instanceId}"`,
        `SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
        `MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1 | tr '"' "'" | cut -c1-200)`,
        `FILES=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | tr '\\n' ',' | sed 's/,$//')`,
        `node -e "try{require('child_process').execSync('npx @cachly-dev/mcp-server@latest cls-ingest \\''+ JSON.stringify({instance_id:'$CACHLY_INSTANCE',source:'git_commit',payload:{message:'$MSG',sha:'$SHA',files:'$FILES'.split(',').filter(Boolean)}})+'\\'' ,{stdio:'ignore',timeout:5000})}catch(e){}" 2>/dev/null &`,
        `exit 0`,
      ].join('\n');
      let existing = '';
      try { const { readFile } = await import('node:fs/promises'); existing = await readFile(hookPath, 'utf-8'); } catch { /* no existing hook */ }
      if (existing && !existing.includes('cachly CLS')) {
        // Append to existing hook
        await writeFile(hookPath, existing.trimEnd() + '\n\n' + hookScript + '\n', 'utf-8');
        console.log(`✅ Appended: .git/hooks/post-commit (CLS hook)`);
      } else if (!existing) {
        await writeFile(hookPath, hookScript + '\n', 'utf-8');
        const { chmod } = await import('node:fs/promises');
        await chmod(hookPath, 0o755);
        console.log(`✅ Written: .git/hooks/post-commit (CLS hook)`);
      } else {
        console.log(`✓  CLS hook already present in .git/hooks/post-commit`);
      }
    }
  } catch { /* non-critical — git hook is a best-effort feature */ }

  console.log(`\n🧠 Cachly AI Brain configured for ${editor === 'claude' ? 'Claude Code' : editor}!`);
  console.log(`   Restart your editor — the \`cachly\` MCP tools will appear.\n`);
  process.exit(0);
}

// ── CLI: cachly setup (interactive — no flags required) ───────────────────────
// Usage: npx @cachly-dev/mcp-server setup

if (process.argv[2] === 'setup') {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { createInterface } = await import('node:readline');

  // --yes / -y → non-interactive mode (skips all prompts, picks defaults)
  const nonInteractive = process.argv.includes('--yes') || process.argv.includes('-y');

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
    const AUTH_BASE = 'https://auth.cachly.dev/realms/cachly/protocol/openid-connect';
    const CLIENT_ID = 'cachly-cli';

    console.log('Step 1: Sign in to cachly (free, no credit card)\n');

    // Start device flow
    let deviceCode = '', userCode = '', verifyUri = '', pollInterval = 5000;
    try {
      const deviceRes = await fetch(`${AUTH_BASE}/auth/device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `client_id=${CLIENT_ID}&scope=openid`,
      });
      if (!deviceRes.ok) throw new Error(`Device flow error: HTTP ${deviceRes.status}`);
      const data = await deviceRes.json() as {
        device_code: string; user_code: string;
        verification_uri_complete: string; interval: number;
      };
      deviceCode    = data.device_code;
      userCode      = data.user_code;
      verifyUri     = data.verification_uri_complete;
      pollInterval  = (data.interval ?? 5) * 1000;
    } catch (e) {
      console.error(`\nFailed to start device flow: ${(e as Error).message}`);
      console.error('Falling back: sign in at https://cachly.dev/setup-ai and paste your API token.\n');
      token = await ask('   Paste API token (cky_live_...): ');
      if (!token) { console.error('\nToken is required. Aborting.\n'); rl.close(); process.exit(1); }
      console.log('');
      deviceCode = ''; // mark as fallback so we skip polling
    }

    if (deviceCode!) {
      // Open browser
      console.log(`   Code: \x1b[1;33m${userCode!}\x1b[0m`);
      console.log(`   URL:  ${verifyUri!}\n`);
      try {
        const { execSync } = await import('node:child_process');
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execSync(`${openCmd} "${verifyUri!}"`, { stdio: 'ignore' });
        console.log('   ✓  Browser opened — confirm the code above to continue...\n');
      } catch {
        console.log('   👉  Open the URL above in your browser and enter the code.\n');
      }

      // Poll for token
      process.stdout.write('   Waiting for authorization');
      const deadline = Date.now() + 10 * 60 * 1000; // 10 min
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, pollInterval!));
        process.stdout.write('.');
        try {
          const tokenRes = await fetch(`${AUTH_BASE}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `client_id=${CLIENT_ID}&grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=${deviceCode!}`,
          });
          const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
          if (tokenData.access_token) {
            token = tokenData.access_token;
            console.log(' \x1b[32m✓ Authorized!\x1b[0m\n');
            break;
          }
          // authorization_pending = keep polling; slow_down = increase interval
          if (tokenData.error === 'slow_down') pollInterval = Math.min(pollInterval! + 2000, 15000);
          else if (tokenData.error && tokenData.error !== 'authorization_pending') {
            console.error(`\nAuth error: ${tokenData.error}. Aborting.\n`);
            rl.close(); process.exit(1);
          }
        } catch { /* network hiccup — keep polling */ }
      }
      if (!token) { console.error('\nTimed out waiting for authorization. Aborting.\n'); rl.close(); process.exit(1); }
      console.log('');
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
    } catch (e) {
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
      console.error('Token rejected. Get a valid token at https://cachly.dev/setup-ai\n');
      try {
        const { execSync } = await import('node:child_process');
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execSync(`${openCmd} https://cachly.dev/setup-ai`, { stdio: 'ignore' });
      } catch { /* ignore */ }
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
        process.stdout.write('⏳ Waiting for instance to start');
        for (let attempt = 0; attempt < 15; attempt++) {
          await new Promise(r => setTimeout(r, 2000));
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
      console.error('\nCould not create an instance automatically. Opening https://cachly.dev/instances …\n');
      try {
        const { execSync } = await import('node:child_process');
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        execSync(`${openCmd} https://cachly.dev/instances`, { stdio: 'ignore' });
      } catch { /* ignore */ }
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

  // ── Step 4: Write editor configs ──────────────────────────────────────────
  for (const editor of editorsToSetup) {
    const configFile = EDITOR_FILES[editor] ?? '.mcp.json';
    const configPath = resolve(cwd, configFile);
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, buildMcpConfig(token, instance.id, editor), 'utf-8');
    console.log(`✅ Written: ${configFile}`);
  }

  // ── Step 5: CLAUDE.md (always — idempotent) ───────────────────────────────
  const mdResult = await writeClaudeMd(cwd, instance.id);
  const mdLabel = mdResult === 'updated' ? '✅ Updated' : mdResult === 'appended' ? '✅ Appended to' : '✅ Written';
  console.log(`${mdLabel}: CLAUDE.md\n`);

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
    } else {
      console.log(' (skipped)');
    }
  } catch { console.log(' (skipped)'); }

  console.log(`\n🧠  Done! Restart your editor — the \`cachly\` MCP tools will appear.`);
  console.log(`   Your AI now has persistent memory across every session.\n`);
  console.log(`   Dashboard: https://cachly.dev/instances/${instance.id}\n`);

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
    const { existsSync } = await import('node:fs');
    const { writeFile: wf2, mkdir: mk2, chmod: ch2, readFile: rf2 } = await import('node:fs/promises');
    const { resolve: res2 } = await import('node:path');
    const setupProjectDir = process.cwd();
    const gitHookDir2 = res2(setupProjectDir, '.git', 'hooks');
    const hookPath2   = res2(gitHookDir2, 'post-commit');
    if (existsSync(res2(setupProjectDir, '.git'))) {
      await mk2(gitHookDir2, { recursive: true });
      const hs2 = [
        `#!/bin/sh`,
        `# cachly CLS — Continuous Learning Stream (installed by cachly setup)`,
        `CACHLY_INSTANCE="${instance.id}"`,
        `SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
        `MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1 | tr '"' "'" | cut -c1-200)`,
        `FILES=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | tr '\\n' ',' | sed 's/,$//')`,
        `node -e "try{require('child_process').execSync('npx @cachly-dev/mcp-server@latest cls-ingest \\''+ JSON.stringify({instance_id:'$CACHLY_INSTANCE',source:'git_commit',payload:{message:'$MSG',sha:'$SHA',files:'$FILES'.split(',').filter(Boolean)}})+'\\'' ,{stdio:'ignore',timeout:5000})}catch(e){}" 2>/dev/null &`,
        `exit 0`,
      ].join('\n');
      let ex2 = '';
      try { ex2 = await rf2(hookPath2, 'utf-8'); } catch { /* no existing */ }
      if (!ex2) {
        await wf2(hookPath2, hs2 + '\n', 'utf-8');
        await ch2(hookPath2, 0o755);
        console.log(`\n✅  CLS git hook installed — your brain will learn from every commit.`);
      } else if (!ex2.includes('cachly CLS')) {
        await wf2(hookPath2, ex2.trimEnd() + '\n\n' + hs2 + '\n', 'utf-8');
        console.log(`\n✅  CLS git hook appended to existing post-commit.`);
      }
    }
  } catch { /* non-critical */ }

  rl.close();
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

// ── Start ─────────────────────────────────────────────────────────────────────

// Warn on stderr when credentials are missing so the user sees a clear
// actionable message in their editor's MCP log instead of silent failures.
if (!JWT) {
  process.stderr.write(
    '\n' +
    '╔══════════════════════════════════════════════════════════════════╗\n' +
    '║  🧠  cachly AI Brain — Setup required                           ║\n' +
    '╠══════════════════════════════════════════════════════════════════╣\n' +
    '║                                                                  ║\n' +
    '║  CACHLY_JWT is not set. Get your free credentials at:           ║\n' +
    '║                                                                  ║\n' +
    '║    👉  https://cachly.dev/setup-ai                              ║\n' +
    '║                                                                  ║\n' +
    '║  Then run the interactive setup wizard:                         ║\n' +
    '║                                                                  ║\n' +
    '║    npx @cachly-dev/mcp-server@latest setup                      ║\n' +
    '║                                                                  ║\n' +
    '║  Free tier — no credit card required.                           ║\n' +
    '╚══════════════════════════════════════════════════════════════════╝\n' +
    '\n',
  );
} else {
  // Warn if the JWT is already expired or expiring within the hour.
  const expMs = jwtExpiryMs(JWT);
  if (expMs !== null) {
    const minsLeft = Math.floor((expMs - Date.now()) / 60_000);
    if (minsLeft <= 0) {
      process.stderr.write(
        `\n⚠️  cachly: CACHLY_JWT expired ${Math.abs(minsLeft)} minute(s) ago.\n` +
        `   All tool calls will fail. Get a fresh token at https://cachly.dev/setup-ai\n\n`,
      );
    } else if (minsLeft < 60) {
      process.stderr.write(
        `\n⚠️  cachly: CACHLY_JWT expires in ${minsLeft} minute(s).\n` +
        `   Refresh it soon at https://cachly.dev/setup-ai to avoid interruptions.\n\n`,
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
            `   Run: npx @cachly-dev/mcp-server@latest setup\n\n`,
          );
        }
      }
    } catch { /* ignore – network unavailable or timeout */ }
  })();
}

const httpPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

if (httpPort) {
  // ── HTTP mode (Streamable HTTP transport) ───────────────────────────────
  // Used for Smithery URL deployment: PORT=3000 node dist/index.js
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

