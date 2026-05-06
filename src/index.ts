#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { createHash, createHmac } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, relative, extname } from 'node:path';
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
const CURRENT_VERSION = '0.9.17';

// ── Default Instance Resolution (for Smithery & single-credential setups) ────
// When CACHLY_BRAIN_INSTANCE_ID is set, tools can omit the instance_id parameter.
// When neither is set, we auto-fetch the first running instance once per process.
let _defaultInstanceId: string = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';
let _defaultInstanceFetched = false;

async function resolveDefaultInstanceId(): Promise<string> {
  if (_defaultInstanceId) return _defaultInstanceId;
  if (_defaultInstanceFetched) return '';
  _defaultInstanceFetched = true;
  if (!JWT) return '';
  try {
    const res = await fetch(`${API_URL}/api/v1/instances`, {
      headers: { Authorization: `Bearer ${JWT}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return '';
    const data = await res.json() as { data?: Array<{ id: string; status: string }> };
    const running = (data?.data ?? []).filter(i => i.status === 'running');
    if (running.length > 0) { _defaultInstanceId = running[0].id; return _defaultInstanceId; }
  } catch { /* non-fatal — caller will surface missing instance_id error */ }
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
      // Auto-provision instance
      _defaultInstanceFetched = false;
      await resolveDefaultInstanceId();
      if (!_defaultInstanceId) {
        // Try auto-provision
        try {
          const autoRes = await fetch(`${API_URL}/api/v1/instances/auto`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${JWT}`, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(10000),
          });
          if (autoRes.ok) {
            const body = await autoRes.json() as { instance?: { id: string }; instance_id?: string };
            const id = body.instance?.id ?? body.instance_id;
            if (id) _defaultInstanceId = id;
          }
        } catch { /* non-fatal */ }
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
  if (pool.has(instance_id)) return pool.get(instance_id)!;

  const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
  if (inst.status !== 'running') {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Instance "${inst.name}" is not running (status: ${inst.status}). ` +
        `It may still be provisioning or awaiting payment.`
    );
  }
  if (!inst.host || !inst.port) {
    throw new McpError(ErrorCode.InternalError, `Instance "${inst.name}" has no host/port yet.`);
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
    // Fallback: no password, use TLS default from instance
  }

  const client = new Redis({
    host: inst.host,
    port: inst.port,
    password: password || undefined,
    ...(tlsEnabled ? { tls: {} } : {}),
    lazyConnect: true,          // don't auto-connect — we connect explicitly below
    enableReadyCheck: true,
    connectTimeout: 5000,
    retryStrategy: () => null,  // fail fast, no reconnect loops in MCP context
  });

  client.on('error', () => {
    pool.delete(instance_id); // remove stale connection on error
  });

  // Connect explicitly so we can catch connection errors as a proper rejected
  // Promise instead of an unhandled 'error' event that would kill the process.
  try {
    await client.connect();
  } catch (err: unknown) {
    client.disconnect();
    const msg = err instanceof Error ? err.message : String(err);
    throw new McpError(
      ErrorCode.InternalError,
      `Could not connect to instance "${inst.name}" (${inst.host}:${inst.port}): ${msg}`
    );
  }

  pool.set(instance_id, client);
  return client;
}

// ── API helper ────────────────────────────────────────────────────────────────

function jwtExpiryMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : null;
  } catch { return null; }
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!JWT) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'CACHLY_JWT env var not set.\n\nGet your token at https://cachly.dev/setup-ai and add it to your MCP config:\n  CACHLY_JWT=<your-token>'
    );
  }

  // Detect token expiry before making the network call — gives a clearer error
  const expMs = jwtExpiryMs(JWT);
  if (expMs !== null && expMs < Date.now()) {
    const expiredAt = new Date(expMs).toISOString();
    throw new McpError(
      ErrorCode.InvalidRequest,
      `CACHLY_JWT expired at ${expiredAt}.\n\nGet a fresh token at https://cachly.dev/setup-ai and update CACHLY_JWT in your MCP config.`
    );
  }

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
    if (res.status === 401) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Authentication failed (401): ${detail}\n\nYour CACHLY_JWT may be expired or invalid. Get a fresh token at https://cachly.dev/setup-ai`
      );
    }
    if (res.status === 403) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Access denied (403): ${detail}\n\nCheck that your CACHLY_JWT belongs to an account with access to this resource.`
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `cachly API error ${res.status}: ${detail}`
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

import { detectNamespace } from './namespace.js';

// ── CKG (imported from ckg.ts) ─────────────────────────────────────────────
import type { CKGEdge, CKGNode } from './ckg.js';
import { ckgSlug, extractProblemConcept, ckgUpsertNode, ckgUpdateEdge } from './ckg.js';
import { handleBrainTool } from './handlers/brain.js';
import type { Instance } from './handlers/brain.js';

// ── Tools (imported from tools.ts) ─────────────────────────────────────────
import { TOOLS } from './tools.js';


// ── Handlers ──────────────────────────────────────────────────────────────────

function formatInstance(inst: Instance): string {
  const lines = [
    `**${inst.name}** (${inst.tier.toUpperCase()})`,
    `  ID:      ${inst.id}`,
    `  Status:  ${inst.status}`,
    `  Region:  ${inst.region}`,
    `  Memory:  ${inst.memory_mb} MB`,
    `  Enc:     ${inst.encryption_at_rest ? 'AES-256 at rest' : 'TLS in-transit'}`,
    `  Created: ${new Date(inst.created_at).toLocaleDateString('de-DE')}`,
  ];
  if (inst.host && inst.port) lines.push(`  Host:    ${inst.host}:${inst.port}`);
  return lines.join('\n');
}

function buildConnectionString(inst: Instance): string {
  if (!inst.host || !inst.port) return '(not yet provisioned)';
  const scheme = inst.tls_enabled !== false ? 'rediss' : 'redis';
  const pw = inst.password ? `:${inst.password}@` : '@';
  return `${scheme}://${pw}${inst.host}:${inst.port}`;
}

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

  // Delegate v0.2 bulk/lock/stream tools first
  const bulkResult = await handleBulkLockStream(name, args);
  if (bulkResult !== null) return bulkResult;

  // Delegate brain tools (learn, recall, session, etc.)
  const brainResult = await handleBrainTool(name, args, getConnection, apiFetch);
  if (brainResult !== null) return brainResult;

  switch (name) {
    // ── Instance management ──────────────────────────────────────────────
    case 'list_instances': {
      const res = await apiFetch<{ data: Instance[] }>('/api/v1/instances');
      const instances = res.data ?? [];
      if (instances.length === 0)
        return 'You have no cache instances yet. Use `create_instance` to create one.';
      return [`Found ${instances.length} instance(s):\n`, ...instances.map(formatInstance)].join('\n');
    }

    case 'create_instance': {
      const { name: instName, tier } = args as { name: string; tier: string };
      const res = await apiFetch<CreateResponse>('/api/v1/instances', {
        method: 'POST',
        body: JSON.stringify({ name: instName, tier, created_via: 'api' }),
      });
      if (res.checkout_url) {
        return [
          `✅ Instance **${instName}** (${tier}) created! ID: \`${res.instance_id}\``,
          ``,
          `💳 This is a paid tier. Complete payment to activate:`,
          `   ${res.checkout_url}`,
          ``,
          `After payment, provisioning starts automatically (~30 seconds).`,
        ].join('\n');
      }
      return [
        `✅ Instance **${instName}** (${tier}) created and provisioning started!`,
        `   ID: \`${res.instance_id}\``,
        `   Status: ${res.status}`,
        ``,
        `Use \`get_instance\` or \`get_connection_string\` to get your connection details.`,
      ].join('\n');
    }

    case 'get_instance': {
      const inst = await apiFetch<Instance>(`/api/v1/instances/${(args as { instance_id: string }).instance_id}`);
      return formatInstance(inst);
    }

    case 'get_connection_string': {
      const inst = await apiFetch<Instance>(`/api/v1/instances/${(args as { instance_id: string }).instance_id}`);
      if (inst.status !== 'running') {
        return `Instance is not running yet (status: ${inst.status}). Provisioning takes ~30 seconds after payment.`;
      }
      const connStr = buildConnectionString(inst);
      return [
        `**Connection string for ${inst.name}:**`,
        `\`\`\``,
        connStr,
        `\`\`\``,
        ``,
        `**Environment variable:**`,
        `\`\`\`bash`,
        `REDIS_URL="${connStr}"`,
        `CACHLY_URL="${connStr}"`,
        `\`\`\``,
        ``,
        `**Quick test:**`,
        `\`\`\`bash`,
        `redis-cli -u "${connStr}" PING`,
        `\`\`\``,
      ].join('\n');
    }

    case 'delete_instance': {
      const { instance_id, confirm } = args as { instance_id: string; confirm: boolean };
      if (!confirm) return 'Deletion cancelled. Set `confirm: true` to proceed.';
      pool.get(instance_id)?.quit().catch(() => undefined);
      pool.delete(instance_id);
      await apiFetch(`/api/v1/instances/${instance_id}`, { method: 'DELETE' });
      return `✅ Instance \`${instance_id}\` has been deleted and all data removed.`;
    }

    // ── Org / Team management ────────────────────────────────────────────
    case 'list_orgs': {
      const res = await apiFetch<{ orgs: Array<{ id: string; name: string; slug: string; plan: string; max_members: number; member_count?: number }> }>('/api/v1/orgs');
      const orgs = res.orgs ?? [];
      if (orgs.length === 0) return `📭 No organizations yet.\n\nCreate one with \`create_org(name="My Team")\`.\nOrg plans: Team €99/mo (10 seats), Business €299/mo (50 seats), Enterprise custom.`;
      return [
        `🏢 **Your organizations (${orgs.length})**\n`,
        ...orgs.map(o => `• **${o.name}** (\`${o.slug}\`) — plan: ${o.plan} · seats: ${o.member_count ?? '?'}/${o.max_members}\n  ID: \`${o.id}\``),
        `\n_Manage: \`get_org_plan\`, \`invite_member\`, dashboard → /team_`,
      ].join('\n');
    }

    case 'create_org': {
      const { name: orgName, slug } = args as { name: string; slug?: string };
      const body: Record<string, string> = { name: orgName };
      if (slug) body.slug = slug;
      const res = await apiFetch<{ id: string; name: string; slug: string; plan: string }>('/api/v1/orgs', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return [
        `✅ **Organization created:** ${res.name}`,
        `   ID: \`${res.id}\` · Slug: \`${res.slug}\` · Plan: ${res.plan}`,
        ``,
        `**Next steps:**`,
        `1. Invite team members: \`invite_member(org_id="${res.id}", email="dev@example.com")\``,
        `2. Upgrade plan: open billing portal via dashboard → /team`,
        `   Team: €99/mo (10 seats) · Business: €299/mo (50 seats)`,
      ].join('\n');
    }

    case 'invite_member': {
      const { org_id, email, role = 'member' } = args as { org_id: string; email: string; role?: string };
      await apiFetch(`/api/v1/orgs/${org_id}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, role }),
      });
      return `✅ Invite sent to **${email}** as \`${role}\` in org \`${org_id}\`.\n\nThey will receive an email to join the organization.`;
    }

    case 'get_org_plan': {
      const { org_id } = args as { org_id: string };
      const org = await apiFetch<{
        id: string; name: string; plan: string; max_members: number;
        members: Array<{ role: string; invite_email: string; accepted_at?: string }>;
        stripe_customer_id?: string;
      }>(`/api/v1/orgs/${org_id}`);
      const accepted = (org.members ?? []).filter(m => m.accepted_at).length;
      const pending = (org.members ?? []).filter(m => !m.accepted_at).length;
      const planPrice: Record<string, string> = { free: '€0', team: '€99/mo', business: '€299/mo', enterprise: 'custom' };
      return [
        `🏢 **${org.name}** — Plan: **${org.plan}** (${planPrice[org.plan] ?? org.plan})`,
        `   Seats: ${accepted} active + ${pending} pending / ${org.max_members} max`,
        ``,
        `**Members:**`,
        ...(org.members ?? []).map(m => `  • ${m.invite_email} (${m.role})${m.accepted_at ? '' : ' — pending'}`),
        ``,
        org.stripe_customer_id
          ? `💳 Billing: managed via Stripe. Upgrade/cancel: dashboard → /billing`
          : `💳 No payment method yet. Upgrade: dashboard → /billing → Team Plans`,
      ].join('\n');
    }

    // ── Live cache operations ────────────────────────────────────────────
    case 'cache_get': {
      const { instance_id, key } = args as { instance_id: string; key: string };
      const redis = await getConnection(instance_id);
      const value = await redis.get(key);
      if (value === null) return `Key \`${key}\` → **not found** (null)`;
      let pretty = value;
      try {
        pretty = JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        // not JSON — return raw
      }
      return `Key \`${key}\`:\n\`\`\`\n${pretty}\n\`\`\``;
    }

    case 'cache_set': {
      const { instance_id, key, value, ttl } = args as {
        instance_id: string;
        key: string;
        value: string;
        ttl?: number;
      };
      const redis = await getConnection(instance_id);
      if (ttl && ttl > 0) {
        await redis.set(key, value, 'EX', ttl);
        return `✅ Set \`${key}\` (TTL: ${ttl}s)`;
      }
      await redis.set(key, value);
      return `✅ Set \`${key}\` (no expiry)`;
    }

    case 'cache_delete': {
      const { instance_id, keys } = args as { instance_id: string; keys: string[] };
      const redis = await getConnection(instance_id);
      const deleted = await redis.del(...keys);
      return `✅ Deleted **${deleted}** of ${keys.length} key(s): ${keys.map((k) => `\`${k}\``).join(', ')}`;
    }

    case 'cache_exists': {
      const { instance_id, keys } = args as { instance_id: string; keys: string[] };
      const redis = await getConnection(instance_id);
      const count = await redis.exists(...keys);
      return `**${count}** of ${keys.length} key(s) exist in cache.`;
    }

    case 'cache_ttl': {
      const { instance_id, key } = args as { instance_id: string; key: string };
      const redis = await getConnection(instance_id);
      const ttl = await redis.ttl(key);
      if (ttl === -2) return `Key \`${key}\` → **does not exist**`;
      if (ttl === -1) return `Key \`${key}\` → **no expiry** (persists forever)`;
      const mins = Math.floor(ttl / 60);
      const secs = ttl % 60;
      return `Key \`${key}\` → TTL: **${ttl}s** (${mins}m ${secs}s remaining)`;
    }

    case 'cache_keys': {
      const { instance_id, pattern = '*', count = 50 } = args as {
        instance_id: string;
        pattern?: string;
        count?: number;
      };
      const limit = Math.min(count, 500);
      const redis = await getConnection(instance_id);
      const keys: string[] = [];
      const stream = redis.scanStream({ match: pattern, count: 100 });
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (batch: string[]) => {
          keys.push(...batch);
          if (keys.length >= limit) {
            stream.destroy();
            resolve();
          }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      const result = keys.slice(0, limit);
      if (result.length === 0) return `No keys found matching pattern \`${pattern}\`.`;
      return [
        `Found **${result.length}** key(s) matching \`${pattern}\`:`,
        ...result.map((k) => `  • \`${k}\``),
        result.length === limit ? `\n_(showing first ${limit} — narrow pattern to see more)_` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    case 'cache_stats': {
      const { instance_id } = args as { instance_id: string };
      const redis = await getConnection(instance_id);

      const [infoAll, infoStats, infoKeyspace] = await Promise.all([
        redis.info('memory'),
        redis.info('stats'),
        redis.info('keyspace'),
      ]);

      const parse = (section: string, field: string): string =>
        section.match(new RegExp(`${field}:([^\r\n]+)`))?.[1]?.trim() ?? 'n/a';

      const usedMem = parse(infoAll, 'used_memory_human');
      const peakMem = parse(infoAll, 'used_memory_peak_human');
      const hits = parse(infoStats, 'keyspace_hits');
      const misses = parse(infoStats, 'keyspace_misses');
      const opsPerSec = parse(infoStats, 'instantaneous_ops_per_sec');
      const connectedClients = (await redis.info('clients')).match(/connected_clients:(\d+)/)?.[1] ?? 'n/a';

      const hitsN = parseInt(hits) || 0;
      const missesN = parseInt(misses) || 0;
      const total = hitsN + missesN;
      const hitRate = total > 0 ? ((hitsN / total) * 100).toFixed(1) : 'n/a';

      const keyspaceLines = infoKeyspace
        .split('\n')
        .filter((l: string) => l.startsWith('db'))
        .map((l: string) => `  ${l.trim()}`);

      return [
        `📊 **Cache Stats for instance \`${instance_id}\`:**`,
        ``,
        `  💾 Memory used:   ${usedMem} (peak: ${peakMem})`,
        `  ⚡ Ops/sec:       ${opsPerSec}`,
        `  🎯 Hit rate:      ${hitRate}% (${hits} hits / ${misses} misses)`,
        `  🔗 Clients:       ${connectedClients}`,
        ``,
        keyspaceLines.length > 0
          ? `  🗂️ Keyspace:\n${keyspaceLines.join('\n')}`
          : `  🗂️ Keyspace: (empty)`,
      ].join('\n');
    }

    case 'semantic_search': {
      const {
        instance_id,
        query,
        threshold = 0.82,
        namespace: nsArg = 'cachly:sem',
        top_k = 5,
        use_hybrid = false,
        auto_namespace = false,
      } = args as {
        instance_id: string;
        query: string;
        threshold?: number;
        namespace?: string;
        top_k?: number;
        use_hybrid?: boolean;
        auto_namespace?: boolean;
      };

      // resolve namespace from query text when requested
      const namespace = auto_namespace ? detectNamespace(query) : nsArg;

      if (!hasEmbedProvider()) {
        return (
          `❌ semantic_search requires an embedding provider.\n\n` +
          `Current: ${embedProviderHint()}\n\n` +
          `Set one of these in your MCP env config:\n` +
          `  OPENAI_API_KEY   (provider: openai – default)\n` +
          `  MISTRAL_API_KEY  (provider: mistral)\n` +
          `  COHERE_API_KEY   (provider: cohere)\n` +
          `  GEMINI_API_KEY   (provider: gemini)\n` +
          `  OLLAMA_BASE_URL  (provider: ollama – local, no key needed)\n` +
          `Also set: CACHLY_EMBED_PROVIDER=<provider>`
        );
      }

      const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
      if (!inst.vector_token) {
        return (
          `❌ Semantic search is only available on Speed and Business tiers.\n\n` +
          `Your instance "${inst.name}" is on the **${inst.tier.toUpperCase()}** tier.\n` +
          `Upgrade at https://cachly.dev/instances/${instance_id}`
        );
      }

      // Compute embedding via configured provider
      const embedding = await computeEmbedding(query);

      // Query cachly vector API
      const vectorUrl = process.env.CACHLY_VECTOR_URL ?? `https://api.cachly.dev/v1/sem/${inst.vector_token}`;
      const searchPayload: Record<string, unknown> = { embedding, namespace, threshold, top_k };
      // hybrid BM25+Vector RRF: include query text when requested.
      if (use_hybrid) {
        searchPayload['hybrid'] = true;
        searchPayload['prompt'] = query;
      }
      const searchRes = await fetch(`${vectorUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(searchPayload),
      });

      if (!searchRes.ok) {
        throw new McpError(ErrorCode.InternalError, `Vector search failed: ${searchRes.statusText}`);
      }

      const results = (await searchRes.json()) as SemanticSearchResponse[];

      if (!results.length || (results.length === 1 && !results[0].found)) {
        return (
          `🔍 No semantically similar entries found for:\n  _"${query}"_\n\n` +
          `Try lowering the threshold (current: ${threshold}) or using different keywords.`
        );
      }

      const redis = await getConnection(instance_id);
      const lines: string[] = [
        `🔍 **Semantic search results** for: _"${query}"_`,
        `   Threshold: ${threshold} · Namespace: \`${namespace}\``,
        ``,
      ];

      for (const hit of results) {
        if (!hit.found || !hit.id) continue;
        const value = await redis.get(`${namespace}:val:${hit.id}`);
        lines.push(
          `**Match** (similarity: ${((hit.similarity ?? 0) * 100).toFixed(1)}%)`,
          `  Prompt: _"${hit.prompt ?? '(unknown)'}"_`,
          value ? `  Value:  \`${value.slice(0, 200)}${value.length > 200 ? '…' : ''}\`` : `  Value:  _(evicted from cache)_`,
          ``
        );
      }

      return lines.join('\n');
    }

    // ── Namespace Auto-Detection ──────────────────────────────────────────
    case 'detect_namespace': {
      const { prompt } = args as { prompt: string };
      const ns = detectNamespace(prompt);
      const typeLabel = ns.split(':').pop()!;
      const descriptions: Record<string, string> = {
        code:        '💻 Code — contains programming constructs or syntax',
        translation: '🌐 Translation — asks to translate between languages',
        summary:     '📝 Summary — requests a summary or key points (TL;DR)',
        qa:          '❓ Q&A — a direct question or query',
        creative:    '🎨 Creative — general, creative, or conversational prompt',
      };
      return [
        `**Detected namespace:** \`${ns}\``,
        `**Type:** ${descriptions[typeLabel] ?? typeLabel}`,
        ``,
        `_Prompt: "${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}"_`,
        ``,
        `💡 Use this namespace in \`semantic_search\` or \`cache_warmup\` for better hit rates.`,
        `   Set \`auto_namespace: true\` to apply this detection automatically.`,
      ].join('\n');
    }

    // ── Cache Warmup ───────────────────────────────────────────────────────
    case 'cache_warmup': {
      const {
        instance_id,
        entries: rawEntries,
        namespace: nsArg = 'cachly:sem',
        ttl,
        auto_namespace = false,
      } = args as {
        instance_id: string;
        entries: Array<{ prompt: string; value: string; namespace?: string }>;
        namespace?: string;
        ttl?: number;
        auto_namespace?: boolean;
      };

      if (!hasEmbedProvider()) {
        return (
          `❌ cache_warmup requires an embedding provider.\n\n` +
          `Current: ${embedProviderHint()}\n\n` +
          `Supported: openai (default) · mistral · cohere · ollama (local) · gemini\n` +
          `Set CACHLY_EMBED_PROVIDER and the matching API key env var.`
        );
      }

      const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
      const vectorUrl =
        process.env.CACHLY_VECTOR_URL ??
        (inst.vector_token ? `https://api.cachly.dev/v1/sem/${inst.vector_token}` : null);

      const redis = await getConnection(instance_id);

      let warmed = 0;
      let skipped = 0;
      const details: string[] = [];

      for (const entry of rawEntries) {
        // resolve namespace per entry
        const ns = entry.namespace ?? (auto_namespace ? detectNamespace(entry.prompt) : nsArg);

        // Compute embedding for this prompt
        const embedding = await computeEmbedding(entry.prompt);

        // Check if a very-similar entry already exists (threshold 0.98 → skip to avoid duplicates)
        let alreadyCached = false;
        if (vectorUrl) {
          const checkRes = await fetch(`${vectorUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embedding, namespace: ns, threshold: 0.98 }),
          }).catch(() => null);
          if (checkRes?.ok) {
            const results = (await checkRes.json()) as SemanticSearchResponse[];
            alreadyCached = results[0]?.found ?? false;
          }
        }

        if (alreadyCached) {
          skipped++;
          details.push(`  ⏭️  _"${entry.prompt.slice(0, 60)}${entry.prompt.length > 60 ? '…' : ''}"_ → already cached`);
          continue;
        }

        // Write value to Valkey
        const id = randomUUID();
        const vk = `${ns}:val:${id}`;
        if (ttl && ttl > 0) {
          await redis.set(vk, entry.value, 'EX', ttl);
        } else {
          await redis.set(vk, entry.value);
        }

        if (vectorUrl) {
          // pgvector path – index embedding in HNSW
          const body: Record<string, unknown> = { id, prompt: entry.prompt, namespace: ns, embedding };
          if (ttl && ttl > 0) {
            body['expires_at'] = new Date(Date.now() + ttl * 1000).toISOString();
          }
          await fetch(`${vectorUrl}/entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).catch(() => undefined);
        } else {
          // Legacy SCAN path – write emb key to Valkey
          const embKey = `${ns}:emb:${id}`;
          const embPayload = JSON.stringify({ embedding, prompt: entry.prompt });
          if (ttl && ttl > 0) {
            await redis.set(embKey, embPayload, 'EX', ttl);
          } else {
            await redis.set(embKey, embPayload);
          }
        }

        warmed++;
        details.push(`  ✅ _"${entry.prompt.slice(0, 60)}${entry.prompt.length > 60 ? '…' : ''}"_ → \`${ns}\``);
      }

      return [
        `🔥 **Cache Warmup Complete**`,
        ``,
        `  ✅ Warmed:  **${warmed}** new entries`,
        `  ⏭️  Skipped: **${skipped}** (already cached at ≥ 0.98 similarity)`,
        `  📦 Total:   ${rawEntries.length}`,
        auto_namespace
          ? `  🏷️  Namespacing: auto-detected per prompt`
          : `  🏷️  Namespace: \`${nsArg}\``,
        vectorUrl
          ? `  🔍 Mode: pgvector HNSW (Speed/Business tier)`
          : `  🔍 Mode: Valkey SCAN (upgrade to Speed tier for scalable search)`,
        ``,
        ...details,
      ].join('\n');
    }

    // ── index_project – Codebase Indexing ─────────────────────────────────────
    case 'index_project': {
      const {
        instance_id,
        dir,
        extensions: extArg,
        max_files = 100,
        ttl = 86400,
        summary_chars = 1200,
        namespace: nsArg = 'cachly:sem:code',
      } = args as {
        instance_id: string;
        dir: string;
        extensions?: string[];
        max_files?: number;
        ttl?: number;
        summary_chars?: number;
        namespace?: string;
      };

      const ALLOWED_EXT = new Set(
        (extArg ?? ['ts', 'js', 'tsx', 'jsx', 'go', 'py', 'java', 'rs', 'md', 'kt', 'swift']).map(
          (e) => (e.startsWith('.') ? e : `.${e}`),
        ),
      );

      // Recursively collect files up to max_files limit
      const files: string[] = [];
      async function walk(d: string): Promise<void> {
        if (files.length >= max_files) return;
        const entries = await readdir(d, { withFileTypes: true }).catch(() => null);
        if (!entries) return;
        for (const entry of entries) {
          if (files.length >= max_files) break;
          const full = join(d, entry.name as unknown as string);
          if (entry.isDirectory()) {
            if (['.git', 'node_modules', 'dist', 'build', '.next', '__pycache__', 'vendor'].includes(entry.name as unknown as string))
              continue;
            await walk(full);
          } else if (entry.isFile() && ALLOWED_EXT.has(extname(entry.name as unknown as string).toLowerCase())) {
            files.push(full);
          }
        }
      }
      await walk(dir);

      if (files.length === 0) {
        return `❌ No matching files found in \`${dir}\`.\nExtensions checked: ${[...ALLOWED_EXT].join(', ')}`;
      }

      const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
      const vectorUrl =
        process.env.CACHLY_VECTOR_URL ??
        (inst.vector_token ? `https://api.cachly.dev/v1/sem/${inst.vector_token}` : null);
      const canEmbed = vectorUrl && hasEmbedProvider();

      let indexed = 0;
      let skipped = 0;
      let errors = 0;
      let semanticIndexed = 0;
      let unchanged = 0;
      const details: string[] = [];
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const redis = await getConnection(instance_id);

      for (const filePath of files) {
        const relPath = relative(dir, filePath);
        let content: string;
        let fileSize: number;
        try {
          const s = await stat(filePath);
          if (s.size > 200_000) { skipped++; continue; } // skip files >200 KB
          fileSize = s.size;
          content = await readFile(filePath, 'utf-8');
        } catch {
          errors++;
          continue;
        }

        // ── Smart invalidation: hash-based change detection ──
        // Compute a simple hash of file content to skip unchanged files
        const hashKey = `cachly:idx:hash:${relPath}`;
        const contentHash = `${fileSize}:${content.length}:${simpleHash(content)}`;
        const existingHash = await redis.get(hashKey);
        if (existingHash === contentHash) {
          // File unchanged — refresh TTL but skip re-indexing
          const idxKey = `cachly:idx:${relPath}`;
          if (ttl > 0) await redis.expire(idxKey, ttl);
          if (ttl > 0) await redis.expire(hashKey, ttl);
          unchanged++;
          continue;
        }

        const excerpt = content.slice(0, summary_chars).replace(/\s+/g, ' ').trim();

        // ── Layer 1: Keyword index in Valkey (always works, no embedding needed) ──
        const idxKey = `cachly:idx:${relPath}`;
        const idxValue = `File: ${relPath}\n${excerpt}`;
        if (ttl > 0) {
          await redis.set(idxKey, idxValue, 'EX', ttl);
        } else {
          await redis.set(idxKey, idxValue);
        }
        // Store content hash for smart invalidation on next run
        if (ttl > 0) {
          await redis.set(hashKey, contentHash, 'EX', ttl);
        } else {
          await redis.set(hashKey, contentHash);
        }
        indexed++;
        details.push(`  ✅ ${relPath}`);

        // ── Layer 2: Semantic vector index (optional, only if embedding available) ──
        if (canEmbed) {
          try {
            const prompt = `File: ${relPath}\n${excerpt}`;
            const embedding = await computeEmbedding(prompt);
            const id = randomUUID();
            await fetch(`${vectorUrl}/entries`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, prompt, namespace: nsArg, embedding, expires_at: expiresAt }),
            });
            await redis.set(`${nsArg}:val:${id}`, relPath, 'EX', ttl);
            semanticIndexed++;
          } catch {
            // Semantic indexing failed — keyword index is enough
          }
        }
      }

      const mode = canEmbed ? '🔍 Keyword + 🎯 Semantic' : '🔍 Keyword only (no embedding provider)';

      return [
        `📂 **index_project Complete** — ${mode}`,
        ``,
        `  📁 Dir:       ${dir}`,
        `  ✅ Indexed:   **${indexed}** files (new/changed)`,
        `  ♻️  Unchanged: ${unchanged} files (hash match — skipped)`,
        ...(canEmbed ? [`  🎯 Semantic:  **${semanticIndexed}** files (vector-searchable)`] : []),
        `  ⏭️  Skipped:   ${skipped} (too large or filtered)`,
        `  ❌ Errors:    ${errors}`,
        `  ⏱️  TTL:       ${ttl}s (${Math.round(ttl / 3600)}h)`,
        ``,
        `💡 **Next steps:**`,
        `   1. Use \`smart_recall("how does auth work")\` to find relevant files.`,
        `   2. Re-run index_project after major refactors.`,
        ...(canEmbed ? [] : [`   3. Set OPENAI_API_KEY (or similar) in .env to also enable semantic search.`]),
        ``,
        ...(details.length <= 20 ? details : [...details.slice(0, 20), `  … and ${details.length - 20} more`]),
      ].join('\n');
    }

    // ── Thinking/Context Cache Tools ────────────────────────────────────────
    case 'remember_context': {
      const {
        instance_id,
        key,
        content,
        category = 'custom',
        ttl = 86400,
      } = args as {
        instance_id: string;
        key: string;
        content: string;
        category?: string;
        ttl?: number;
      };

      const redis = await getConnection(instance_id);
      const cacheKey = `cachly:ctx:${category}:${key}`;
      const meta = JSON.stringify({
        key,
        category,
        size: content.length,
        created: new Date().toISOString(),
      });

      if (ttl && ttl > 0) {
        await redis.set(cacheKey, content, 'EX', ttl);
        await redis.set(`${cacheKey}:meta`, meta, 'EX', ttl);
      } else {
        await redis.set(cacheKey, content);
        await redis.set(`${cacheKey}:meta`, meta);
      }

      // Also index semantically for smart_recall (if vector available)
      const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
      if (inst.vector_token) {
        try {
          const embedding = await computeEmbedding(`${key}: ${content.slice(0, 500)}`);
          const vectorUrl = `https://api.cachly.dev/v1/sem/${inst.vector_token}`;
          const body: Record<string, unknown> = {
            id: `ctx:${category}:${key}`,
            prompt: key,
            namespace: 'cachly:ctx',
            embedding,
          };
          if (ttl && ttl > 0) {
            body['expires_at'] = new Date(Date.now() + ttl * 1000).toISOString();
          }
          await fetch(`${vectorUrl}/entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).catch(() => undefined);
        } catch {
          // Embedding optional — continue silently
        }
      }

      return [
        `🧠 **Context Saved**`,
        ``,
        `  Key:      \`${key}\``,
        `  Category: ${category}`,
        `  Size:     ${content.length} chars`,
        `  TTL:      ${ttl > 0 ? `${ttl}s (${Math.round(ttl / 3600)}h)` : 'no expiry'}`,
        ``,
        `💡 Use \`recall_context("${key}")\` to retrieve this later.`,
        `   Or \`smart_recall("${key.split('_').join(' ')}")\` for semantic search.`,
      ].join('\n');
    }

    case 'recall_context': {
      const { instance_id, key } = args as { instance_id: string; key: string };
      const redis = await getConnection(instance_id);

      // Check if key is a glob pattern
      if (key.includes('*')) {
        const keys: string[] = [];
        const stream = redis.scanStream({ match: `cachly:ctx:*:${key}`, count: 100 });
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (batch: string[]) => {
            keys.push(...batch.filter((k: string) => !k.endsWith(':meta')));
            if (keys.length >= 20) { stream.destroy(); resolve(); }
          });
          stream.on('end', resolve);
          stream.on('error', reject);
        });

        if (keys.length === 0) return `⚠️ No cached context found matching pattern \`${key}\`.`;

        const results: string[] = [`🧠 **Recalled ${keys.length} context entries matching \`${key}\`:**\n`];
        for (const k of keys.slice(0, 10)) {
          const content = await redis.get(k);
          const shortKey = k.replace('cachly:ctx:', '');
          results.push(`### ${shortKey}\n\`\`\`\n${content?.slice(0, 500)}${(content?.length ?? 0) > 500 ? '…' : ''}\n\`\`\`\n`);
        }
        if (keys.length > 10) results.push(`_(+${keys.length - 10} more matches)_`);
        return results.join('\n');
      }

      // Try exact match across categories
      const categories = ['overview', 'architecture', 'file_summary', 'dependency', 'thinking', 'custom'];
      for (const cat of categories) {
        const content = await redis.get(`cachly:ctx:${cat}:${key}`);
        if (content) {
          const ttl = await redis.ttl(`cachly:ctx:${cat}:${key}`);
          return [
            `🧠 **Recalled Context: \`${key}\`**`,
            ``,
            `  Category: ${cat}`,
            `  Size:     ${content.length} chars`,
            `  TTL:      ${ttl === -1 ? 'no expiry' : ttl === -2 ? 'expired' : `${ttl}s remaining`}`,
            ``,
            `---`,
            ``,
            content,
          ].join('\n');
        }
      }

      return `⚠️ No cached context found for key \`${key}\`.\n\nUse \`list_remembered\` to see available cached context.`;
    }

    case 'list_remembered': {
      const {
        instance_id,
        category = 'all',
        limit = 50,
      } = args as { instance_id: string; category?: string; limit?: number };

      const redis = await getConnection(instance_id);
      const pattern = category === 'all' ? 'cachly:ctx:*' : `cachly:ctx:${category}:*`;
      const keys: string[] = [];
      const stream = redis.scanStream({ match: pattern, count: 100 });
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (batch: string[]) => {
          keys.push(...batch.filter((k: string) => !k.endsWith(':meta')));
          if (keys.length >= limit) { stream.destroy(); resolve(); }
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });

      if (keys.length === 0) {
        return `📭 No cached context found.\n\nUse \`remember_context\` to cache context for faster future access.`;
      }

      const lines: string[] = [`🧠 **Cached Context** (${keys.length} entries):\n`];
      for (const k of keys.slice(0, limit)) {
        const ttl = await redis.ttl(k);
        const content = await redis.get(k);
        const parts = k.replace('cachly:ctx:', '').split(':');
        const cat = parts[0];
        const key = parts.slice(1).join(':');
        const preview = content?.slice(0, 80).replace(/\n/g, ' ') ?? '';
        lines.push(
          `  • **${key}** (${cat})`,
          `    Size: ${content?.length ?? 0} chars · TTL: ${ttl === -1 ? '∞' : `${Math.round(ttl / 60)}m`}`,
          `    _"${preview}${(content?.length ?? 0) > 80 ? '…' : ''}"_`,
          ``
        );
      }

      return lines.join('\n');
    }

    case 'forget_context': {
      const { instance_id, keys } = args as { instance_id: string; keys: string[] };
      const redis = await getConnection(instance_id);
      let deleted = 0;

      for (const key of keys) {
        if (key.includes('*')) {
          // Glob delete
          const toDelete: string[] = [];
          const stream = redis.scanStream({ match: `cachly:ctx:*:${key}*`, count: 100 });
          await new Promise<void>((resolve, reject) => {
            stream.on('data', (batch: string[]) => toDelete.push(...batch));
            stream.on('end', resolve);
            stream.on('error', reject);
          });
          if (toDelete.length > 0) {
            deleted += await redis.del(...toDelete);
          }
        } else {
          // Try all categories
          const categories = ['overview', 'architecture', 'file_summary', 'dependency', 'thinking', 'custom'];
          for (const cat of categories) {
            deleted += await redis.del(`cachly:ctx:${cat}:${key}`, `cachly:ctx:${cat}:${key}:meta`);
          }
        }
      }

      return `🗑️ **Forgot ${deleted} context entries.**\n\nKeys: ${keys.map(k => `\`${k}\``).join(', ')}`;
    }

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

      return [
        `📡 **cachly API Status**`,
        ``,
        `  🌐 API:    ${API_URL}`,
        `  💓 Health: ${healthStatus}`,
        ``,
        `🔑 **Auth:**`,
        authInfo,
      ].join('\n');
    }

    // ── session_start ─────────────────────────────────────────────────────────
    case 'sync_file_changes': {
      const { instance_id, changed_files, git_diff_stat, commit_msg } = args as {
        instance_id: string;
        changed_files: string[];
        git_diff_stat?: string;
        commit_msg?: string;
      };
      const redis = await getConnection(instance_id);

      // Store file change event in session history
      const changeRecord = {
        ts: new Date().toISOString(),
        files: changed_files,
        commit_msg,
        diff_stat: git_diff_stat?.slice(0, 500),
      };
      await redis.lpush('cachly:session:file_changes', JSON.stringify(changeRecord));
      await redis.ltrim('cachly:session:file_changes', 0, 99);
      await redis.expire('cachly:session:file_changes', 30 * 86400);

      // Find lessons relevant to the changed files
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      type Lesson = { topic: string; what_worked: string; outcome: string; file_paths?: string[] };
      const relevant: string[] = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        const lesson = JSON.parse(raw) as Lesson;
        // Match by file_paths stored in lesson OR by topic keywords matching file name
        const topicWords = lesson.topic.toLowerCase().split(/[:\-_]/);
        const fileMatches = changed_files.some(f => {
          const fname = f.split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase() ?? '';
          return topicWords.some(w => w.length > 3 && fname.includes(w))
            || (lesson.file_paths ?? []).some(lf => f.includes(lf) || lf.includes(f));
        });
        if (fileMatches) {
          const emoji = lesson.outcome === 'success' ? '✅' : '⚠️';
          relevant.push(`  ${emoji} \`${lesson.topic}\` — ${lesson.what_worked.slice(0, 80)}`);
        }
      }

      const lines = [
        `📁 **File sync recorded**: ${changed_files.length} files`,
        commit_msg ? `📝 Commit: "${commit_msg}"` : '',
        '',
        `**Changed:** ${changed_files.slice(0, 8).map(f => `\`${f}\``).join(', ')}${changed_files.length > 8 ? ` +${changed_files.length - 8} more` : ''}`,
        '',
      ];
      if (relevant.length > 0) {
        lines.push(`🧠 **Relevant brain lessons (${relevant.length}):**`, ...relevant);
      } else {
        lines.push(`💡 No existing lessons match these files yet. Add them with \`learn_from_attempts\`.`);
      }
      return lines.filter(Boolean).join('\n');
    }

    // ── team_learn ────────────────────────────────────────────────────────────
    case 'team_learn': {
      const { instance_id, author, topic, outcome, what_worked, what_failed, severity, file_paths, commands, tags } = args as {
        instance_id: string; author: string; topic: string; outcome: string;
        what_worked: string; what_failed?: string; severity?: string;
        file_paths?: string[]; commands?: string[]; tags?: string[];
      };
      if (!author || !topic || !outcome || !what_worked) {
        return '❌ Required: author, topic, outcome, what_worked';
      }
      const iid = instance_id;
      if (!iid) return '❌ instance_id required';

      // Store with author attribution via the same learn_from_attempts Redis structure
      const lesson = {
        topic, outcome, what_worked,
        what_failed: what_failed ?? '',
        severity: severity ?? 'minor',
        author,
        file_paths: file_paths ?? [],
        commands: commands ?? [],
        tags: [...(tags ?? []), 'team'],
        timestamp: new Date().toISOString(),
        recall_count: 0,
        version: 2,
      };

      const redis = await getConnection(iid);
      const key = `cachly:lessons:${topic}`;
      await redis.rpush(key, JSON.stringify(lesson));
      if (outcome === 'success') {
        await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(lesson));
      }

      return `✅ Team lesson stored by **${author}**: \`${topic}\` (${outcome})\n💡 ${what_worked.slice(0, 120)}`;
    }

    // ── team_recall ───────────────────────────────────────────────────────────
    case 'team_recall': {
      const { instance_id, topic, author, limit = 10 } = args as {
        instance_id: string;
        topic?: string;
        author?: string;
        limit?: number;
      };
      const redis = await getConnection(instance_id);

      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      type TeamLesson = {
        topic: string; outcome: string; what_worked: string;
        ts: string; severity?: string; recall_count?: number;
        author?: string; tags?: string[];
      };
      let lessons: TeamLesson[] = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try { lessons.push(JSON.parse(raw) as TeamLesson); } catch { /* skip */ }
      }

      // Filter
      if (topic) {
        const t = topic.toLowerCase();
        lessons = lessons.filter(l =>
          l.topic.toLowerCase().includes(t) ||
          (l.tags ?? []).some((tag: string) => tag.toLowerCase().includes(t))
        );
      }
      if (author) {
        const a = author.toLowerCase();
        lessons = lessons.filter(l => l.author?.toLowerCase().includes(a));
      }

      // Sort by recall_count desc
      lessons.sort((a, b) => (b.recall_count ?? 0) - (a.recall_count ?? 0));
      lessons = lessons.slice(0, limit);

      if (lessons.length === 0) {
        return topic
          ? `📭 No team lessons found for \`${topic}\`.\n\nShared instance: add lessons with \`learn_from_attempts\` and include an \`author\` field.`
          : `📭 No lessons in this brain yet.\n\nAll team members sharing this instance will see lessons here.`;
      }

      const lines = [`👥 **Team Brain** — ${lessons.length} lesson${lessons.length > 1 ? 's' : ''}`, ''];
      for (const l of lessons) {
        const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
        const sev = l.severity === 'critical' ? '🔴 ' : l.severity === 'major' ? '🟡 ' : '';
        const authorStr = l.author ? ` · _by ${l.author}_` : '';
        const recallStr = (l.recall_count ?? 0) > 0 ? ` · recalled ${l.recall_count}×` : '';
        const ago = Math.round((Date.now() - new Date(l.ts).getTime()) / 86400000);
        const agoStr = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago}d ago`;
        lines.push(`${emoji} ${sev}**\`${l.topic}\`**${authorStr}${recallStr} · ${agoStr}`);
        lines.push(`   ${l.what_worked.slice(0, 120)}`);
        lines.push('');
      }
      return lines.join('\n');
    }

    // ── team_synthesize — Team Brain Synthesis ────────────────────────────────
    case 'team_synthesize': {
      const { instance_id, topic } = args as { instance_id: string; topic: string };
      const redis = await getConnection(instance_id);

      // Load history list for this topic (all authors' contributions)
      const listKey = `cachly:lessons:${topic}`;
      const all = await redis.lrange(listKey, 0, -1);
      if (all.length < 2) {
        return `📭 Need at least 2 entries for topic \`${topic}\` to synthesize.\n\nCurrently: ${all.length} entr${all.length === 1 ? 'y' : 'ies'}.\n\nHave team members store lessons via \`learn_from_attempts(topic="${topic}", ...)\`.`;
      }

      type Entry = { outcome: string; what_worked: string; what_failed?: string; author?: string; ts: string; severity?: string };
      const entries: Entry[] = all.map(r => { try { return JSON.parse(r) as Entry; } catch { return null; } }).filter((e): e is Entry => e !== null);

      // Group by outcome
      const successes = entries.filter(e => e.outcome === 'success');
      const failures  = entries.filter(e => e.outcome === 'failure');
      const partials  = entries.filter(e => e.outcome === 'partial');

      const authors = [...new Set(entries.map(e => e.author).filter(Boolean))];
      const hasMultiAuthor = authors.length > 1;

      // Build canonical merged version
      // what_worked: pick the most recent success, or longest for most detail
      const bestSuccess = successes.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0];
      const whatWorkedCandidates = successes.map(e => e.what_worked).filter(w => w && w.length > 10);
      const canonicalWorked = whatWorkedCandidates.sort((a, b) => b.length - a.length)[0] ?? bestSuccess?.what_worked ?? '';

      // what_failed: union of all unique failure reasons
      const allFailed = [...new Set(
        [...failures, ...partials].map(e => e.what_failed).filter((w): w is string => !!w && w.length > 5)
      )];

      const severities = entries.map(e => e.severity).filter(Boolean);
      const canonicalSeverity = severities.includes('critical') ? 'critical' : severities.includes('major') ? 'major' : 'minor';

      const lines = [
        `🧬 **Team Brain Synthesis: \`${topic}\`**`,
        `_${entries.length} entries from ${authors.length} author${authors.length === 1 ? '' : 's'}${hasMultiAuthor ? ` (${authors.join(', ')})` : ''} · ${successes.length} success · ${failures.length} failure · ${partials.length} partial_`,
        '',
        `**Canonical "what worked":**`,
        `> ${canonicalWorked}`,
        '',
        allFailed.length > 0 ? `**Avoid (combined failures):**` : '',
        ...allFailed.map(f => `> ❌ ${f}`),
        allFailed.length > 0 ? '' : '',
        `**Suggested canonical lesson:**`,
        '```',
        `learn_from_attempts(`,
        `  topic       = "${topic}",`,
        `  outcome     = "success",`,
        `  what_worked = "${canonicalWorked.replace(/"/g, "'")}",`,
        allFailed.length > 0 ? `  what_failed = "${allFailed[0].replace(/"/g, "'")}",` : '',
        `  severity    = "${canonicalSeverity}",`,
        `)`,
        '```',
        '',
        hasMultiAuthor
          ? `💡 _${authors.length} team members contributed to this synthesis. Store the canonical version to replace individual entries._`
          : `💡 _Single author — more value when multiple team members contribute to the same topic._`,
      ].filter(l => l !== undefined).join('\n');
      return lines;
    }

    // ── brain_doctor ──────────────────────────────────────────────────────────
    // ── memory_crystalize ─────────────────────────────────────────────────────
    case 'memory_crystalize': {
      const { instance_id, label: crystalLabel = '' } = args as { instance_id: string; label?: string };
      const redis = await getConnection(instance_id);
      const now = new Date();
      const week = `${now.getFullYear()}-W${String(Math.ceil((now.getDate() - now.getDay() + 10) / 7)).padStart(2, '0')}`;
      const effectiveLabel = crystalLabel || `${now.toISOString().slice(0, 7)} Crystal`;

      // Read session history
      const sessionHistory = await redis.lrange('cachly:session:history', 0, 49);

      // Read all auto-learned lessons
      const allLessonKeys: string[] = [];
      const ls = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((res, rej) => {
        ls.on('data', (b: string[]) => allLessonKeys.push(...b));
        ls.on('end', res);
        ls.on('error', rej);
      });

      type RawLesson = { topic: string; outcome: string; what_worked: string; severity?: string; ts: string; auto_learned?: boolean };
      const allLessons: RawLesson[] = [];
      for (const k of allLessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try { allLessons.push(JSON.parse(raw) as RawLesson); } catch { /* skip */ }
      }

      // Group lessons by top-level category
      const categoryMap = new Map<string, RawLesson[]>();
      for (const l of allLessons) {
        const cat = l.topic.split(':')[0] || 'misc';
        if (!categoryMap.has(cat)) categoryMap.set(cat, []);
        categoryMap.get(cat)!.push(l);
      }

      // Build top patterns (most frequent categories with a representative insight)
      const topPatterns: Array<{ category: string; insight: string; count: number }> = [];
      for (const [cat, catLessons] of [...categoryMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
        const successLessons = catLessons.filter(l => l.outcome === 'success');
        const best = successLessons[0] ?? catLessons[0];
        if (!best) continue;
        topPatterns.push({
          category: cat,
          insight: best.what_worked.slice(0, 120),
          count: catLessons.length,
        });
      }

      const crystal = {
        label: effectiveLabel,
        ts: now.toISOString(),
        session_count: sessionHistory.length,
        lesson_count: allLessons.length,
        top_patterns: topPatterns,
        categories: [...categoryMap.keys()],
        created_from: `${sessionHistory.length} sessions, ${allLessons.length} lessons`,
      };

      const crystalJson = JSON.stringify(crystal);
      await redis.set('cachly:crystal:latest', crystalJson);
      await redis.expire('cachly:crystal:latest', 90 * 86400);
      await redis.set(`cachly:crystal:${week}`, crystalJson);
      await redis.expire(`cachly:crystal:${week}`, 365 * 86400);

      const lines = [
        `💎 **Memory Crystal created: ${effectiveLabel}**`,
        ``,
        `📊 Compressed: **${sessionHistory.length} sessions** + **${allLessons.length} lessons** → ${topPatterns.length} top patterns`,
        ``,
        `**Top patterns by category:**`,
        ...topPatterns.slice(0, 6).map(p => `  • **${p.category}** (${p.count}×): ${p.insight.slice(0, 90)}`),
        ``,
        `💡 This crystal will appear in every future \`session_start\` briefing.`,
        `💡 Re-run \`memory_crystalize\` monthly to keep it fresh.`,
      ];
      return lines.join('\n');
    }

    case 'brain_doctor': {
      const { instance_id, workspace_path: drWorkspacePath = '' } = args as { instance_id: string; workspace_path?: string };
      const redis = await getConnection(instance_id);
      const issues: string[] = [];
      const checks: string[] = [];

      // Count lessons
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      // Count context
      let ctxCount = 0;
      const ctxStream = redis.scanStream({ match: 'cachly:ctx:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        ctxStream.on('data', (batch: string[]) => {
          ctxCount += batch.filter((k: string) => !k.endsWith(':meta')).length;
        });
        ctxStream.on('end', resolve);
        ctxStream.on('error', reject);
      });

      // Load lessons for analysis
      type DrLesson = {
        topic: string; outcome: string; recall_count?: number; ts: string;
        verified_at?: string; severity?: string; audit_trail?: unknown[];
      };
      const lessons: DrLesson[] = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try { lessons.push(JSON.parse(raw) as DrLesson); } catch { /* skip */ }
      }

      // Last session
      const lastSessionRaw = await redis.get('cachly:session:last');
      let lastSession: { ts: string; summary: string } | null = null;
      if (lastSessionRaw) {
        try { lastSession = JSON.parse(lastSessionRaw); } catch { /* ignore */ }
      }

      // Open failures
      const openFailures = lessons.filter(l => l.outcome === 'failure' || l.outcome === 'partial');
      // Unused lessons (never recalled)
      const unusedLessons = lessons.filter(l => (l.recall_count ?? 0) === 0);
      // Critical lessons
      const criticalLessons = lessons.filter(l => l.severity === 'critical');
      // Confidence decay analysis
      const staleLessons  = lessons.filter(l => l.outcome === 'success' && calculateConfidence(l) < CONFIDENCE_STALE_VALUE);
      const warnLessons   = lessons.filter(l => l.outcome === 'success' && calculateConfidence(l) >= CONFIDENCE_STALE_VALUE && calculateConfidence(l) < CONFIDENCE_WARN_VALUE);
      const withAudit     = lessons.filter(l => (l.audit_trail ?? []).length > 1);
      // Team lessons
      type DrLessonWithAuthor = DrLesson & { author?: string };
      const teamLessons = (lessons as DrLessonWithAuthor[]).filter(l => l.author);
      const uniqueAuthors = new Set((lessons as DrLessonWithAuthor[]).map(l => l.author).filter(Boolean));
      // Effective IQ boost: total recalls / lessons (how much the brain actually helped)
      const totalRecalls = lessons.reduce((sum, l) => sum + (l.recall_count ?? 0), 0);
      const iqBoostPct = lessons.length > 0 ? Math.min(100, Math.round((totalRecalls / lessons.length) * 10)) : 0;

      // Quality score (0-100)
      let score = 50;
      if (lessonKeys.length >= 5)  score += 10;
      if (lessonKeys.length >= 20) score += 10;
      if (ctxCount >= 3)           score += 10;
      if (ctxCount >= 10)          score += 5;
      if (lastSession)             score += 10;
      if (openFailures.length === 0) score += 5;
      const unusedRatio = lessons.length > 0 ? unusedLessons.length / lessons.length : 0;
      if (unusedRatio < 0.5)       score += 10;
      if (staleLessons.length === 0) score += 5;
      if (uniqueAuthors.size >= 2) score += 5; // team collaboration bonus

      const scoreEmoji = score >= 80 ? '🟢' : score >= 50 ? '🟡' : '🔴';
      const iqEmoji = iqBoostPct >= 50 ? '🚀' : iqBoostPct >= 20 ? '📈' : '💤';

      checks.push(`${scoreEmoji} **Brain Quality Score: ${score}/100**`);
      checks.push(`${iqEmoji} **Effective IQ Boost: ${iqBoostPct}%** (${totalRecalls} recalls across ${lessons.length} lessons)`);
      checks.push(`📚 **Lessons:** ${lessonKeys.length} (${criticalLessons.length} critical · ${withAudit.length} with audit trail · ${teamLessons.length} from team)`);
      checks.push(`💾 **Context entries:** ${ctxCount}`);
      checks.push(`🎯 **Confidence:** ${lessons.length - staleLessons.length - warnLessons.length} fresh · ${warnLessons.length} warn · ${staleLessons.length} stale`);
      checks.push(`⏱️ **Decay config:** warn after ${CONFIDENCE_WARN_DAYS}d · stale after ${CONFIDENCE_STALE_DAYS}d`);
      if (uniqueAuthors.size >= 2) {
        checks.push(`👥 **Team:** ${uniqueAuthors.size} contributors (${[...uniqueAuthors].join(', ')})`);
      }

      // Stale index detection
      try {
        const lastIndexRaw = await redis.get('cachly:index:last_run');
        if (lastIndexRaw) {
          const lastIndexAge = Math.round((Date.now() - new Date(lastIndexRaw).getTime()) / 86_400_000);
          if (lastIndexAge > 7) {
            issues.push(`🔄 Index is ${lastIndexAge}d stale — run \`index_project\` to re-sync semantic search`);
          } else {
            checks.push(`🗂️ **Semantic index:** ${lastIndexAge}d old (fresh)`);
          }
        } else {
          issues.push(`💡 No semantic index — run \`index_project(dir="<your-src>")\` to enable semantic search`);
        }
      } catch { /* non-critical */ }

      // Memory crystal status
      try {
        const crystalRaw = await redis.get('cachly:crystal:latest');
        if (crystalRaw) {
          const crystal = JSON.parse(crystalRaw) as { ts: string; label: string };
          const crystalAge = Math.round((Date.now() - new Date(crystal.ts).getTime()) / 86_400_000);
          checks.push(`💎 **Memory Crystal:** ${crystal.label} (${crystalAge}d ago)`);
          if (crystalAge > 30) issues.push(`💡 Memory Crystal is ${crystalAge}d old — re-run \`memory_crystalize\` to compress new sessions`);
        } else if (lessonKeys.length >= 10) {
          issues.push(`💡 ${lessonKeys.length} lessons but no Memory Crystal — run \`memory_crystalize\` to compress wisdom`);
        }
      } catch { /* non-critical */ }

      // openclaw cross-promo (check package.json in workspace)
      if (drWorkspacePath) {
        try {
          const pkgPath = drWorkspacePath.replace(/\/$/, '') + '/package.json';
          const pkgRaw = readFileSync(pkgPath, 'utf-8');
          const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          const hasLLMDep = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'mistralai', 'cohere-ai'].some(d => d in allDeps);
          const hasOpenclaw = '@cachly-dev/openclaw' in allDeps;
          if (hasLLMDep && !hasOpenclaw) {
            issues.push(`💡 **openclaw missing:** you use LLM APIs (${Object.keys(allDeps).filter(d => ['openai','@anthropic-ai/sdk'].includes(d)).join(', ')}) but not \`@cachly-dev/openclaw\``);
            issues.push(`   → \`npm install @cachly-dev/openclaw\` cuts LLM costs 60–90% with 3 lines of code`);
          } else if (hasOpenclaw) {
            checks.push(`✅ **@cachly-dev/openclaw installed** (LLM cost caching active)`);
          }
        } catch { /* no package.json or unreadable */ }
      }

      if (lastSession) {
        const ageMin = Math.round((Date.now() - new Date(lastSession.ts).getTime()) / 60000);
        const ageStr = ageMin < 60 ? `${ageMin}m` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 1440)}d`;
        checks.push(`🕐 **Last session:** ${ageStr} ago`);
      } else {
        issues.push('❌ No session history — call `session_start` + `session_end` to start tracking');
      }

      if (lessonKeys.length === 0) {
        issues.push('❌ No lessons — call `learn_from_attempts` after solving bugs');
      } else if (lessonKeys.length < 5) {
        issues.push(`💡 Only ${lessonKeys.length} lessons — add more after each problem solved`);
      }

      if (iqBoostPct === 0 && lessons.length >= 5) {
        issues.push(`💤 **IQ Boost is 0%** — lessons exist but are never recalled. Use \`recall_best_solution\` BEFORE tasks.`);
      }

      if (ctxCount === 0) {
        issues.push('💡 No context — use `remember_context` to cache architecture docs, ADRs, etc.');
      }

      if (openFailures.length > 0) {
        issues.push(`⚠️ ${openFailures.length} unresolved failure${openFailures.length > 1 ? 's' : ''}: ${openFailures.slice(0, 3).map(l => `\`${l.topic}\``).join(', ')}`);
      }

      if (staleLessons.length > 0) {
        issues.push(`🔴 ${staleLessons.length} STALE lesson${staleLessons.length > 1 ? 's' : ''} (>${CONFIDENCE_STALE_DAYS}d, confidence <${CONFIDENCE_STALE_VALUE * 100}%): ${staleLessons.slice(0, 3).map(l => `\`${l.topic}\``).join(', ')}`);
        issues.push(`   → Re-verify with \`recall_best_solution\` to reset confidence clock`);
      }

      if (warnLessons.length > 0) {
        issues.push(`⚠️ ${warnLessons.length} lesson${warnLessons.length > 1 ? 's' : ''} aging (>${CONFIDENCE_WARN_DAYS}d): ${warnLessons.slice(0, 3).map(l => `\`${l.topic}\``).join(', ')}`);
      }

      if (unusedRatio > 0.7 && lessons.length > 5) {
        issues.push(`💡 ${unusedLessons.length} lessons never recalled — verify topics match your workflow`);
      }

      const lines = ['🩺 **Brain Doctor Report**', '', ...checks.map(c => '  ' + c), ''];
      if (issues.length > 0) {
        lines.push('**Issues to fix:**');
        for (const i of issues) lines.push('  ' + i);
        lines.push('');
      } else {
        lines.push('  🎉 Brain looks healthy! Keep calling session_start/session_end.');
      }
      return lines.join('\n');
    }

    // ── recall_at — Brain Archaeology ────────────────────────────────────────
    case 'recall_at': {
      const { instance_id, topic, date } = args as { instance_id: string; topic: string; date: string };
      const redis = await getConnection(instance_id);
      const cutoff = new Date(date).getTime();
      if (isNaN(cutoff)) return `❌ Invalid date "${date}". Use ISO format: "2026-01-15"`;

      const listKey = `cachly:lessons:${topic}`;
      const all = await redis.lrange(listKey, 0, -1);
      if (all.length === 0) return `📭 No history found for \`${topic}\`. Lessons are stored via \`learn_from_attempts\`.`;

      const before = all
        .map(raw => { try { return JSON.parse(raw) as { ts: string; outcome?: string; what_worked?: string; what_failed?: string }; } catch { return null; } })
        .filter((l): l is NonNullable<typeof l> => l !== null && new Date(l.ts).getTime() <= cutoff)
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

      if (before.length === 0) return `📭 No entries for \`${topic}\` found before **${date}**. Earliest entry: ${new Date(JSON.parse(all[0]).ts).toLocaleDateString('de-DE')}.`;

      const lines = [
        `🏺 **Brain Archaeology: \`${topic}\` before ${date}**`,
        `_${before.length} of ${all.length} total entries shown_`,
        '',
      ];
      for (const l of before.slice(-10)) {
        const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
        const d = new Date(l.ts).toLocaleDateString('de-DE');
        lines.push(`**${d}** ${emoji} ${l.outcome}`);
        if (l.what_worked) lines.push(`  → ${l.what_worked.slice(0, 100)}`);
        lines.push('');
      }
      lines.push(`_Full evolution: ${all.map(r => { try { const l = JSON.parse(r) as { outcome?: string }; return l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌'; } catch { return '?'; } }).join(' → ')}_`);
      return lines.join('\n');
    }

    // ── trace_dependency — Causal Chain ──────────────────────────────────────
    case 'trace_dependency': {
      const { instance_id, dependency, mark_review = false } = args as { instance_id: string; dependency: string; mark_review?: boolean };
      const redis = await getConnection(instance_id);

      const depKey = `cachly:dep:${dependency}`;
      const raw = await redis.get(depKey);
      if (!raw) return `📭 No lessons found that depend on \`${dependency}\`.\n\nAdd dependencies via: \`learn_from_attempts(..., depends_on=["${dependency}"])\``;

      const topics: string[] = JSON.parse(raw);
      const lines = [
        `🔗 **Causal Chain: \`${dependency}\`** — ${topics.length} dependent lesson${topics.length === 1 ? '' : 's'}`,
        '',
      ];

      for (const t of topics) {
        const lessonRaw = await redis.get(`cachly:lesson:best:${t}`);
        if (!lessonRaw) { lines.push(`  • \`${t}\` _(lesson deleted)_`); continue; }
        const lesson = JSON.parse(lessonRaw) as { outcome?: string; severity?: string; needs_review?: boolean };
        const emoji = lesson.outcome === 'success' ? '✅' : lesson.outcome === 'partial' ? '⚠️' : '❌';
        const reviewBadge = lesson.needs_review ? ' 🔍 **needs_review**' : '';
        lines.push(`  ${emoji} \`${t}\` (${lesson.severity ?? 'major'})${reviewBadge}`);

        if (mark_review) {
          const updated = { ...lesson, needs_review: true };
          await redis.set(`cachly:lesson:best:${t}`, JSON.stringify(updated));
        }
      }

      if (mark_review) {
        lines.push('', `🔍 All ${topics.length} lessons marked as **needs_review** — verify they still work with the changed dependency.`);
      } else {
        lines.push('', `_Run with \`mark_review: true\` to flag all dependent lessons for re-verification._`);
      }
      return lines.join('\n');
    }

    // ── global_learn ──────────────────────────────────────────────────────────
    case 'global_learn': {
      const { instance_id, topic, lesson, severity = 'minor', tags = [] } = args as {
        instance_id: string;
        topic: string;
        lesson: string;
        severity?: string;
        tags?: string[];
      };
      const redis = await getConnection(instance_id);
      const key = `cachly:global:lesson:${topic}`;
      const record = {
        topic,
        lesson,
        severity,
        tags,
        ts: new Date().toISOString(),
        scope: 'global',
        recall_count: 0,
      };
      // Preserve recall_count on update
      const existing = await redis.get(key);
      if (existing) {
        const prev = JSON.parse(existing) as { recall_count?: number };
        record.recall_count = prev.recall_count ?? 0;
      }
      await redis.set(key, JSON.stringify(record));
      return `🌐 **Global lesson stored**: \`${topic}\`\n\n${lesson}\n\nRecallable from any project via \`global_recall(topic="${topic}")\`.`;
    }

    // ── global_recall ─────────────────────────────────────────────────────────
    case 'global_recall': {
      const { instance_id, topic } = args as { instance_id: string; topic?: string };
      const redis = await getConnection(instance_id);
      const keys: string[] = [];
      const gStream = redis.scanStream({ match: 'cachly:global:lesson:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        gStream.on('data', (batch: string[]) => keys.push(...batch));
        gStream.on('end', resolve);
        gStream.on('error', reject);
      });

      type GlobalLesson = { topic: string; lesson: string; severity?: string; ts: string; recall_count?: number };
      let lessons: GlobalLesson[] = [];
      for (const k of keys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try { lessons.push(JSON.parse(raw) as GlobalLesson); } catch { /* skip */ }
      }

      if (topic) {
        const t = topic.toLowerCase();
        lessons = lessons.filter(l => l.topic.toLowerCase().includes(t));
      }

      if (lessons.length === 0) {
        return `📭 No global lessons${topic ? ` for \`${topic}\`` : ''}.\n\nAdd cross-project knowledge with \`global_learn(topic="...", lesson="...")\`.`;
      }

      // Increment recall_count
      for (const l of lessons) {
        const k = `cachly:global:lesson:${l.topic}`;
        const raw = await redis.get(k);
        if (raw) {
          const rec = JSON.parse(raw) as { recall_count?: number };
          rec.recall_count = (rec.recall_count ?? 0) + 1;
          await redis.set(k, JSON.stringify(rec));
        }
      }

      const lines = [`🌐 **Global Brain** — ${lessons.length} lesson${lessons.length > 1 ? 's' : ''}`, ''];
      for (const l of lessons) {
        const sev = l.severity === 'critical' ? '🔴 ' : l.severity === 'major' ? '🟡 ' : '';
        lines.push(`${sev}**\`${l.topic}\`**`);
        lines.push(l.lesson.slice(0, 200));
        lines.push('');
      }
      return lines.join('\n');
    }

    // ── publish_lesson ────────────────────────────────────────────────────────
    case 'publish_lesson': {
      const { instance_id, topic, lesson, framework = 'general', severity = 'minor' } = args as {
        instance_id: string;
        topic: string;
        lesson: string;
        framework?: string;
        severity?: string;
      };
      const redis = await getConnection(instance_id);

      // Strip potential PII patterns (emails, tokens, paths)
      const sanitized = lesson
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[email]')
        .replace(/\b(sk-|cky_live_|Bearer\s)[A-Za-z0-9_\-]{8,}/g, '[token]')
        .replace(/\/Users\/[^\s/]+/g, '/Users/[user]')
        .replace(/\/home\/[^\s/]+/g, '/home/[user]');

      const publicLesson = {
        topic,
        lesson: sanitized,
        framework,
        severity,
        ts: new Date().toISOString(),
        published: true,
        votes: 0,
      };

      // Store locally with public flag (future: sync to Cachly public API)
      const key = `cachly:public:lesson:${framework}:${topic}`;
      await redis.set(key, JSON.stringify(publicLesson), 'EX', 365 * 86400);

      return [
        `📢 **Lesson published!**`,
        ``,
        `**Topic:** \`${topic}\``,
        `**Framework:** ${framework}`,
        `**Content:** ${sanitized.slice(0, 200)}${sanitized.length > 200 ? '…' : ''}`,
        ``,
        `This lesson is now available in the Public Brain for other developers.`,
        `Import it anywhere: \`import_public_brain(framework="${framework}")\``,
      ].join('\n');
    }

    // ── import_public_brain ───────────────────────────────────────────────────
    case 'import_public_brain': {
      const { instance_id, framework, limit = 20 } = args as {
        instance_id: string;
        framework: string;
        limit?: number;
      };
      const redis = await getConnection(instance_id);

      // Community-curated lessons per framework
      const COMMUNITY_LESSONS: Record<string, Array<{ topic: string; lesson: string; severity: string }>> = {
        nextjs: [
          { topic: 'nextjs:image-layout', lesson: 'Use fill + relative parent instead of layout="fill" (deprecated since Next.js 13)', severity: 'major' },
          { topic: 'nextjs:app-router-fetch', lesson: 'fetch() in Server Components is cached by default — add {cache:"no-store"} for dynamic data', severity: 'major' },
          { topic: 'nextjs:metadata-export', lesson: 'Export metadata const or generateMetadata() — never both in same file', severity: 'minor' },
          { topic: 'nextjs:client-boundary', lesson: '"use client" propagates down — keep it at the lowest component, not at page level', severity: 'major' },
          { topic: 'nextjs:env-prefix', lesson: 'Only NEXT_PUBLIC_* env vars are exposed to client — others are server-only', severity: 'critical' },
          { topic: 'nextjs:revalidate', lesson: 'export const revalidate = 0 disables caching for entire route; use revalidatePath() for on-demand', severity: 'minor' },
        ],
        fastapi: [
          { topic: 'fastapi:async-db', lesson: 'Use async session with asyncpg — sync SQLAlchemy blocks the event loop', severity: 'critical' },
          { topic: 'fastapi:pydantic-v2', lesson: 'Pydantic v2: use model_validate() instead of parse_obj(), .dict() → .model_dump()', severity: 'major' },
          { topic: 'fastapi:lifespan', lesson: 'Use lifespan context manager instead of deprecated on_event startup/shutdown', severity: 'minor' },
          { topic: 'fastapi:background-tasks', lesson: 'BackgroundTasks run after response is sent — not in a separate thread pool', severity: 'major' },
          { topic: 'fastapi:cors-order', lesson: 'CORSMiddleware must be added before other middleware to work correctly', severity: 'critical' },
        ],
        go: [
          { topic: 'go:context-cancel', lesson: 'Always call cancel() from context.WithCancel — leak goroutines if not cancelled', severity: 'critical' },
          { topic: 'go:defer-in-loop', lesson: 'defer in a loop runs at function return, not loop iteration — use IIFE or explicit close', severity: 'major' },
          { topic: 'go:nil-interface', lesson: 'nil interface != interface containing nil pointer — use explicit nil checks', severity: 'major' },
          { topic: 'go:goroutine-leak', lesson: 'Goroutines with channel sends block forever if receiver is gone — use select with done chan', severity: 'critical' },
          { topic: 'go:embed-path', lesson: '//go:embed path must be relative and known at compile time — no os.Getenv', severity: 'minor' },
        ],
        docker: [
          { topic: 'docker:layer-cache', lesson: 'Copy package.json before source code — Docker caches layers, npm install only reruns on dep changes', severity: 'major' },
          { topic: 'docker:non-root', lesson: 'Run as non-root user (USER 1001) — some k8s clusters reject root containers by policy', severity: 'critical' },
          { topic: 'docker:build-arg-secret', lesson: 'Never use ARG for secrets — visible in image history. Use --secret mount instead', severity: 'critical' },
          { topic: 'docker:entrypoint-exec', lesson: 'Use exec form ["cmd","arg"] not shell form "cmd arg" — shell form ignores SIGTERM', severity: 'major' },
          { topic: 'docker:multi-stage', lesson: 'Multi-stage builds: copy only built artifacts to final stage — keep image small', severity: 'minor' },
        ],
        kubernetes: [
          { topic: 'k8s:resource-limits', lesson: 'Always set resource limits — unbounded pods cause node evictions and OOMKill', severity: 'critical' },
          { topic: 'k8s:liveness-vs-readiness', lesson: 'Liveness failures restart pod; Readiness failures remove from LB. Use different endpoints', severity: 'major' },
          { topic: 'k8s:imagepullpolicy', lesson: 'imagePullPolicy: Always in production — IfNotPresent can serve stale images', severity: 'major' },
          { topic: 'k8s:configmap-env', lesson: 'ConfigMap changes don\'t restart pods — use rollout restart or mount as volume', severity: 'critical' },
          { topic: 'k8s:pdb', lesson: 'Set PodDisruptionBudget for stateful apps — node drains kill all pods without it', severity: 'major' },
        ],
        react: [
          { topic: 'react:useeffect-deps', lesson: 'Omitting dependencies from useEffect deps array causes stale closure bugs — use exhaustive-deps ESLint rule', severity: 'critical' },
          { topic: 'react:key-index', lesson: 'Never use array index as key in lists — causes subtle re-render bugs on reorder/delete', severity: 'major' },
          { topic: 'react:setState-in-render', lesson: 'setState() during render causes infinite loop — move to useEffect or event handler', severity: 'critical' },
          { topic: 'react:memo-reference', lesson: 'Object/array literals in JSX recreate on every render — useMemo for expensive derived values', severity: 'minor' },
        ],
        typescript: [
          { topic: 'ts:type-guard', lesson: 'Use "x is Type" return type for type guard functions — not "boolean"', severity: 'minor' },
          { topic: 'ts:strict-null', lesson: 'Enable strictNullChecks in tsconfig — catches 90% of runtime null errors at compile time', severity: 'critical' },
          { topic: 'ts:enum-avoid', lesson: 'Prefer union types ("a"|"b") over enum — enums have surprising runtime behavior', severity: 'minor' },
          { topic: 'ts:satisfies', lesson: 'Use "satisfies" operator to validate type without widening — more precise than explicit annotation', severity: 'minor' },
        ],
        python: [
          { topic: 'python:mutable-default', lesson: 'Never use mutable default arguments (def f(x=[])) — shared across all calls. Use None + guard', severity: 'critical' },
          { topic: 'python:walrus-operator', lesson: ':= (walrus) assigns and returns — useful in while/comprehensions but hard to read in complex expr', severity: 'minor' },
          { topic: 'python:asyncio-run', lesson: 'asyncio.run() creates new event loop — calling it inside an existing loop raises RuntimeError', severity: 'major' },
          { topic: 'python:typing-optional', lesson: 'Optional[X] == Union[X, None] — in Python 3.10+ use X | None syntax', severity: 'minor' },
        ],
      };

      const fw = framework.toLowerCase();
      const lessons = COMMUNITY_LESSONS[fw];

      if (!lessons) {
        const available = Object.keys(COMMUNITY_LESSONS).join(', ');
        return `❌ No public brain available for \`${framework}\`.\n\nAvailable: ${available}\n\nOr publish your own: \`publish_lesson(framework="${framework}", ...)\``;
      }

      const toImport = lessons.slice(0, limit);
      let importedCount = 0;

      for (const l of toImport) {
        const key = `cachly:lesson:best:${l.topic}`;
        const existing = await redis.get(key);
        if (!existing) {
          await redis.set(key, JSON.stringify({
            ...l,
            what_worked: l.lesson,
            outcome: 'success',
            ts: new Date().toISOString(),
            recall_count: 0,
            source: 'public_brain',
            version: 2,
          }));
          importedCount++;
        }
      }

      const lines = [
        `📥 **Public Brain imported: ${framework}**`,
        ``,
        `${importedCount} new lessons added (${toImport.length - importedCount} already existed)`,
        ``,
        `**Imported topics:**`,
        ...toImport.map(l => {
          const sev = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '💡';
          return `  ${sev} \`${l.topic}\``;
        }),
        ``,
        `These lessons will now appear in \`session_start\` when relevant.`,
        `Recall any time: \`recall_best_solution(topic="${fw}:...")\``,
      ];
      return lines.join('\n');
    }

    // ── setup_ai_memory ───────────────────────────────────────────────────────
    case 'setup_ai_memory': {
      const {
        instance_id,
        project_dir,
        embed_provider: providerArg = 'openai',
        project_description = 'a software project',
      } = args as {
        instance_id: string;
        project_dir?: string;
        embed_provider?: string;
        project_description?: string;
      };

      const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);

      // Provider-specific env var instructions
      const providerEnvMap: Record<string, { key: string; hint: string }> = {
        openai:  { key: 'OPENAI_API_KEY',  hint: 'Get at: https://platform.openai.com/api-keys' },
        mistral: { key: 'MISTRAL_API_KEY', hint: 'Get at: https://console.mistral.ai/api-keys' },
        cohere:  { key: 'COHERE_API_KEY',  hint: 'Get at: https://dashboard.cohere.com/api-keys' },
        ollama:  { key: 'OLLAMA_BASE_URL', hint: 'Run: brew install ollama && ollama serve  (free, local, no key needed)' },
        gemini:  { key: 'GEMINI_API_KEY',  hint: 'Get at: https://aistudio.google.com/app/apikey' },
      };
      const provInfo = providerEnvMap[providerArg] ?? providerEnvMap['openai'];
      const hasVector = !!inst.vector_token;

      // Generate .mcp.json snippet
      const mcpJsonSnippet = JSON.stringify({
        mcpServers: {
          cachly: {
            command: 'npx',
            args: ['-y', '@cachly-dev/mcp-server@latest'],
            env: {
              CACHLY_JWT: 'your-api-token-from-cachly.dev/settings',
              [provInfo.key]: providerArg === 'ollama' ? 'http://localhost:11434' : 'your-key-here',
              ...(providerArg !== 'openai' ? { CACHLY_EMBED_PROVIDER: providerArg } : {}),
            },
          },
        },
      }, null, 2);

      // Generate copilot-instructions.md content
      const tier = inst.tier.toUpperCase();
      const smartRecallNote = hasVector
        ? '- `smart_recall("natural language query")` — semantic search (finds by meaning)'
        : '- `recall_context("arch:*")` — exact/glob key lookup (upgrade to Speed/Business for smart_recall)';
      const layerNote = hasVector
        ? `Layer 3 (Semantic): smart_recall uses pgvector HNSW on your ${tier} instance`
        : `Layer 3 (Autopilot): this file — upgrade to Speed/Business tier to unlock smart_recall`;

      const copilotInstructions = `# cachly AI Brain — ${project_description}

> AI memory system powered by [cachly.dev](https://cachly.dev). Works with GitHub Copilot, Claude Code, Cursor, Windsurf, Continue.dev, and any MCP-compatible editor.

---

## 🔴 MANDATORY RULES — Always enforced, no exceptions

### Rule 1 — Session Start (FIRST thing in every window)
Call \`session_start\` **before reading any source files or making any changes**:

\`\`\`
session_start(
  instance_id = "${instance_id}",
  focus       = "<what you plan to work on today>",
)
\`\`\`

Returns: last session summary, handoff from previous window, recent lessons, open failures, brain health.

**If \`session_start\` is unavailable**, fall back:
1. \`smart_recall("recent lessons <topic>")\`
2. \`recall_best_solution("<topic>")\`

### Rule 2 — Learn After Every Fix/Deploy/Discovery (AUTOMATIC — no prompting needed)
After **every** bug fix, deployment, failed attempt, or discovery — call \`learn_from_attempts\` immediately:

\`\`\`
learn_from_attempts(
  instance_id = "${instance_id}",
  topic       = "category:keyword",   # deploy:web | fix:auth | debug:db | infra:docker
  outcome     = "success" | "failure" | "partial",
  what_worked = "exact approach or command that worked",
  what_failed = "what did NOT work (prevents future wasted time)",
  severity    = "critical" | "major" | "minor",
  commands    = ["exact command that worked"],
  file_paths  = ["path/to/changed/file"],
)
\`\`\`

**These events MUST automatically trigger \`learn_from_attempts\`:**
- ✅ Successfully deployed → \`topic="deploy:<component>", outcome="success"\`
- ✅ Fixed a bug → \`topic="fix:<description>", outcome="success"\`
- ✅ Discovered root cause → \`topic="debug:<area>", outcome="partial"\`
- ✅ Tried something that failed → \`topic="<area>", outcome="failure", what_failed="..."\`
- ✅ Found a config quirk → \`topic="infra:<topic>", outcome="success"\`
- ✅ Ran a working command → store it in \`commands=[...]\`

### Rule 3 — Session Handoff (when closing window or task list > 3 items)
\`\`\`
session_handoff(
  instance_id     = "${instance_id}",
  completed_tasks = ["what was done"],
  remaining_tasks = ["what is still to do"],
  files_changed   = [{"path": "src/...", "status": "modified", "description": "what changed"}],
  instructions    = "IMPORTANT: what the next window MUST know to not break things",
  context_summary = "current state of the system",
)
\`\`\`

The next \`session_start\` automatically includes this handoff. The new window sees exactly what's done, what remains, and what NOT to break.

### Rule 4 — Session End (LAST thing before closing)
\`\`\`
session_end(
  instance_id     = "${instance_id}",
  summary         = "What was accomplished (2-3 sentences with specifics)",
  files_changed   = ["list", "of", "changed", "files"],
  lessons_learned = <number of learn_from_attempts calls made>,
)
\`\`\`

> \`session_end\` **automatically extracts and stores lessons** from the summary text — no manual calls needed.

### Rule 5 — Code Index Invalidation (AUTOMATIC)
- \`index_project\` tracks MD5 hashes per file — **skips unchanged files automatically**
- After code changes: next \`index_project\` run re-indexes only modified files
- After delete/rename: run \`index_project\` again to sync
- No manual invalidation needed

---

## Task-type trigger table

| You're about to... | Call BEFORE | Call AFTER |
|---|---|---|
| Deploy anything | \`recall_best_solution("deploy:<component>")\` | \`learn_from_attempts(topic="deploy:...")\` |
| Fix a bug | \`recall_best_solution("fix:<area>")\` | \`learn_from_attempts(topic="fix:...")\` |
| Add a feature | \`session_start(focus="feat:<area>")\` | \`learn_from_attempts(topic="feat:...")\` |
| Infra/server work | \`recall_best_solution("infra:<topic>")\` | \`learn_from_attempts(topic="infra:...")\` |
| Debug an issue | \`smart_recall("<error message or symptom>")\` | \`learn_from_attempts(topic="debug:...")\` |

---

## Available Brain Tools

| Tool | When to use |
|------|-------------|
| \`session_start\` | **FIRST** — mandatory at start of every session |
| \`session_end\` | **LAST** — mandatory at end, auto-learns from summary |
| \`session_handoff\` | When closing window with remaining tasks |
| \`learn_from_attempts\` | **AUTOMATIC** after every fix/deploy/discovery |
| \`recall_best_solution\` | Before any non-trivial task |
| \`remember_context\` | After analyzing code — save findings for future sessions |
${smartRecallNote ? `| \`smart_recall\` | Search brain by meaning/keywords |\n` : ''}\
| \`recall_context\` | Get exact key (supports glob: \`arch:*\`, \`file:*\`) |
| \`brain_search\` | BM25+ full-text search over all brain data |
| \`auto_learn_session\` | Batch-learn from a list of observations (optional) |
| \`index_project\` | Index source files (smart hash, skips unchanged files) |
| \`list_remembered\` | See what's cached in the brain |
| \`forget_context\` | Remove stale context |

---

## Instance Details

- **Instance ID:** \`${instance_id}\`
- **Instance name:** ${inst.name}
- **Tier:** ${tier}
- **${layerNote}**
- **Embedding provider:** ${providerArg}

---

## How the 3-layer system works

\`\`\`
Layer 1 — Storage:  Your cachly Valkey instance (${inst.name}) — persists forever
Layer 2 — Tools:    learn_from_attempts · recall_best_solution · brain_search · session_start/end
Layer 3 — Autopilot: This file — AI reads it and runs tools automatically every session
\`\`\`

Result: Your AI **never solves the same problem twice** and always picks up exactly where it left off. 🚀
`;


      const lines: string[] = [
        `🧠 **cachly AI Memory Setup Complete**`,
        ``,
        `**Instance:** ${inst.name} (${tier}) · ID: \`${instance_id}\``,
        `**Embedding Provider:** ${providerArg}`,
        `**Semantic Search:** ${hasVector ? '✅ pgvector HNSW available' : '⚠️  Not available on ' + tier + ' — upgrade to Speed/Business'}`,
        ``,
        `─────────────────────────────────────────────`,
        `**Step 1 — Add to .mcp.json:**`,
        `\`\`\`json`,
        mcpJsonSnippet,
        `\`\`\``,
        ``,
        `**Step 2 — Set your ${providerArg} key:**`,
        `\`\`\`bash`,
        `export ${provInfo.key}="your-key-here"`,
        `\`\`\``,
        `_(${provInfo.hint})_`,
        ``,
        `─────────────────────────────────────────────`,
        `**Step 3 — copilot-instructions.md (Layer 3 Autopilot):**`,
        ``,
        ...(project_dir
          ? [`🔍 Detecting IDEs in \`${project_dir}\`…`]
          : [`Copy this to \`.github/copilot-instructions.md\` (Copilot), \`CLAUDE.md\` (Claude Code), or \`.cursor/rules\` (Cursor) in your project:`]),
        ``,
        `\`\`\`markdown`,
        copilotInstructions,
        `\`\`\``,
        ``,
        `─────────────────────────────────────────────`,
        `**How the 3 layers work together:**`,
        `  Layer 1 → Your Valkey instance stores all lessons + context (persists forever)`,
        `  Layer 2 → MCP tools (learn_from_attempts, recall_best_solution, smart_recall) read/write it`,
        `  Layer 3 → copilot-instructions.md makes your AI run them automatically`,
        ``,
        `Result: Your AI never solves the same problem twice. 🚀`,
      ];

      // ── IDE auto-detection + file writing ────────────────────────────────
      if (project_dir) {
        const { mkdir, writeFile, access } = await import('node:fs/promises');
        const { constants } = await import('node:fs');

        const exists = async (p: string) => access(p, constants.F_OK).then(() => true).catch(() => false);

        // Detect which IDEs are present based on marker files/dirs
        interface IdeTarget { ide: string; path: string; content: string }
        const targets: IdeTarget[] = [];
        let stopHookWritten = false;

        // GitHub Copilot — always write (universal fallback)
        targets.push({
          ide: 'GitHub Copilot',
          path: join(project_dir, '.github', 'copilot-instructions.md'),
          content: copilotInstructions,
        });

        // Claude Code — CLAUDE.md in project root
        if (await exists(join(project_dir, 'CLAUDE.md')) || await exists(join(project_dir, '.claude'))) {
          targets.push({
            ide: 'Claude Code',
            path: join(project_dir, 'CLAUDE.md'),
            content: copilotInstructions,
          });

          // Claude Code Stop-Hook — auto-saves checkpoint when Claude stops responding
          const claudeDir = join(project_dir, '.claude');
          await mkdir(claudeDir, { recursive: true });
          const stopHook = {
            hooks: {
              Stop: [
                {
                  matcher: '',
                  hooks: [
                    {
                      type: 'command',
                      command: `npx --yes @cachly-dev/mcp-server@latest checkpoint --instance-id ${instance_id}`,
                    },
                  ],
                },
              ],
            },
          };
          const settingsPath = join(claudeDir, 'settings.json');
          let existingSettings: Record<string, unknown> = {};
          try {
            const { readFile: rf } = await import('node:fs/promises');
            existingSettings = JSON.parse(await rf(settingsPath, 'utf-8'));
          } catch { /* new file */ }
          const merged = { ...existingSettings, hooks: (stopHook as Record<string, unknown>).hooks };
          await writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
          stopHookWritten = true;
        }

        // Cursor — .cursor/rules (new format) or .cursorrules (legacy)
        if (
          await exists(join(project_dir, '.cursor')) ||
          await exists(join(project_dir, '.cursorrules'))
        ) {
          const cursorDir = join(project_dir, '.cursor');
          await mkdir(cursorDir, { recursive: true });
          targets.push({
            ide: 'Cursor',
            path: join(cursorDir, 'rules'),
            content: copilotInstructions,
          });
        }

        // Windsurf — .windsurfrules
        if (
          await exists(join(project_dir, '.windsurfrules')) ||
          await exists(join(project_dir, '.windsurf'))
        ) {
          targets.push({
            ide: 'Windsurf',
            path: join(project_dir, '.windsurfrules'),
            content: copilotInstructions,
          });
        }

        // VS Code (Copilot) — already covered by .github/copilot-instructions.md above
        // Continue.dev — .continue/config.json is JSON, not markdown — skip, copilot-instructions handles it

        const written: string[] = [];
        for (const target of targets) {
          const dir = target.path.substring(0, target.path.lastIndexOf('/'));
          await mkdir(dir, { recursive: true });
          await writeFile(target.path, target.content, 'utf-8');
          written.push(`✅ [${target.ide}] → \`${target.path.replace(project_dir, '.')}\``);
        }

        if (stopHookWritten) {
          written.push(`✅ [Claude Code Stop-Hook] → \`.claude/settings.json\` (auto-checkpoint on stop)`);
        }

        lines.push(...written);
      }

      return lines.join('\n');
    }

    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
}


