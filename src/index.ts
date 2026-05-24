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
const CURRENT_VERSION = '0.10.27';

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
      sendFunnelEvent('device_flow_completed');
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
          } else {
            // Log so telemetry can detect free-tier auto-provision failures
            void fetch(`${API_URL}/api/v1/telemetry/mcp`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${JWT}` },
              body: JSON.stringify({ event: 'auto_provision_failed', status: autoRes.status, version: CURRENT_VERSION }),
              signal: AbortSignal.timeout(3000),
            }).catch(() => {});
          }
        } catch { /* non-fatal — server unreachable, getConnection will surface the error */ }
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
    let hint: string;
    if (inst.status === 'provisioning') {
      hint = `⏳ Brain instance "${inst.name}" is still starting up.\n\nFirst-time provisioning typically takes 1–3 minutes. Please retry in a moment — the instance will be ready soon.`;
    } else if (inst.status === 'failed') {
      hint = `❌ Brain instance "${inst.name}" failed to start.\n\n` +
        `Our system will retry automatically. Check status at: https://cachly.dev/instances\n` +
        `If this persists, contact support@cachly.dev.`;
    } else if (inst.status === 'suspended') {
      hint = `⏸ Brain instance "${inst.name}" is suspended (billing issue).\n\n` +
        `Update your payment method at: https://cachly.dev/billing`;
    } else if (inst.status === 'pending_payment') {
      hint = `💳 Brain instance "${inst.name}" is waiting for payment.\n\n` +
        `Complete your checkout at: https://cachly.dev/instances`;
    } else {
      hint = `Brain instance "${inst.name}" is not reachable (status: ${inst.status}).\n\n` +
        `• View your instance at: https://cachly.dev/instances\n` +
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
// Fires once per process on the first successful Brain tool call — key activation metric
let _firstCallSuccessSent = false;

function detectEditor(): string {
  return process.env.CURSOR_TRACE_ID ? 'cursor'
    : process.env.WINDSURF_SESSION_ID ? 'windsurf'
    : process.env.GITHUB_COPILOT_WORKSPACE ? 'copilot'
    : process.env.CLAUDE_CODE_ENTRYPOINT ? 'claude'
    : 'unknown';
}

function sendFunnelEvent(event: string, extra?: Record<string, unknown>): void {
  if (process.env.CACHLY_NO_TELEMETRY === '1') return;
  void fetch(`${API_URL}/api/v1/telemetry/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event, version: CURRENT_VERSION, editor: detectEditor(),
      ...(JWT ? { jwt: JWT } : {}),
      ...extra,
    }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {/* fire-and-forget */});
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
      sendFunnelEvent('device_flow_started', { tool: name });
      // Try to open the browser automatically — fire-and-forget, never block
      void (async () => {
        try {
          const { exec } = await import('node:child_process');
          const url = flow.verifyUrl;
          const cmd = process.platform === 'win32' ? `start "" "${url}"`
            : process.platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
          exec(cmd);
        } catch { /* non-critical */ }
      })();
      return [
        '🧠 **cachly AI Brain — sign in to activate** (browser opening...)',
        '',
        `👉 **${flow.verifyUrl}**`,
        '',
        `Code: **${flow.userCode}** (pre-filled if browser opened automatically)`,
        '',
        'After sign-in: call **any tool again** — your Brain activates instantly.',
        '',
        '✨ Free forever · No credit card · 89 MCP tools · GDPR · EU servers',
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
  if (brainResult !== null) {
    if (!_firstCallSuccessSent && JWT) {
      _firstCallSuccessSent = true;
      sendFunnelEvent('first_call_success', { tool: name, instance_id: args.instance_id ?? _defaultInstanceId ?? '' });
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
      sendFunnelEvent('session_start', telemetryExtra);
      // When brain has lessons, session_start acts as an implicit recall.
      // Firing recall_best_solution here increments BrainRecallCount so the
      // dashboard nudge + first-recall email trigger correctly.
      const resultText = typeof brainResult === 'object' && brainResult !== null && 'content' in brainResult
        ? JSON.stringify(brainResult)
        : String(brainResult ?? '');
      if (!resultText.includes('Welcome! Your AI Brain is live.') && resultText.length > 100) {
        sendFunnelEvent('recall_best_solution', telemetryExtra);
      }
    } else if (name === 'session_end') {
      sendFunnelEvent('session_end', telemetryExtra);
    } else if (name === 'smart_recall') {
      sendFunnelEvent('smart_recall', telemetryExtra);
    }
    return brainResult;
  }

  // Delegate context tools (remember/recall/list/forget)
  const contextResult = await handleContextTool(name, args, getConnection, apiFetch);
  if (contextResult !== null) {
    if (!_firstCallSuccessSent && JWT) {
      _firstCallSuccessSent = true;
      sendFunnelEvent('first_call_success', { tool: name, instance_id: args.instance_id ?? _defaultInstanceId ?? '' });
    }
    return contextResult;
  }

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
  if (syndicateResult !== null) {
    // brain_predict is in syndicate handler — track telemetry here.
    if (name === 'brain_predict') {
      const instanceId = (args.instance_id as string | undefined) ?? _defaultInstanceId ?? '';
      const telemetryExtra = JWT ? { api_key: JWT, instance_id: instanceId } : { instance_id: instanceId };
      sendFunnelEvent('brain_predict', telemetryExtra);
    }
    return syndicateResult;
  }

  const fedbrainResult = await handleFedbrainTool(name, args, getConnection, apiFetch);
  if (fedbrainResult !== null) {
    // brain_from_git and brain_predict_failures are in fedbrain handler.
    const instanceId = (args.instance_id as string | undefined) ?? _defaultInstanceId ?? '';
    const telemetryExtra = JWT ? { api_key: JWT, instance_id: instanceId } : { instance_id: instanceId };
    if (name === 'brain_from_git') {
      sendFunnelEvent('brain_from_git', telemetryExtra);
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

// mergeMcpConfig reads an existing config file (if any), merges the cachly entry,
// and returns the updated JSON string — preserving all other MCP servers and settings.
async function mergeMcpConfig(
  configPath: string,
  apiKey: string,
  instanceId: string,
  editor: string,
  fsOps: { readFile: (p: string, enc: BufferEncoding) => Promise<string>; existsSync: (p: string) => boolean },
): Promise<string> {
  const cachlyEntry = {
    command: 'npx',
    args: ['-y', '@cachly-dev/mcp-server@latest'],
    env: { CACHLY_API_URL: 'https://api.cachly.dev', CACHLY_JWT: apiKey, CACHLY_BRAIN_INSTANCE_ID: instanceId },
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

function buildClaudeMdBlock(instanceId: string): string {
  return `${CLAUDE_MD_MARKER_START}
## Cachly AI Brain — Always Active

The Brain MCP server runs automatically. Instance: \`${instanceId}\`

Sessions start and end automatically — never call \`session_start\` or \`session_end\`.

---

### BEFORE every task (mandatory — no exceptions):
\`\`\`
smart_recall(instance_id="${instanceId}", query="<what you are about to do>")
\`\`\`
Report any relevant lessons found to the user before proceeding.

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



// ── CLI: cachly digest ────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest digest
// Weekly brain summary — what your AI learned this week. Shareable output.

if (process.argv[2] === 'digest') {
  const apiKey = process.env.CACHLY_JWT ?? '';
  const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';

  if (!apiKey || !instanceId) {
    console.log('\n⚠️  CACHLY_JWT and CACHLY_BRAIN_INSTANCE_ID must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest setup\n');
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

    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log('│  \x1b[32m📋 Share this digest:\x1b[0m                                        │');
    console.log('│  \x1b[90m   npx @cachly-dev/mcp-server@latest share\x1b[0m                   │');
    console.log('│  \x1b[90m   Add more: npx @cachly-dev/mcp-server@latest invite\x1b[0m         │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    // Pro tip for cron
    console.log('  \x1b[2m💡 Automate: add to crontab for a weekly team email\x1b[0m');
    console.log('  \x1b[2m   0 9 * * 1 npx @cachly-dev/mcp-server@latest digest\x1b[0m');
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
  const { createInterface } = await import('node:readline');
  const apiKey = process.env.CACHLY_JWT ?? '';

  if (!apiKey) {
    console.log('\n⚠️  CACHLY_JWT must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest setup\n');
    process.exit(1);
  }

  let email = process.argv[3] ?? '';

  if (!email) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    email = await new Promise<string>((resolve) => {
      rl.question('\n  📬 Teammate email to invite: ', (ans) => { rl.close(); resolve(ans.trim()); });
    });
  }

  if (!email || !email.includes('@')) {
    console.log('\n❌ Invalid email address.\n');
    process.exit(1);
  }

  console.log(`\n  ⏳ Inviting ${email}...`);

  try {
    const res = await fetch(`${API_URL}/api/v1/team/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role: 'member', source: 'cli-invite' }),
      signal: AbortSignal.timeout(8000),
    });

    if (res.ok) {
      console.log(`\n  ✅ Invite sent to \x1b[32m${email}\x1b[0m`);
      console.log(`     They'll get a link to join your Brain — one click, 1–5 minutes.\n`);
      console.log(`  💡 Once they join, your AI assistants share lessons automatically.\n`);
    } else if (res.status === 409) {
      console.log(`\n  ✓  ${email} is already a team member.\n`);
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string };
      console.log(`\n  ❌ Invite failed: ${body.error ?? `HTTP ${res.status}`}\n`);
      process.exit(1);
    }
  } catch (e) {
    console.log(`\n  ❌ Network error: ${(e as Error).message}\n`);
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
      console.log(`   Set CACHLY_JWT manually from https://cachly.dev/setup-ai\n`);
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
      env['CACHLY_API_URL'] ??= 'https://api.cachly.dev';
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
      console.log('  \x1b[32m  npx @cachly-dev/mcp-server@latest setup\x1b[0m');
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
  const previewURL = `https://cachly.dev/preview?${previewParams.toString()}`;

  console.log('  \x1b[1mMake this permanent (free, 1–5 minutes):\x1b[0m');
  console.log('  \x1b[32m$ npx @cachly-dev/mcp-server@latest setup\x1b[0m');
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
    console.log('   Run: npx @cachly-dev/mcp-server@latest setup  (takes 1–5 minutes)\n');
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
    console.log('│  \x1b[35mnpx @cachly-dev/mcp-server@latest setup\x1b[0m                     │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    // Tweet text
    const shareUrl = 'https://cachly.dev?ref=share&utm_source=x&utm_medium=social&utm_campaign=cli-share';
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

// ── CLI: cachly badge ─────────────────────────────────────────────────────────
// Outputs the Markdown + HTML snippet for embedding a live Brain lesson-count
// badge in any README or website. Badge SVG served by cachly API (public, no auth).

if (process.argv[2] === 'badge') {
  const instanceId = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';

  if (!instanceId) {
    console.log('\n⚠️  CACHLY_BRAIN_INSTANCE_ID must be set.');
    console.log('   Run: npx @cachly-dev/mcp-server@latest setup  (takes 1–5 minutes)\n');
    process.exit(1);
  }

  const badgeUrl   = `${API_URL}/api/v1/badge/${instanceId}`;
  const targetUrl  = 'https://cachly.dev';
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
  console.log('  \x1b[32m  npx @cachly-dev/mcp-server@latest demo\x1b[0m     ← Start here (no account)');
  console.log('  \x1b[32m  npx @cachly-dev/mcp-server@latest setup\x1b[0m    ← Wire up your AI editors');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest health\x1b[0m   ← Check everything works');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest digest\x1b[0m   ← Weekly Brain summary');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest share\x1b[0m    ← Share your Brain stats');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest badge\x1b[0m    ← README badge for your Brain');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest invite\x1b[0m   ← Invite a teammate');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest join <token>\x1b[0m ← Accept a Brain invite');
  console.log('  \x1b[36m  npx @cachly-dev/mcp-server@latest upgrade\x1b[0m  ← Check for updates');
  console.log('');
  console.log('  \x1b[90mWorks with: Claude Code · Cursor · Windsurf · GitHub Copilot · Cline · Zed\x1b[0m');
  console.log('  \x1b[90mFree forever · GDPR · German servers · 89 MCP tools\x1b[0m');
  console.log('');
  process.exit(0);
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
  const { existsSync: exInit } = await import('node:fs');
  const merged = await mergeMcpConfig(configPath, apiKey, instanceId, editor, { readFile, existsSync: exInit });
  await writeFile(configPath, merged, 'utf-8');
  console.log(`\n✅ ${exInit(configPath) ? 'Updated' : 'Written'}: ${configFile}`);

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
  console.log(`   Restart your editor — the \`cachly\` MCP tools will appear.`);
  console.log(`\n   📛 Add a live badge to your README:`);
  console.log(`      npx @cachly-dev/mcp-server@latest badge\n`);
  process.exit(0);
}

// ── CLI: cachly health ────────────────────────────────────────────────────────
// Usage: npx @cachly-dev/mcp-server@latest health
// Checks: JWT valid, Brain API reachable, editor configs found, git hook present.

if (process.argv[2] === 'health') {
  const { existsSync } = await import('node:fs');
  const { readFile } = await import('node:fs/promises');
  const { resolve, join: pJoin } = await import('node:path');

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
    fail('CACHLY_JWT not set — run: npx @cachly-dev/mcp-server@latest setup');
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
        fail(`JWT expired ${Math.abs(minsLeft!)} minute(s) ago — get a new one: https://cachly.dev/setup-ai`);
      } else if (minsLeft !== null && minsLeft < 30) {
        warn(`JWT expires in ${minsLeft} minute(s) — refresh soon at https://cachly.dev/setup-ai`);
      } else {
        ok(`JWT valid${minsLeft !== null ? ` (expires in ${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m)` : ''}`);
      }
    } catch {
      fail('CACHLY_JWT format invalid (expected JWT with 3 parts)');
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
    fail('No editor MCP configs found — run: npx @cachly-dev/mcp-server@latest setup');
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
    warn('.git/hooks/post-commit not found — run: npx @cachly-dev/mcp-server@latest setup');
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  if (failed === 0) {
    console.log(`✅ All checks passed (${passed} ok)\n`);
  } else {
    console.log(`❌ ${failed} check(s) failed, ${passed} passed\n`);
    console.log(`💡 Fix issues with: npx @cachly-dev/mcp-server@latest setup\n`);
    process.exit(1);
  }
  process.exit(0);
}

// ── CLI: cachly setup (interactive — no flags required) ───────────────────────
// Usage: npx @cachly-dev/mcp-server setup

if (process.argv[2] === 'setup') {
  const { writeFile, mkdir, readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { createInterface } = await import('node:readline');

  sendFunnelEvent('setup_started');

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

  // ── Step 4: Write editor configs (project-level) ─────────────────────────
  // Uses mergeMcpConfig to preserve all existing MCP servers — only adds/updates
  // the cachly entry without touching filesystem, github, or other servers.
  const { existsSync: exSetup } = await import('node:fs');
  for (const editor of editorsToSetup) {
    const configFile = EDITOR_FILES[editor] ?? '.mcp.json';
    const configPath = resolve(cwd, configFile);
    try {
      await mkdir(dirname(configPath), { recursive: true });
      const wasExisting = exSetup(configPath);
      const merged = await mergeMcpConfig(configPath, token, instance.id, editor, { readFile, existsSync: exSetup });
      await writeFile(configPath, merged, 'utf-8');
      console.log(`✅ ${wasExisting ? 'Updated' : 'Written'}: ${configFile}`);
    } catch (writeErr) {
      console.log(`⚠️  Could not write ${configFile}: ${(writeErr as Error).message}`);
      console.log(`   Fix permissions or run with sudo, then re-run setup.`);
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
      env: { CACHLY_API_URL: 'https://api.cachly.dev', CACHLY_JWT: token, CACHLY_BRAIN_INSTANCE_ID: instance.id },
    };
    await writeFile(globalClaudePath, JSON.stringify(globalConfig, null, 2), 'utf-8');
    console.log(`✅ Written: ~/.claude/mcp.json  (global — works in every project)`);
  } catch (e) {
    console.log(`⚠️  Could not write ~/.claude/mcp.json: ${(e as Error).message}`);
  }

  // ── Step 5: CLAUDE.md (always — idempotent) ───────────────────────────────
  const mdResult = await writeClaudeMd(cwd, instance.id);
  const mdLabel = mdResult === 'updated' ? '✅ Updated' : mdResult === 'appended' ? '✅ Appended to' : '✅ Written';
  console.log(`${mdLabel}: CLAUDE.md\n`);

  // ── Step 5b: Bootstrap Brain from git history ─────────────────────────────
  // Pre-populates the Brain with real lessons so the first session_start shows
  // actual project knowledge instead of an empty brain.
  if (existsSync(resolve(cwd, '.git'))) {
    process.stdout.write('⏳ Bootstrapping Brain from git history (~10s)...');
    try {
      JWT = token; // set global JWT so handleTool can authenticate
      const gitResult = await handleTool('brain_from_git', {
        instance_id: instance.id,
        dir: cwd,
        max_commits: 100,
      });
      const match = gitResult.match(/(\d+) lesson/);
      console.log(` ✓  ${match ? match[1] + ' lessons' : 'done'} extracted from git history`);
    } catch (e) {
      console.log(` (skipped: ${(e as Error).message.slice(0, 80)})`);
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
  console.log(`   Dashboard: https://cachly.dev/instances/${instance.id}`);
  console.log(`\n   📛 Add a live badge to your README:`);
  console.log(`      npx @cachly-dev/mcp-server@latest badge\n`);

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
// Skip for CLI commands that intentionally run without credentials.
const _cliNoAuthCommands = ['demo', 'share', 'health', 'setup', 'init', 'digest', 'invite', 'badge', 'join', 'upgrade'];
if (!JWT && !_cliNoAuthCommands.includes(process.argv[2] ?? '') && !(!process.argv[2] && process.stdout.isTTY)) {
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