async function handleBulkLockStream(name: string, args: Record<string, unknown>): Promise<string | null> {
  const instance_id = args.instance_id as string;

  switch (name) {
    // ── cache_mset ────────────────────────────────────────────────────────
    case 'cache_mset': {
      const items = args.items as Array<{ key: string; value: unknown; ttl?: number }>;
      if (!Array.isArray(items) || items.length === 0) return '⚠️ No items provided.';
      const redis = await getConnection(instance_id);
      const pipe = redis.pipeline();
      for (const item of items) {
        const serialized = typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
        if (item.ttl && item.ttl > 0) {
          pipe.set(item.key, serialized, 'EX', item.ttl);
        } else {
          pipe.set(item.key, serialized);
        }
      }
      await pipe.exec();
      return `✅ **cache_mset** – ${items.length} key(s) written in one pipeline round-trip.\n` +
        items.map(i => `  • \`${i.key}\`${i.ttl ? ` (TTL ${i.ttl}s)` : ''}`).join('\n');
    }

    // ── cache_mget ────────────────────────────────────────────────────────
    case 'cache_mget': {
      const keys = args.keys as string[];
      if (!Array.isArray(keys) || keys.length === 0) return '⚠️ No keys provided.';
      const redis = await getConnection(instance_id);
      const raws = await redis.mget(...keys);
      const result = keys.map((k, i) => {
        const raw = raws[i];
        if (raw === null) return `  • \`${k}\`: _null (miss)_`;
        try { return `  • \`${k}\`: ${raw}`; } catch { return `  • \`${k}\`: ${raw}`; }
      });
      return `✅ **cache_mget** – ${keys.length} key(s) fetched in one round-trip.\n` + result.join('\n');
    }

    // ── cache_lock_acquire ────────────────────────────────────────────────
    case 'cache_lock_acquire': {
      const key          = args.key as string;
      const ttlMs        = Number(args.ttl_ms ?? 5000);
      const retries      = Number(args.retries ?? 3);
      const retryDelayMs = Number(args.retry_delay_ms ?? 50);
      const redis        = await getConnection(instance_id);
      const lockKey      = `cachly:lock:${key}`;
      const token        = randomUUID();

      for (let attempt = 0; attempt <= retries; attempt++) {
        const result = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
        if (result === 'OK') {
          return (
            `🔒 **cache_lock_acquire** – Lock acquired!\n\n` +
            `  Key:   \`${key}\`\n` +
            `  Token: \`${token}\`\n` +
            `  TTL:   ${ttlMs} ms\n\n` +
            `💡 Use **cache_lock_release** with this token to release early.`
          );
        }
        if (attempt < retries) await new Promise(r => setTimeout(r, retryDelayMs));
      }
      return `❌ **cache_lock_acquire** – Could not acquire lock for \`${key}\` after ${retries + 1} attempts.`;
    }

    // ── cache_lock_release ────────────────────────────────────────────────
    case 'cache_lock_release': {
      const key   = args.key as string;
      const token = args.token as string;
      const redis = await getConnection(instance_id);
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end`;
      const released = await redis.eval(script, 1, `cachly:lock:${key}`, token);
      return released === 1
        ? `🔓 **cache_lock_release** – Lock \`${key}\` released successfully.`
        : `⚠️ **cache_lock_release** – Lock \`${key}\` was already expired or token mismatch.`;
    }

    // ── cache_stream_set ──────────────────────────────────────────────────
    case 'cache_stream_set': {
      const key    = args.key as string;
      const chunks = args.chunks as string[];
      const ttl    = args.ttl ? Number(args.ttl) : null;
      if (!Array.isArray(chunks) || chunks.length === 0) return '⚠️ No chunks provided.';
      const redis   = await getConnection(instance_id);
      const listKey = `cachly:stream:${key}`;
      await redis.del(listKey);
      const pipe = redis.pipeline();
      for (const chunk of chunks) pipe.rpush(listKey, chunk);
      if (ttl && ttl > 0) pipe.expire(listKey, ttl);
      await pipe.exec();
      return (
        `✅ **cache_stream_set** – ${chunks.length} chunk(s) stored.\n` +
        `  Key: \`${key}\`\n` +
        (ttl ? `  TTL: ${ttl}s\n` : '') +
        `  Total size: ${chunks.reduce((a, c) => a + c.length, 0)} chars`
      );
    }

    // ── cache_stream_get ──────────────────────────────────────────────────
    case 'cache_stream_get': {
      const key     = args.key as string;
      const redis   = await getConnection(instance_id);
      const listKey = `cachly:stream:${key}`;
      const len     = await redis.llen(listKey);
      if (len === 0) return `⚠️ **cache_stream_get** – Cache miss for key \`${key}\`.`;
      const chunks = await redis.lrange(listKey, 0, -1);
      const preview = chunks.join('').slice(0, 500);
      return (
        `✅ **cache_stream_get** – ${len} chunk(s) retrieved for \`${key}\`.\n\n` +
        `**Preview** (first 500 chars):\n\`\`\`\n${preview}${preview.length < chunks.join('').length ? '…' : ''}\n\`\`\``
      );
    }

    // ── Roadmap ──────────────────────────────────────────────────────────────

    case 'roadmap_add': {
      const {
        instance_id: rid,
        title,
        description: desc = '',
        priority = 'medium',
        tags: rtags = [],
        milestone = '',
      } = args as {
        instance_id: string; title: string; description?: string;
        priority?: string; tags?: string[]; milestone?: string;
      };
      const redis = await getConnection(rid);
      const id = `rm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const item = {
        id, title, description: desc, priority, tags: rtags, milestone,
        status: 'planned',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        notes: '',
      };
      await redis.hset(`cachly:roadmap:${rid}`, id, JSON.stringify(item));
      const PRIORITY_ICON: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
      return [
        `📋 **Roadmap item added**`,
        ``,
        `  ID:       \`${id}\``,
        `  Title:    ${title}`,
        `  Priority: ${PRIORITY_ICON[priority] ?? '⚪'} ${priority}`,
        `  Status:   planned`,
        milestone ? `  Milestone: ${milestone}` : '',
        rtags.length ? `  Tags:     ${rtags.join(', ')}` : '',
        ``,
        `💡 Use \`roadmap_update(id: "${id}", status: "in-progress")\` when you start working on it.`,
      ].filter(Boolean).join('\n');
    }

    case 'roadmap_update': {
      const {
        instance_id: rid,
        id: itemId,
        status: newStatus,
        priority: newPriority,
        notes: newNotes,
        title: newTitle,
        description: newDesc,
      } = args as {
        instance_id: string; id: string; status?: string; priority?: string;
        notes?: string; title?: string; description?: string;
      };
      const redis = await getConnection(rid);
      const raw = await redis.hget(`cachly:roadmap:${rid}`, itemId);
      if (!raw) return `⚠️ **roadmap_update** – Item \`${itemId}\` not found. Use \`roadmap_list\` to see all items.`;
      const item = JSON.parse(raw) as Record<string, unknown>;
      const oldStatus = item.status as string;
      if (newStatus) item.status = newStatus;
      if (newPriority) item.priority = newPriority;
      if (newTitle) item.title = newTitle;
      if (newDesc) item.description = newDesc;
      if (newNotes) item.notes = item.notes ? `${item.notes}\n[${new Date().toISOString().slice(0, 10)}] ${newNotes}` : `[${new Date().toISOString().slice(0, 10)}] ${newNotes}`;
      item.updated = new Date().toISOString();
      await redis.hset(`cachly:roadmap:${rid}`, itemId, JSON.stringify(item));
      const statusEmoji: Record<string, string> = { planned: '📋', 'in-progress': '⚡', done: '✅', blocked: '🚫', cancelled: '🗑️' };
      return [
        `${statusEmoji[newStatus ?? oldStatus] ?? '📋'} **Roadmap updated** \`${itemId}\``,
        ``,
        `  Title:  ${item.title}`,
        oldStatus !== newStatus ? `  Status: ${oldStatus} → ${newStatus}` : `  Status: ${item.status}`,
        newNotes ? `  Notes:  ${newNotes}` : '',
      ].filter(Boolean).join('\n');
    }

    case 'roadmap_list': {
      const {
        instance_id: rid,
        status: filterStatus = 'open',
        tag: filterTag,
        milestone: filterMilestone,
        priority: filterPriority,
      } = args as {
        instance_id: string; status?: string; tag?: string;
        milestone?: string; priority?: string;
      };
      const redis = await getConnection(rid);
      const all = await redis.hgetall(`cachly:roadmap:${rid}`);
      if (!all || Object.keys(all).length === 0) {
        return '📋 **Roadmap is empty.**\n\nUse `roadmap_add` to create your first item.';
      }
      const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const PRIORITY_ICON: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
      const STATUS_ICON: Record<string, string> = { planned: '📋', 'in-progress': '⚡', done: '✅', blocked: '🚫', cancelled: '🗑️' };
      const openStatuses = new Set(['planned', 'in-progress', 'blocked']);
      let items = Object.values(all).map(v => JSON.parse(v as string) as Record<string, string | string[]>);
      // Filter
      if (filterStatus === 'open') items = items.filter(i => openStatuses.has(i.status as string));
      else if (filterStatus) items = items.filter(i => i.status === filterStatus);
      if (filterTag) items = items.filter(i => (i.tags as string[]).includes(filterTag));
      if (filterMilestone) items = items.filter(i => i.milestone === filterMilestone);
      if (filterPriority) items = items.filter(i => (PRIORITY_ORDER[i.priority as string] ?? 99) <= (PRIORITY_ORDER[filterPriority] ?? 99));
      // Sort: priority asc, then created asc
      items.sort((a, b) => {
        const pa = PRIORITY_ORDER[a.priority as string] ?? 99;
        const pb = PRIORITY_ORDER[b.priority as string] ?? 99;
        return pa !== pb ? pa - pb : (a.created as string).localeCompare(b.created as string);
      });
      if (items.length === 0) return `📋 **No roadmap items** match the current filter (status: ${filterStatus}).`;
      const grouped: Record<string, typeof items> = {};
      for (const it of items) {
        const st = it.status as string;
        if (!grouped[st]) grouped[st] = [];
        grouped[st].push(it);
      }
      const lines: string[] = [`📋 **Roadmap** (${items.length} item${items.length !== 1 ? 's' : ''})`, ''];
      for (const [st, grp] of Object.entries(grouped)) {
        lines.push(`**${STATUS_ICON[st] ?? '•'} ${st.toUpperCase()}** (${grp.length})`);
        for (const it of grp) {
          const tags = (it.tags as string[]).length ? ` [${(it.tags as string[]).join(', ')}]` : '';
          const milestone = it.milestone ? ` · ${it.milestone}` : '';
          lines.push(`  ${PRIORITY_ICON[it.priority as string] ?? '⚪'} \`${it.id}\` **${it.title}**${tags}${milestone}`);
          if (it.description) lines.push(`      ${(it.description as string).slice(0, 120)}`);
          if (it.notes) lines.push(`      📝 ${(it.notes as string).split('\n').pop()?.slice(0, 100)}`);
        }
        lines.push('');
      }
      lines.push(`💡 \`roadmap_update(id, status: "in-progress")\` to start · \`roadmap_next\` for top priority item`);
      return lines.join('\n');
    }

    case 'roadmap_next': {
      const { instance_id: rid, tag: filterTag } = args as { instance_id: string; tag?: string };
      const redis = await getConnection(rid);
      const all = await redis.hgetall(`cachly:roadmap:${rid}`);
      if (!all || Object.keys(all).length === 0) {
        return '📋 **Roadmap is empty.** Use `roadmap_add` to plan your first task.';
      }
      const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const PRIORITY_ICON: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
      let items = Object.values(all)
        .map(v => JSON.parse(v as string) as Record<string, unknown>)
        .filter(i => i.status === 'in-progress' || i.status === 'planned')
        .filter(i => !filterTag || (i.tags as string[]).includes(filterTag));
      if (items.length === 0) return '🎉 **No open roadmap items!** All tasks are done (or use `roadmap_list` to check).';
      // in-progress first, then by priority
      items.sort((a, b) => {
        if (a.status === 'in-progress' && b.status !== 'in-progress') return -1;
        if (b.status === 'in-progress' && a.status !== 'in-progress') return 1;
        return (PRIORITY_ORDER[a.priority as string] ?? 99) - (PRIORITY_ORDER[b.priority as string] ?? 99);
      });
      const next = items[0];
      const remaining = items.length - 1;
      const tags = (next.tags as string[]).length ? `\nTags:      ${(next.tags as string[]).join(', ')}` : '';
      const milestone = next.milestone ? `\nMilestone: ${next.milestone}` : '';
      const notes = next.notes ? `\nNotes:     ${(next.notes as string).split('\n').pop()?.slice(0, 120)}` : '';
      return [
        `${next.status === 'in-progress' ? '⚡' : '📋'} **Next up: ${next.title}**`,
        ``,
        `ID:        \`${next.id}\``,
        `Priority:  ${PRIORITY_ICON[next.priority as string] ?? '⚪'} ${next.priority}`,
        `Status:    ${next.status}`,
        next.description ? `\nWhat to do:\n${next.description}` : '',
        tags, milestone, notes,
        ``,
        remaining > 0 ? `(+${remaining} more open item${remaining !== 1 ? 's' : ''} in roadmap)` : '(last open item)',
        ``,
        next.status === 'planned'
          ? `💡 Start with: \`roadmap_update(id: "${next.id}", status: "in-progress")\``
          : `💡 Finish with: \`roadmap_update(id: "${next.id}", status: "done", notes: "...")\``,
      ].filter(s => s !== undefined).join('\n');
    }

    // ── v0.6 Cognitive Cache: memory_consolidate ─────────────────────────────
    case 'memory_consolidate': {
      const { instance_id, dry_run = false, stale_days = 90 } = args as {
        instance_id: string; dry_run?: boolean; stale_days?: number;
      };
      const redis = await getConnection(instance_id);
      const now = Date.now();
      const staleMs = stale_days * 86400 * 1000;

      // Scan all lessons
      let cursor = 0;
      const lessonKeys: string[] = [];
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 200);
        cursor = parseInt(next);
        lessonKeys.push(...keys);
      } while (cursor !== 0);

      if (lessonKeys.length === 0) {
        return '🧠 **Brain is empty** — no lessons to consolidate yet. Use `learn_from_attempts` after your next bug fix.';
      }

      type Lesson = { topic: string; outcome: string; what_worked?: string; what_failed?: string; ts: string; recall_count?: number; severity?: string; tags?: string[] };
      const lessons: Map<string, Lesson> = new Map();
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try { lessons.set(k, JSON.parse(raw) as Lesson); } catch { /* skip malformed */ }
      }

      // Detect duplicates: same topic prefix (e.g. deploy:api vs deploy:api-v2)
      const duplicates: string[][] = [];
      const topicGroups = new Map<string, string[]>();
      for (const [k, l] of lessons) {
        const prefix = l.topic.split(':')[0];
        const group = topicGroups.get(prefix) ?? [];
        group.push(k);
        topicGroups.set(prefix, group);
      }

      // Detect contradictions: same exact topic, different outcomes
      const contradictions: Array<{ topic: string; keys: string[] }> = [];
      const exactTopics = new Map<string, string[]>();
      for (const [k, l] of lessons) {
        const arr = exactTopics.get(l.topic) ?? [];
        arr.push(k);
        exactTopics.set(l.topic, arr);
      }
      for (const [topic, keys] of exactTopics) {
        const outcomes = new Set(keys.map(k => lessons.get(k)?.outcome));
        if (outcomes.size > 1) contradictions.push({ topic, keys });
      }

      // Detect stale: not recalled in stale_days
      const stale: string[] = [];
      for (const [k, l] of lessons) {
        const age = now - new Date(l.ts).getTime();
        const recalls = l.recall_count ?? 0;
        if (age > staleMs && recalls === 0) stale.push(k);
      }

      // Merge duplicates by prefix: keep the success/highest-severity one
      let merged = 0;
      if (!dry_run) {
        for (const [, keys] of topicGroups) {
          if (keys.length < 2) continue;
          const bySuccess = keys.filter(k => lessons.get(k)?.outcome === 'success');
          const winner = bySuccess[0] ?? keys[0];
          for (const k of keys) {
            if (k !== winner) { await redis.del(k); merged++; }
          }
        }
        // Resolve contradictions: keep success, delete failure for same topic
        for (const { keys } of contradictions) {
          const success = keys.find(k => lessons.get(k)?.outcome === 'success');
          if (success) {
            for (const k of keys) {
              if (k !== success) { await redis.del(k); }
            }
          }
        }
        // Flag stale entries with a TTL of 30 days (not deleted, just expiring)
        for (const k of stale) {
          await redis.expire(k, 86400 * 30);
        }
      }

      const lines = [
        `🔬 **Memory Consolidation Report** ${dry_run ? '(dry run — no changes made)' : '✅ Applied'}`,
        ``,
        `📊 **Before:** ${lessonKeys.length} lessons`,
        ``,
        `🔁 **Contradictions detected:** ${contradictions.length}`,
        ...contradictions.slice(0, 5).map(c => `  → \`${c.topic}\`: ${c.keys.length} conflicting entries (kept: success)`),
        contradictions.length > 5 ? `  … and ${contradictions.length - 5} more` : '',
        ``,
        `♻️ **Duplicate clusters:** ${Array.from(topicGroups.values()).filter(v => v.length > 1).length}` +
          (merged > 0 ? ` → ${merged} entries merged` : ''),
        ``,
        `🕰️ **Stale entries (${stale_days}d, 0 recalls):** ${stale.length}` +
          (stale.length > 0 && !dry_run ? ` → set to expire in 30 days` : ''),
        ``,
        `📊 **After:** ${dry_run ? lessonKeys.length : lessonKeys.length - merged} lessons`,
        ``,
        dry_run
          ? `💡 Re-run without dry_run=true to apply changes.`
          : `✨ Brain consolidated. Run \`brain_diff(since="1h")\` to see the delta.`,
      ].filter(s => s !== '').join('\n');
      return lines;
    }

    // ── v0.6 Cognitive Cache: brain_diff ─────────────────────────────────────
    case 'brain_diff': {
      const { instance_id, since = '7d', format = 'summary' } = args as {
        instance_id: string; since?: string; format?: 'summary' | 'detailed';
      };
      const redis = await getConnection(instance_id);

      // Parse since
      let sinceMs: number;
      const match = since.match(/^(\d+)([dhm])$/);
      if (match) {
        const n = parseInt(match[1]);
        const unit = match[2];
        const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
        sinceMs = Date.now() - n * mult;
      } else {
        sinceMs = new Date(since).getTime() || Date.now() - 7 * 86400000;
      }

      // Scan all lessons
      let cursor = 0;
      const lessonKeys: string[] = [];
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 200);
        cursor = parseInt(next);
        lessonKeys.push(...keys);
      } while (cursor !== 0);

      type Lesson = { topic: string; outcome: string; what_worked?: string; ts: string; recall_count?: number; severity?: string };
      const added: Lesson[] = [];
      const updated: Lesson[] = [];
      const recalled: Lesson[] = [];
      const total = lessonKeys.length;

      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try {
          const l = JSON.parse(raw) as Lesson;
          const ts = new Date(l.ts).getTime();
          if (ts >= sinceMs) {
            // Check history to determine add vs update
            const histKey = `cachly:lesson:history:${l.topic}`;
            const histLen = await redis.llen(histKey);
            if (histLen <= 1) added.push(l);
            else updated.push(l);
          }
          if ((l.recall_count ?? 0) > 0) {
            // We can't easily know when last recalled without extra metadata, so include
            // lessons with recalls as "active"
            recalled.push(l);
          }
        } catch { /* skip */ }
      }

      const sinceLabel = match ? `last ${since}` : new Date(sinceMs).toLocaleDateString('de-DE');
      const lines: string[] = [
        `📊 **Brain Diff** — ${sinceLabel}`,
        ``,
        `Total lessons in brain: **${total}**`,
        ``,
        `✅ **New** (${added.length}):`,
        ...added.slice(0, format === 'detailed' ? 20 : 5).map(l =>
          `  + \`${l.topic}\` — ${l.outcome} ${l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟠' : '🟢'}`
        ),
        added.length > 5 && format === 'summary' ? `  … and ${added.length - 5} more` : '',
        ``,
        `🔄 **Updated** (${updated.length}):`,
        ...updated.slice(0, format === 'detailed' ? 20 : 5).map(l =>
          `  ~ \`${l.topic}\` — now: ${l.outcome}`
        ),
        updated.length > 5 && format === 'summary' ? `  … and ${updated.length - 5} more` : '',
        ``,
        `🔍 **Active** (recalled at least once): ${recalled.length}`,
        ``,
      ].filter(s => s !== '');

      // ── 10X brain_diff extensions ──────────────────────────────────────────
      // 1. Contested → Established (resolution nodes created in window)
      const resolutionKeys: string[] = [];
      const rsStream = redis.scanStream({ match: 'cachly:ckg:node:resolution-*', count: 100 });
      await new Promise<void>((res, rej) => { rsStream.on('data', (b: string[]) => resolutionKeys.push(...b)); rsStream.on('end', res); rsStream.on('error', rej); });
      const recentResolutions: Array<{ topic: string; resolution: string; ts: string }> = [];
      for (const rk of resolutionKeys) {
        const rr = await redis.get(rk);
        if (!rr) continue;
        try {
          const rn = JSON.parse(rr) as { topic?: string; resolution?: string; ts?: string };
          if (rn.ts && new Date(rn.ts).getTime() >= sinceMs) recentResolutions.push({ topic: rn.topic ?? rk, resolution: rn.resolution ?? 'unknown', ts: rn.ts });
        } catch { /* skip */ }
      }
      if (recentResolutions.length > 0) {
        lines.push(`🗳️ **MADC Resolutions** (${recentResolutions.length} contested beliefs resolved):`);
        for (const r of recentResolutions.slice(0, 5)) {
          const rIcon = r.resolution === 'unanimous_success' ? '✅' : r.resolution === 'unanimous_failure' ? '❌' : '⚠️';
          lines.push(`  ${rIcon} \`${r.topic}\` → ${r.resolution}`);
        }
        lines.push('');
      }

      // 2. New domains bootstrapped (domains in added lessons that weren't in older lessons)
      const existingDomains = new Set(updated.concat(recalled).map(l => l.topic.split(':')[0]));
      const newDomains = [...new Set(added.map(l => l.topic.split(':')[0]))].filter(d => !existingDomains.has(d));
      if (newDomains.length > 0) {
        lines.push(`🌱 **New domains bootstrapped:** ${newDomains.map(d => `\`${d}\``).join(', ')}`, '');
      }

      // 3. FedBrain transfers received in window
      const fedHistRaw = await redis.lrange('cachly:fedbrain:federations', -20, -1);
      const recentFeds = fedHistRaw.map(r => { try { return JSON.parse(r) as { source: string; domain: string; transferred_at: string; nodes: number; edges: number }; } catch { return null; } })
        .filter(f => f && new Date(f!.transferred_at).getTime() >= sinceMs) as Array<{ source: string; domain: string; transferred_at: string; nodes: number; edges: number }>;
      if (recentFeds.length > 0) {
        lines.push(`🧠 **FedBrain transfers received (${recentFeds.length}):**`);
        for (const f of recentFeds.slice(0, 3)) {
          lines.push(`  📥 domain \`${f.domain}\` from \`${f.source.slice(0, 16)}…\` — ${f.nodes} nodes, ${f.edges} edges`);
        }
        lines.push('');
      }

      lines.push(`💡 Run \`memory_consolidate\` to merge duplicates · \`knowledge_decay\` to see confidence scores.`);
      return lines.join('\n');
    }

    // ── v0.6 Cognitive Cache: causal_trace ───────────────────────────────────
    case 'causal_trace': {
      const { instance_id, problem, max_depth = 5, tags: filterTags = [] } = args as {
        instance_id: string; problem: string; max_depth?: number; tags?: string[];
      };
      const redis = await getConnection(instance_id);

      // Normalize problem to keyword tokens
      const tokens = problem.toLowerCase()
        .replace(/[^a-z0-9\s\-_:]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);

      const SEV_ICON: Record<string, string> = { critical: '🔴', major: '🟠', minor: '🟡' };

      // ── Layer 1: CKG graph traversal (if graph data exists) ─────────────────
      type CKGResult = { conceptId: string; edge: CKGEdge; lesson?: { topic: string; what_worked?: string; ts: string; outcome: string; recall_count?: number; severity?: string } };
      const ckgResults: CKGResult[] = [];
      try {
        for (const token of tokens.slice(0, 4)) {
          // Search for CKG nodes matching this token
          const fromKeys = await redis.smembers(`cachly:ckg:idx:from:${ckgSlug(token)}`);
          const toKeys   = await redis.smembers(`cachly:ckg:idx:to:${ckgSlug(token)}`);
          // Also try pattern: scan nodes containing the token
          const nodeKeys: string[] = [];
          const nStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 50 });
          await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });
          for (const nodeKey of nodeKeys.slice(0, 10)) {
            const nodeRaw = await redis.get(nodeKey);
            if (!nodeRaw) continue;
            const node: CKGNode = JSON.parse(nodeRaw);
            // Get edges from this node
            const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${node.id}`);
            for (const ek of edgeKeys.slice(0, 20)) {
              const edgeRaw = await redis.get(ek);
              if (!edgeRaw) continue;
              const edge: CKGEdge = JSON.parse(edgeRaw);
              if (edge.edgeType !== 'fixes' && edge.edgeType !== 'requires') continue;
              // Find lesson for this concept
              const lessonRaw = await redis.get(`cachly:lesson:best:${edge.from.replace(/-/g, ':').replace(/^fix:/, 'fix:')}`);
              const lesson = lessonRaw ? JSON.parse(lessonRaw) : undefined;
              ckgResults.push({ conceptId: node.id, edge, lesson });
            }
          }
          for (const ek of [...fromKeys, ...toKeys].slice(0, 20)) {
            const edgeRaw = await redis.get(ek);
            if (!edgeRaw) continue;
            const edge: CKGEdge = JSON.parse(edgeRaw);
            const lessonRaw = await redis.get(`cachly:lesson:best:${edge.from}`);
            const lesson = lessonRaw ? JSON.parse(lessonRaw) : undefined;
            ckgResults.push({ conceptId: edge.from, edge, lesson });
          }
        }
      } catch { /* CKG traversal non-critical */ }

      // Deduplicate CKG results and sort by confidence
      const ckgSeen = new Set<string>();
      const ckgDeduped = ckgResults.filter(r => {
        const key = `${r.edge.from}:${r.edge.edgeType}:${r.edge.to}`;
        if (ckgSeen.has(key)) return false;
        ckgSeen.add(key);
        return true;
      }).sort((a, b) => b.edge.confidence - a.edge.confidence).slice(0, max_depth);

      // ── Layer 2 (fallback): text similarity over all lessons ─────────────────
      let cursor = 0;
      const lessonKeys: string[] = [];
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:*', 'COUNT', 200);
        cursor = parseInt(next);
        lessonKeys.push(...keys);
      } while (cursor !== 0);

      type Lesson = {
        topic: string; outcome: string; what_worked?: string; what_failed?: string;
        ts: string; recall_count?: number; severity?: string; tags?: string[];
        context?: string;
      };

      // Score each lesson by token overlap with problem description
      const scored: Array<{ score: number; lesson: Lesson; key: string }> = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try {
          const l = JSON.parse(raw) as Lesson;
          if (filterTags.length > 0 && !(l.tags ?? []).some((t: string) => filterTags.includes(t))) continue;
          const haystack = [l.topic, l.what_failed ?? '', l.what_worked ?? '', l.context ?? '']
            .join(' ').toLowerCase();
          const score = tokens.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
          if (score > 0) scored.push({ score, lesson: l, key: k });
        } catch { /* skip */ }
      }
      scored.sort((a, b) => b.score - a.score);
      const chain = scored.slice(0, max_depth);

      if (chain.length === 0 && ckgDeduped.length === 0) {
        return [
          `🔍 **Causal Trace: "${problem}"**`,
          ``,
          `No matching lessons found in brain.`,
          ``,
          `💡 After you solve this, call:`,
          `\`\`\``,
          `learn_from_attempts(`,
          `  instance_id = "${instance_id}",`,
          `  topic       = "fix:${tokens[0] ?? 'issue'}",`,
          `  outcome     = "success",`,
          `  what_worked = "...",`,
          `  what_failed = "${problem}",`,
          `)`,
          `\`\`\``,
        ].join('\n');
      }

      const lines: string[] = [
        `🔍 **Causal Trace: "${problem}"**`,
        ``,
      ];

      // Show CKG graph results first if available
      if (ckgDeduped.length > 0) {
        lines.push(`### 🕸️ CKG Graph (confidence-ranked)`);
        for (const r of ckgDeduped) {
          const confPct = Math.round(r.edge.confidence * 100);
          const confBar = '▓'.repeat(Math.round(confPct / 10)) + '░'.repeat(10 - Math.round(confPct / 10));
          lines.push(`  ${r.edge.from} **→[${r.edge.edgeType}]→** ${r.edge.to}`);
          lines.push(`  ${confBar} ${confPct}% confidence (${r.edge.successes}/${r.edge.trials} confirmed)`);
          if (r.lesson?.what_worked) lines.push(`  ✅ Fix: ${r.lesson.what_worked.slice(0, 150)}`);
          lines.push('');
        }
      }

      // Build text-based causal chain narrative
      if (chain.length > 0) {
        lines.push(ckgDeduped.length > 0 ? `### 📚 Text Search (${chain.length} related lessons)` : `Found **${chain.length}** related lessons. Reconstructed causal chain:`, '');
        const failures = chain.filter(c => c.lesson.outcome !== 'success');
        const solutions = chain.filter(c => c.lesson.outcome === 'success');

        if (failures.length > 0) {
          lines.push(`**Root causes & failure chain:**`);
          failures.forEach((c, i) => {
            const l = c.lesson;
            const sev = SEV_ICON[l.severity ?? 'minor'] ?? '🟡';
            lines.push(`${i === 0 ? '  Root:' : '   → :'} ${sev} \`${l.topic}\``);
            if (l.what_failed) lines.push(`          ↳ ${l.what_failed.slice(0, 120)}`);
          });
          lines.push('');
        }

        if (solutions.length > 0) {
          lines.push(`**Solutions that worked before:**`);
          solutions.forEach((c, i) => {
            const l = c.lesson;
            const date = new Date(l.ts).toLocaleDateString('de-DE');
            lines.push(`  ${i + 1}. ✅ \`${l.topic}\` — ${date} · recalled ${l.recall_count ?? 0}×`);
            if (l.what_worked) lines.push(`     ${l.what_worked.slice(0, 200)}`);
          });
          lines.push('');
        }

        const topSolution = solutions[0]?.lesson;
        if (topSolution?.what_worked) {
          lines.push(`**⚡ Most likely fix:**`);
          lines.push(`\`\`\``);
          lines.push(topSolution.what_worked.slice(0, 500));
          lines.push(`\`\`\``);
          lines.push('');
        }
      }

      lines.push(`💡 After applying: \`learn_from_attempts(topic="fix:${tokens[0] ?? 'issue'}", outcome="success", ...)\``);
      if (ckgDeduped.length > 0) lines.push(`🕸️ Explore graph: \`ckg_inspect(concept="${tokens[0] ?? 'fix'}")\``);
      return lines.join('\n');
    }


    case 'knowledge_decay': {
      const { instance_id, min_age_days = 0, show_top = 20 } = args as {
        instance_id: string; min_age_days?: number; show_top?: number;
      };
      const redis = await getConnection(instance_id);
      const now = Date.now();
      const minAgeMs = min_age_days * 86400000;

      let cursor = 0;
      const lessonKeys: string[] = [];
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 200);
        cursor = parseInt(next);
        lessonKeys.push(...keys);
      } while (cursor !== 0);

      type Lesson = { topic: string; outcome: string; ts: string; recall_count?: number; severity?: string };
      type Scored = { topic: string; confidence: number; age_days: number; recalls: number; outcome: string };

      const scores: Scored[] = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try {
          const l = JSON.parse(raw) as Lesson;
          const ageMs = now - new Date(l.ts).getTime();
          if (ageMs < minAgeMs) continue;
          const age_days = Math.floor(ageMs / 86400000);
          const recalls = l.recall_count ?? 0;

          // Confidence formula:
          // base = 100 → decays by 1pt/day after 7 days, floored at 5
          // boost: +5 per recall, capped at +50
          // penalty: failure outcome → -20
          const decayPts = Math.max(0, age_days - 7);
          const base = Math.max(5, 100 - decayPts);
          const recallBoost = Math.min(50, recalls * 5);
          const outcomePenalty = l.outcome === 'failure' ? -20 : 0;
          const confidence = Math.min(100, Math.max(0, base + recallBoost + outcomePenalty));

          scores.push({ topic: l.topic, confidence, age_days, recalls, outcome: l.outcome });
        } catch { /* skip */ }
      }

      // Sort by lowest confidence first
      scores.sort((a, b) => a.confidence - b.confidence);
      const shown = scores.slice(0, show_top);

      function bar(pct: number): string {
        const filled = Math.round(pct / 10);
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
      }

      const avgConf = scores.length > 0
        ? Math.round(scores.reduce((s, e) => s + e.confidence, 0) / scores.length)
        : 0;
      const critical = scores.filter(s => s.confidence < 30).length;
      const healthy = scores.filter(s => s.confidence >= 70).length;

      const lines: string[] = [
        `🧪 **Knowledge Decay Report** — ${scores.length} lessons`,
        ``,
        `Average confidence: **${bar(avgConf)}**`,
        `🔴 Critical (<30%): ${critical}  🟢 Healthy (≥70%): ${healthy}`,
        ``,
        `Lowest confidence lessons (fix these first):`,
        ``,
        ...shown.map((s, i) =>
          `${(i + 1).toString().padStart(2)}. \`${s.topic}\`\n    ${bar(s.confidence)} · ${s.age_days}d old · ${s.recalls} recalls · ${s.outcome}`
        ),
        ``,
        scores.length > show_top ? `… and ${scores.length - show_top} more lessons` : '',
        ``,
        critical > 0
          ? `⚠️ ${critical} lessons are critically stale. Validate them and re-run \`learn_from_attempts\` with updated findings.`
          : `✅ Brain confidence is healthy overall.`,
        ``,
        `💡 Run \`memory_consolidate\` to prune stale entries · \`causal_trace\` to find root causes.`,
      ].filter(s => s !== '');
      return lines.join('\n');
    }

    // ── v0.6 Cognitive Cache: autopilot ──────────────────────────────────────
    case 'autopilot': {
      const { instance_id, editor = 'claude', project_name = 'this project', style = 'full' } = args as {
        instance_id: string; editor?: string; project_name?: string; style?: 'minimal' | 'full';
      };

      const minimal = `## Cachly AI Brain — Autopilot

**Instance:** \`${instance_id}\`

> Sessions are fully automatic. The Brain starts when you call any tool and saves a summary when you close.

### MANDATORY hooks (always fire, no exceptions):
- **Window opens** → call \`session_start(instance_id="${instance_id}", focus="<today's goal>")\`
- **Bug fixed / deployed / discovered** → call \`learn_from_attempts(instance_id="${instance_id}", topic="fix:<area>", outcome="success", what_worked="...")\`
- **Window closes** → call \`session_end(instance_id="${instance_id}", summary="...", files_changed=[...])\`
`;

      const full = `## Cachly AI Brain — Autopilot for ${project_name}

**Instance:** \`${instance_id}\`

---

## 🔴 MANDATORY RULES — No exceptions, no prompting needed

### Rule 1 — Session Start (FIRST thing in every window)
\`\`\`
session_start(
  instance_id = "${instance_id}",
  focus       = "<what you plan to work on today>",
)
\`\`\`
Returns: last session summary, handoff tasks, recent lessons, open failures.

### Rule 2 — Learn After Every Fix/Deploy/Discovery (AUTOMATIC)
**After EVERY** bug fix, deployment, or technical discovery — call immediately:
\`\`\`
learn_from_attempts(
  instance_id = "${instance_id}",
  topic       = "category:keyword",
  outcome     = "success" | "failure" | "partial",
  what_worked = "exact command or approach",
  what_failed = "what failed (if applicable)",
  severity    = "critical" | "major" | "minor",
  commands    = ["the exact command that worked"],
  file_paths  = ["path/to/file"],
  tags        = ["relevant", "tags"],
)
\`\`\`

**Triggers:**
- ✅ Deployed → \`topic="deploy:web", outcome="success"\`
- ✅ Fixed bug → \`topic="fix:auth-race", outcome="success"\`
- ✅ Got error → \`topic="debug:docker", outcome="partial"\`

### Rule 3 — Session End (LAST thing before closing)
\`\`\`
session_end(
  instance_id     = "${instance_id}",
  summary         = "What was accomplished (2-3 sentences)",
  files_changed   = ["list", "of", "changed", "files"],
  lessons_learned = <number of learn_from_attempts calls>,
)
\`\`\`

### Rule 4 — Before any non-trivial task
\`\`\`
smart_recall(
  instance_id = "${instance_id}",
  query       = "<describe what you are about to do>",
)
\`\`\`

---

## ⚡ Cognitive Tools (v0.6)

| When | Call |
|---|---|
| Brain feeling cluttered | \`memory_consolidate(instance_id="${instance_id}")\` |
| Weekly review | \`brain_diff(instance_id="${instance_id}", since="7d")\` |
| Weird bug, no idea why | \`causal_trace(instance_id="${instance_id}", problem="<symptom>")\` |
| Before big refactor | \`knowledge_decay(instance_id="${instance_id}")\` |

---

*Cachly v0.6 · Generated ${new Date().toISOString().slice(0, 10)}*
`;

      const content = style === 'minimal' ? minimal : full;
      const filename = editor === 'copilot'
        ? '.github/copilot-instructions.md'
        : editor === 'continue'
          ? '.continue/cachly-autopilot.md'
          : 'CLAUDE.md';

      return [
        `🤖 **Autopilot instructions generated** for **${editor === 'all' ? 'all editors' : editor}**`,
        ``,
        `**File to create:** \`${filename}\``,
        ``,
        `\`\`\`markdown`,
        content,
        `\`\`\``,
        ``,
        `**How to apply:**`,
        `\`\`\`bash`,
        `# Copy to your project root:`,
        `cat > ${filename} << 'EOF'`,
        content,
        `EOF`,
        `\`\`\``,
        ``,
        `✨ Once this file is in place, **${editor === 'copilot' ? 'GitHub Copilot' : editor === 'continue' ? 'Continue.dev' : 'Claude/Cursor/Windsurf'}** will manage the Brain automatically — no manual calls needed, ever.`,
      ].join('\n');
    }

    // ── v0.7 Knowledge Syndication: syndicate ────────────────────────────────
    case 'syndicate': {
      const { topic, outcome = 'success', what_worked, what_failed = '', severity = 'minor', tags = [], scope = 'public' } = args as {
        topic: string; outcome?: string; what_worked: string; what_failed?: string; severity?: string; tags?: string[]; scope?: string;
      };

      if (!topic || !what_worked) {
        throw new McpError(ErrorCode.InvalidParams, 'topic and what_worked are required');
      }

      const body = { topic, outcome, what_worked, what_failed, severity, tags, scope };
      const res = await apiFetch<{ id: string; topic: string; outcome: string; message: string; deduped?: boolean }>(
        '/api/v1/syndication/contribute',
        { method: 'POST', body: JSON.stringify(body) }
      );

      const scopeLabel = scope === 'org' ? '🏢 org-private' : '🌐 global commons';
      const dedupNote = res.deduped
        ? `\n> ♻️ Duplicate detected — trust score incremented for the existing lesson.`
        : '';

      return [
        `${scope === 'org' ? '🏢' : '🌐'} **Lesson syndicated to the ${scope === 'org' ? 'org Knowledge Commons' : 'global Knowledge Commons'}**${dedupNote}`,
        ``,
        `**ID:** \`${res.id}\``,
        `**Topic:** \`${res.topic}\` · **Outcome:** ${res.outcome} · **Scope:** ${scopeLabel}`,
        ``,
        scope === 'org'
          ? `This lesson is visible only within your organisation. Use \`syndicate_search(scope="org")\` to find it.`
          : `Your lesson is now searchable by every AI brain in the network.`,
        `When another instance confirms it works, its trust score rises — and so does your contributor reputation.`,
        ``,
        `**Tip:** Use \`syndicate_search(q="${topic}")\` to see all community lessons on this topic.`,
      ].join('\n');
    }

    // ── v0.7 Knowledge Syndication: syndicate_search ─────────────────────────
    case 'syndicate_search': {
      const { q = '', limit = 20, category = '', scope = '' } = args as { q?: string; limit?: number; category?: string; scope?: string };

      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (category) params.set('category', category);
      if (scope) params.set('scope', scope);
      params.set('limit', String(Math.min(Math.max(1, limit), 50)));

      const res = await apiFetch<{ results: Array<{
        id: string; topic: string; category: string; outcome: string;
        what_worked: string; what_failed: string; severity: string;
        confirm_count: number; created_at: string;
      }>; count: number; query: string }>(`/api/v1/syndication/search?${params}`);

      if (!res.results || res.results.length === 0) {
        return q
          ? `No lessons found for "${q}" in the global Knowledge Commons yet.\n\nBe the first to contribute: \`syndicate(topic="...", what_worked="...")\``
          : `The global Knowledge Commons is empty. Be the first contributor:\n\`syndicate(topic="deploy:api", what_worked="...")\``;
      }

      const outcomeIcon = (o: string) => o === 'success' ? '✅' : o === 'failure' ? '❌' : '⚠️';
      const severityLabel = (s: string) => s === 'critical' ? '🔴' : s === 'major' ? '🟡' : '🟢';
      const confirmBar = (n: number) => {
        const filled = Math.min(10, Math.round(n / 5));
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ×${n}`;
      };

      const header = [q, category].filter(Boolean).join(' · ');
      const lines: string[] = [
        `## 🌐 Global Knowledge Commons${header ? ` — ${header}` : ' — Recent'}`,
        `*${res.count} lesson${res.count === 1 ? '' : 's'} found*`,
        ``,
      ];

      for (const lesson of res.results) {
        lines.push(
          `### ${outcomeIcon(lesson.outcome)} \`${lesson.topic}\` ${severityLabel(lesson.severity)}`,
          `**Trust:** ${confirmBar(lesson.confirm_count)}`,
          lesson.what_worked ? `**What worked:** ${lesson.what_worked}` : '',
          lesson.what_failed ? `**What failed:** ${lesson.what_failed}` : '',
          `*Contributed ${new Date(lesson.created_at).toLocaleDateString('de-DE')} · ID: \`${lesson.id}\`*`,
          ``,
        );
      }

      lines.push(
        `---`,
        `**Confirm** (this helped you): \`syndicate(topic="${res.results[0]?.topic ?? '...'}", what_worked="...")\` → auto-deduped, trust +1`,
        `**Contribute your own:** \`syndicate(topic="fix:...", what_worked="...")\``,
        `**Filter by category:** \`syndicate_search(category="fix")\``,
      );

      return lines.filter(l => l !== '').join('\n');
    }

    // ── v0.7 Knowledge Syndication: syndicate_stats ──────────────────────────
    case 'syndicate_stats': {
      const res = await apiFetch<{
        total_lessons: number;
        total_confirms: number;
        added_last_7_days: number;
        top_categories: Array<{ category: string; count: number }>;
        most_trusted: Array<{
          id: string; topic: string; outcome: string;
          what_worked: string; confirm_count: number; created_at: string;
        }>;
      }>('/api/v1/syndication/stats');

      const confirmBar = (n: number) => {
        const filled = Math.min(10, Math.round(n / 5));
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ×${n}`;
      };

      const lines: string[] = [
        `## 🌐 Global Knowledge Commons — Stats`,
        ``,
        `| Metric | Value |`,
        `|---|---|`,
        `| Total lessons | **${res.total_lessons.toLocaleString()}** |`,
        `| Total confirms | **${res.total_confirms.toLocaleString()}** |`,
        `| Added last 7 days | **${res.added_last_7_days}** |`,
        ``,
        `### Top Categories`,
      ];

      for (const cat of res.top_categories ?? []) {
        lines.push(`- \`${cat.category}\` — ${cat.count} lesson${cat.count === 1 ? '' : 's'}`);
      }

      lines.push(``, `### Most Trusted Lessons`);

      for (const lesson of res.most_trusted ?? []) {
        lines.push(
          `**\`${lesson.topic}\`** ${confirmBar(lesson.confirm_count)}`,
          `> ${lesson.what_worked.slice(0, 120)}${lesson.what_worked.length > 120 ? '…' : ''}`,
          ``,
        );
      }

      lines.push(
        `---`,
        `**Contribute:** \`syndicate(topic="...", what_worked="...")\`  |  **Search:** \`syndicate_search(q="your problem")\``,
      );

      // Top contributors (anonymous scores)
      if ((res as any).top_contributors?.length) {
        lines.push(``, `### 🏅 Top Contributors (anonymous)`);
        for (const c of (res as any).top_contributors) {
          lines.push(`- Trust **${c.trust_score}** · ${c.lessons_count} lesson${c.lessons_count === 1 ? '' : 's'} · ${c.confirms_received} confirms received`);
        }
      }

      return lines.join('\n');
    }

    // ── v0.8 Knowledge Syndication: syndicate_trending ───────────────────────
    case 'syndicate_trending': {
      const { limit = 10 } = args as { limit?: number };

      const params = new URLSearchParams({ limit: String(Math.min(Math.max(1, limit), 50)) });
      const res = await apiFetch<{ results: Array<{
        id: string; topic: string; category: string; outcome: string;
        what_worked: string; what_failed: string; severity: string;
        confirm_count: number; trend_score: number; created_at: string;
      }>; count: number }>(`/api/v1/syndication/trending?${params}`);

      if (!res.results || res.results.length === 0) {
        return [
          `## 📈 Trending in the Knowledge Commons`,
          ``,
          `No trending lessons yet (need at least 2 confirms in the last 7 days).`,
          ``,
          `Contribute and confirm lessons to see them trend: \`syndicate(topic="...", what_worked="...")\``,
        ].join('\n');
      }

      const outcomeIcon = (o: string) => o === 'success' ? '✅' : o === 'failure' ? '❌' : '⚠️';
      const severityLabel = (s: string) => s === 'critical' ? '🔴' : s === 'major' ? '🟡' : '🟢';
      const confirmBar = (n: number) => {
        const filled = Math.min(10, Math.round(n / 5));
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ×${n}`;
      };
      const trendBar = (score: number) => {
        const filled = Math.min(10, Math.round(score * 2));
        return '▲'.repeat(filled) + '△'.repeat(10 - filled) + ` ${score.toFixed(2)}/day`;
      };

      const lines: string[] = [
        `## 📈 Trending in the Knowledge Commons`,
        `*Lessons with the fastest confirmation velocity in the last 7 days*`,
        ``,
      ];

      for (const lesson of res.results) {
        lines.push(
          `### ${outcomeIcon(lesson.outcome)} \`${lesson.topic}\` ${severityLabel(lesson.severity)}`,
          `**Trend:** ${trendBar(lesson.trend_score)}  |  **Trust:** ${confirmBar(lesson.confirm_count)}`,
          lesson.what_worked ? `**What worked:** ${lesson.what_worked.slice(0, 200)}${lesson.what_worked.length > 200 ? '…' : ''}` : '',
          `*ID: \`${lesson.id}\` · ${new Date(lesson.created_at).toLocaleDateString('de-DE')}*`,
          ``,
        );
      }

      lines.push(
        `---`,
        `**Confirm** (if this helped you): \`syndicate(topic="${res.results[0]?.topic ?? '...'}", what_worked="...")\` → auto-deduped, trust +1`,
        `**All trending:** \`syndicate_trending(limit=50)\`  |  **Search:** \`syndicate_search(q="...")\``,
      );

      return lines.filter(l => l !== '').join('\n');
    }

    // ── Layer 1: brain_search ─────────────────────────────────────────────────
    case 'brain_search': {
      const { instance_id, query, limit = 15 } = args as { instance_id: string; query: string; limit?: number };
      const redis = await getConnection(instance_id);

      // BM25+ over ALL brain key namespaces
      const allMatches = await keywordSearch(
        redis,
        [
          'cachly:lesson:best:*',
          'cachly:ctx:*',
          'cachly:idx:*',
          'cachly:session:last',
          'cachly:session:handoff',
          'cachly:roadmap:*',
          'cachly:ckg:node:*',
        ],
        query,
        limit,
      );

      if (allMatches.length === 0) {
        return [`🔎 **Brain Search: "${query}"**`, '', `No results found across all brain data.`, '', `💡 Try \`smart_recall\` or check \`list_remembered\`.`].join('\n');
      }

      const lines = [`🔎 **Brain Search: "${query}"** — ${allMatches.length} result${allMatches.length !== 1 ? 's' : ''} across all brain data\n`];
      for (const m of allMatches.slice(0, limit)) {
        const ns = m.key.startsWith('cachly:lesson:') ? '💡 lesson'
          : m.key.startsWith('cachly:ctx:') ? '📝 context'
          : m.key.startsWith('cachly:idx:') ? '📂 index'
          : m.key.startsWith('cachly:session:') ? '🕐 session'
          : m.key.startsWith('cachly:roadmap:') ? '🗺️ roadmap'
          : m.key.startsWith('cachly:ckg:node:') ? '🕸️ ckg-node'
          : '🗄️ data';
        const preview = m.content.slice(0, 280).replace(/\n/g, ' ');
        lines.push(`**${ns}** \`${m.key.split(':').slice(2).join(':')}\` _(BM25: ${m.score.toFixed(2)})_`);
        lines.push(`> ${preview}${m.content.length > 280 ? '…' : ''}\n`);
      }
      return lines.join('\n');
    }

    // ── Layer 1: ckg_inspect ─────────────────────────────────────────────────
    case 'ckg_inspect': {
      const { instance_id, concept, max_hops = 2 } = args as { instance_id: string; concept: string; max_hops?: number };
      const redis = await getConnection(instance_id);

      const conceptId = ckgSlug(concept);
      const visited = new Set<string>();
      const allEdges: CKGEdge[] = [];

      // BFS traversal of CKG
      const queue: Array<{ id: string; hop: number }> = [{ id: conceptId, hop: 0 }];
      while (queue.length > 0) {
        const { id, hop } = queue.shift()!;
        if (visited.has(id) || hop > max_hops) continue;
        visited.add(id);

        const fromKeys = await redis.smembers(`cachly:ckg:idx:from:${id}`);
        const toKeys   = await redis.smembers(`cachly:ckg:idx:to:${id}`);

        for (const ek of [...fromKeys, ...toKeys].slice(0, 50)) {
          const raw = await redis.get(ek);
          if (!raw) continue;
          const edge: CKGEdge = JSON.parse(raw);
          allEdges.push(edge);
          if (hop < max_hops) {
            if (!visited.has(edge.from)) queue.push({ id: edge.from, hop: hop + 1 });
            if (!visited.has(edge.to))   queue.push({ id: edge.to, hop: hop + 1 });
          }
        }
      }

      if (allEdges.length === 0) {
        // Try fuzzy: scan for nodes matching the concept as substring
        const nodeKeys: string[] = [];
        const nStream = redis.scanStream({ match: `cachly:ckg:node:*${conceptId}*`, count: 100 });
        await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });
        if (nodeKeys.length === 0) {
          return [`🕸️ **CKG Inspect: "${concept}"**`, '', `No CKG nodes found. The graph builds automatically as you call \`learn_from_attempts\`.`, '', `💡 Once you have lessons stored, CKG edges will appear here.`].join('\n');
        }
        const nodeList = nodeKeys.slice(0, 10).map(k => `  • \`${k.replace('cachly:ckg:node:', '')}\``).join('\n');
        return [`🕸️ **CKG Inspect: "${concept}"**`, '', `No edges found for \`${conceptId}\`, but found similar nodes:`, nodeList, '', `Try: \`ckg_inspect(concept="<exact-node-id>")\``].join('\n');
      }

      // Sort by confidence desc, deduplicate
      const edgeSeen = new Set<string>();
      const unique = allEdges.filter(e => {
        const k = `${e.from}:${e.edgeType}:${e.to}`;
        if (edgeSeen.has(k)) return false;
        edgeSeen.add(k);
        return true;
      }).sort((a, b) => b.confidence - a.confidence);

      const EDGE_ICON: Record<string, string> = { fixes: '🔧', requires: '🔗', 'co-occurs': '🔄', causes: '⚡', contradicts: '⚠️', degrades_under: '📉' };

      const lines = [`🕸️ **CKG Inspect: "${concept}"** (${unique.length} edge${unique.length !== 1 ? 's' : ''}, ${visited.size} node${visited.size !== 1 ? 's' : ''} traversed)\n`];

      // Group by edge type
      const byType = new Map<string, CKGEdge[]>();
      for (const e of unique) {
        if (!byType.has(e.edgeType)) byType.set(e.edgeType, []);
        byType.get(e.edgeType)!.push(e);
      }
      for (const [eType, edges] of byType) {
        const icon = EDGE_ICON[eType] ?? '→';
        lines.push(`**${icon} ${eType}** (${edges.length})`);
        for (const e of edges.slice(0, 8)) {
          const confPct = Math.round(e.confidence * 100);
          const bar = '▓'.repeat(Math.round(confPct / 10)) + '░'.repeat(10 - Math.round(confPct / 10));
          lines.push(`  \`${e.from}\` → \`${e.to}\`  ${bar} ${confPct}% (${e.successes.toFixed(1)}/${e.trials} trials)`);
        }
        lines.push('');
      }

      lines.push(`💡 Expand: \`ckg_inspect(concept="${concept}", max_hops=3)\`  |  Predict: \`brain_predict(context="${concept}")\``);
      return lines.join('\n');
    }

    // ── Layer 4: brain_predict (PPE) ─────────────────────────────────────────
    case 'brain_predict': {
      const { instance_id, context: ctx, top_k = 5 } = args as { instance_id: string; context: string; top_k?: number };
      const redis = await getConnection(instance_id);

      const ctxTokens = ctx.toLowerCase().replace(/[^a-z0-9\s\-_:]/g, ' ').split(/\s+/).filter(t => t.length > 2);

      // Step 1: Find CKG nodes matching context tokens
      type Prediction = { concept: string; edgeType: string; target: string; confidence: number; lesson?: { what_worked?: string; topic: string } };
      const predictions: Prediction[] = [];

      for (const token of ctxTokens.slice(0, 6)) {
        const nodeKeys: string[] = [];
        const nStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 50 });
        await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });

        for (const nk of nodeKeys.slice(0, 5)) {
          const nodeRaw = await redis.get(nk);
          if (!nodeRaw) continue;
          const node: CKGNode = JSON.parse(nodeRaw);
          const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${node.id}`);
          for (const ek of edgeKeys.slice(0, 20)) {
            const edgeRaw = await redis.get(ek);
            if (!edgeRaw) continue;
            const edge: CKGEdge = JSON.parse(edgeRaw);
            // Only interested in fixes and co-occurs for prediction
            if (edge.edgeType !== 'fixes' && edge.edgeType !== 'co-occurs' && edge.edgeType !== 'causes') continue;
            const lessonRaw = await redis.get(`cachly:lesson:best:${edge.from}`);
            const lesson = lessonRaw ? JSON.parse(lessonRaw) : undefined;
            predictions.push({ concept: node.id, edgeType: edge.edgeType, target: edge.to, confidence: edge.confidence, lesson });
          }
        }
      }

      // Step 2: Text-based fallback — scan lessons for matching topics
      const textPredictions: Array<{ topic: string; what_worked?: string; what_failed?: string; outcome: string; severity?: string; confidence: number }> = [];
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((res, rej) => { lStream.on('data', (b: string[]) => lessonKeys.push(...b)); lStream.on('end', res); lStream.on('error', rej); });
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try {
          const l = JSON.parse(raw) as { topic: string; what_worked?: string; what_failed?: string; outcome: string; severity?: string; ts: string; verified_at?: string; recall_count?: number };
          const haystack = [l.topic, l.what_failed ?? '', l.what_worked ?? ''].join(' ').toLowerCase();
          const score = ctxTokens.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
          if (score >= 1 && l.outcome !== 'failure') {
            const conf = calculateConfidence(l);
            textPredictions.push({ ...l, confidence: conf });
          }
        } catch { /* skip */ }
      }
      textPredictions.sort((a, b) => b.confidence - a.confidence);

      if (predictions.length === 0 && textPredictions.length === 0) {
        return [
          `🔮 **Brain Predict: "${ctx}"**`,
          ``,
          `No predictions yet — the brain hasn't seen this domain.`,
          ``,
          `💡 As you solve problems in this area and call \`learn_from_attempts\`, the CKG builds up and predictions become available.`,
        ].join('\n');
      }

      const lines = [`🔮 **Brain Predict: "${ctx}"**\n`];

      // CKG-based predictions
      if (predictions.length > 0) {
        const pSeen = new Set<string>();
        const pUniq = predictions.filter(p => { const k = `${p.concept}:${p.edgeType}:${p.target}`; if (pSeen.has(k)) return false; pSeen.add(k); return true; })
          .sort((a, b) => b.confidence - a.confidence).slice(0, top_k);

        lines.push(`### 🕸️ CKG Predictions (based on ${pUniq.length} known edges)`);
        for (const p of pUniq) {
          const confPct = Math.round(p.confidence * 100);
          const icon = p.edgeType === 'fixes' ? '🔧' : p.edgeType === 'co-occurs' ? '🔄' : '⚡';
          lines.push(`${icon} **${confPct}%** \`${p.concept}\` _${p.edgeType}_ \`${p.target}\``);
          if (p.lesson?.what_worked) lines.push(`   ✅ ${p.lesson.what_worked.slice(0, 120)}`);
        }
        lines.push('');
      }

      // Text-based lesson predictions
      if (textPredictions.length > 0) {
        lines.push(`### 📚 Relevant Lessons (${Math.min(textPredictions.length, top_k)} pre-loaded)`);
        for (const l of textPredictions.slice(0, top_k)) {
          const confPct = Math.round(l.confidence * 100);
          lines.push(`  ✅ **${confPct}%** \`${l.topic}\` — ${(l.what_worked ?? '').slice(0, 120)}`);
        }
        lines.push('');
      }

      lines.push(`💡 Outcome confirmed? \`learn_from_attempts(topic="fix:...", outcome="success", ...)\` → improves future predictions`);
      return lines.join('\n');
    }

    // ── Layer 3: MADC ─────────────────────────────────────────────────────────
    case 'madc_deliberate': {
      const { instance_id, topic } = args as { instance_id: string; topic: string };
      const redis = await getConnection(instance_id);

      const historyRaw = await redis.lrange(`cachly:lessons:${topic}`, 0, -1);
      const history = historyRaw.map(r => { try { return JSON.parse(r) as { outcome: string; what_worked?: string; what_failed?: string; ts?: string }; } catch { return null; } }).filter(Boolean) as Array<{ outcome: string; what_worked?: string; what_failed?: string; ts?: string }>;

      if (history.length < 2) {
        return [
          `🗳️ **MADC: "${topic}"**`, '',
          `Not enough history for deliberation (need ≥ 2 entries, found ${history.length}).`,
          '', `Call \`learn_from_attempts\` with conflicting outcomes to trigger deliberation.`,
        ].join('\n');
      }

      // Specialist agents and their domain keywords
      const AGENTS = [
        { name: 'InfraAgent',    domains: ['infra', 'k8s', 'docker', 'server', 'wireguard', 'helm'] },
        { name: 'AuthAgent',     domains: ['auth', 'jwt', 'keycloak', 'oauth', 'oidc', 'token'] },
        { name: 'DeployAgent',   domains: ['deploy', 'ci', 'pipeline', 'rsync', 'release'] },
        { name: 'DatabaseAgent', domains: ['db', 'gorm', 'migration', 'postgres', 'clickhouse', 'redis'] },
        { name: 'DebugAgent',    domains: ['debug', 'panic', 'race', 'nil', 'fix', 'error'] },
        { name: 'APIAgent',      domains: ['api', 'http', 'grpc', 'rest', 'fiber', 'web'] },
      ];

      const topicDomain = topic.split(':')[0] ?? '';
      const relevantAgents = AGENTS.filter(a => a.domains.some(d => topicDomain === d || topic.includes(d)));
      const votingAgents = relevantAgents.length > 0 ? relevantAgents : AGENTS;

      // Measure each agent's CKG coverage in their domains
      const agentCoverage = new Map<string, number>();
      for (const agent of votingAgents) {
        let edgeCount = 0;
        for (const domain of agent.domains) {
          const nodeKeys: string[] = [];
          const nStream = redis.scanStream({ match: `cachly:ckg:node:${domain}*`, count: 50 });
          await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });
          edgeCount += nodeKeys.length;
        }
        agentCoverage.set(agent.name, edgeCount);
      }

      const successLessons = history.filter(l => l.outcome === 'success' || l.outcome === 'partial');
      const failureLessons = history.filter(l => l.outcome === 'failure');

      if (failureLessons.length === 0) {
        return [
          `🗳️ **MADC: "${topic}"**`, '',
          `No contradictions found — all ${successLessons.length} entries have non-failure outcomes.`,
          '', `Use \`ckg_inspect(concept="${ckgSlug(topic)}")\` to explore the confidence graph.`,
        ].join('\n');
      }

      // Agent voting logic
      const votes: Array<{ agent: string; vote: 'success' | 'failure' | 'abstain'; coverage: number; reason: string }> = [];
      for (const agent of votingAgents) {
        const coverage = agentCoverage.get(agent.name) ?? 0;
        let vote: 'success' | 'failure' | 'abstain';
        let reason: string;
        if (coverage < 2) {
          vote = 'abstain'; reason = 'insufficient domain coverage';
        } else if (successLessons.length >= failureLessons.length * 2) {
          vote = 'success'; reason = `${successLessons.length}/${history.length} entries confirm success`;
        } else if (failureLessons.length >= successLessons.length * 2) {
          vote = 'failure'; reason = `${failureLessons.length}/${history.length} entries confirm failure`;
        } else {
          vote = 'abstain'; reason = `contested (${successLessons.length} success vs ${failureLessons.length} failure)`;
        }
        votes.push({ agent: agent.name, vote, coverage, reason });
      }

      const successVotes = votes.filter(v => v.vote === 'success').length;
      const failureVotes = votes.filter(v => v.vote === 'failure').length;
      const abstainVotes = votes.filter(v => v.vote === 'abstain').length;

      let resolution: 'unanimous_success' | 'unanimous_failure' | 'contested';
      let resolutionText: string;
      if (successVotes > 0 && failureVotes === 0) {
        resolution = 'unanimous_success';
        resolutionText = `✅ **Unanimous: SUCCESS** — ${successVotes} agent(s) confirm, ${abstainVotes} abstain`;
      } else if (failureVotes > 0 && successVotes === 0) {
        resolution = 'unanimous_failure';
        resolutionText = `❌ **Unanimous: FAILURE** — ${failureVotes} agent(s) confirm, ${abstainVotes} abstain`;
      } else {
        resolution = 'contested';
        resolutionText = `⚠️ **CONTESTED** — ${successVotes} success votes, ${failureVotes} failure votes, ${abstainVotes} abstain`;
      }

      // Store resolution as CKG node
      const resNodeId = ckgSlug(`resolution:${topic}`);
      const resNode = {
        id: resNodeId, domain: 'resolution', type: 'resolution', count: 1,
        ts: new Date().toISOString(), resolution, topic,
        votes: { success: successVotes, failure: failureVotes, abstain: abstainVotes },
      };
      await redis.set(`cachly:ckg:node:${resNodeId}`, JSON.stringify(resNode));

      // Write contradicts edge if contested; decay loser confidence to 0.1 if unanimous
      if (resolution === 'contested') {
        await ckgUpdateEdge(redis, ckgSlug(topic), 'contradicts', resNodeId, false);
      } else {
        // Unanimous — demote the losing side's edges to near-zero confidence
        const loserOutcome = resolution === 'unanimous_success' ? 'failure' : 'success';
        const loserLessons = (loserOutcome === 'failure' ? failureLessons : successLessons);
        if (loserLessons.length > 0) {
          // Decay all 'fixes' edges from this concept that contradict the resolution
          const fromKeys = await redis.smembers(`cachly:ckg:idx:from:${ckgSlug(topic)}`);
          for (const fk of fromKeys) {
            const er = await redis.get(fk);
            if (!er) continue;
            try {
              const edge: CKGEdge = JSON.parse(er);
              if (edge.edgeType === 'fixes' && edge.confidence > 0.15) {
                if (resolution === 'unanimous_failure') {
                  // Fix was wrong — decay to 0.1
                  edge.confidence = 0.1;
                  edge.last_updated = new Date().toISOString();
                  await redis.set(fk, JSON.stringify(edge));
                }
              }
            } catch { /* skip corrupt edges */ }
          }
        }
        // Remove the conflict marker — deliberation resolved it
        await redis.del(`cachly:ckg:conflict:${ckgSlug(topic)}`);
      }

      const lines = [
        `🗳️ **MADC Deliberation: "${topic}"**`, '',
        `📊 Evidence: ${successLessons.length} success/partial vs ${failureLessons.length} failure entries (${history.length} total)`,
        '', `**Voting agents (${votingAgents.length}):**`,
        ...votes.map(v => {
          const icon = v.vote === 'success' ? '✅' : v.vote === 'failure' ? '❌' : '⬜';
          const covBar = '▓'.repeat(Math.min(v.coverage, 5)) + '░'.repeat(Math.max(0, 5 - v.coverage));
          return `  ${icon} **${v.agent}** [${covBar}] ${v.coverage} CKG edges — ${v.reason}`;
        }),
        '', resolutionText, '',
      ];

      if (resolution === 'unanimous_success') {
        lines.push(`🔧 Failure entries superseded — store confirmed lesson: \`learn_from_attempts(topic="${topic}", outcome="success", ...)\``);
      } else if (resolution === 'unanimous_failure') {
        lines.push(`🚫 Success claims unconfirmed — re-verify: \`recall_best_solution(topic="${topic}")\``);
      } else {
        lines.push(`⚠️ Contested — run \`causal_trace\` before acting. Explore: \`ckg_inspect(concept="${ckgSlug(topic)}")\``);
      }

      lines.push('', `📝 Resolution node: \`cachly:ckg:node:${resNodeId}\``);
      return lines.join('\n');
    }

    // ── Layer 5: CLS — cls_ingest ─────────────────────────────────────────────
    case 'cls_ingest': {
      const { instance_id, source, payload } = args as {
        instance_id: string;
        source: 'git_commit' | 'ci_outcome' | 'ide_diagnostic';
        payload: Record<string, unknown>;
      };
      const redis = await getConnection(instance_id);
      const ts = new Date().toISOString();
      const clsKey = 'cachly:cls:events';

      if (source === 'git_commit') {
        const message = String(payload.message ?? '');
        const sha = String(payload.sha ?? '');
        const files = (Array.isArray(payload.files) ? payload.files : []) as string[];

        const domain = /^fix/i.test(message) ? 'fix' : /^feat/i.test(message) ? 'feat' : /^refactor/i.test(message) ? 'refactor' : /^test/i.test(message) ? 'test' : 'commit';
        const slug = `${domain}:${ckgSlug(message.slice(0, 60))}`;
        const conceptId = ckgSlug(slug);

        await ckgUpsertNode(redis, conceptId, domain, 'commit');
        for (const f of files.slice(0, 10)) {
          const fd = f.includes('auth') ? 'auth' : f.includes('api') ? 'api' : f.includes('infra') ? 'infra' : f.includes('web') ? 'web' : 'code';
          const fileId = ckgSlug(`file:${fd}`);
          await ckgUpsertNode(redis, fileId, 'file', fd);
          await ckgUpdateEdge(redis, conceptId, 'co-occurs', fileId, true);
        }

        const lessonObj = {
          topic: slug, outcome: 'success' as const, what_worked: message, what_failed: '',
          context: `CLS/git: sha=${sha}`, severity: 'minor' as const,
          file_paths: files.slice(0, 10), commands: sha ? [`git show ${sha}`] : [],
          tags: ['cls', 'git'], depends_on: [], recall_count: 0, ts, verified_at: ts,
          confidence: 0.6, audit_trail: [{ ts, action: 'cls_git_commit' }], version: 3,
        };
        await redis.rpush(`cachly:lessons:${slug}`, JSON.stringify(lessonObj));
        const existing = await redis.get(`cachly:lesson:best:${slug}`);
        if (!existing) await redis.set(`cachly:lesson:best:${slug}`, JSON.stringify(lessonObj));

        await redis.rpush(clsKey, JSON.stringify({ source, payload: { message, sha }, ts }));
        await redis.ltrim(clsKey, -200, -1);

        return [
          `📨 **CLS Ingested: git_commit**`, '',
          `Commit \`${sha.slice(0, 8) || '?'}\`: ${message.slice(0, 80)}`,
          `Concept: \`${conceptId}\` (${domain}) · Files: ${files.length}`,
          '', `🕸️ CKG: \`${conceptId}\` + ${files.length} file edges · Lesson: \`${slug}\``,
          `💡 Inspect: \`ckg_inspect(concept="${domain}")\``,
        ].join('\n');
      }

      if (source === 'ci_outcome') {
        const status = String(payload.status ?? '');
        const prev_status = String(payload.prev_status ?? '');
        const job = String(payload.job ?? 'unknown');
        const ciCtx = String(payload.context ?? '');

        const isFixed = ['failure', 'red', 'error'].includes(prev_status) && ['success', 'green', 'passed'].includes(status);
        const isBroken = ['success', 'green', 'passed'].includes(prev_status) && ['failure', 'red', 'error'].includes(status);

        const slug = `ci:${ckgSlug(job)}`;
        const conceptId = ckgSlug(slug);
        await ckgUpsertNode(redis, conceptId, 'ci', 'job');

        if (isFixed) {
          const problemId = ckgSlug(`problem:${ckgSlug(job)}`);
          await ckgUpsertNode(redis, problemId, 'problem', 'ci-failure');
          await ckgUpdateEdge(redis, conceptId, 'fixes', problemId, true);
          const lessonObj = {
            topic: slug, outcome: 'success' as const,
            what_worked: `CI job "${job}" went ${prev_status} → ${status}`,
            what_failed: `Job "${job}" was failing`, context: `CLS/ci: ${ciCtx}`,
            severity: 'major' as const, file_paths: [], commands: [], tags: ['cls', 'ci'],
            depends_on: [], recall_count: 0, ts, verified_at: ts, confidence: 0.75,
            audit_trail: [{ ts, action: 'cls_ci_fixed' }], version: 3,
          };
          await redis.rpush(`cachly:lessons:${slug}`, JSON.stringify(lessonObj));
          await redis.set(`cachly:lesson:best:${slug}`, JSON.stringify(lessonObj));
        } else if (isBroken) {
          const causeId = ckgSlug(`cause:${ckgSlug(job)}`);
          await ckgUpsertNode(redis, causeId, 'cause', 'ci-break');
          await ckgUpdateEdge(redis, conceptId, 'causes', causeId, false);
        }

        await redis.rpush(clsKey, JSON.stringify({ source, payload: { status, prev_status, job }, ts }));
        await redis.ltrim(clsKey, -200, -1);

        const statusIcon = isFixed ? '✅ Fixed' : isBroken ? '🔴 Broken' : '📊 Recorded';
        return [
          `📨 **CLS Ingested: ci_outcome**`, '',
          `${statusIcon}: \`${job}\` — ${prev_status || '?'} → ${status}`,
          isFixed ? `🔧 CKG \`fixes\` edge added (75% confidence)` : isBroken ? `⚡ CKG \`causes\` edge added` : `📊 State recorded`,
          `💡 Lesson: \`${slug}\`  |  Predict: \`brain_predict(context="${job}")\``,
        ].join('\n');
      }

      if (source === 'ide_diagnostic') {
        const error = String(payload.error ?? '');
        const fix = String(payload.fix ?? '');
        const file = String(payload.file ?? '');

        const errorConcept = extractProblemConcept(error) ?? 'unknown-error';
        const slug = `debug:${ckgSlug(errorConcept)}`;
        const conceptId = ckgSlug(slug);
        const problemId = ckgSlug(`problem:${errorConcept}`);

        await ckgUpsertNode(redis, conceptId, 'debug', 'diagnostic');
        await ckgUpsertNode(redis, problemId, 'problem', 'compiler-error');
        await ckgUpdateEdge(redis, conceptId, 'fixes', problemId, true);

        const lessonObj = {
          topic: slug, outcome: 'success' as const, what_worked: fix, what_failed: error,
          context: `CLS/ide: ${file}`, severity: 'minor' as const,
          file_paths: file ? [file] : [], commands: [], tags: ['cls', 'ide-diagnostic'],
          depends_on: [], recall_count: 0, ts, verified_at: ts, confidence: 0.65,
          audit_trail: [{ ts, action: 'cls_ide_diagnostic' }], version: 3,
        };
        await redis.rpush(`cachly:lessons:${slug}`, JSON.stringify(lessonObj));
        const existingL = await redis.get(`cachly:lesson:best:${slug}`);
        if (!existingL) await redis.set(`cachly:lesson:best:${slug}`, JSON.stringify(lessonObj));

        await redis.rpush(clsKey, JSON.stringify({ source, payload: { error: error.slice(0, 60), fix: fix.slice(0, 60), file }, ts }));
        await redis.ltrim(clsKey, -200, -1);

        return [
          `📨 **CLS Ingested: ide_diagnostic**`, '',
          `Error: \`${error.slice(0, 80)}\``,
          `Fix: ${fix.slice(0, 100)}`,
          file ? `File: \`${file}\`` : '',
          '', `🕸️ CKG: \`${conceptId}\` → fixes → \`${problemId}\`  |  Lesson: \`${slug}\``,
        ].filter(l => l !== '').join('\n');
      }

      return `❌ Unknown CLS source: "${source}". Valid: git_commit, ci_outcome, ide_diagnostic`;
    }

    // ── Layer 5: CLS — cls_install_hooks ─────────────────────────────────────
    case 'cls_install_hooks': {
      const { instance_id, repo_path = '.', hooks = ['git', 'ci'] } = args as {
        instance_id: string; repo_path?: string; hooks?: string[];
      };
      const hooksArr = Array.isArray(hooks) ? hooks : ['git', 'ci'];
      const lines: string[] = [`🔌 **CLS Hook Installation Guide**\n`];

      if (hooksArr.includes('git')) {
        const hookScript = [
          `#!/bin/sh`,
          `# cachly CLS — Continuous Learning Stream git hook`,
          `# Installed by cls_install_hooks · runs silently on every commit`,
          `INSTANCE="${instance_id}"`,
          `SHA=$(git rev-parse HEAD 2>/dev/null || echo "")`,
          `MSG=$(git log -1 --pretty=%B 2>/dev/null | head -1)`,
          `FILES=$(git diff-tree --no-commit-id -r --name-only HEAD 2>/dev/null | tr '\\n' ',' | sed 's/,$//')`,
          `node -e "`,
          `const p={instance_id:'$INSTANCE',source:'git_commit',payload:{message:$(echo "$MSG" | jq -R . 2>/dev/null || echo '"commit"'),sha:'$SHA',files:'$FILES'.split(',').filter(Boolean)}};`,
          `try{require('child_process').execSync('npx @cachly-dev/mcp-server@latest cls-ingest \\''+JSON.stringify(p)+'\\'',{stdio:'ignore',timeout:5000})}catch(e){}`,
          `" 2>/dev/null &`,
          `exit 0`,
        ].join('\n');

        lines.push(`### Git post-commit hook`);
        lines.push(`**Quick install (run once per repo):**`);
        lines.push('```sh');
        lines.push(`cat > ${repo_path}/.git/hooks/post-commit << 'HOOK'`);
        lines.push(hookScript);
        lines.push(`HOOK`);
        lines.push(`chmod +x ${repo_path}/.git/hooks/post-commit`);
        lines.push('```');
        lines.push(`After install: every \`git commit\` automatically updates your brain's CKG.`);
        lines.push('');
      }

      if (hooksArr.includes('ci')) {
        lines.push(`### GitHub Actions CI outcome hook`);
        lines.push(`**Add at the end of each job** (after build/test steps):`);
        lines.push('```yaml');
        lines.push(`- name: cachly CLS — record CI outcome`);
        lines.push(`  if: always()`);
        lines.push(`  run: |`);
        lines.push(`    node -e "`);
        lines.push(`    const r=require('https');`);
        lines.push(`    const d=JSON.stringify({instance_id:'${instance_id}',source:'ci_outcome',payload:{`);
        lines.push(`      status:'\${{ job.status }}',prev_status:'unknown',job:'\${{ github.job }}',`);
        lines.push(`      context:'github-actions run \${{ github.run_number }}'}});`);
        lines.push(`    r.request({hostname:'api.cachly.dev',path:'/api/v1/cls/ingest',method:'POST',`);
        lines.push(`      headers:{'Content-Type':'application/json','Authorization':'Bearer \$CACHLY_JWT',`);
        lines.push(`        'Content-Length':d.length}},()=>{}).end(d);`);
        lines.push(`    " 2>/dev/null || true`);
        lines.push(`  env:`);
        lines.push(`    CACHLY_JWT: \${{ secrets.CACHLY_JWT }}`);
        lines.push('```');
        lines.push('');
      }

      lines.push(`💡 Once installed: \`brain_search(query="cls")\` to verify events are arriving.`);
      lines.push(`📊 Monitor CKG growth: \`ckg_inspect(concept="ci")\` or \`ckg_inspect(concept="fix")\``);
      return lines.join('\n');
    }

    // ── Layer 6: FedBrain — fedbrain_contribute ───────────────────────────────
    case 'fedbrain_contribute': {
      const { instance_id, lesson_key, visibility = 'public' } = args as {
        instance_id: string; lesson_key: string; visibility?: string;
      };
      const redis = await getConnection(instance_id);

      const raw = await redis.get(`cachly:lesson:best:${lesson_key}`);
      if (!raw) return `❌ Lesson \`${lesson_key}\` not found. Store it first with \`learn_from_attempts\`.`;

      const lesson = JSON.parse(raw) as { topic: string; outcome: string; what_worked: string; what_failed?: string; tags?: string[]; commands?: string[]; severity?: string; ts?: string };

      const domainTokens = [lesson.topic.split(':')[0], ...(lesson.tags ?? [])].filter(Boolean);
      const domainFingerprint = [...new Set(domainTokens)].sort().join(',');

      // HMAC certificate ID (non-reversible, privacy-safe)
      const certContent = `${lesson.topic}:${lesson.outcome}:${lesson.what_worked}`;
      const certId = createHmac('sha256', `cachly-fedbrain:${instance_id}`).update(certContent).digest('hex').slice(0, 16);

      const cert = {
        cert_id: certId, lesson_key, visibility,
        domain_fingerprint: domainFingerprint,
        contributed_at: new Date().toISOString(),
        confirm_count: 0,
        trust_score: lesson.outcome === 'success' ? 0.85 : 0.5,
      };
      await redis.set(`cachly:fedbrain:cert:${certId}`, JSON.stringify(cert));
      await redis.sadd('cachly:fedbrain:contributed', certId);

      // Try global commons via syndication API
      let syndicationResult: string;
      try {
        await apiFetch('/api/v1/syndication/contribute', {
          method: 'POST',
          body: JSON.stringify({
            topic: lesson.topic, outcome: lesson.outcome,
            what_worked: lesson.what_worked, what_failed: lesson.what_failed ?? '',
            severity: lesson.severity ?? 'major', cert_id: certId,
            domain_fingerprint: domainFingerprint, visibility,
          }),
        });
        syndicationResult = `✅ Contributed to global commons`;
      } catch {
        syndicationResult = `📦 Stored locally (commons API unavailable — will sync when online)`;
      }

      return [
        `🌐 **FedBrain Contribute: "${lesson_key}"**`, '',
        `📜 Certificate: \`${certId}\``,
        `🏷️ Domain fingerprint: ${domainTokens.slice(0, 6).map(t => `\`${t}\``).join(', ')}`,
        `🔒 Visibility: ${visibility}`,
        '', syndicationResult, '',
        `💡 At 10 independent confirms → 🏆 Gold Standard`,
        `🔍 Search: \`fedbrain_search(query="${lesson.topic.split(':').slice(-1)[0]}")\``,
      ].join('\n');
    }

    // ── Layer 6: FedBrain — fedbrain_search ──────────────────────────────────
    case 'fedbrain_search': {
      const { instance_id, query, context_hints = [], limit = 10 } = args as {
        instance_id: string; query: string; context_hints?: string[]; limit?: number;
      };
      const redis = await getConnection(instance_id);

      // Build local domain context from contributed certificates + explicit hints
      const contribIds = await redis.smembers('cachly:fedbrain:contributed');
      const localDomains = new Map<string, number>();
      for (const certId of contribIds.slice(0, 30)) {
        const certRaw = await redis.get(`cachly:fedbrain:cert:${certId}`);
        if (!certRaw) continue;
        try {
          const cert = JSON.parse(certRaw) as { domain_fingerprint?: string };
          for (const d of (cert.domain_fingerprint ?? '').split(',').filter(Boolean)) {
            localDomains.set(d, (localDomains.get(d) ?? 0) + 1);
          }
        } catch { /* skip */ }
      }
      for (const hint of (Array.isArray(context_hints) ? context_hints : [])) {
        localDomains.set(hint.toLowerCase(), (localDomains.get(hint.toLowerCase()) ?? 0) + 2);
      }

      // Search global commons
      type SynResult = { id: string; topic: string; category: string; outcome: string; what_worked: string; what_failed?: string; severity: string; confirm_count: number; created_at: string; domain_fingerprint?: string };
      let results: SynResult[] = [];
      try {
        const params = new URLSearchParams({ q: query, limit: String(Math.min((limit as number) * 2, 50)) });
        const res = await apiFetch<{ results: SynResult[]; count: number }>(`/api/v1/syndication/search?${params}`);
        results = res.results ?? [];
      } catch {
        // Fallback: search local lessons
        const lessonKeys: string[] = [];
        const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
        await new Promise<void>((res, rej) => { lStream.on('data', (b: string[]) => lessonKeys.push(...b)); lStream.on('end', res); lStream.on('error', rej); });
        for (const k of lessonKeys.slice(0, 60)) {
          const r = await redis.get(k);
          if (!r) continue;
          try {
            const l = JSON.parse(r) as { topic: string; outcome: string; what_worked?: string; what_failed?: string; severity?: string; ts?: string };
            const haystack = `${l.topic} ${l.what_worked ?? ''} ${l.what_failed ?? ''}`.toLowerCase();
            if (query.toLowerCase().split(/\s+/).some(t => t.length > 2 && haystack.includes(t))) {
              results.push({ id: k.split(':').pop() ?? k, topic: l.topic, category: l.topic.split(':')[0], outcome: l.outcome, what_worked: l.what_worked ?? '', severity: l.severity ?? 'major', confirm_count: 0, created_at: l.ts ?? new Date().toISOString() });
            }
          } catch { /* skip */ }
        }
      }

      if (results.length === 0) {
        return [`🌐 **FedBrain Search: "${query}"**`, '', `No results. Contribute: \`fedbrain_contribute(lesson_key="fix:...")\``].join('\n');
      }

      // Context-weighted ranking
      const ranked = results.map(r => {
        const rDomains = (r.domain_fingerprint ?? r.category ?? '').split(',').filter(Boolean);
        const overlap = rDomains.reduce((s, d) => s + (localDomains.get(d) ?? 0), 0);
        const contextScore = localDomains.size > 0 ? overlap / Math.max(1, localDomains.size + rDomains.length) : 0;
        const confirmedScore = Math.min(1, r.confirm_count / 10);
        const weightedScore = (contextScore * 0.4) + (confirmedScore * 0.4) + (r.outcome === 'success' ? 0.2 : 0);
        return { ...r, weightedScore, isGoldStandard: r.confirm_count >= 10 };
      }).sort((a, b) => b.weightedScore - a.weightedScore).slice(0, limit as number);

      const lines = [`🌐 **FedBrain Search: "${query}"** — ${ranked.length} result${ranked.length !== 1 ? 's' : ''} (context-weighted)\n`];
      for (const r of ranked) {
        const icon = r.outcome === 'success' ? '✅' : r.outcome === 'failure' ? '❌' : '⚠️';
        const goldBadge = r.isGoldStandard ? ' 🏆 _Gold Standard_' : r.confirm_count >= 3 ? ` ✓${r.confirm_count}` : '';
        const ctxPct = Math.round(r.weightedScore * 100);
        lines.push(`${icon}${goldBadge} **\`${r.topic}\`** [ctx: ${ctxPct}%]`);
        if (r.what_worked) lines.push(`  ✅ ${r.what_worked.slice(0, 150)}`);
        if (r.what_failed) lines.push(`  ❌ ${r.what_failed.slice(0, 80)}`);
        lines.push(`  _${r.confirm_count} confirm${r.confirm_count !== 1 ? 's' : ''}  |  \`${r.id.slice(0, 12)}\`_`, '');
      }
      if (localDomains.size > 0) {
        const topDomains = [...localDomains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `\`${d}\`(${n})`).join(', ');
        lines.push(`🎯 Your context: ${topDomains}`);
      }
      lines.push(`💡 Confirm: \`fedbrain_confirm(topic="<topic>", outcome="worked")\``);
      return lines.join('\n');
    }

    // ── Layer 6: FedBrain — fedbrain_confirm ─────────────────────────────────
    case 'fedbrain_confirm': {
      const { instance_id, topic, outcome } = args as {
        instance_id: string; topic: string; outcome: 'worked' | 'partially_worked' | 'did_not_work';
      };
      const redis = await getConnection(instance_id);
      const ts = new Date().toISOString();

      const confirmEntry = JSON.stringify({ topic, outcome, ts });
      await redis.rpush('cachly:fedbrain:confirmations', confirmEntry);
      await redis.ltrim('cachly:fedbrain:confirmations', -200, -1);

      // Update local CKG confidence
      const worked = outcome === 'worked';
      const partial = outcome === 'partially_worked';
      await ckgUpdateEdge(redis, ckgSlug(topic), 'fixes', ckgSlug(`syndicated:${topic}`), worked, partial);

      // Propagate to global commons
      let propResult: string;
      try {
        await apiFetch('/api/v1/syndication/confirm', { method: 'POST', body: JSON.stringify({ topic, outcome }) });
        propResult = `✅ Confirmation propagated to global commons`;
      } catch {
        await redis.rpush('cachly:fedbrain:pending_confirms', confirmEntry);
        await redis.ltrim('cachly:fedbrain:pending_confirms', -50, -1);
        propResult = `📦 Queued locally (API unavailable — will propagate on next online session)`;
      }

      const icon = worked ? '✅' : partial ? '⚠️' : '❌';
      return [
        `${icon} **FedBrain Confirm: "${topic}"** → ${outcome}`, '',
        propResult, '',
        `🕸️ CKG confidence ${worked || partial ? 'boosted' : 'reduced'} for \`${ckgSlug(topic)}\``,
        `💡 Your confirmation helps other brains worldwide.`,
        `📊 Status: \`fedbrain_status(instance_id="...")\``,
      ].join('\n');
    }

    // ── Layer 6: FedBrain — fedbrain_status ──────────────────────────────────
    case 'fedbrain_status': {
      const { instance_id } = args as { instance_id: string };
      const redis = await getConnection(instance_id);

      const contribIds = await redis.smembers('cachly:fedbrain:contributed');
      const confirmsRaw = await redis.lrange('cachly:fedbrain:confirmations', -10, -1);
      const pendingConfirms = await redis.llen('cachly:fedbrain:pending_confirms');
      const confirms = confirmsRaw.map(r => { try { return JSON.parse(r) as { topic: string; outcome: string; ts: string }; } catch { return null; } }).filter(Boolean) as Array<{ topic: string; outcome: string; ts: string }>;

      const certDetails: Array<{ cert_id: string; lesson_key: string; confirm_count: number; trust_score: number; isGold: boolean }> = [];
      for (const certId of contribIds.slice(0, 15)) {
        const raw = await redis.get(`cachly:fedbrain:cert:${certId}`);
        if (!raw) continue;
        try {
          const cert = JSON.parse(raw) as { cert_id: string; lesson_key: string; confirm_count?: number; trust_score?: number };
          certDetails.push({ cert_id: cert.cert_id, lesson_key: cert.lesson_key, confirm_count: cert.confirm_count ?? 0, trust_score: cert.trust_score ?? 0.5, isGold: (cert.confirm_count ?? 0) >= 10 });
        } catch { /* skip */ }
      }

      const lines = [
        `🌐 **FedBrain Status**\n`,
        `### 📤 Contributed Lessons: ${contribIds.length}`,
      ];

      if (certDetails.length > 0) {
        for (const c of certDetails) {
          const goldBadge = c.isGold ? ' 🏆 Gold Standard' : '';
          const confBar = '█'.repeat(Math.min(10, c.confirm_count)) + '░'.repeat(Math.max(0, 10 - c.confirm_count));
          lines.push(`  \`${c.lesson_key}\` [${confBar}] ×${c.confirm_count}${goldBadge}`);
        }
      } else {
        lines.push(`  _None yet. Contribute with \`fedbrain_contribute(lesson_key="fix:...")\`_`);
      }

      lines.push('', `### 📥 Recent Confirmations: ${confirms.length}`);
      if (confirms.length > 0) {
        for (const c of confirms.slice(-5)) {
          const icon = c.outcome === 'worked' ? '✅' : c.outcome === 'partially_worked' ? '⚠️' : '❌';
          lines.push(`  ${icon} \`${c.topic}\` — ${c.outcome} (${new Date(c.ts).toLocaleDateString('de-DE')})`);
        }
      } else {
        lines.push(`  _None yet. Confirm syndicated lessons with \`fedbrain_confirm\`_`);
      }

      if (pendingConfirms > 0) {
        lines.push('', `⚠️ ${pendingConfirms} confirmation${pendingConfirms !== 1 ? 's' : ''} pending propagation`);
      }

      lines.push('', '---',
        `**Contribute:** \`fedbrain_contribute(lesson_key="fix:...")\``,
        `**Search:** \`fedbrain_search(query="...")\``,
        `**Confirm:** \`fedbrain_confirm(topic="...", outcome="worked")\``,
      );
      return lines.join('\n');
    }

    // ── Layer 6: FedBrain — brain_federate ───────────────────────────────────
    case 'brain_federate': {
      const { instance_id, source, domain, min_confidence = 0.6, dry_run = false } = args as {
        instance_id: string; source: string; domain: string;
        min_confidence?: number; dry_run?: boolean;
      };
      if (instance_id === source) return `❌ Source and destination cannot be the same brain.`;

      const destRedis = await getConnection(instance_id);
      const srcRedis = await getConnection(source);

      const domainPattern = domain === '*' ? 'cachly:ckg:node:*' : `cachly:ckg:node:${domain}*`;

      // Scan source CKG nodes matching the domain
      const nodeKeys: string[] = [];
      const nStream = srcRedis.scanStream({ match: domainPattern, count: 100 });
      await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });

      if (nodeKeys.length === 0) {
        return [
          `🧠 **brain_federate: "${domain}"**`, '',
          `No CKG nodes found in source brain for domain \`${domain}\`.`,
          `The source brain may not have knowledge in this area yet.`,
          `Try: \`fedbrain_search(query="${domain}")\` to find global commons knowledge instead.`,
        ].join('\n');
      }

      // Transfer nodes + their outgoing edges
      let nodesTransferred = 0;
      let edgesTransferred = 0;
      let lessonsTransferred = 0;
      let skippedLowConf = 0;
      const transferLog: string[] = [];

      for (const nk of nodeKeys) {
        const nodeRaw = await srcRedis.get(nk);
        if (!nodeRaw) continue;
        let node: CKGNode;
        try { node = JSON.parse(nodeRaw); } catch { continue; }

        if (!dry_run) await destRedis.set(nk, nodeRaw);
        nodesTransferred++;

        // Transfer outgoing edges for this node
        const edgeKeys = await srcRedis.smembers(`cachly:ckg:idx:from:${node.id}`);
        for (const ek of edgeKeys) {
          const edgeRaw = await srcRedis.get(ek);
          if (!edgeRaw) continue;
          let edge: CKGEdge;
          try { edge = JSON.parse(edgeRaw); } catch { continue; }
          if (edge.confidence < (min_confidence as number)) { skippedLowConf++; continue; }
          if (!dry_run) {
            await destRedis.set(ek, edgeRaw);
            await destRedis.sadd(`cachly:ckg:idx:from:${edge.from}`, ek);
            await destRedis.sadd(`cachly:ckg:idx:to:${edge.to}`, ek);
          }
          edgesTransferred++;
        }

        // Transfer best-lesson for the same topic slug
        const lessonKey = `cachly:lesson:best:${node.id}`;
        const lessonRaw = await srcRedis.get(lessonKey);
        if (lessonRaw) {
          if (!dry_run) await destRedis.set(lessonKey, lessonRaw);
          lessonsTransferred++;
          if (transferLog.length < 8) {
            try {
              const l = JSON.parse(lessonRaw) as { topic: string; outcome: string; what_worked?: string };
              const icon = l.outcome === 'success' ? '✅' : l.outcome === 'failure' ? '❌' : '⚠️';
              transferLog.push(`  ${icon} \`${l.topic}\` — ${(l.what_worked ?? '').slice(0, 80)}`);
            } catch { /* skip */ }
          }
        }
      }

      // Record federation provenance
      if (!dry_run) {
        const provEntry = JSON.stringify({
          source, domain, transferred_at: new Date().toISOString(),
          nodes: nodesTransferred, edges: edgesTransferred, lessons: lessonsTransferred,
        });
        await destRedis.rpush('cachly:fedbrain:federations', provEntry);
        await destRedis.ltrim('cachly:fedbrain:federations', -50, -1);
      }

      const dryTag = dry_run ? ' (DRY RUN — no writes)' : '';
      const lines = [
        `🧠 **brain_federate: "${domain}"**${dryTag}`, '',
        `📤 Source: \`${source}\``,
        `📥 Destination: \`${instance_id}\``,
        `🔍 Domain filter: \`${domain}\`  |  min_confidence: ${min_confidence}`,
        '',
        `### Transfer Summary`,
        `  🕸️ CKG nodes:  ${nodesTransferred}`,
        `  🔗 CKG edges:  ${edgesTransferred}  (${skippedLowConf} skipped, confidence < ${min_confidence})`,
        `  📚 Lessons:    ${lessonsTransferred}`,
        '',
      ];
      if (transferLog.length > 0) {
        lines.push(`### Sample lessons transferred:`, ...transferLog);
        if (lessonsTransferred > transferLog.length) lines.push(`  _... and ${lessonsTransferred - transferLog.length} more_`);
        lines.push('');
      }
      if (dry_run) {
        lines.push(`💡 Run without \`dry_run: true\` to apply the transfer.`);
      } else {
        lines.push(`✅ Transfer complete. Your brain now has the \`${domain}\` knowledge from \`${source}\`.`);
        lines.push(`🔍 Explore: \`ckg_inspect(concept="${domain}")\`  |  \`recall_best_solution(topic="${domain}:...")\``);
      }
      return lines.join('\n');
    }

    // ── crystal_view ──────────────────────────────────────────────────────────
    case 'crystal_view': {
      const { instance_id, show_raw = false } = args as { instance_id: string; show_raw?: boolean };
      const redis = await getConnection(instance_id);

      const raw = await redis.get('cachly:crystal:latest');
      if (!raw) {
        return [
          `💎 **Memory Crystal: not yet created**`, '',
          `No crystal found. Create one with \`memory_crystalize()\` to compress your accumulated wisdom.`,
          '', `💡 Tip: run \`memory_crystalize\` monthly for best results.`,
        ].join('\n');
      }

      type Crystal = { label: string; ts: string; session_count: number; lesson_count: number; top_patterns: Array<{ category: string; insight: string; count: number }>; categories: string[]; created_from: string };
      const crystal: Crystal = JSON.parse(raw);
      const age = Math.floor((Date.now() - new Date(crystal.ts).getTime()) / 86400000);
      const freshEmoji = age <= 7 ? '🟢' : age <= 30 ? '🟡' : '🔴';

      const lines = [
        `💎 **Memory Crystal: ${crystal.label}**`, '',
        `📅 Created: ${new Date(crystal.ts).toLocaleDateString('de-DE')} (${age}d ago ${freshEmoji})`,
        `📊 Compressed from: ${crystal.created_from}`,
        `🗂️ Categories: ${crystal.categories.slice(0, 10).map(c => `\`${c}\``).join(', ')}${crystal.categories.length > 10 ? ` +${crystal.categories.length - 10} more` : ''}`,
        '',
        `**🔑 Top patterns (${crystal.top_patterns.length}):**`,
      ];
      for (const p of crystal.top_patterns) {
        lines.push(`  • **${p.category}** (${p.count}×): ${p.insight.slice(0, 110)}`);
      }
      if (age > 30) {
        lines.push('', `⚠️ Crystal is ${age}d old — run \`memory_crystalize()\` to refresh it.`);
      }
      if (show_raw) {
        lines.push('', '```json', JSON.stringify(crystal, null, 2), '```');
      }
      lines.push('', `💡 Refresh: \`memory_crystalize()\`  |  Recover: \`compact_recover(instance_id="...")\``);
      return lines.join('\n');
    }

    // ── compact_recover ───────────────────────────────────────────────────────
    case 'compact_recover': {
      const { instance_id, focus = '' } = args as { instance_id: string; focus?: string };
      const redis = await getConnection(instance_id);

      const lines = [`🔁 **Compact Recovery Briefing**\n`];
      lines.push(`> *Call this first after any context limit hit. Reconstructs where you left off.*\n`);

      // 1. Memory Crystal
      const crystalRaw = await redis.get('cachly:crystal:latest');
      if (crystalRaw) {
        type Crystal = { label: string; ts: string; session_count: number; lesson_count: number; top_patterns: Array<{ category: string; insight: string; count: number }> };
        const crystal: Crystal = JSON.parse(crystalRaw);
        lines.push(`### 💎 Memory Crystal: ${crystal.label}`);
        lines.push(`Compressed from ${crystal.session_count} sessions, ${crystal.lesson_count} lessons.`);
        const topN = focus
          ? crystal.top_patterns.filter(p => p.category.toLowerCase().includes(focus.toLowerCase()) || p.insight.toLowerCase().includes(focus.toLowerCase())).slice(0, 4)
          : crystal.top_patterns.slice(0, 4);
        for (const p of topN) lines.push(`  • **${p.category}**: ${p.insight.slice(0, 100)}`);
        lines.push('');
      }

      // 2. Last session summary
      const lastSession = await redis.get('cachly:session:last');
      if (lastSession) {
        type Session = { summary?: string; ts?: string; focus?: string };
        const sess: Session = JSON.parse(lastSession);
        lines.push(`### 🕐 Last Session`);
        if (sess.focus) lines.push(`Focus: _${sess.focus}_`);
        if (sess.summary) lines.push(`Summary: ${sess.summary.slice(0, 300)}`);
        lines.push('');
      }

      // 3. Session handoff
      const handoff = await redis.get('cachly:session:handoff');
      if (handoff) {
        type Handoff = { remaining_tasks?: string[]; instructions?: string; context_summary?: string; blocked_on?: string };
        const h: Handoff = JSON.parse(handoff);
        lines.push(`### 📋 Handoff (from last window)`);
        if (h.context_summary) lines.push(`Context: ${h.context_summary.slice(0, 200)}`);
        if (h.remaining_tasks?.length) {
          lines.push(`Remaining tasks:`);
          for (const t of h.remaining_tasks.slice(0, 5)) lines.push(`  • ${t}`);
        }
        if (h.instructions) lines.push(`⚠️ Instructions: ${h.instructions.slice(0, 200)}`);
        if (h.blocked_on) lines.push(`🚧 Blocked on: ${h.blocked_on}`);
        lines.push('');
      }

      // 4. WIP registry
      const wipRaw = await redis.get('cachly:ctx:wip-registry');
      if (wipRaw) {
        type Ctx = { content?: string };
        const wip: Ctx = JSON.parse(wipRaw);
        if (wip.content) {
          lines.push(`### 🔧 WIP Registry`);
          lines.push(wip.content.slice(0, 400));
          lines.push('');
        }
      }

      // 5. Open failures (roadmap with status=blocked/in_progress)
      const roadmapKeys: string[] = [];
      const rStream = redis.scanStream({ match: 'cachly:roadmap:*', count: 100 });
      await new Promise<void>((res, rej) => { rStream.on('data', (b: string[]) => roadmapKeys.push(...b)); rStream.on('end', res); rStream.on('error', rej); });
      const openItems: Array<{ title: string; status: string; priority?: string }> = [];
      for (const k of roadmapKeys.slice(0, 30)) {
        const r = await redis.get(k);
        if (!r) continue;
        try {
          const item = JSON.parse(r) as { title?: string; status?: string; priority?: string };
          if (item.status === 'in_progress' || item.status === 'blocked') openItems.push({ title: item.title ?? k, status: item.status, priority: item.priority });
        } catch { /* skip */ }
      }
      if (openItems.length > 0) {
        lines.push(`### 🚧 Open Items`);
        for (const i of openItems.slice(0, 5)) lines.push(`  • [${i.status}] ${i.title}`);
        lines.push('');
      }

      // 6. Focus-relevant lessons
      if (focus) {
        const lessonKeys: string[] = [];
        const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
        await new Promise<void>((res, rej) => { lStream.on('data', (b: string[]) => lessonKeys.push(...b)); lStream.on('end', res); lStream.on('error', rej); });
        const relevant: Array<{ topic: string; what_worked: string }> = [];
        for (const k of lessonKeys) {
          const r = await redis.get(k);
          if (!r) continue;
          try {
            const l = JSON.parse(r) as { topic: string; what_worked?: string };
            if (l.topic.toLowerCase().includes(focus.toLowerCase()) && l.what_worked) {
              relevant.push({ topic: l.topic, what_worked: l.what_worked });
            }
          } catch { /* skip */ }
        }
        if (relevant.length > 0) {
          lines.push(`### 💡 Relevant Lessons for "${focus}"`);
          for (const l of relevant.slice(0, 4)) lines.push(`  • **${l.topic}**: ${l.what_worked.slice(0, 100)}`);
          lines.push('');
        }
      }

      if (lines.length <= 3) {
        lines.push(`_No brain data found. Start accumulating knowledge with \`learn_from_attempts\` and \`session_start\`._`);
      }
      lines.push(`---`, `🧠 Brain is ready. Continue your work — full context restored.`);
      return lines.join('\n');
    }

    // ── brain_from_git ────────────────────────────────────────────────────────
    case 'brain_from_git': {
      const { instance_id, repo_path = '.', limit = 100, branch = 'HEAD', since = '' } = args as {
        instance_id: string; repo_path?: string; limit?: number; branch?: string; since?: string;
      };
      const redis = await getConnection(instance_id);
      const { execSync } = await import('node:child_process');
      const { resolve } = await import('node:path');

      const repoDir = resolve(repo_path);
      const maxCommits = Math.min(Number(limit) || 100, 500);

      // Semaphore: max 10 concurrent git subprocesses per MCP process
      await _gitSemAcquire();
      try {
      // Verify it's a git repo
      try {
        execSync('git rev-parse --git-dir', { cwd: repoDir, stdio: 'pipe' });
      } catch {
        return `❌ Not a git repository: \`${repoDir}\`. Pass \`repo_path\` pointing to a git checkout.`;
      }

      // Build git log command
      const sinceFlag = since ? `--since="${since}"` : '';
      const logCmd = `git log ${branch} ${sinceFlag} --pretty=format:"%H|||%s|||%ad|||%an" --date=short --no-merges -n ${maxCommits}`;

      let logOutput = '';
      try {
        logOutput = execSync(logCmd, { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' });
      } catch (e) {
        return `❌ git log failed: ${(e as Error).message}. Check \`repo_path\` and \`branch\`.`;
      }

      const commits = logOutput.trim().split('\n').filter(Boolean).map(line => {
        const [sha, subject, date, author] = line.split('|||');
        return { sha: (sha ?? '').trim(), subject: (subject ?? '').trim(), date: (date ?? '').trim(), author: (author ?? '').trim() };
      });

      if (commits.length === 0) {
        return `⚠️ No commits found in \`${repoDir}\` on branch \`${branch}\`${since ? ` since ${since}` : ''}.`;
      }

      // Pattern classifiers
      const classifyCommit = (subject: string): { category: string; outcome: 'success' | 'failure' | 'partial'; severity: 'critical' | 'major' | 'minor' } => {
        const s = subject.toLowerCase();
        if (/\b(fix|fixed|fixes|bug|hotfix|patch|revert|resolve|closes? #\d+)\b/.test(s)) {
          const sev: 'critical' | 'major' | 'minor' = /\b(critical|crash|security|auth|data loss|outage|prod|production)\b/.test(s) ? 'critical' : /\b(major|breaking|regression|hotfix)\b/.test(s) ? 'major' : 'minor';
          return { category: 'fix', outcome: 'success', severity: sev };
        }
        if (/\b(feat|feature|add|added|implement|new|introduce)\b/.test(s)) return { category: 'feat', outcome: 'success', severity: 'minor' };
        if (/\b(refactor|clean|cleanup|improve|simplify|extract|rename)\b/.test(s)) return { category: 'refactor', outcome: 'success', severity: 'minor' };
        if (/\b(perf|optimize|speed|cache|latency|memory|performance)\b/.test(s)) return { category: 'perf', outcome: 'success', severity: 'major' };
        if (/\b(security|cve|auth|csrf|xss|sql|injection|sanitize|escape|encrypt)\b/.test(s)) return { category: 'security', outcome: 'success', severity: 'critical' };
        if (/\b(deploy|ci|cd|build|docker|k8s|helm|infra|devops)\b/.test(s)) return { category: 'deploy', outcome: 'success', severity: 'major' };
        if (/\b(test|spec|coverage|assert|mock|unit|integration)\b/.test(s)) return { category: 'test', outcome: 'success', severity: 'minor' };
        return { category: 'chore', outcome: 'success', severity: 'minor' };
      };

      // Extract domain keywords from commit subject
      const extractDomain = (subject: string): string => {
        const s = subject.toLowerCase();
        const tokens = s.replace(/[^a-z0-9\s\-_]/g, ' ').split(/\s+/).filter(t => t.length > 3 && !['that', 'this', 'with', 'from', 'when', 'into', 'also', 'some', 'were'].includes(t));
        return tokens.slice(0, 3).join('-') || 'general';
      };

      const ts = new Date().toISOString();
      let ingested = 0;
      let skipped = 0;
      const categoryCount = new Map<string, number>();

      for (const commit of commits) {
        if (!commit.subject) { skipped++; continue; }
        const { category, outcome, severity } = classifyCommit(commit.subject);
        const domain = extractDomain(commit.subject);
        const topic = `${category}:${domain}`;
        categoryCount.set(category, (categoryCount.get(category) ?? 0) + 1);

        const lessonObj = {
          topic, outcome, severity,
          what_worked: commit.subject.slice(0, 200),
          what_failed: '',
          context: `git:${commit.sha.slice(0, 8)} by ${commit.author} on ${commit.date}`,
          file_paths: [], commands: [`git show ${commit.sha.slice(0, 8)}`],
          tags: ['brain_from_git', category, 'git-history'],
          depends_on: [], recall_count: 0, ts, verified_at: ts,
          confidence: 0.55, // lower confidence for auto-inferred lessons
          audit_trail: [{ ts, action: 'brain_from_git', sha: commit.sha.slice(0, 8) }],
          version: 3,
        };

        // Only store if no existing lesson for this topic (avoid overwriting higher-confidence lessons)
        const existing = await redis.get(`cachly:lesson:best:${topic}`);
        if (!existing) {
          await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(lessonObj));
          await redis.rpush(`cachly:lessons:${topic}`, JSON.stringify(lessonObj));
        }
        await redis.rpush('cachly:lessons:brain_from_git:all', JSON.stringify({ topic, sha: commit.sha.slice(0, 8), subject: commit.subject.slice(0, 60) }));
        await redis.ltrim('cachly:lessons:brain_from_git:all', -500, -1);

        // Update CKG
        const conceptId = ckgSlug(topic);
        await ckgUpsertNode(redis, conceptId, category, 'git-derived');
        ingested++;
      }

      const categoryBreakdown = [...categoryCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `  • **${k}** (${v})`).join('\n');

      return [
        `🔁 **brain_from_git: ${repoDir}**`, '',
        `📂 Branch: \`${branch}\`  |  Processed: **${commits.length}** commits  |  Ingested: **${ingested}** lessons  |  Skipped: ${skipped}`,
        ``,
        `**Breakdown by category:**`,
        categoryBreakdown,
        ``,
        `💡 New lessons are stored with confidence 0.55 (auto-inferred).`,
        `💡 As you confirm them via \`learn_from_attempts\`, confidence rises automatically.`,
        `🔍 Explore: \`brain_search(query="fix")\`  |  \`ckg_inspect(concept="deploy")\``,
      ].join('\n');
      } finally {
        _gitSemRelease();
      }
    }

    // ── brain_predict_failures ─────────────────────────────────────────────────
    case 'brain_predict_failures': {
      const { instance_id, context: ctx, top_k = 5, format = 'detailed' } = args as {
        instance_id: string; context: string; top_k?: number; format?: 'brief' | 'detailed';
      };
      const redis = await getConnection(instance_id);

      const ctxTokens = ctx.toLowerCase().replace(/[^a-z0-9\s\-_:.]/g, ' ').split(/\s+/).filter(t => t.length > 2);

      type FailurePred = { concept: string; failure: string; probability: number; fix?: string; topic?: string; source: 'ckg' | 'lesson' };
      const failures: FailurePred[] = [];

      // Step 1: CKG — find 'causes' and 'degrades_under' edges from context tokens
      for (const token of ctxTokens.slice(0, 8)) {
        const nodeKeys: string[] = [];
        const nStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 50 });
        await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });

        for (const nk of nodeKeys.slice(0, 5)) {
          const nodeRaw = await redis.get(nk);
          if (!nodeRaw) continue;
          const node: CKGNode = JSON.parse(nodeRaw);
          const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${node.id}`);
          for (const ek of edgeKeys.slice(0, 20)) {
            const edgeRaw = await redis.get(ek);
            if (!edgeRaw) continue;
            const edge: CKGEdge = JSON.parse(edgeRaw);
            if (edge.edgeType !== 'causes' && edge.edgeType !== 'degrades_under') continue;

            // Look up fix for this failure from CKG 'fixes' edges
            const fixEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${edge.to}`);
            let fix: string | undefined;
            for (const fek of fixEdgeKeys.slice(0, 10)) {
              const feRaw = await redis.get(fek);
              if (!feRaw) continue;
              const fe: CKGEdge = JSON.parse(feRaw);
              if (fe.edgeType === 'fixes') {
                const lessonRaw = await redis.get(`cachly:lesson:best:${fe.from}`);
                if (lessonRaw) {
                  const lesson = JSON.parse(lessonRaw) as { what_worked?: string };
                  fix = lesson.what_worked?.slice(0, 120);
                  break;
                }
              }
            }

            failures.push({
              concept: node.id,
              failure: edge.to.replace(/-/g, ' '),
              probability: edge.confidence,
              fix,
              source: 'ckg',
            });
          }
        }
      }

      // Step 2: Lesson history — find failure-outcome lessons matching context
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 300 });
      await new Promise<void>((res, rej) => { lStream.on('data', (b: string[]) => lessonKeys.push(...b)); lStream.on('end', res); lStream.on('error', rej); });

      for (const k of lessonKeys.slice(0, 100)) {
        const r = await redis.get(k);
        if (!r) continue;
        try {
          const l = JSON.parse(r) as { topic: string; outcome: string; what_failed?: string; what_worked?: string; confidence?: number; severity?: string };
          if (l.outcome !== 'failure' && l.outcome !== 'partial') continue;
          if (!l.what_failed) continue;
          const haystack = `${l.topic} ${l.what_failed}`.toLowerCase();
          const matchScore = ctxTokens.filter(t => haystack.includes(t)).length / Math.max(1, ctxTokens.length);
          if (matchScore < 0.15) continue;
          const sevBoost = l.severity === 'critical' ? 0.15 : l.severity === 'major' ? 0.05 : 0;
          failures.push({
            concept: l.topic,
            failure: l.what_failed.slice(0, 80),
            probability: Math.min(0.97, (l.confidence ?? 0.5) * matchScore * 1.5 + sevBoost),
            fix: l.what_worked?.slice(0, 120),
            topic: l.topic,
            source: 'lesson',
          });
        } catch { /* skip */ }
      }

      if (failures.length === 0) {
        return [
          `🔮 **Failure Prediction: "${ctx}"**`, '',
          `No known failure patterns found for this context.`,
          `💡 The brain learns from every \`learn_from_attempts(outcome="failure")\` call.`,
          `🔍 Try: \`brain_predict(context="${ctx}")\` for broader predictions.`,
        ].join('\n');
      }

      // Deduplicate and rank by probability
      const seen = new Set<string>();
      const ranked = failures.filter(f => {
        const k = f.failure.slice(0, 40);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).sort((a, b) => b.probability - a.probability).slice(0, Number(top_k));

      const lines = [`🔮 **Failure Prediction for: "${ctx}"**\n`];
      lines.push(`> Pre-deploy failure analysis based on ${failures.length} patterns. Ranked by probability.\n`);

      for (let i = 0; i < ranked.length; i++) {
        const f = ranked[i];
        const pct = Math.round(f.probability * 100);
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        const icon = pct >= 70 ? '🔴' : pct >= 40 ? '🟡' : '🟢';
        lines.push(`${icon} **${i + 1}. ${f.failure}**`);
        lines.push(`   Probability: ${bar} **${pct}%** (${f.source === 'ckg' ? 'CKG causal edge' : 'lesson history'})`);
        if (format === 'detailed' && f.fix) {
          lines.push(`   ✅ Pre-loaded fix: _${f.fix}_`);
        }
        if (format === 'detailed' && f.topic) {
          lines.push(`   📚 Lesson: \`${f.topic}\``);
        }
        lines.push('');
      }

      const highRisk = ranked.filter(f => f.probability >= 0.6);
      if (highRisk.length > 0) {
        lines.push(`⚠️ **${highRisk.length} high-risk failure${highRisk.length > 1 ? 's' : ''} detected** (≥60% probability). Review fixes before proceeding.`);
      } else {
        lines.push(`✅ No high-risk failures detected. Proceed with caution and monitor closely.`);
      }
      lines.push('', `💡 After deploy: \`learn_from_attempts(topic="deploy:...", outcome="success|failure")\` to improve future predictions.`);
      return lines.join('\n');
    }

    default:
      return null;
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────

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
let _gitSemCount = 0;
const _GIT_SEM_MAX = 10;
const _gitSemQueue: Array<() => void> = [];
function _gitSemAcquire(): Promise<void> {
  if (_gitSemCount < _GIT_SEM_MAX) { _gitSemCount++; return Promise.resolve(); }
  return new Promise(resolve => _gitSemQueue.push(resolve));
}
function _gitSemRelease(): void {
  const next = _gitSemQueue.shift();
  if (next) { next(); } else { _gitSemCount--; }
}

async function autoStartSession(instanceId: string): Promise<void> {
  if (_autoSessionStarted) return;
  // If another call already started the session, await it instead of double-starting.
  if (_autoSessionStarting) { await _autoSessionStarting; return; }
  _autoSessionStarting = (async () => {
    _autoSessionStarted = true;
    _autoSessionInstanceId = instanceId;
    try {
      await handleTool('session_start', { instance_id: instanceId, focus: 'auto (MCP session)' });
    } catch { /* non-fatal — session tracking is a best-effort feature */ }
    _autoSessionStarting = null;
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
    const instanceId = (args as Record<string, unknown>)?.instance_id as string | undefined;
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

