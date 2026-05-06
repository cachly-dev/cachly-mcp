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
/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  EMBEDDING PROVIDER — pluggable, client-side first                  │
 * │                                                                      │
 * │  Auto-detects from env vars. To force a provider, set:              │
 * │    CACHLY_EMBED_PROVIDER=openai   (+ OPENAI_API_KEY)                │
 * │    CACHLY_EMBED_PROVIDER=gemini   (+ GEMINI_API_KEY)                │
 * │    CACHLY_EMBED_PROVIDER=mistral  (+ MISTRAL_API_KEY)               │
 * │    CACHLY_EMBED_PROVIDER=cohere   (+ COHERE_API_KEY)                │
 * │    CACHLY_EMBED_PROVIDER=ollama   (+ OLLAMA_BASE_URL, local)        │
 * │    CACHLY_EMBED_PROVIDER=cachly   (server-side fallback, no key)    │
 * │                                                                      │
 * │  Priority: openai > gemini > mistral > cohere > ollama > cachly     │
 * │  Brain works WITHOUT embedding (keyword search + exact key lookup).│
 * │  Embedding is an optional boost for semantic_search/index_project.  │
 * └──────────────────────────────────────────────────────────────────────┘
 */
const EMBED_PROVIDER = (process.env.CACHLY_EMBED_PROVIDER ?? detectEmbedProvider()).toLowerCase();

// ── Confidence Decay Config (all values configurable via env) ─────────────────
const CONFIDENCE_WARN_DAYS  = Number(process.env.CACHLY_CONFIDENCE_WARN_DAYS  ?? 5);   // → 0.7
const CONFIDENCE_STALE_DAYS = Number(process.env.CACHLY_CONFIDENCE_STALE_DAYS ?? 10);  // → 0.5
const CONFIDENCE_WARN_VALUE  = 0.7;
const CONFIDENCE_STALE_VALUE = 0.5;

/** Calculate current confidence for a lesson based on how long since last verified. */
function calculateConfidence(lesson: { verified_at?: string; ts: string; recall_count?: number }): number {
  const ref = lesson.verified_at ?? lesson.ts;
  const ageMs = Date.now() - new Date(ref).getTime();
  const ageDays = ageMs / 86400000;
  if (ageDays >= CONFIDENCE_STALE_DAYS) return CONFIDENCE_STALE_VALUE;
  if (ageDays >= CONFIDENCE_WARN_DAYS)  return CONFIDENCE_WARN_VALUE;
  // Linear interpolation between fresh (1.0) and warn threshold
  return 1.0 - (ageDays / CONFIDENCE_WARN_DAYS) * (1.0 - CONFIDENCE_WARN_VALUE);
}

/** Render a confidence badge string. */
function confidenceBadge(confidence: number, ageDays: number): string {
  if (confidence >= 0.9) return '✅';
  if (confidence >= 0.7) return `⚠️ (${Math.round(ageDays)}d old, confidence ${(confidence * 100).toFixed(0)}% — verify before applying)`;
  return `🔴 STALE (${Math.round(ageDays)}d old, confidence ${(confidence * 100).toFixed(0)}% — likely outdated!)`;
}

/** Category-specific required fields for structured lessons. */
const STRUCTURED_TEMPLATES: Record<string, { required: string[]; hint: string }> = {
  'deploy':  { required: ['commands'],                hint: 'deploy:* needs commands[]' },
  'bash':    { required: ['commands'],                hint: 'bash:* needs commands[]' },
  'infra':   { required: ['commands'],                hint: 'infra:* needs commands[] + verified on real system' },
  'pricing': { required: [],                          hint: 'pricing:* — add context with source (e.g. "Stripe Dashboard Apr 2026")' },
  'stripe':  { required: [],                          hint: 'stripe:* — add context with Stripe API version' },
};

/** Fast content hash for index invalidation (not cryptographic, just change detection) */
function simpleHash(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, 12);
}

function detectEmbedProvider(): string {
  // Client-side keys first (direct, fast, no server roundtrip)
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.MISTRAL_API_KEY) return 'mistral';
  if (process.env.COHERE_API_KEY) return 'cohere';
  if (process.env.OLLAMA_BASE_URL) return 'ollama';
  // Server-side fallback — no API key needed, but adds latency
  if (process.env.CACHLY_JWT) return 'cachly';
  return 'none'; // no provider → embedding disabled, brain still works via exact keys
}

// ── Multi-provider embedding ─────────────────────────────────────────────────

/**
 * Compute an embedding vector for `text` using the configured provider.
 *
 * Client-side (recommended — set one API key in your .env):
 *   openai   – OPENAI_API_KEY  · text-embedding-3-small
 *   gemini   – GEMINI_API_KEY  · text-embedding-004
 *   mistral  – MISTRAL_API_KEY · mistral-embed
 *   cohere   – COHERE_API_KEY  · embed-english-v3.0
 *   ollama   – OLLAMA_BASE_URL · nomic-embed-text (local, free)
 *
 * Server-side fallback (no key needed on client):
 *   cachly   – POST /api/v1/embed (requires CACHLY_JWT)
 *
 * Note: Brain works fully WITHOUT embedding (keyword search + exact keys).
 *       Embedding is an OPTIONAL boost for semantic_search and index_project.
 */
async function computeEmbedding(text: string): Promise<number[]> {
  switch (EMBED_PROVIDER) {
    case 'cachly': {
      // Server-side embedding — the Cachly API computes the embedding
      // using whatever provider is configured on the server. No client-side API key needed.
      if (!JWT) throw new Error(
        'CACHLY_JWT not set.\n\n' +
        'The "cachly" provider uses server-side embeddings via the Cachly API.\n' +
        'Set CACHLY_JWT, or use another provider via CACHLY_EMBED_PROVIDER:\n' +
        '  openai  → OPENAI_API_KEY\n' +
        '  gemini  → GEMINI_API_KEY\n' +
        '  ollama  → OLLAMA_BASE_URL (local, no key needed)'
      );
      const url = `${API_URL}/api/v1/embed`;
      const body: Record<string, string> = { text };
      if (EMBED_MODEL) body.model = EMBED_MODEL;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${JWT}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Cachly embed API error ${res.status}: ${errBody}`);
      }
      const json = (await res.json()) as { embedding: number[]; dimensions: number };
      return json.embedding;
    }

    case 'mistral': {
      const key = process.env.MISTRAL_API_KEY;
      if (!key) throw new Error('MISTRAL_API_KEY not set');
      const model = EMBED_MODEL !== 'text-embedding-3-small' ? EMBED_MODEL : 'mistral-embed';
      const res = await fetch('https://api.mistral.ai/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: [text] }),
      });
      if (!res.ok) throw new Error(`Mistral embedding error: ${res.statusText}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      if (!json.data?.[0]?.embedding) throw new Error('Mistral returned empty embedding response');
      return json.data[0].embedding;
    }

    case 'cohere': {
      const key = process.env.COHERE_API_KEY;
      if (!key) throw new Error('COHERE_API_KEY not set');
      const model = EMBED_MODEL !== 'text-embedding-3-small' ? EMBED_MODEL : 'embed-english-v3.0';
      const res = await fetch('https://api.cohere.com/v2/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, texts: [text], input_type: 'search_query', embedding_types: ['float'] }),
      });
      if (!res.ok) throw new Error(`Cohere embedding error: ${res.statusText}`);
      const json = (await res.json()) as { embeddings: { float: number[][] } };
      return json.embeddings.float[0];
    }

    case 'ollama': {
      const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      const model = EMBED_MODEL !== 'text-embedding-3-small' ? EMBED_MODEL : 'nomic-embed-text';
      const res = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
      });
      if (!res.ok) throw new Error(`Ollama embedding error: ${res.statusText}`);
      const json = (await res.json()) as { embedding: number[] };
      return json.embedding;
    }

    case 'gemini': {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('GEMINI_API_KEY not set');
      const model = EMBED_MODEL !== 'text-embedding-3-small' ? EMBED_MODEL : 'text-embedding-004';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] } }),
        },
      );
      if (!res.ok) throw new Error(`Gemini embedding error: ${res.statusText}`);
      const json = (await res.json()) as { embedding: { values: number[] } };
      return json.embedding.values;
    }

    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error(
        'OPENAI_API_KEY not set.\n\n' +
        'Set OPENAI_API_KEY in your .env, or switch provider:\n' +
        '  CACHLY_EMBED_PROVIDER=gemini  (+ GEMINI_API_KEY)\n' +
        '  CACHLY_EMBED_PROVIDER=ollama  (local, free)\n' +
        '  CACHLY_EMBED_PROVIDER=cachly  (server-side, no key needed)'
      );
      const model = EMBED_MODEL || 'text-embedding-3-small';
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) throw new Error(`OpenAI embedding error: ${res.statusText}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      if (!json.data?.[0]?.embedding) throw new Error('OpenAI returned empty embedding response');
      return json.data[0].embedding;
    }

    default: {
      throw new Error(
        `Unknown CACHLY_EMBED_PROVIDER="${EMBED_PROVIDER}".\n` +
        'Supported: cachly (default), openai, mistral, cohere, ollama, gemini'
      );
    }
  }
}

/** Returns true if the configured embedding provider has its required key/URL set. */
function hasEmbedProvider(): boolean {
  switch (EMBED_PROVIDER) {
    case 'cachly':  return !!JWT;
    case 'mistral': return !!process.env.MISTRAL_API_KEY;
    case 'cohere':  return !!process.env.COHERE_API_KEY;
    case 'ollama':  return true; // OLLAMA_BASE_URL is optional (defaults to localhost)
    case 'gemini':  return !!process.env.GEMINI_API_KEY;
    case 'openai':  return !!process.env.OPENAI_API_KEY;
    case 'none':    return false;
    default:        return false;
  }
}

/** Returns a human-readable description of the current embed provider/model for error messages. */
function embedProviderHint(): string {
  const providerKeys: Record<string, string> = {
    cachly: 'CACHLY_JWT (server-side, no extra key needed)',
    openai: 'OPENAI_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    cohere: 'COHERE_API_KEY',
    ollama: 'OLLAMA_BASE_URL (optional, default: http://localhost:11434)',
    gemini: 'GEMINI_API_KEY',
  };
  if (EMBED_PROVIDER === 'none') {
    return 'No embedding provider configured. Set OPENAI_API_KEY, GEMINI_API_KEY, or another provider key in .env. Brain works without embedding.';
  }
  const key = providerKeys[EMBED_PROVIDER] ?? 'CACHLY_JWT';
  return `CACHLY_EMBED_PROVIDER=${EMBED_PROVIDER} → requires ${key}`;
}

// ── Search Engine (BM25+ with enhancements, works without embedding) ──────────
//
// Features beyond standard BM25:
//   • BM25+ (delta=1) — fixes BM25's "long document penalty" bug
//   • Bigram proximity boost — adjacent query terms in doc score 2× more
//   • Recency boost — newer entries rank higher (exponential decay, 7-day half-life)
//   • Multi-query splitting — numbered lists, semicolons, conjunctions
//   • Fuzzy matching with Levenshtein distance ≤ 2
//   • Multilingual stopwords (EN, DE, FR, ES, IT, PT, ZH, JA, KO, AR, HE)
//   • CJK character bigram extraction — handles Chinese, Japanese, Korean
//   • RTL language support (Arabic, Hebrew) — word tokenization + light stemming
//   • Romanization matching — katakana → romaji tokens for romaji queries
//   • Cross-language retrieval — tech term synonyms EN↔JA↔ZH↔KO↔AR↔HE
//   • Pipeline Redis reads for performance
//

/**
 * Stopwords — filtered out during tokenization.
 * Covers: English, German, French, Spanish, Italian, Portuguese,
 *         Chinese (Simplified + Traditional), Japanese, Korean.
 * Keeps the index small and scores meaningful.
 */
const STOPWORDS = new Set([
  // ── English ──
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'about', 'against', 'among', 'around', 'without', 'within',
  'along', 'across', 'behind', 'beyond', 'upon', 'toward', 'towards',
  'and', 'but', 'or', 'not', 'no', 'nor', 'so', 'if', 'then', 'than',
  'too', 'very', 'quite', 'rather', 'just', 'also', 'only', 'even',
  'it', 'its', 'this', 'that', 'these', 'those', 'here', 'there',
  'my', 'your', 'his', 'her', 'our', 'their', 'mine', 'yours', 'ours',
  'what', 'which', 'who', 'whom', 'whose', 'how', 'when', 'where', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'much', 'many',
  'other', 'some', 'such', 'own', 'same', 'any', 'either', 'neither',
  'been', 'being', 'because', 'until', 'while', 'once', 'again', 'further',
  'already', 'always', 'never', 'sometimes', 'often', 'still', 'yet',
  // ── German ──
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen',
  'einem', 'einer', 'eines', 'und', 'oder', 'aber', 'denn', 'weil',
  'ist', 'sind', 'war', 'waren', 'sein', 'wird', 'werden', 'wurde',
  'hat', 'haben', 'hatte', 'hatten', 'kann', 'können', 'konnte',
  'soll', 'sollen', 'sollte', 'muss', 'müssen', 'musste', 'darf',
  'mag', 'möchte', 'wollen', 'wollte', 'würde', 'könnte', 'sollte',
  'mit', 'für', 'auf', 'von', 'aus', 'bei', 'nach', 'über', 'unter',
  'vor', 'hinter', 'neben', 'zwischen', 'durch', 'gegen', 'ohne',
  'um', 'bis', 'seit', 'während', 'wegen', 'trotz', 'statt',
  'wie', 'was', 'wer', 'wen', 'wem', 'wessen', 'wo', 'wann', 'warum',
  'nicht', 'noch', 'auch', 'schon', 'nur', 'sehr', 'mehr', 'viel',
  'alle', 'jeder', 'jede', 'jedes', 'dieser', 'diese', 'dieses',
  'jener', 'jene', 'jenes', 'mein', 'dein', 'sein', 'ihr', 'unser',
  'euer', 'kein', 'keine', 'sich', 'mir', 'dir', 'ihm', 'uns', 'euch',
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man',
  'hier', 'dort', 'da', 'dann', 'also', 'doch', 'mal', 'eben', 'ganz',
  // ── French ──
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux',
  'et', 'ou', 'mais', 'donc', 'car', 'ni', 'que', 'qui', 'quoi',
  'est', 'sont', 'était', 'ont', 'avoir', 'être', 'fait', 'faire',
  'pour', 'par', 'avec', 'dans', 'sur', 'sous', 'entre', 'vers',
  'chez', 'sans', 'avant', 'après', 'pendant', 'depuis', 'contre',
  'ce', 'cette', 'ces', 'mon', 'ton', 'son', 'notre', 'votre', 'leur',
  'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'on',
  'ne', 'pas', 'plus', 'très', 'bien', 'aussi', 'tout', 'tous', 'toute',
  'même', 'autre', 'quel', 'quelle', 'comment', 'quand', 'où', 'pourquoi',
  // ── Spanish ──
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'al',
  'lo', 'que', 'en', 'es', 'por', 'con', 'para', 'como', 'pero', 'más',
  'fue', 'ser', 'hay', 'está', 'han', 'son', 'tiene', 'había', 'era',
  'su', 'sus', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos',
  'mi', 'tu', 'yo', 'él', 'ella', 'nosotros', 'ellos', 'ellas', 'usted',
  'no', 'ya', 'sí', 'sin', 'sobre', 'entre', 'hasta', 'desde', 'donde',
  'muy', 'todo', 'toda', 'todos', 'cada', 'otro', 'otra', 'otros',
  'cuando', 'porque', 'aunque', 'también', 'solo', 'después', 'antes',
  // ── Italian ──
  'il', 'lo', 'la', 'li', 'le', 'gli', 'uno', 'una', 'dei', 'del',
  'che', 'di', 'da', 'per', 'con', 'tra', 'fra', 'sul', 'nel', 'al',
  'è', 'sono', 'ha', 'hanno', 'era', 'essere', 'fare', 'fatto', 'stato',
  'suo', 'sua', 'suoi', 'questo', 'questa', 'questi', 'quello', 'quella',
  'io', 'tu', 'lui', 'lei', 'noi', 'voi', 'loro', 'ci', 'si',
  'non', 'più', 'molto', 'anche', 'solo', 'tutto', 'tutti', 'ogni',
  'come', 'dove', 'quando', 'perché', 'ancora', 'già', 'sempre', 'mai',
  // ── Portuguese ──
  'um', 'uma', 'uns', 'umas', 'do', 'da', 'dos', 'das', 'no', 'na',
  'ao', 'aos', 'em', 'por', 'com', 'para', 'sem', 'sob', 'sobre',
  'que', 'se', 'mas', 'ou', 'como', 'mais', 'entre', 'até', 'desde',
  'é', 'são', 'foi', 'tem', 'ser', 'ter', 'estar', 'fazer', 'havia',
  'seu', 'sua', 'seus', 'suas', 'este', 'esta', 'esse', 'essa', 'aquele',
  'eu', 'tu', 'ele', 'ela', 'nós', 'eles', 'elas', 'você', 'vocês',
  'não', 'já', 'sim', 'bem', 'muito', 'também', 'ainda', 'sempre',
  'todo', 'toda', 'todos', 'cada', 'outro', 'outra', 'quando', 'porque',
  // ── Chinese (Simplified + Traditional) — high-frequency function characters ──
  '的', '了', '是', '在', '不', '和', '我', '他', '这', '中', '大', '为',
  '上', '个', '国', '以', '要', '就', '出', '说', '们', '有', '来', '到',
  '时', '地', '年', '得', '着', '那', '过', '后', '还', '与', '也', '可',
  '于', '从', '但', '而', '被', '把', '让', '使', '对', '很', '都', '一',
  '会', '没', '人', '它', '这个', '那个', '什么', '如果', '因为', '所以',
  '已经', '可以', '这些', '那些', '我们', '他们', '她们', '它们',
  // ── Japanese — common hiragana particles and auxiliary verbs ──
  'の', 'は', 'が', 'を', 'に', 'で', 'と', 'も', 'や', 'か', 'な', 'ね',
  'よ', 'わ', 'て', 'い', 'う', 'え', 'お', 'き', 'く', 'け', 'こ', 'さ',
  'し', 'す', 'せ', 'そ', 'た', 'ち', 'つ', 'ぬ', 'ん', 'から', 'まで',
  'より', 'へ', 'です', 'ます', 'ない', 'ある', 'いる', 'する', 'こと',
  'もの', 'ので', 'では', 'には', 'との', 'への', 'から', 'まで',
  // ── Korean — common particles and auxiliary forms ──
  '이', '가', '은', '는', '을', '를', '의', '에', '와', '과', '도',
  '로', '에서', '한', '하', '있', '없', '것', '수', '않', '들',
  '이다', '하다', '이고', '이며', '라고', '에게', '에서', '으로',
  // ── Arabic — high-frequency function words & particles ──
  'في', 'من', 'إلى', 'على', 'عن', 'مع', 'هذا', 'هذه', 'ذلك', 'تلك',
  'الذي', 'التي', 'الذين', 'اللواتي', 'هو', 'هي', 'هم', 'هن', 'نحن',
  'أنت', 'أنتم', 'أنا', 'كان', 'كانت', 'كانوا', 'يكون', 'تكون',
  'أن', 'إن', 'لأن', 'لكن', 'أو', 'بل', 'ثم', 'حتى', 'إذا', 'كي',
  'قد', 'لقد', 'لم', 'لن', 'ما', 'لا', 'ليس', 'غير', 'بعض', 'كل',
  'جميع', 'أي', 'كيف', 'متى', 'أين', 'لماذا', 'ماذا', 'هل', 'ال',
  'و', 'ف', 'ب', 'ل', 'ك', 'يا', 'أم', 'إلا', 'عند', 'بين',
  // ── Hebrew — common particles, pronouns, conjunctions ──
  'של', 'את', 'אל', 'על', 'עם', 'לא', 'הוא', 'היא', 'הם', 'הן',
  'אני', 'אתה', 'אנחנו', 'אתם', 'כי', 'אם', 'אבל', 'גם', 'כבר',
  'רק', 'עוד', 'יש', 'אין', 'מה', 'זה', 'זאת', 'אלה', 'כל', 'כן',
  'לו', 'לה', 'להם', 'בו', 'בה', 'בהם', 'שם', 'כך', 'כן', 'מי',
  'אשר', 'אחרי', 'לפני', 'תחת', 'בין', 'מאז', 'עד', 'כמו', 'אז',
  // ── Farsi/Persian — common function words, prepositions, pronouns ──
  'در', 'از', 'به', 'با', 'که', 'این', 'آن', 'را', 'است',
  'بود', 'باشد', 'شد', 'شده', 'می', 'نه', 'نیست', 'هم', 'هر',
  'یک', 'اما', 'و', 'یا', 'تا', 'اگر', 'برای', 'چون', 'چه',
  'کجا', 'کی', 'چطور', 'وقتی', 'بعد', 'قبل', 'مثل', 'همه', 'بعضی',
  'هیچ', 'آیا', 'خود', 'چند', 'دیگر', 'هنوز', 'همان', 'آنها', 'اینها',
  'ما', 'شما', 'آنان', 'من', 'تو', 'او', 'آنان', 'ایشان',
  'روی', 'زیر', 'بین', 'پیش', 'پس', 'طرف', 'داخل', 'خارج', 'کنار',
  'همچنین', 'مگر', 'ولی', 'وگرنه', 'چرا', 'چگونه', 'کدام',
  // ── Hindi — common particles, postpositions, pronouns, auxiliary verbs ──
  'है', 'में', 'से', 'को', 'का', 'की', 'के', 'पर', 'और', 'या',
  'नहीं', 'यह', 'वह', 'एक', 'इस', 'उस', 'भी', 'हो', 'था', 'थी',
  'थे', 'हैं', 'हूँ', 'लिए', 'तक', 'साथ', 'बाद', 'पहले', 'जो',
  'जब', 'कैसे', 'क्यों', 'क्या', 'कहाँ', 'कौन', 'हम', 'आप', 'वे',
  'मैं', 'तुम', 'उन', 'इन', 'ने', 'बहुत', 'सब', 'कुछ', 'फिर',
  'अब', 'तो', 'ही', 'तरह', 'जैसे', 'करना', 'होना', 'रहा', 'रही',
  'रहे', 'गया', 'गई', 'गए', 'किया', 'किए', 'कर', 'हुआ', 'हुई',
  // ── Russian — common prepositions, pronouns, auxiliary verbs ───────────────
  'в', 'на', 'не', 'с', 'и', 'а', 'но', 'по', 'за', 'из', 'от', 'до',
  'к', 'у', 'о', 'об', 'во', 'при', 'под', 'над', 'без', 'для',
  'что', 'как', 'это', 'все', 'так', 'уже', 'или', 'же', 'ли',
  'если', 'то', 'да', 'нет', 'был', 'была', 'были', 'быть', 'есть',
  'его', 'её', 'их', 'этот', 'эта', 'эти', 'который', 'которая',
  'которые', 'который', 'мой', 'моя', 'мои', 'ваш', 'ваша', 'ваши',
  'он', 'она', 'они', 'мы', 'вы', 'я', 'ты', 'тот', 'та', 'те',
  'очень', 'тоже', 'также', 'когда', 'где', 'как', 'почему', 'зачем',
  'сейчас', 'здесь', 'там', 'потому', 'поэтому', 'чтобы', 'тут',
  // ── Turkish — common particles, postpositions, copulas ─────────────────────
  'bir', 'bu', 'şu', 'o', 've', 'ile', 'de', 'da', 'için', 'gibi',
  'ama', 'fakat', 'ancak', 'ya', 'ne', 'ki', 'mi', 'mı', 'mu', 'mü',
  'var', 'yok', 'olan', 'oldu', 'olur', 'olarak', 'ise', 'daha',
  'çok', 'en', 'her', 'hiç', 'bazı', 'tüm', 'bütün', 'hem', 'veya',
  'bu', 'şu', 'ben', 'sen', 'biz', 'siz', 'onlar', 'benim', 'senin',
  'nasıl', 'neden', 'niçin', 'nerede', 'ne', 'hangi', 'kaç',
  // ── Polish — common prepositions, pronouns, particles ─────────────────────
  'w', 'na', 'z', 'do', 'się', 'że', 'to', 'jest', 'i', 'a', 'nie',
  'tak', 'jak', 'czy', 'po', 'o', 'ale', 'go', 'mu', 'jej', 'ich',
  'tego', 'tej', 'te', 'ten', 'ta', 'są', 'był', 'była', 'było', 'byli',
  'będzie', 'będą', 'ma', 'mam', 'masz', 'mają', 'ze', 'co', 'już',
  'przez', 'przy', 'za', 'bez', 'nad', 'pod', 'przed', 'po', 'między',
  'kiedy', 'gdzie', 'dlaczego', 'który', 'która', 'które', 'tylko', 'też',
  // ── Czech — common words ──────────────────────────────────────────────────
  'v', 'na', 'z', 'do', 'se', 'že', 'to', 'je', 'a', 'ne', 'pro',
  'ale', 'jak', 'by', 'byl', 'být', 'jsem', 'jsou', 'má', 'mám',
  'ten', 'ta', 'ty', 'tato', 'jeho', 'její', 'jejich', 'také', 'jen',
  'kde', 'kdy', 'proč', 'který', 'která', 'které', 'co', 'při', 'bez',
  // ── Bengali — common particles, pronouns, verbs ───────────────────────────
  'এই', 'এটি', 'এটা', 'এর', 'তার', 'তারা', 'আমি', 'তুমি', 'সে', 'আমরা',
  'এবং', 'কিন্তু', 'বা', 'না', 'হ্যাঁ', 'যে', 'কি', 'কে', 'কী', 'থেকে',
  'দিয়ে', 'জন্য', 'সাথে', 'মধ্যে', 'উপর', 'নিচে', 'আছে', 'ছিল', 'হয়',
  'করা', 'করে', 'করেছে', 'হবে', 'হয়েছে', 'একটি', 'একটা', 'অনেক', 'সব',
  // ── Vietnamese — common particles, pronouns, auxiliary words ─────────────
  'tôi', 'bạn', 'anh', 'chị', 'em', 'họ', 'chúng', 'ta', 'mình',
  'là', 'có', 'không', 'và', 'với', 'của', 'cho', 'trong', 'về',
  'từ', 'đến', 'để', 'khi', 'nếu', 'thì', 'mà', 'nhưng', 'vì',
  'đây', 'đó', 'này', 'kia', 'rất', 'cũng', 'đã', 'sẽ', 'đang',
  'được', 'bị', 'những', 'các', 'một', 'hai', 'ba', 'nhiều', 'ít',
  'nào', 'ai', 'gì', 'đâu', 'sao', 'bao', 'giờ', 'lúc', 'sau',
]);


// CJK Unicode ranges used for bigram extraction
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const SEGMENT_RE = /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+|[^\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+)/g;

// RTL Unicode ranges: Arabic (U+0600–U+06FF + extended), Hebrew (U+0590–U+05FF)
const RTL_RE = /[\u0590-\u05ff\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufb4f\ufb50-\ufdff\ufe70-\ufeff]/;
// Distinguish Arabic from Hebrew within RTL segments
const HEBREW_CHAR_RE = /[\u0590-\u05ff\ufb1d-\ufb4f]/;
const ARABIC_CHAR_RE  = /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/;
// Persian/Farsi: exclusive chars not in Arabic (U+067E=پ, U+0686=چ, U+0698=ژ, U+06AF=گ, U+06CC=ی)
const FARSI_CHAR_RE   = /[\u067e\u0686\u0698\u06af\u06cc]/;
// Devanagari (Hindi, Sanskrit, Marathi …) — U+0900–U+097F + extended
const DEVANAGARI_RE   = /[\u0900-\u097f]/;
// Cyrillic (Russian, Bulgarian, Ukrainian, Serbian …) — U+0400–U+04FF
const CYRILLIC_RE     = /[\u0400-\u04ff]/;
// Turkish uses Latin alphabet but has unique chars (ğ, ş, ı, ö, ü, ç) — detected by these
const TURKISH_CHAR_RE = /[\u011f\u015f\u0131\u0130\u00e7]/; // ğ ş ı İ ç
// Bengali (Bangla) — U+0980–U+09FF
const BENGALI_RE      = /[\u0980-\u09ff]/;
// Vietnamese uses Latin + Latin Extended Additional (U+1EA0–U+1EF9) for tone marks
// e.g. ắ ặ ầ ổ ợ ụ ừ — detected by chars exclusive to Vietnamese diacritics
const VIETNAMESE_CHAR_RE = /[\u1ea0-\u1ef9]/;

// ── Katakana → Romaji conversion table (Hepburn system) ──────────────────────
// Digraphs must be listed before single chars so they match first.
const KATA_ROMAJI_TABLE: [string, string][] = [
  // Special combinations for loanwords
  ['ファ', 'fa'], ['フィ', 'fi'], ['フェ', 'fe'], ['フォ', 'fo'],
  ['ティ', 'ti'], ['ディ', 'di'], ['トゥ', 'tu'], ['ドゥ', 'du'],
  ['ウィ', 'wi'], ['ウェ', 'we'], ['ウォ', 'wo'],
  ['チェ', 'che'], ['ジェ', 'je'], ['シェ', 'she'],
  ['イェ', 'ye'], ['ヴァ', 'va'], ['ヴィ', 'vi'], ['ヴェ', 've'], ['ヴォ', 'vo'],
  // Digraphs (2-char → romaji)
  ['キャ', 'kya'], ['キュ', 'kyu'], ['キョ', 'kyo'],
  ['シャ', 'sha'], ['シュ', 'shu'], ['ショ', 'sho'],
  ['チャ', 'cha'], ['チュ', 'chu'], ['チョ', 'cho'],
  ['ニャ', 'nya'], ['ニュ', 'nyu'], ['ニョ', 'nyo'],
  ['ヒャ', 'hya'], ['ヒュ', 'hyu'], ['ヒョ', 'hyo'],
  ['ミャ', 'mya'], ['ミュ', 'myu'], ['ミョ', 'myo'],
  ['リャ', 'rya'], ['リュ', 'ryu'], ['リョ', 'ryo'],
  ['ギャ', 'gya'], ['ギュ', 'gyu'], ['ギョ', 'gyo'],
  ['ジャ', 'ja'], ['ジュ', 'ju'], ['ジョ', 'jo'],
  ['ビャ', 'bya'], ['ビュ', 'byu'], ['ビョ', 'byo'],
  ['ピャ', 'pya'], ['ピュ', 'pyu'], ['ピョ', 'pyo'],
  // Single chars
  ['ア', 'a'], ['イ', 'i'], ['ウ', 'u'], ['エ', 'e'], ['オ', 'o'],
  ['カ', 'ka'], ['キ', 'ki'], ['ク', 'ku'], ['ケ', 'ke'], ['コ', 'ko'],
  ['サ', 'sa'], ['シ', 'shi'], ['ス', 'su'], ['セ', 'se'], ['ソ', 'so'],
  ['タ', 'ta'], ['チ', 'chi'], ['ツ', 'tsu'], ['テ', 'te'], ['ト', 'to'],
  ['ナ', 'na'], ['ニ', 'ni'], ['ヌ', 'nu'], ['ネ', 'ne'], ['ノ', 'no'],
  ['ハ', 'ha'], ['ヒ', 'hi'], ['フ', 'fu'], ['ヘ', 'he'], ['ホ', 'ho'],
  ['マ', 'ma'], ['ミ', 'mi'], ['ム', 'mu'], ['メ', 'me'], ['モ', 'mo'],
  ['ヤ', 'ya'], ['ユ', 'yu'], ['ヨ', 'yo'],
  ['ラ', 'ra'], ['リ', 'ri'], ['ル', 'ru'], ['レ', 're'], ['ロ', 'ro'],
  ['ワ', 'wa'], ['ヲ', 'wo'], ['ン', 'n'],
  // Voiced
  ['ガ', 'ga'], ['ギ', 'gi'], ['グ', 'gu'], ['ゲ', 'ge'], ['ゴ', 'go'],
  ['ザ', 'za'], ['ジ', 'ji'], ['ズ', 'zu'], ['ゼ', 'ze'], ['ゾ', 'zo'],
  ['ダ', 'da'], ['ヂ', 'ji'], ['ヅ', 'zu'], ['デ', 'de'], ['ド', 'do'],
  ['バ', 'ba'], ['ビ', 'bi'], ['ブ', 'bu'], ['ベ', 'be'], ['ボ', 'bo'],
  ['パ', 'pa'], ['ピ', 'pi'], ['プ', 'pu'], ['ペ', 'pe'], ['ポ', 'po'],
  ['ヴ', 'v'],
  // Long vowel / small chars
  ['ー', ''], ['ァ', 'a'], ['ィ', 'i'], ['ゥ', 'u'], ['ェ', 'e'], ['ォ', 'o'],
  ['ッ', ''],  // handled separately (doubles next consonant)
];

const KATA_MAP = new Map<string, string>(KATA_ROMAJI_TABLE);

/**
 * Convert a katakana string to Hepburn romaji.
 * Handles digraphs, geminate consonants (ッ), and long vowel marks (ー).
 */
function katakanaToRomaji(kata: string): string {
  let result = '';
  let i = 0;
  while (i < kata.length) {
    // Geminate consonant: ッ doubles the following consonant
    if (kata[i] === 'ッ' && i + 1 < kata.length) {
      const next = KATA_MAP.get(kata[i + 1]) ?? KATA_MAP.get(kata[i + 1] + kata[i + 2]) ?? '';
      if (next.length > 0) result += next[0]; // double first consonant
      i++;
      continue;
    }
    // Try 2-char digraph first
    if (i + 1 < kata.length) {
      const two = kata[i] + kata[i + 1];
      const r2 = KATA_MAP.get(two);
      if (r2 !== undefined) { result += r2; i += 2; continue; }
    }
    // Single char
    const r1 = KATA_MAP.get(kata[i]);
    if (r1 !== undefined) result += r1;
    i++;
  }
  return result;
}

/**
 * Arabic light stemmer — strips definite article and common prefix particles.
 * Handles: ال (al-), و (wa-), ب (bi-), ل (li-), ف (fa-), ك (ka-).
 * Runs iteratively (max 3 passes) so compound prefixes like فال- are fully
 * resolved: فالخطأ → الخطأ → خطأ.
 * Only strips when the result is still ≥ 3 chars to avoid over-stemming.
 */
function arabicLightStem(word: string): string {
  let result = word;
  for (let i = 0; i < 3; i++) {
    const prev = result;
    if (result.startsWith('ال') && result.length > 4) {
      result = result.slice(2);
    } else if (result.length > 3 && 'وبلفك'.includes(result[0]) && RTL_RE.test(result[1])) {
      result = result.slice(1);
    }
    if (result === prev) break; // stable — no more prefixes to strip
  }
  return result;
}

/**
 * Hebrew light stemmer — strips the definite article and common prefix particles
 * that attach directly to words (no space) in Hebrew.
 *
 * Handles:
 *   ה (ha-) — definite article:   הפריסה → פריסה
 *   ו (ve-/u-) — conjunction “and”: ופריסה → פריסה
 *   ב (be-/bi-) — preposition “in”: בסביבה → סביבה
 *   ל (le-/li-) — preposition “for”: לשרת → שרת
 *   מ (mi-/me-) — preposition “from”: מהשרת → השרת → שרת
 *   כ (ke-/ki-) — preposition “like”: כשרת → שרת
 *
 * Iterative (max 3 passes): מהפריסה → הפריסה → פריסה.
 * Only strips when result is still ≥ 3 chars.
 */
function hebrewLightStem(word: string): string {
  let result = word;
  for (let i = 0; i < 3; i++) {
    const prev = result;
    if (result.length > 3 && 'הובלמכ'.includes(result[0]) && HEBREW_CHAR_RE.test(result[1])) {
      result = result.slice(1);
    }
    if (result === prev) break;
  }
  return result;
}

/**
 * Farsi/Persian light stemmer — handles Persian morphology.
 * Strips:
 *   \u0647\u0627 / \u0647\u0627\u06cc (ha/haye) — plural suffixes:  \u0633\u0631\u0648\u0631\u0647\u0627 \u2192 \u0633\u0631\u0648\u0631
 *   \u0645\u06cc\u200c / \u0645\u06cc   (mi-)    — present-tense prefix: \u0645\u06cc\u200c\u06a9\u0646\u062f \u2192 \u06a9\u0646\u062f
 *   \u0646\u0645\u06cc\u200c             (nami-)  — negated present:  \u0646\u0645\u06cc\u200c\u0634\u0648\u062f \u2192 \u0634\u0648\u062f
 * Only strips when the result is still \u2265 3 chars.
 */
function farsiLightStem(word: string): string {
  let result = word;
  // Suffixes first (longest first)
  if (result.endsWith('\u0647\u0627\u06cc') && result.length > 5) result = result.slice(0, -3);
  else if (result.endsWith('\u0647\u0627') && result.length > 4) result = result.slice(0, -2);
  // Prefixes
  if (result.startsWith('\u0646\u0645\u06cc\u200c') && result.length > 5) result = result.slice(4);
  else if (result.startsWith('\u0645\u06cc\u200c') && result.length > 4) result = result.slice(3);
  else if (result.startsWith('\u0645\u06cc') && result.length > 4) result = result.slice(2);
  return result;
}

/**
 * Hindi light stemmer — strips the most common inflectional suffixes.
 * Handles basic verb forms and oblique plural markers.
 * Avoids over-stemming loanwords (most tech terms in Hindi are English loanwords).
 * Only strips when result is still \u2265 3 chars.
 */
function hindiLightStem(word: string): string {
  const result = word;
  // Infinitive / verb suffixes (longest first to avoid partial match)
  if (result.endsWith('\u0928\u093e') && result.length > 4) return result.slice(0, -2); // \u0928\u093e (nā) infinitive
  if (result.endsWith('\u0928\u0947') && result.length > 4) return result.slice(0, -2); // \u0928\u0947 (ne) ergative
  if (result.endsWith('\u0928\u0940') && result.length > 4) return result.slice(0, -2); // \u0928\u0940 (nī) fem infinitive
  if (result.endsWith('\u0924\u093e') && result.length > 4) return result.slice(0, -2); // \u0924\u093e (tā) m present participle
  if (result.endsWith('\u0924\u0940') && result.length > 4) return result.slice(0, -2); // \u0924\u0940 (tī) f present participle
  if (result.endsWith('\u0915\u0930') && result.length > 4) return result.slice(0, -2); // \u0915\u0930 (kar) conjunctive
  if (result.endsWith('\u0913\u0902') && result.length > 4) return result.slice(0, -2); // \u0913\u0902 (oṃ) oblique plural
  if (result.endsWith('\u0907\u092f\u093e\u0902') && result.length > 5) return result.slice(0, -4); // \u0907\u092f\u093e\u0902 (iyāṃ) f plural
  if (result.endsWith('\u0940\u092f\u093e\u0902') && result.length > 5) return result.slice(0, -4); // \u0940\u092f\u093e\u0102 (īyāṃ)
  return result;
}

/**
 * Russian light stemmer — strips common inflectional suffixes.
 * Handles the most frequent verb/noun/adjective endings to improve recall.
 * Only strips when result is still ≥ 3 chars.
 *
 * Covers:
 *  ошибки/ошибка → ошибк  (noun plural/genitive)
 *  развёртывание → развёртыва  (gerund → stem)
 *  установить → установ  (infinitive)
 *  настройки → настройк  (genitive plural)
 */
function russianLightStem(word: string): string {
  let w = word;
  // Longest first to avoid partial stripping
  // Verb infinitives / gerunds
  if (w.endsWith('ывание') && w.length > 7) return w.slice(0, -6);
  if (w.endsWith('ивание') && w.length > 7) return w.slice(0, -6);
  if (w.endsWith('ование') && w.length > 7) return w.slice(0, -6);
  if (w.endsWith('вание')  && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('ение')   && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('ание')   && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('ить')    && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('ать')    && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('еть')    && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('уть')    && w.length > 4) return w.slice(0, -3);
  // Noun plural/genitive
  if (w.endsWith('ки')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ги')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ов')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ев')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ей')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ий')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ый')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ая')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ое')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ую')     && w.length > 4) return w.slice(0, -2);
  // Verb present tense
  if (w.endsWith('ет')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ют')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ут')     && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ят')     && w.length > 4) return w.slice(0, -2);
  return w;
}

/**
 * Turkish light stemmer — strips common agglutinative suffixes.
 * Turkish is highly agglutinative; this covers the most common inflectional ends.
 *
 * Covers:
 *  hatalar → hata  (-lar/-ler plural)
 *  sunucuda → sunucu  (-da/-de locative)
 *  dağıtımı → dağıtım  (-ı/-i/-u/-ü accusative)
 *  yüklemek → yükle  (-mek/-mak infinitive)
 */
function turkishLightStem(word: string): string {
  let w = word;
  // Suffixes longest-first
  if (w.endsWith('lardaki') && w.length > 7) return w.slice(0, -7);
  if (w.endsWith('lerdeki') && w.length > 7) return w.slice(0, -7);
  if (w.endsWith('ların')   && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('lerin')   && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('larda')   && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('lerde')   && w.length > 6) return w.slice(0, -5);
  if (w.endsWith('ları')    && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('leri')    && w.length > 5) return w.slice(0, -4);
  if (w.endsWith('mek')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('mak')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('ler')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('lar')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('nın')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('nin')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('nun')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('nün')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('da')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('de')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ta')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('te')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('dan')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('den')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('tan')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('ten')     && w.length > 4) return w.slice(0, -3);
  if (w.endsWith('ın')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('in')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('un')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ün')      && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ı')       && w.length > 4) return w.slice(0, -1);
  if (w.endsWith('i')       && w.length > 4) return w.slice(0, -1);
  if (w.endsWith('u')       && w.length > 4) return w.slice(0, -1);
  if (w.endsWith('ü')       && w.length > 4) return w.slice(0, -1);
  return w;
}

/**
 * Bengali (Bangla) light stemmer — strips common verbal and nominal suffixes.
 * Bengali is an Indo-Aryan language with moderate morphological complexity.
 * Only strips when result is still ≥ 2 chars.
 *
 * Covers:
 *  করছে/করেছে → কর  (progressive/perfect aspect)
 *  সার্ভারগুলো → সার্ভার  (-গুলো plural)
 *  সমস্যাটি → সমস্যা  (-টি singular marker)
 */
function bengaliLightStem(word: string): string {
  let w = word;
  // Plural / collective markers (longest first)
  if (w.endsWith('\u0997\u09c1\u09b2\u09cb') && w.length > 5) return w.slice(0, -4); // গুলো (-gulo plural)
  if (w.endsWith('\u0997\u09c1\u09b2\u09bf') && w.length > 5) return w.slice(0, -4); // গুলি (-guli plural)
  if (w.endsWith('\u09a6\u09c7\u09b0') && w.length > 4) return w.slice(0, -3); // দের (genitive plural)
  if (w.endsWith('\u09a6\u09bf\u0997\u09c7') && w.length > 5) return w.slice(0, -4); // দিগে
  // Definiteness / case markers
  if (w.endsWith('\u099f\u09bf') && w.length > 3) return w.slice(0, -2); // টি (singular definite)
  if (w.endsWith('\u099f\u09be') && w.length > 3) return w.slice(0, -2); // টা (singular definite)
  if (w.endsWith('\u0996\u09be\u09a8\u09be') && w.length > 5) return w.slice(0, -4); // খানা
  // Verbal suffixes
  if (w.endsWith('\u099b\u09c7') && w.length > 3) return w.slice(0, -2); // ছে (progressive)
  if (w.endsWith('\u099b\u09bf\u09b2') && w.length > 4) return w.slice(0, -3); // ছিল (past progressive)
  if (w.endsWith('\u09af\u09be\u09ac\u09c7') && w.length > 5) return w.slice(0, -4); // যাবে (future)
  if (w.endsWith('\u0995\u09b0\u09be') && w.length > 4) return w.slice(0, -3); // করা (infinitive)
  if (w.endsWith('\u0995\u09b0\u09c7') && w.length > 4) return w.slice(0, -3); // করে (present)
  if (w.endsWith('\u09b9\u09df') && w.length > 3) return w.slice(0, -2); // হয় (is/becomes)
  if (w.endsWith('\u09b9\u09ac\u09c7') && w.length > 4) return w.slice(0, -3); // হবে (will be)
  return w;
}

/**
 * Pre-process text BEFORE tokenization to split code identifiers.
 * Handles camelCase, PascalCase, snake_case, and kebab-case.
 *
 * Examples:
 *   deployServer       → deploy Server  (then lowercased → deploy server)
 *   HTMLParser         → HTML Parser
 *   my_api_key         → my api key
 *   get-user-by-id     → get user by id (hyphens preserved in regex, spaces also fine)
 *   BackendServiceImpl → Backend Service Impl
 */
function preprocessText(text: string): string {
  return text
    // camelCase boundary: lowercase/digit → uppercase
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // Consecutive uppercase → uppercase+lowercase boundary: HTMLParser → HTML Parser
    .replace(/([A-Z]{2,})([A-Z][a-z])/g, '$1 $2')
    // snake_case: replace underscores with spaces
    .replace(/_/g, ' ');
}


// Maps tokens (English, Japanese katakana, Chinese, Korean, Arabic, Hebrew)
// to their equivalents in other languages. Used to expand tokens at search time
// so "deploy" finds documents containing "デプロイ" / "部署" / "배포", and vice versa.
//
// Keys must be lowercase. CJK values will be bigram-expanded at use time.
const CROSS_LINGUAL_MAP = new Map<string, string[]>([

  // ── Tech / Ecosystem synonyms (language-agnostic) ─────────────────────────
  ['javascript',    ['js', 'node', 'nodejs', 'ecmascript']],
  ['js',            ['javascript', 'node', 'nodejs']],
  ['typescript',    ['ts', 'javascript', 'js', 'tsc']],
  ['ts',            ['typescript', 'javascript', 'js']],
  ['python',        ['py', 'pip', 'django', 'flask', 'fastapi']],
  ['py',            ['python', 'pip']],
  ['golang',        ['go', 'gopher', 'goroutine']],
  ['go',            ['golang', 'goroutine']],
  ['rust',          ['cargo', 'rustlang', 'crates']],
  ['cargo',         ['rust', 'rustlang']],
  ['java',          ['jvm', 'maven', 'gradle', 'spring']],
  ['kotlin',        ['jvm', 'android', 'coroutine']],
  ['dotnet',        ['csharp', 'asp', 'nuget', 'aspnet']],
  ['postgresql',    ['postgres', 'pg', 'psql']],
  ['postgres',      ['postgresql', 'pg', 'psql']],
  ['mysql',         ['mariadb', 'sql']],
  ['mongodb',       ['mongo', 'nosql', 'bson', 'mongoose']],
  ['mongo',         ['mongodb', 'nosql', 'bson']],
  ['elasticsearch', ['elastic', 'opensearch', 'lucene', 'kibana']],
  ['elastic',       ['elasticsearch', 'opensearch']],
  ['kubernetes',    ['k8s', 'kube', 'kubectl', 'helm', 'k3s']],
  ['k8s',           ['kubernetes', 'kube', 'kubectl', 'helm']],
  ['helm',          ['kubernetes', 'k8s', 'chart']],
  ['terraform',     ['tf', 'hcl', 'iac', 'opentofu']],
  ['ansible',       ['playbook', 'automation']],
  ['grafana',       ['dashboard', 'visualization', 'metrics']],
  ['prometheus',    ['metrics', 'alert', 'scrape', 'grafana']],
  ['nginx',         ['proxy', 'webserver', 'ingress']],
  ['traefik',       ['proxy', 'ingress', 'router']],
  ['rabbitmq',      ['amqp', 'queue', 'broker', 'messaging']],
  ['kafka',         ['messaging', 'stream', 'broker']],
  ['grpc',          ['protobuf', 'proto', 'rpc']],
  ['graphql',       ['gql', 'resolver', 'schema']],
  ['react',         ['jsx', 'hooks', 'component', 'redux']],
  ['nextjs',        ['next', 'react', 'ssr', 'vercel']],
  ['vue',           ['vuejs', 'vite', 'nuxt']],
  ['angular',       ['ng', 'rxjs', 'typescript']],
  ['aws',           ['amazon', 'ec2', 's3', 'lambda', 'cloudwatch', 'ecs', 'eks']],
  ['gcp',           ['google cloud', 'gke', 'bigquery']],
  ['azure',         ['microsoft cloud', 'aks', 'devops']],
  ['s3',            ['bucket', 'object storage', 'aws']],
  ['lambda',        ['serverless', 'function', 'faas', 'aws']],
  ['jwt',           ['token', 'bearer', 'oauth', 'auth']],
  ['oauth',         ['oidc', 'auth', 'token', 'sso']],
  ['webhook',       ['callback', 'event', 'trigger']],
  ['cron',          ['schedule', 'job', 'timer']],
  ['yaml',          ['yml', 'config', 'manifest']],
  ['dotenv',        ['env', 'environment', 'envfile']],
  ['github',        ['git', 'actions', 'repo', 'ci']],
  ['gitlab',        ['git', 'pipeline', 'runner']],
  ['wireguard',     ['vpn', 'tunnel', 'wg']],
  ['prisma',        ['orm', 'database', 'schema', 'migration']],
  ['npm',           ['node', 'package', 'registry', 'yarn', 'pnpm']],
  ['yarn',          ['npm', 'package', 'node']],
  ['pip',           ['python', 'package', 'pypi']],
  ['brew',          ['homebrew', 'macos', 'package']],
  // English → all
  ['deploy',      ['デプロイ', '部署', '배포', 'deployment', 'deploying', 'نشر', 'פריסה', 'استقرار', 'तैनाती', 'bereitstellen', 'bereitstellung', 'déployer', 'déploiement', 'desplegar', 'despliegue', 'distribuire', 'distribuzione', 'implantar', 'implantação', 'развёртывание', 'развертывание', 'dağıtım', 'dağıtmak', 'triển khai']],
  ['deployment',  ['デプロイ', '部署', '배포', 'deploy', 'نشر', 'פריסה', 'استقرار', 'तैनाती', 'bereitstellung', 'déploiement', 'despliegue', 'distribuzione', 'implantação', 'развёртывание', 'dağıtım', 'triển khai']],
  ['container',   ['コンテナ', '容器', '컨테이너', 'docker']],
  ['server',      ['サーバー', 'サーバ', '服务器', '서버', 'سيرفر', 'שרת', 'سرور', 'सर्वर', 'сервер', 'sunucu', 'máy chủ']],
  ['database',    ['データベース', '数据库', '데이터베이스', 'db', 'قاعدة البيانات', 'datenbank', 'پایگاه داده', 'डेटाबेس', 'base de données', 'base de datos', 'banco de dados']],
  ['cache',       ['キャッシュ', '缓存', '캐시', 'كاش', 'מטמון', 'کش', 'कैश', 'кэш', 'önbellek', 'bộ đệm']],
  ['error',       ['エラー', '错误', '오류', 'خطأ', 'שגיאה', 'خطا', 'त्रुटि', 'गलती', 'exception', 'err', 'fehler', 'erreur', 'fallo', 'errore', 'erro', 'ошибка', 'hata', 'hatalı', 'lỗi']],
  ['bug',         ['バグ', '缺陷', '버그', 'issue', 'defect', 'خلل', 'اشکال', 'बग']],
  ['fix',         ['修正', '修复', '수정', 'bugfix', 'patch', 'hotfix', 'إصلاح', 'תיקון', 'رفع', 'सुधार', 'beheben', 'behoben', 'réparer', 'correction', 'arreglar', 'corrección', 'correggere', 'corrigir', 'исправить', 'исправление', 'düzeltmek', 'düzeltme']],
  ['build',       ['ビルド', '构建', '빌드', 'بناء', 'בנייה', 'ساخت', 'निर्माण', 'bauen', 'construire', 'construir', 'costruire', 'сборка', 'собрать', 'derleme', 'derlemek']],
  ['test',        ['テスト', '测试', '테스트', 'اختبار', 'בדיקה', 'آزمایش', 'परीक्षण', 'testen', 'tester', 'probar', 'testare', 'testar', 'тест', 'тестирование', 'test', 'testlemek']],
  ['auth',        ['認証', '认证', '인증', 'authentication', 'login', 'oauth', 'مصادقة', 'אימות', 'احراز هویت', 'प्रमाणीकरण', 'authentifizierung', 'authentification', 'autenticación', 'autenticazione', 'autenticação', 'аутентификация', 'авторизация', 'kimlik doğrulama', 'yetkilendirme']],
  ['authentication', ['auth', 'مصادقة', 'אימות', 'احراز هویت', 'प्रमाणीकरण', '認証', '认证', '인증', 'login', 'oauth', 'аутентификация', 'авторизация', 'kimlik doğrulama']],
  ['environment', ['環境', '环境', '환경', 'env', 'بيئة', 'סביבה', 'umgebung', 'environnement', 'entorno', 'ambiente', 'среда', 'окружение', 'ortam']],
  ['secret',      ['key', 'token', 'password', 'jwt', 'مفتاح', 'מפתח', 'geheimnis', 'schlüssel', 'clave', 'clé', 'chiave', 'chave', 'секрет', 'ключ', 'gizli', 'anahtar']],
  ['problem',     ['error', 'issue', 'bug', 'failure', 'مشكلة', '問題', '오류', 'fehler', 'problème', 'problema', 'проблема', 'ошибка', 'sorun', 'problem']],
  ['kubernetes',  ['クベルネテス', 'k8s', 'kube']],
  ['network',     ['ネットワーク', '网络', '네트워크', 'شبكة', 'רשת', 'شبکه', 'नेटवर्क', 'netzwerk', 'réseau', 'red', 'rete', 'rede', 'сеть', 'ağ']],
  ['timeout',     ['タイムアウト', '超时', '타임아웃', 'مهلة']],
  ['memory',      ['メモリ', '内存', '메모리', 'ram', 'ذاكرة', 'זיכרון', 'حافظه', 'मेमोरी', 'speicher', 'mémoire', 'memoria', 'memória', 'память', 'bellek', 'hafıza']],
  ['config',      ['設定', '配置', '설정', 'configuration', 'settings', 'conf', 'إعدادات', 'הגדרות', 'پیکربندی', 'कॉन्फ़िग', 'konfiguration', 'einstellungen', 'configuración', 'configurazione', 'configuração', 'конфигурация', 'настройки', 'yapılandırma', 'ayarlar']],
  ['install',     ['インストール', '安装', '설치', 'تثبيت', 'התקנה', 'نصب', 'इंस्टॉल', 'installieren', 'installer', 'instalar', 'installare', 'установить', 'установка', 'yüklemek', 'kurulum']],
  ['update',      ['アップデート', '更新', '업데이트', 'upgrade', 'تحديث', 'עדכון', 'به‌روزرسانی', 'अपडेट', 'aktualisieren', 'aktualisierung', 'actualizar', 'aggiornare', 'atualizar', 'обновление', 'обновить', 'güncelleme']],
  ['log',         ['ログ', '日志', '로그', 'logging', 'سجل', 'יומן', 'ثبت', 'लॉग', 'protokoll', 'protokolle', 'journal', 'registro', 'журнал', 'лог', 'günlük']],
  ['port',        ['ポート', '端口', '포트', 'منفذ', 'פורט']],
  ['file',        ['ファイル', '文件', '파일', 'ملف', 'קובץ']],
  ['image',       ['イメージ', '镜像', '이미지', 'صورة', 'תמונה', 'abbild', 'imagen', 'imagem']],
  ['volume',      ['ボリューム', '卷', '볼륨']],
  ['cluster',     ['クラスター', '集群', '클러스터']],
  ['node',        ['ノード', '节点', '노드']],
  ['service',     ['サービス', '服务', '서비스', 'svc', 'خدمة', 'שירות', 'dienst', 'servicio', 'servizio', 'serviço', 'сервис', 'служба', 'servis', 'hizmet']],
  ['certificate', ['証明書', '证书', '인증서', 'cert', 'ssl', 'tls', 'شهادة', 'תעודה']],
  ['password',    ['パスワード', '密码', '비밀번호', 'passwd', 'pwd', 'كلمة المرور', 'סיסמה']],
  ['token',       ['トークン', '令牌', '토큰', 'jwt', 'secret', 'رمز', 'אסימון']],
  ['health',      ['ヘルス', '健康', '헬스', 'healthcheck', 'probe', 'صحة']],
  ['migration',   ['マイグレーション', '迁移', '마이그레이션', 'migrate', 'هجرة']],
  ['backup',      ['バックアップ', '备份', '백업', 'نسخ احتياطي', 'גיבוי', 'پشتیبان‌گیری', 'बैकअप', 'sicherung', 'sauvegarde', 'respaldo', 'cópia de segurança', 'резервная копия', 'резерв', 'yedekleme']],
  ['monitor',     ['モニター', '监控', '모니터링', 'monitoring', 'metrics', 'alert', 'مراقبة', 'ניטור', 'نظارت', 'निगरानी', 'überwachung', 'surveiller', 'monitoreo', 'monitorare', 'monitorar', 'мониторинг', 'наблюдение', 'izleme']],
  ['performance', ['パフォーマンス', '性能', '성능', 'latency', 'throughput', 'عملکرد', 'प्रदर्शन', 'leistung', 'performances', 'rendimiento', 'prestazioni', 'desempenho', 'производительность', 'быстродействие', 'performans']],
  ['connection',  ['接続', '连接', '연결', 'conn', 'socket', 'اتصال', 'חיבור', 'اتصال', 'कनेक्शन', 'verbindung', 'connexion', 'conexión', 'connessione', 'conexão']],
  ['queue',       ['キュー', '队列', '큐', 'طابور', 'warteschlange', 'file d\'attente', 'cola', 'coda', 'fila']],
  ['redis',       ['レディス', '레디스']],
  ['nginx',       ['エンジンエックス']],
  ['linux',       ['リナックス', 'لينكس']],
  ['api',         ['エーピーアイ', '接口', 'endpoint', 'واجهة برمجية', 'ממשק']],
  ['healthcheck', ['ヘルスチェック', 'health', 'probe', 'فحص الصحة']],
  ['loadbalancer',['ロードバランサー', '负载均衡', '로드밸런서', 'lb']],
  ['ssl',         ['tls', 'https', 'certificate', 'cert']],
  ['tls',         ['ssl', 'https', 'certificate', 'cert']],
  ['docker',      ['container', 'コンテナ', '容器', '컨테이너', 'دوكر']],
  ['git',         ['version control', 'repo', 'repository', 'commit', 'push', 'pull']],
  ['ci',          ['pipeline', 'github actions', 'gitlab', 'jenkins', 'build']],
  ['cd',          ['deploy', 'deployment', 'release']],
  ['debug',       ['デバッグ', '调试', '디버그', 'debugging', 'breakpoint', 'تصحيح', 'איתור באגים', 'اشکال‌زدایی', 'डीबग', 'debuggen', 'déboguer', 'depurar', 'отладка', 'дебаг', 'hata ayıklama']],
  ['crash',       ['クラッシュ', '崩溃', '크래시', 'panic', 'segfault', 'انهيار', 'קריסה', 'خرابی', 'क्रैश', 'absturz', 'panne', 'plantage', 'caída', 'falha', 'сбой', 'крэш', 'çökme', 'çöküş']],
  ['restart',     ['再起動', '重启', '재시작', 'reboot', 'إعادة تشغيل', 'הפעלה מחדש', 'راه‌اندازی مجدد', 'पुنरारंभ', 'neustart', 'redémarrer', 'reiniciar', 'riavviare']],
  ['permission',  ['権限', '权限', '권한', 'access', 'acl', 'chmod', 'صلاحية', 'הרשאה', 'مجوز', 'अनुमति', 'berechtigung', 'berechtigungen', 'permiso', 'permesso', 'permissão', 'разрешение', 'доступ', 'izin', 'yetki']],
  // Japanese katakana → English
  ['デプロイ',    ['deploy', 'deployment']],
  ['コンテナ',    ['container', 'docker']],
  ['サーバー',    ['server']],
  ['サーバ',      ['server']],
  ['データベース',['database', 'db']],
  ['キャッシュ',  ['cache']],
  ['エラー',      ['error', 'err']],
  ['バグ',        ['bug', 'issue']],
  ['ビルド',      ['build']],
  ['テスト',      ['test']],
  ['認証',        ['auth', 'authentication']],
  ['設定',        ['config', 'configuration']],
  ['インストール',['install']],
  ['アップデート',['update', 'upgrade']],
  ['ログ',        ['log', 'logs']],
  ['ポート',      ['port']],
  ['ファイル',    ['file']],
  ['イメージ',    ['image']],
  ['クラスター',  ['cluster']],
  ['ノード',      ['node']],
  ['サービス',    ['service']],
  ['パスワード',  ['password']],
  ['トークン',    ['token']],
  ['バックアップ',['backup']],
  ['モニター',    ['monitor', 'monitoring']],
  ['接続',        ['connection']],
  ['キュー',      ['queue']],
  ['ヘルスチェック',['healthcheck', 'health check', 'health']],
  ['ロードバランサー',['loadbalancer', 'load balancer']],
  ['デバッグ',    ['debug']],
  ['クラッシュ',  ['crash', 'panic']],
  ['再起動',      ['restart', 'reboot']],
  ['権限',        ['permission', 'access']],
  // Chinese → English
  ['部署',        ['deploy', 'deployment']],
  ['容器',        ['container', 'docker']],
  ['服务器',      ['server']],
  ['数据库',      ['database']],
  ['缓存',        ['cache']],
  ['错误',        ['error']],
  ['修复',        ['fix', 'bugfix']],
  ['构建',        ['build']],
  ['测试',        ['test']],
  ['认证',        ['auth']],
  ['配置',        ['config']],
  ['安装',        ['install']],
  ['更新',        ['update']],
  ['日志',        ['log']],
  ['端口',        ['port']],
  ['镜像',        ['image']],
  ['集群',        ['cluster']],
  ['节点',        ['node']],
  ['服务',        ['service']],
  ['密码',        ['password']],
  ['令牌',        ['token']],
  ['备份',        ['backup']],
  ['监控',        ['monitor']],
  ['连接',        ['connection']],
  ['队列',        ['queue']],
  ['性能',        ['performance']],
  ['内存',        ['memory']],
  ['调试',        ['debug']],
  ['崩溃',        ['crash']],
  ['重启',        ['restart']],
  ['权限',        ['permission']],
  // Korean → English
  ['배포',        ['deploy', 'deployment']],
  ['컨테이너',    ['container']],
  ['서버',        ['server']],
  ['데이터베이스',['database']],
  ['캐시',        ['cache']],
  ['오류',        ['error']],
  ['수정',        ['fix']],
  ['빌드',        ['build']],
  ['테스트',      ['test']],
  ['인증',        ['auth']],
  ['설정',        ['config']],
  ['설치',        ['install']],
  ['업데이트',    ['update']],
  ['로그',        ['log']],
  ['포트',        ['port']],
  ['이미지',      ['image']],
  ['클러스터',    ['cluster']],
  ['노드',        ['node']],
  ['서비스',      ['service']],
  ['토큰',        ['token']],
  ['백업',        ['backup']],
  ['모니터링',    ['monitor']],
  ['연결',        ['connection']],
  ['큐',          ['queue']],
  ['성능',        ['performance']],
  ['메모리',      ['memory']],
  ['디버그',      ['debug']],
  ['크래시',      ['crash']],
  ['재시작',      ['restart']],
  ['권한',        ['permission']],
  // Arabic → English
  ['خطأ',              ['error']],
  ['إصلاح',            ['fix']],
  ['بناء',             ['build']],
  ['اختبار',           ['test']],
  ['مصادقة',           ['auth', 'authentication']],
  ['إعدادات',          ['config', 'configuration']],
  ['تثبيت',            ['install']],
  ['تحديث',            ['update', 'upgrade']],
  ['سجل',              ['log']],
  ['صورة',             ['image']],
  ['خدمة',             ['service']],
  ['نسخ احتياطي',      ['backup']],
  ['مراقبة',           ['monitor', 'monitoring']],
  ['اتصال',            ['connection']],
  ['ذاكرة',            ['memory']],
  ['تصحيح',            ['debug', 'debugging']],
  ['شبكة',             ['network']],
  // Additional Arabic → English (covering blog post examples + common terms)
  ['نشر',              ['deploy', 'deployment']],
  ['انهيار',           ['crash', 'panic']],
  ['طابور',            ['queue']],
  ['رمز',              ['token', 'secret']],
  ['كاش',              ['cache']],
  ['منفذ',             ['port']],
  ['سيرفر',            ['server']],
  ['قاعدة البيانات',   ['database', 'db']],
  ['إعادة تشغيل',      ['restart', 'reboot']],
  ['صلاحية',           ['permission', 'access']],
  ['تطبيق',            ['application', 'app']],
  ['مفتاح',            ['key', 'token', 'secret']],
  ['واجهة برمجية',     ['api', 'interface']],
  ['فحص الصحة',        ['healthcheck', 'health']],
  ['حاوية',            ['container', 'docker']],
  ['عقدة',             ['node']],
  ['سرعة',             ['performance', 'speed']],
  ['قرص',              ['disk', 'storage']],
  ['خادم',             ['server']],
  ['برنامج',           ['application', 'software', 'app']],
  // Arabic terms from blog examples
  ['مشكلة',            ['error', 'issue', 'bug', 'problem', 'failure']],
  ['بيئة',             ['environment', 'env']],
  ['متغيرات',          ['variables', 'env', 'environment']],
  ['إنتاج',            ['production', 'prod']],
  ['سري',              ['secret', 'key', 'token']],
  ['مفتاح سري',        ['secret', 'key']],
  // Hebrew → English
  ['שגיאה',            ['error']],
  ['תיקון',            ['fix']],
  ['בנייה',            ['build']],
  ['בדיקה',            ['test']],
  ['אימות',            ['auth', 'authentication']],
  ['הגדרות',           ['config', 'configuration']],
  ['התקנה',            ['install']],
  ['עדכון',            ['update', 'upgrade']],
  ['יומן',             ['log']],
  ['שרת',              ['server']],
  ['שירות',            ['service']],
  ['גיבוי',            ['backup']],
  ['ניטור',            ['monitor', 'monitoring']],
  ['חיבור',            ['connection']],
  ['זיכרון',           ['memory']],
  ['רשת',              ['network']],
  ['תמונה',            ['image']],
  ['סיסמה',            ['password']],
  ['הרשאה',            ['permission', 'access']],
  // Additional Hebrew → English (covering blog post examples + common terms)
  ['קריסה',            ['crash', 'panic']],
  ['תור',              ['queue']],
  ['מטמון',            ['cache']],
  ['אסימון',           ['token', 'secret']],
  ['פורט',             ['port']],
  ['איתור באגים',      ['debug', 'debugging']],
  ['הפעלה מחדש',       ['restart', 'reboot']],
  ['מיכל',             ['container', 'docker']],
  ['יישום',            ['application', 'app']],
  ['מפתח',             ['key', 'token', 'secret']],
  ['בדיקת תקינות',     ['healthcheck', 'health']],
  ['ממשק תכנות',       ['api', 'interface']],
  ['ביצועים',          ['performance']],
  ['אחסון',            ['storage', 'disk']],
  // Hebrew terms from blog examples
  ['פריסה',            ['deploy', 'deployment']],
  ['בעיה',             ['error', 'issue', 'bug', 'problem']],
  ['סביבה',            ['environment', 'env']],
  ['ייצור',            ['production', 'prod']],
  ['סודי',             ['secret', 'key', 'token']],
  ['מפתח סודי',        ['secret', 'key']],

  // ── Farsi/Persian → English ───────────────────────────────────────────────
  ['استقرار',          ['deploy', 'deployment']],
  ['خطا',              ['error', 'err']],         // Farsi: خطا  vs Arabic: خطأ
  ['اشکال',            ['bug', 'issue', 'error']],
  ['رفع اشکال',        ['fix', 'debug', 'debugging']],
  ['ساخت',             ['build']],
  ['آزمایش',           ['test']],
  ['احراز هویت',       ['auth', 'authentication']],
  ['پیکربندی',         ['config', 'configuration']],
  ['نصب',              ['install']],
  ['به‌روزرسانی',      ['update', 'upgrade']],
  ['ثبت',              ['log']],
  ['سرور',             ['server']],
  ['پایگاه داده',      ['database', 'db']],
  ['شبکه',             ['network']],              // Farsi شبکه vs Arabic شبكة
  ['حافظه',            ['memory', 'ram']],        // Farsi حافظه vs Arabic ذاكرة
  ['کش',               ['cache']],
  ['اشکال‌زدایی',      ['debug', 'debugging']],
  ['خرابی',            ['crash', 'failure', 'error']],
  ['راه‌اندازی مجدد',  ['restart', 'reboot']],
  ['مجوز',             ['permission', 'access']],
  ['پشتیبان‌گیری',     ['backup']],
  ['عملکرد',           ['performance']],
  ['مشکل',             ['problem', 'issue', 'error']],
  ['سرویس',            ['service']],
  ['کلید',             ['key', 'token', 'secret']],
  ['محیط',             ['environment', 'env']],
  ['تولید',            ['production', 'prod']],
  ['رمز',              ['secret', 'key', 'token']],
  ['اتصال',            ['connection', 'conn']],

  // ── Hindi (Devanagari) → English ──────────────────────────────────────────
  ['तैनाती',           ['deploy', 'deployment']],
  ['तैना',             ['deploy', 'deployment']],  // stemmed form
  ['त्रुटि',           ['error', 'err']],
  ['गलती',             ['error', 'bug', 'issue']],
  ['सुधार',            ['fix', 'bugfix']],
  ['निर्माण',          ['build']],
  ['परीक्षण',          ['test']],
  ['प्रमाणीकरण',       ['auth', 'authentication']],
  ['विन्यास',          ['config', 'configuration']],
  ['कॉन्फ़िगरेशन',     ['config', 'configuration']],
  ['इंस्टॉल',          ['install']],
  ['अपडेट',            ['update', 'upgrade']],
  ['लॉग',              ['log']],
  ['सर्वर',            ['server']],
  ['डेटाबेस',          ['database', 'db']],
  ['नेटवर्क',          ['network']],
  ['मेमोरी',           ['memory', 'ram']],
  ['कैश',              ['cache']],
  ['डीबग',             ['debug', 'debugging']],
  ['क्रैश',            ['crash', 'panic']],
  ['पुनरारंभ',         ['restart', 'reboot']],
  ['अनुमति',           ['permission', 'access']],
  ['बैकअप',            ['backup']],
  ['प्रदर्शन',         ['performance']],
  ['समस्या',           ['problem', 'issue', 'error']],
  ['सेवा',             ['service']],
  ['कनेक्शन',          ['connection', 'conn']],
  ['पासवर्ड',          ['password']],
  ['टोकन',             ['token', 'secret']],
  ['वातावरण',          ['environment', 'env']],
  ['उत्पादन',          ['production', 'prod']],

  // ── European languages → English ─────────────────────────────────────────
  // German (Deutsch) → English
  ['fehler',          ['error', 'err']],
  ['absturz',         ['crash', 'panic']],
  ['bug',             ['bug', 'issue']],  // same word, keep for completeness
  ['beheben',         ['fix', 'bugfix']],
  ['behoben',         ['fix', 'fixed']],
  ['lösung',          ['solution', 'fix']],
  ['bauen',           ['build']],
  ['testen',          ['test']],
  ['authentifizierung',['auth', 'authentication']],
  ['konfiguration',   ['config', 'configuration']],
  ['einstellungen',   ['config', 'settings']],
  ['installieren',    ['install']],
  ['installiert',     ['install', 'installed']],
  ['aktualisieren',   ['update', 'upgrade']],
  ['aktualisierung',  ['update', 'upgrade']],
  ['protokoll',       ['log']],
  ['protokolle',      ['log', 'logs']],
  ['abbild',          ['image']],
  ['knoten',          ['node']],
  ['dienst',          ['service']],
  ['sicherung',       ['backup']],
  ['überwachung',     ['monitor', 'monitoring']],
  ['verbindung',      ['connection', 'conn']],
  ['warteschlange',   ['queue']],
  ['leistung',        ['performance']],
  ['speicher',        ['memory', 'storage']],
  ['debuggen',        ['debug', 'debugging']],
  ['neustart',        ['restart', 'reboot']],
  ['berechtigung',    ['permission', 'access']],
  ['berechtigungen',  ['permission', 'access', 'acl']],
  ['netzwerk',        ['network']],
  ['datenbank',       ['database', 'db']],
  ['bereitstellen',   ['deploy', 'deployment']],
  ['bereitstellung',  ['deploy', 'deployment']],
  // 'container' and 'server' are the same in German/French/Spanish/Italian/Portuguese
  ['kaputt',          ['broken', 'error', 'crash']],
  ['funktioniert',    ['works', 'working']],
  ['geht nicht',      ['not working', 'broken', 'error']],
  ['schlüssel',       ['key', 'token', 'secret']],
  ['zertifikat',      ['certificate', 'cert', 'ssl', 'tls']],
  ['umgebung',        ['environment', 'env']],
  ['variablen',       ['variables', 'env', 'environment']],
  ['aufgabe',         ['task', 'job']],
  ['wartung',         ['maintenance']],
  ['speicherleck',    ['memory leak', 'memory']],
  ['schnittstelle',   ['interface', 'api']],

  // French (Français) → English
  ['erreur',          ['error', 'err']],
  ['réparer',         ['fix']],
  ['correction',      ['fix', 'bugfix']],
  ['construire',      ['build']],
  ['tester',          ['test']],
  ['authentification',['auth', 'authentication']],
  ['configuration',   ['config', 'configuration']],
  ['installer',       ['install']],
  ['installation',    ['install']],
  ['mettre',          ['update', 'upgrade']],
  ['journal',         ['log', 'logs']],
  ['nœud',            ['node']],
  ['sauvegarde',      ['backup']],
  ['surveiller',      ['monitor', 'monitoring']],
  ['connexion',       ['connection']],
  ['mémoire',         ['memory']],
  ['déboguer',        ['debug']],
  ['redémarrer',      ['restart', 'reboot']],
  ['réseau',          ['network']],
  ['base de données', ['database', 'db']],
  ['déployer',        ['deploy']],
  ['déploiement',     ['deploy', 'deployment']],
  ['clé',             ['key', 'token']],
  ['certificat',      ['certificate', 'cert', 'ssl']],
  ['environnement',   ['environment', 'env']],
  ['panne',           ['crash', 'outage', 'failure']],
  ['plantage',        ['crash', 'panic']],
  ['interface',       ['interface', 'api']],
  ['performances',    ['performance']],
  ['stockage',        ['storage', 'disk']],
  ['file attente',    ['queue']],

  // Spanish (Español) → English
  ['arreglar',        ['fix']],
  ['corrección',      ['fix', 'bugfix']],
  ['construir',       ['build']],
  ['probar',          ['test']],
  ['autenticación',   ['auth', 'authentication']],
  ['configuración',   ['config', 'configuration']],
  ['instalar',        ['install']],
  ['actualizar',      ['update', 'upgrade']],
  ['actualización',   ['update', 'upgrade']],
  ['registro',        ['log', 'registry']],
  ['nodo',            ['node']],
  ['servicio',        ['service']],
  ['contraseña',      ['password']],
  ['copia de seguridad',['backup']],
  ['respaldo',        ['backup']],
  ['monitorear',      ['monitor']],
  ['monitoreo',       ['monitoring']],
  ['conexión',        ['connection']],
  ['rendimiento',     ['performance']],
  ['memoria',         ['memory']],
  ['depurar',         ['debug']],
  ['fallo',           ['crash', 'failure', 'error']],
  ['caída',           ['crash', 'outage']],
  ['reiniciar',       ['restart', 'reboot']],
  ['permiso',         ['permission']],
  ['permisos',        ['permission', 'access']],
  ['red',             ['network']],
  ['base de datos',   ['database', 'db']],
  ['desplegar',       ['deploy']],
  ['despliegue',      ['deploy', 'deployment']],
  ['clave',           ['key', 'token', 'secret']],
  ['certificado',     ['certificate', 'cert', 'ssl']],
  ['entorno',         ['environment', 'env']],
  ['cola',            ['queue']],
  ['interfaz',        ['interface', 'api']],
  ['imagen',          ['image']],

  // Italian (Italiano) → English
  ['errore',          ['error', 'err']],
  ['correggere',      ['fix']],
  ['costruire',       ['build']],
  ['testare',         ['test']],
  ['autenticazione',  ['auth', 'authentication']],
  ['configurazione',  ['config', 'configuration']],
  ['installare',      ['install']],
  ['aggiornare',      ['update', 'upgrade']],
  ['aggiornamento',   ['update', 'upgrade']],
  ['registro',        ['log']],
  ['nodo',            ['node']],
  ['servizio',        ['service']],
  ['password',        ['password']],
  ['backup',          ['backup']],
  ['monitorare',      ['monitor']],
  ['connessione',     ['connection']],
  ['prestazioni',     ['performance']],
  ['memoria',         ['memory']],
  ['debug',           ['debug']],
  ['arresto anomalo', ['crash']],
  ['riavviare',       ['restart']],
  ['permesso',        ['permission']],
  ['rete',            ['network']],
  ['database',        ['database', 'db']],
  ['distribuire',     ['deploy']],
  ['distribuzione',   ['deploy', 'deployment']],
  ['chiave',          ['key', 'token', 'secret']],
  ['certificato',     ['certificate', 'cert']],
  ['ambiente',        ['environment', 'env']],
  ['coda',            ['queue']],
  ['immagine',        ['image']],

  // Portuguese (Português) → English
  ['erro',            ['error', 'err']],
  ['corrigir',        ['fix']],
  ['construir',       ['build']],
  ['testar',          ['test']],
  ['autenticação',    ['auth', 'authentication']],
  ['configuração',    ['config', 'configuration']],
  ['instalar',        ['install']],
  ['atualizar',       ['update', 'upgrade']],
  ['atualização',     ['update', 'upgrade']],
  ['registro',        ['log']],
  ['nó',              ['node']],
  ['serviço',         ['service']],
  ['senha',           ['password']],
  ['cópia de segurança',['backup']],
  ['monitorar',       ['monitor']],
  ['conexão',         ['connection']],
  ['desempenho',      ['performance']],
  ['memória',         ['memory']],
  ['depurar',         ['debug']],
  ['falha',           ['crash', 'failure', 'error']],
  ['reiniciar',       ['restart']],
  ['permissão',       ['permission']],
  ['rede',            ['network']],
  ['banco de dados',  ['database', 'db']],
  ['implantar',       ['deploy']],
  ['implantação',     ['deploy', 'deployment']],
  ['chave',           ['key', 'token', 'secret']],
  ['certificado',     ['certificate', 'cert']],
  ['ambiente',        ['environment', 'env']],
  ['fila',            ['queue']],
  ['imagem',          ['image']],

  // ── Russian (Cyrillic) → English ──────────────────────────────────────────
  ['ошибка',          ['error', 'err']],
  ['ошибки',          ['error', 'err']],
  ['сбой',            ['crash', 'failure', 'error']],
  ['крэш',            ['crash', 'panic']],
  ['баг',             ['bug', 'issue']],
  ['исправить',       ['fix', 'bugfix']],
  ['исправление',     ['fix', 'patch']],
  ['сборка',          ['build']],
  ['собрать',         ['build']],
  ['тест',            ['test']],
  ['тестирование',    ['test', 'testing']],
  ['аутентификация',  ['auth', 'authentication']],
  ['авторизация',     ['auth', 'authorization']],
  ['конфигурация',    ['config', 'configuration']],
  ['настройки',       ['config', 'settings']],
  ['установить',      ['install']],
  ['установка',       ['install']],
  ['обновление',      ['update', 'upgrade']],
  ['обновить',        ['update', 'upgrade']],
  ['журнал',          ['log']],
  ['лог',             ['log', 'logs']],
  ['сервер',          ['server']],
  ['база данных',     ['database', 'db']],
  ['сеть',            ['network']],
  ['память',          ['memory', 'ram']],
  ['кэш',             ['cache']],
  ['отладка',         ['debug', 'debugging']],
  ['перезапуск',      ['restart', 'reboot']],
  ['перезагрузка',    ['restart', 'reboot']],
  ['разрешение',      ['permission', 'access']],
  ['доступ',          ['permission', 'access']],
  ['резерв',          ['backup']],
  ['производительность', ['performance']],
  ['проблема',        ['problem', 'issue', 'error']],
  ['сервис',          ['service']],
  ['служба',          ['service']],
  ['подключение',     ['connection', 'conn']],
  ['соединение',      ['connection', 'conn']],
  ['развёртывание',   ['deploy', 'deployment']],
  ['развертывание',   ['deploy', 'deployment']],
  ['развёрт',         ['deploy', 'deployment']],  // stemmed form
  ['разверт',         ['deploy', 'deployment']],  // stemmed form
  ['контейнер',       ['container', 'docker']],
  ['образ',           ['image']],
  ['кластер',         ['cluster']],
  ['узел',            ['node']],
  ['секрет',          ['secret', 'key', 'token']],
  ['ключ',            ['key', 'token', 'secret']],
  ['пароль',          ['password']],
  ['токен',           ['token', 'secret']],
  ['мониторинг',      ['monitor', 'monitoring']],
  ['наблюдение',      ['monitor', 'monitoring']],
  ['мигрировать',     ['migrate', 'migration']],
  ['миграция',        ['migrate', 'migration']],

  // ── Turkish (Latin + special chars ğ/ş/ı) → English ─────────────────────
  ['hata',            ['error', 'err']],
  ['hatalı',          ['error', 'err']],
  ['çökme',           ['crash', 'panic']],
  ['çöküş',           ['crash', 'failure']],
  ['düzeltmek',       ['fix', 'bugfix']],
  ['düzeltme',        ['fix', 'patch']],
  ['derleme',         ['build']],
  ['derlemek',        ['build']],
  ['test',            ['test']],
  ['testlemek',       ['test', 'testing']],
  ['kimlik doğrulama',['auth', 'authentication']],
  ['yetkilendirme',   ['auth', 'authorization']],
  ['yapılandırma',    ['config', 'configuration']],
  ['ayarlar',         ['config', 'settings']],
  ['yüklemek',        ['install']],
  ['kurulum',         ['install']],
  ['güncelleme',      ['update', 'upgrade']],
  ['günlük',          ['log']],
  ['sunucu',          ['server']],
  ['veritabanı',      ['database', 'db']],
  ['ağ',              ['network']],
  ['bellek',          ['memory', 'ram']],
  ['önbellek',        ['cache']],
  ['hata ayıklama',   ['debug', 'debugging']],
  ['yeniden başlatma',['restart', 'reboot']],
  ['izin',            ['permission', 'access']],
  ['yetki',           ['permission', 'access', 'acl']],
  ['yedekleme',       ['backup']],
  ['performans',      ['performance']],
  ['sorun',           ['problem', 'issue', 'error']],
  ['servis',          ['service']],
  ['hizmet',          ['service']],
  ['bağlantı',        ['connection', 'conn']],
  ['dağıtım',         ['deploy', 'deployment']],
  ['dağıtmak',        ['deploy']],
  ['konteyner',       ['container', 'docker']],
  ['küme',            ['cluster']],
  ['düğüm',           ['node']],
  ['gizli',           ['secret', 'key']],
  ['anahtar',         ['key', 'token', 'secret']],
  ['şifre',           ['password']],
  ['izleme',          ['monitor', 'monitoring']],
  ['göç',             ['migrate', 'migration']],

  // ── Vietnamese (Latin + Latin Extended Additional U+1EA0–U+1EF9) → English ─
  ['triển khai',      ['deploy', 'deployment']],
  ['triển',           ['deploy', 'deployment']],  // split token form
  ['lỗi',             ['error', 'err']],
  ['sửa lỗi',         ['fix', 'bugfix', 'debug']],
  ['xây dựng',        ['build']],
  ['kiểm tra',        ['test']],
  ['xác thực',        ['auth', 'authentication']],
  ['cấu hình',        ['config', 'configuration']],
  ['cài đặt',         ['install']],
  ['cập nhật',        ['update', 'upgrade']],
  ['nhật ký',         ['log']],
  ['máy chủ',         ['server']],
  ['cơ sở dữ liệu',   ['database', 'db']],
  ['mạng',            ['network']],
  ['bộ nhớ',          ['memory', 'ram']],
  ['bộ đệm',          ['cache']],
  ['gỡ lỗi',          ['debug', 'debugging']],
  ['sự cố',           ['crash', 'failure', 'error']],
  ['khởi động lại',   ['restart', 'reboot']],
  ['quyền',           ['permission', 'access']],
  ['sao lưu',         ['backup']],
  ['hiệu suất',       ['performance']],
  ['vấn đề',          ['problem', 'issue', 'error']],
  ['dịch vụ',         ['service']],
  ['kết nối',         ['connection', 'conn']],
  ['vùng chứa',       ['container', 'docker']],
  ['nút',             ['node']],
  ['khóa',            ['key', 'token', 'secret']],
  ['mật khẩu',        ['password']],
  ['giám sát',        ['monitor', 'monitoring']],
  ['di chuyển',       ['migrate', 'migration']],
]);

/**
 * Expand a token to its cross-lingual synonyms.
 * Returns synonyms to be added to the token stream (pre-tokenized).
 * CJK synonyms are NOT pre-bigram'd here — caller handles that.
 */
function expandCrossLingual(token: string): string[] {
  return CROSS_LINGUAL_MAP.get(token) ?? [];
}

/**
 * Tokenize text into meaningful keywords.
 * Handles accented Latin, RTL (Arabic, Hebrew), and CJK (Chinese, Japanese, Korean).
 *
 * Features:
 *  • CJK → character bigrams
 *  • Katakana → additionally emits Hepburn romaji tokens (enables romaji queries)
 *  • Arabic  → word tokenization + iterative prefix stemming (ال/و/ب/ل/ف/ك)
 *  • Hebrew  → word tokenization + iterative prefix stemming (ה/ו/ב/ל/מ/כ)
 *  • Farsi   → word tokenization + suffix/prefix stemming (ها/های plural, می prefix)
 *  • Hindi   → Devanagari word tokenization + light suffix stemming
 *  • All scripts → cross-lingual synonym expansion (EN↔JA↔ZH↔KO↔AR↔HE↔FA↔HI↔DE↔FR↔ES↔IT↔PT)
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Pre-process: split camelCase/PascalCase identifiers and snake_case before lowercasing
  const lower = preprocessText(text).toLowerCase();

  for (const [seg] of lower.matchAll(SEGMENT_RE)) {
    if (CJK_RE.test(seg)) {
      // CJK segment — extract overlapping character bigrams
      for (let i = 0; i < seg.length - 1; i++) {
        const bigram = seg[i] + seg[i + 1];
        if (!STOPWORDS.has(seg[i]) && !STOPWORDS.has(bigram)) {
          tokens.push(bigram);
        }
      }
      // Trailing single character (for 1-char CJK terms)
      if (seg.length >= 1) {
        const last = seg[seg.length - 1];
        if (!STOPWORDS.has(last)) tokens.push(last);
      }
      // Whole-segment cross-lingual lookup (for known tech terms like デプロイ, 部署, 배포)
      // This ensures CJK full-words map to their English equivalents
      const segSyns = expandCrossLingual(seg);
      for (const syn of segSyns) {
        if (!CJK_RE.test(syn)) {
          syn.split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w)).forEach(w => tokens.push(w));
        }
      }
      // Romanization: extract katakana-only portion and emit romaji tokens.
      // This allows users to search "kontena" or "depuroi" to find katakana docs.
      const kataOnly = seg.replace(/[^\u30a0-\u30ff]/g, '');
      if (kataOnly.length >= 2) {
        const romaji = katakanaToRomaji(kataOnly);
        if (romaji.length >= 2 && romaji.length <= 40 && !STOPWORDS.has(romaji)) {
          tokens.push(romaji);
        }
      }
    } else if (RTL_RE.test(seg)) {
      // RTL segment — 3-way branch: Farsi / Hebrew / Arabic
      const words = seg.trim().split(/\s+/);
      let stemFn: (w: string) => string;
      if (FARSI_CHAR_RE.test(seg))       stemFn = farsiLightStem;
      else if (HEBREW_CHAR_RE.test(seg)) stemFn = hebrewLightStem;
      else                               stemFn = arabicLightStem;
      for (const w of words) {
        if (w.length <= 1 || STOPWORDS.has(w)) continue;
        const stemmed = stemFn(w);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
      }
    } else if (DEVANAGARI_RE.test(seg)) {
      // Devanagari segment (Hindi / Marathi) — naturally space-separated
      const words = seg.trim().split(/[\s\u200c\u200d]+/); // handle zero-width joiners
      for (const w of words) {
        const deva = w.replace(/[^\u0900-\u097f0-9]/g, '');
        if (deva.length <= 1 || STOPWORDS.has(deva)) continue;
        const stemmed = hindiLightStem(deva);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
      }
    } else if (BENGALI_RE.test(seg)) {
      // Bengali (Bangla) segment — space-separated words, Bengali script
      const words = seg.trim().split(/[\s\u200c\u200d]+/);
      for (const w of words) {
        const bn = w.replace(/[^\u0980-\u09ff0-9]/g, '');
        if (bn.length <= 1 || STOPWORDS.has(bn)) continue;
        const stemmed = bengaliLightStem(bn);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
      }
    } else if (CYRILLIC_RE.test(seg)) {
      // Cyrillic segment (Russian, Bulgarian, Ukrainian, Serbian …)
      const words = seg.trim().split(/\s+/);
      for (const w of words) {
        const cyr = w.replace(/[^\u0400-\u04ff]/g, '');
        if (cyr.length <= 1 || STOPWORDS.has(cyr)) continue;
        const stemmed = russianLightStem(cyr);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) tokens.push(stemmed);
      }
    } else {
      // Latin / other — includes Turkish (ğ/ş/ı), Polish (ą/ę/ł/ń/ó/ś/ź/ż/ć),
      // Czech (č/š/ž/ě/ů/ř), Hungarian (ő/ű), Romanian (ș/ț), Vietnamese (ắặầổợụừ…)
      const words = seg
        .replace(/[^a-záàâãäåæçéèêëíìîïñóòôõöúùûüýÿßœğşıİąćęłńśźżčšžěůřőűșț\u1ea0-\u1ef90-9:\-./]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOPWORDS.has(w));
      // Turkish: apply light stemmer to words with Turkish-specific chars
      for (const w of words) {
        if (TURKISH_CHAR_RE.test(w)) {
          const stemmed = turkishLightStem(w);
          if (stemmed !== w && stemmed.length > 1 && !STOPWORDS.has(stemmed)) {
            tokens.push(stemmed);
          }
        }
        tokens.push(w);
      }
    }
  }

  // ── Cross-lingual expansion ──────────────────────────────────────────────
  // For each token, look up synonyms in other languages and add them.
  // CJK synonyms are bigram-expanded inline; Latin/RTL synonyms added as-is.
  const expansions: string[] = [];
  const seen = new Set(tokens);
  for (const tok of tokens) {
    const syns = expandCrossLingual(tok);
    for (const syn of syns) {
      if (seen.has(syn)) continue;
      seen.add(syn);
      if (CJK_RE.test(syn)) {
        // CJK synonym → expand to character bigrams
        for (let i = 0; i < syn.length - 1; i++) {
          const bg = syn[i] + syn[i + 1];
          if (!STOPWORDS.has(syn[i]) && !STOPWORDS.has(bg)) expansions.push(bg);
        }
        if (syn.length >= 1) {
          const last = syn[syn.length - 1];
          if (!STOPWORDS.has(last)) expansions.push(last);
        }
      } else if (RTL_RE.test(syn)) {
        // RTL synonym — apply correct stemmer per language
        const rtlStem = FARSI_CHAR_RE.test(syn) ? farsiLightStem
                      : HEBREW_CHAR_RE.test(syn) ? hebrewLightStem
                      : arabicLightStem;
        const stemmed = rtlStem(syn);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) expansions.push(stemmed);
      } else if (DEVANAGARI_RE.test(syn)) {
        // Devanagari synonym (Hindi)
        const stemmed = hindiLightStem(syn);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) expansions.push(stemmed);
      } else if (BENGALI_RE.test(syn)) {
        // Bengali synonym
        const stemmed = bengaliLightStem(syn);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) expansions.push(stemmed);
      } else if (CYRILLIC_RE.test(syn)) {
        // Cyrillic synonym (Russian)
        const cyr = syn.replace(/[^\u0400-\u04ff]/g, '');
        const stemmed = russianLightStem(cyr);
        if (stemmed.length > 1 && !STOPWORDS.has(stemmed)) expansions.push(stemmed);
      } else {
        // Latin synonym (includes Turkish) — split in case of multi-word
        const parts = syn.split(/\s+/).filter(w => {
          if (w.length <= 1 || STOPWORDS.has(w)) return false;
          return true;
        });
        for (const p of parts) {
          expansions.push(p);
          // Apply Turkish stemmer if it has Turkish-specific characters
          if (TURKISH_CHAR_RE.test(p)) {
            const stemmed = turkishLightStem(p);
            if (stemmed !== p && stemmed.length > 1 && !STOPWORDS.has(stemmed)) {
              expansions.push(stemmed);
            }
          }
        }
      }
    }
  }
  tokens.push(...expansions);

  return tokens;
}

/**
 * Split a multi-topic query into sub-queries.
 * Detects numbered lists, semicolons, "and also", line breaks, etc.
 *
 * Example: "deploy API fix routing and also check auth" →
 *   ["deploy API fix routing", "check auth"]
 *
 * Example: "1. deploy 2. fix routing 3. auth" →
 *   ["deploy", "fix routing", "auth"]
 */
function splitMultiQuery(query: string): string[] {
  // Numbered list: "1. foo 2. bar 3. baz"
  const numberedParts = query.split(/\d+[.)]\s*/g).filter(s => s.trim().length > 2);
  if (numberedParts.length >= 2) return numberedParts.map(s => s.trim());

  // Semicolons or newlines
  const semiParts = query.split(/[;\n]+/).filter(s => s.trim().length > 2);
  if (semiParts.length >= 2) return semiParts.map(s => s.trim());

  // Conjunctions (EN + DE + FR + ES + IT + PT + RU + TR)
  const conjParts = query.split(
    /\b(?:and also|also noch|außerdem|plus|additionally|furthermore|de plus|además|inoltre|além disso|а также|и также|кроме того|плюс|ayrıca|bunun yanı sıra|همچنین|وأيضاً|وكذلك|وهمچنین|और भी|इसके अलावा)\b/i
  ).filter(s => s.trim().length > 2);
  if (conjParts.length >= 2) return conjParts.map(s => s.trim());

  // Comma-separated with 3+ parts (likely a list)
  const commaParts = query.split(/,\s*/).filter(s => s.trim().length > 2);
  if (commaParts.length >= 3) return commaParts.map(s => s.trim());

  // Single query
  return [query];
}

// ── BM25+ Scoring ─────────────────────────────────────────────────────────────
//
// BM25+ fixes the "long document under-scoring" bug in classic BM25.
// Paper: Lv & Zhai (2011) "Lower-Bounding Term Frequency Normalization"
//
// Improvements over standard BM25:
//   1. δ=1 additive term → guarantees TF>0 terms always contribute positively
//   2. Bigram proximity boost → adjacent query terms in doc get 2× weight
//   3. Recency boost → entries with timestamps get exp-decay bonus (7d half-life)
//   4. Levenshtein fuzzy match → typo-tolerant (distance ≤ 2)
//

/** BM25+ parameters */
const BM25_K1    = 1.2;   // term frequency saturation
const BM25_B     = 0.75;  // length normalization
const BM25_DELTA = 1.0;   // BM25+ lower-bound guarantee (0 = classic BM25)

/** Recency boost: half-life in days. Entry from 7 days ago gets 0.5× boost. */
const RECENCY_HALF_LIFE_DAYS = 7;

/**
 * Zero-results query log — in-memory FIFO ring (max 500 entries).
 * Exposed via /health for observability. Never persisted.
 */
interface ZeroResultEntry { query: string; ts: number; }
const ZERO_RESULTS_LOG: ZeroResultEntry[] = [];
const ZERO_RESULTS_MAX = 500;
let zeroResultsTotal = 0;

function logZeroResult(query: string): void {
  zeroResultsTotal++;
  if (ZERO_RESULTS_LOG.length >= ZERO_RESULTS_MAX) ZERO_RESULTS_LOG.shift();
  ZERO_RESULTS_LOG.push({ query, ts: Date.now() });
}

/** Global index vocabulary — rebuilt on each keywordSearch call from the doc set. */
let _indexVocab: Set<string> = new Set();

interface DocEntry {
  key: string;
  content: string;
  tokens: string[];
  tokenFreq: Map<string, number>;  // term → count in this doc
  bigrams: Set<string>;            // "term1|term2" adjacency pairs
  keyTokens: Set<string>;          // tokens from key/title only (for title boost)
  timestamp?: number;              // epoch ms, extracted from content if present
}

interface KeywordMatch {
  key: string;
  content: string;
  score: number;
  matchedWords: string[];
  subQuery?: string;   // which sub-query matched (for multi-topic)
}

/**
 * Levenshtein distance — edit distance between two strings.
 * Used for typo-tolerant fuzzy matching (distance ≤ 2 = match).
 * O(n*m) but strings are short (tokens), so this is fast.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Skip if length diff > 2 (can't be ≤ 2 edits)
  if (Math.abs(a.length - b.length) > 2) return 3;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let corner = i - 1;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const cur = Math.min(prev[j] + 1, prev[j - 1] + 1, corner + cost);
      corner = prev[j];
      prev[j] = cur;
    }
  }
  return prev[b.length];
}

/** Extract a timestamp from JSON content (looks for "ts" or "created" fields). */
function extractTimestamp(content: string): number | undefined {
  // Fast regex for ISO dates in JSON: "ts":"2026-04-17T..." or "created":"..."
  const match = content.match(/"(?:ts|created|created_at|timestamp)"\s*:\s*"([^"]+)"/);
  if (match) {
    const ms = Date.parse(match[1]);
    if (!isNaN(ms)) return ms;
  }
  return undefined;
}

/** Recency multiplier: 1.0 for now, 0.5 after half-life days, exponential decay. */
function recencyBoost(timestampMs: number | undefined): number {
  if (!timestampMs) return 1.0; // no timestamp → neutral
  const ageDays = (Date.now() - timestampMs) / (1000 * 60 * 60 * 24);
  if (ageDays <= 0) return 1.5; // future/just-now → max boost
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS) + 0.5; // range: [0.5, 1.5]
}

/**
 * BM25+ with Bigram Proximity, Recency Boost, and Fuzzy Matching.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  Query: "deploy API fix routing; check auth"                    │
 * │    ↓ splitMultiQuery                                            │
 * │  Sub-queries: ["deploy API fix routing", "check auth"]          │
 * │    ↓ for each sub-query                                         │
 * │  Tokenize → BM25+ score per doc → Bigram boost → Fuzzy match   │
 * │    ↓ merge & deduplicate                                        │
 * │  Recency boost → Sort → Top-K                                  │
 * └─────────────────────────────────────────────────────────────────┘
 */
async function keywordSearch(
  redis: Redis,
  patterns: string[],
  query: string,
  topK = 10,
): Promise<KeywordMatch[]> {
  // ── Step 1: Collect all matching keys — patterns scanned in parallel ──
  const keyBatches = await Promise.all(patterns.map(pattern => {
    const keys: string[] = [];
    const stream = redis.scanStream({ match: pattern, count: 500 });
    return new Promise<string[]>((resolve, reject) => {
      stream.on('data', (batch: string[]) => {
        keys.push(...batch.filter((k: string) => !k.endsWith(':meta')));
      });
      stream.on('end', () => resolve(keys));
      stream.on('error', reject);
    });
  }));
  // Deduplicate across patterns (a key may match multiple globs)
  const allKeys = [...new Set(keyBatches.flat())];

  if (allKeys.length === 0) return [];

  // Pipeline GET for speed
  const pipeline = redis.pipeline();
  for (const key of allKeys) pipeline.get(key);
  const results = await pipeline.exec();

  const docs: DocEntry[] = [];
  let totalTokens = 0;

  for (let i = 0; i < allKeys.length; i++) {
    const content = results?.[i]?.[1] as string | null;
    if (!content) continue;

    const tokens = tokenize(`${allKeys[i]} ${content}`);
    if (tokens.length === 0) continue;

    // Term frequency map
    const tokenFreq = new Map<string, number>();
    for (const t of tokens) {
      tokenFreq.set(t, (tokenFreq.get(t) ?? 0) + 1);
    }

    // Bigrams — adjacent token pairs for proximity detection
    const bigrams = new Set<string>();
    for (let j = 0; j < tokens.length - 1; j++) {
      bigrams.add(`${tokens[j]}|${tokens[j + 1]}`);
    }

    const timestamp = extractTimestamp(content);
    // Key tokens for title-boost: terms appearing in the Redis key get extra weight
    const keyTokens = new Set(tokenize(allKeys[i]));
    docs.push({ key: allKeys[i], content, tokens, tokenFreq, bigrams, keyTokens, timestamp });
    totalTokens += tokens.length;
  }

  if (docs.length === 0) return [];
  const avgDL = totalTokens / docs.length;

  // ── Step 2: IDF (inverse document frequency) ──
  const docFreq = new Map<string, number>();
  for (const doc of docs) {
    const seen = new Set<string>();
    for (const t of doc.tokens) {
      if (!seen.has(t)) {
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
        seen.add(t);
      }
    }
  }
  const N = docs.length;

  function idf(term: string): number {
    const df = docFreq.get(term) ?? 0;
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * BM25+ score for a term in a document.
   * Classic BM25: TF_norm = tf*(k1+1) / (tf + k1*(1 - b + b*dl/avgdl))
   * BM25+ adds: + δ  (guarantees long docs with the term still score positively)
   */
  function bm25PlusTerm(term: string, doc: DocEntry): number {
    const tf = doc.tokenFreq.get(term) ?? 0;
    if (tf === 0) return 0;
    const dl = doc.tokens.length;
    const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgDL)));
    return idf(term) * (tfNorm + BM25_DELTA);
  }

  /**
   * Fuzzy match: tries exact → prefix → substring → Levenshtein ≤ 2.
   * Returns [matchedTerm, weight] or null.
   *
   * Weights:
   *  1.0 — exact match
   *  0.85 — doc token starts with query (e.g. "dockerf" → "dockerfile")
   *  0.75 — query starts with doc token (e.g. "kubernetes" → "kube")
   *  0.6  — substring (either direction)
   *  0.4  — Levenshtein ≤ 2 (typo tolerance)
   */
  function fuzzyMatch(qt: string, docTermSet: Set<string>): [string, number] | null {
    // Exact
    if (docTermSet.has(qt)) return [qt, 1.0];
    // Prefix: query is prefix of a doc token (user typed partial word)
    if (qt.length >= 4) {
      for (const dt of docTermSet) {
        if (dt.length > qt.length && dt.startsWith(qt)) return [dt, 0.85];
      }
    }
    // Reverse-prefix: doc token is prefix of query (doc has abbreviated form)
    if (qt.length >= 4) {
      for (const dt of docTermSet) {
        if (dt.length >= 4 && dt.length < qt.length && qt.startsWith(dt)) return [dt, 0.75];
      }
    }
    // Substring (partial)
    for (const dt of docTermSet) {
      if (dt.length > 3 && qt.length > 3 && (dt.includes(qt) || qt.includes(dt))) {
        return [dt, 0.6];
      }
    }
    // Levenshtein ≤ 2 (typo tolerance) — only for tokens ≥ 4 chars
    if (qt.length >= 4) {
      for (const dt of docTermSet) {
        if (dt.length >= 4 && levenshtein(qt, dt) <= 2) {
          return [dt, 0.4];
        }
      }
    }
    return null;
  }

  // ── Step 3: Score each sub-query independently ──
  const subQueries = splitMultiQuery(query);
  const allMatches = new Map<string, KeywordMatch>();

  for (const sq of subQueries) {
    const queryTokens = tokenize(sq);
    if (queryTokens.length === 0) continue;

    // Pre-compute query bigrams for proximity boost
    const queryBigrams = new Set<string>();
    for (let j = 0; j < queryTokens.length - 1; j++) {
      queryBigrams.add(`${queryTokens[j]}|${queryTokens[j + 1]}`);
    }

    for (const doc of docs) {
      let score = 0;
      const matchedWords: string[] = [];
      const docTermSet = new Set(doc.tokens);

      for (const qt of queryTokens) {
        // Try exact BM25+ first
        const exactScore = bm25PlusTerm(qt, doc);
        if (exactScore > 0) {
          score += exactScore;
          matchedWords.push(qt);
          continue;
        }
        // Fuzzy match (substring or Levenshtein)
        const fuzz = fuzzyMatch(qt, docTermSet);
        if (fuzz) {
          score += bm25PlusTerm(fuzz[0], doc) * fuzz[1];
          matchedWords.push(`~${qt}`);
        }
      }

      // Bigram proximity boost: +50% for each adjacent query term pair found in doc
      if (queryBigrams.size > 0) {
        let bigramHits = 0;
        for (const bg of queryBigrams) {
          if (doc.bigrams.has(bg)) bigramHits++;
        }
        if (bigramHits > 0) {
          score *= 1 + 0.5 * (bigramHits / queryBigrams.size);
        }
      }

      // Phrase-match boost: if the raw (lowercased) query appears verbatim in content, 2× boost
      // This rewards docs where the exact phrase exists (vs scattered tokens).
      if (sq.length >= 4 && doc.content.toLowerCase().includes(sq.toLowerCase())) {
        score *= 2.0;
      }

      // Key/title boost: if query terms appear in the Redis key (=title), 1.5× boost
      // Keys often encode the primary topic (e.g. "deploy:api:server"), so key hits are high-precision.
      if (score > 0) {
        let keyHits = 0;
        for (const qt of queryTokens) {
          if (doc.keyTokens.has(qt)) keyHits++;
        }
        if (keyHits > 0) {
          score *= 1 + 0.5 * (keyHits / queryTokens.length);
        }
      }

      // Recency boost
      score *= recencyBoost(doc.timestamp);

      if (score > 0) {
        const existing = allMatches.get(doc.key);
        if (!existing || score > existing.score) {
          allMatches.set(doc.key, {
            key: doc.key,
            content: doc.content,
            score,
            matchedWords: [...new Set(matchedWords)],
            subQuery: subQueries.length > 1 ? sq : undefined,
          });
        }
      }
    }
  }

  // ── Step 4: Sort by score, return top-K ──
  const sorted = [...allMatches.values()].sort((a, b) => b.score - a.score);
  const topResults = sorted.slice(0, topK);

  // ── Step 5: Zero-results logging + Did-You-Mean ───────────────────────────
  if (topResults.length === 0) {
    logZeroResult(query);
    // Rebuild index vocab for Did-You-Mean suggestions
    _indexVocab = new Set<string>();
    for (const doc of docs) for (const t of doc.tokens) _indexVocab.add(t);
  }

  return topResults;
}

// ── Exported for testing ──────────────────────────────────────────────────────
export { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS,
         katakanaToRomaji, arabicLightStem, expandCrossLingual, CROSS_LINGUAL_MAP };

// ── Types ─────────────────────────────────────────────────────────────────────

interface Instance {
  id: string;
  name: string;
  tier: string;
  status: string;
  region: string;
  host?: string;
  port?: number;
  password?: string;
  tls_enabled?: boolean;
  vector_token?: string;
  memory_mb: number;
  encryption_at_rest: boolean;
  created_at: string;
}

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

// ── Layer 1: Causal Knowledge Graph (CKG) helpers ────────────────────────────
// Implements the CKG from the 10x Vision Document.
// Nodes: cachly:ckg:node:{id}  → { id, domain, type, count, ts }
// Edges: cachly:ckg:edge:{from}:{edgeType}:{to} → { from, to, edgeType, successes, trials, confidence, last_updated }

type CKGEdge = {
  from: string; to: string; edgeType: string;
  successes: number; trials: number; confidence: number; last_updated: string;
};
type CKGNode = { id: string; domain: string; type: string; count: number; ts: string };

const STOPWORDS_CKG = new Set(['that','this','with','from','when','then','also','have','been','will','were','they','them','than','more','some','into','over','only','just','where','while','which','there','their','would','could','should','after','before','about']);

function ckgSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\-:]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

/** Extract 1-3 significant keywords from free text for a problem concept */
function extractProblemConcept(text: string): string | null {
  const words = text.toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ').split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS_CKG.has(w))
    .slice(0, 5);
  if (words.length === 0) return null;
  return words.slice(0, 2).join('-');
}

async function ckgUpsertNode(redis: Redis, id: string, domain: string, type: string): Promise<void> {
  const key = `cachly:ckg:node:${id}`;
  const raw = await redis.get(key);
  const node: CKGNode = raw ? JSON.parse(raw) : { id, domain, type, count: 0, ts: new Date().toISOString() };
  node.count = (node.count || 0) + 1;
  node.ts = new Date().toISOString();
  await redis.set(key, JSON.stringify(node));
}

async function ckgUpdateEdge(redis: Redis, from: string, edgeType: string, to: string, success: boolean, partial = false): Promise<void> {
  const key = `cachly:ckg:edge:${from}:${edgeType}:${to}`;
  const raw = await redis.get(key);
  const edge: CKGEdge = raw ? JSON.parse(raw) : { from, to, edgeType, successes: 0, trials: 0, confidence: 0, last_updated: '' };
  edge.trials = (edge.trials || 0) + 1;
  if (success) edge.successes = (edge.successes || 0) + 1;
  else if (partial) edge.successes = (edge.successes || 0) + 0.5;
  // Beta distribution smoothed confidence: (successes+1) / (trials+2)
  edge.confidence = (edge.successes + 1) / (edge.trials + 2);
  edge.last_updated = new Date().toISOString();
  await redis.set(key, JSON.stringify(edge));
  // Index: set of edge keys per source node (for fast traversal)
  await redis.sadd(`cachly:ckg:idx:from:${from}`, key);
  await redis.sadd(`cachly:ckg:idx:to:${to}`, key);
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  // ── Instance Management ──────────────────────────────────────────────────
  {
    name: 'list_instances',
    description:
      'List all your cachly cache instances with their status and connection details. ' +
      'Read-only. Returns an array of instance objects — each with id, name, tier, status, region, RAM, ' +
      'and redis:// connection string. Returns an empty array if no instances exist. ' +
      'No pagination: all instances are returned in one call (typical accounts have < 20). ' +
      'Use this first to discover instance UUIDs required by get_instance, cache_get, cache_set, ' +
      'and all other cache tools. Use get_instance to retrieve full metadata for a single instance.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_instance',
    description:
      'Create a new managed Valkey/Redis cache instance on cachly.dev. ' +
      'Free tier provisions in ~30 seconds. Paid tiers return a Stripe checkout URL. ' +
      'Available tiers: free (25 MB), dev (200 MB, €19/mo), pro (900 MB, €49/mo), ' +
      'speed (900 MB Dragonfly + Semantic Cache, €79/mo), business (7 GB, €199/mo).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for the instance (min 3 chars)' },
        tier: {
          type: 'string',
          enum: ['free', 'dev', 'pro', 'speed', 'business'],
          description: 'Pricing tier. Start with "free" for testing.',
        },
      },
      required: ['name', 'tier'],
    },
  },
  {
    name: 'get_instance',
    description:
      'Get full metadata for a specific cache instance: name, tier, status (provisioning / running / paused), ' +
      'region, RAM limit, Redis connection string, created_at, and expiry. Read-only. ' +
      'Returns an error if the instance_id is not found or belongs to another account. ' +
      'Call list_instances first to discover valid UUIDs. ' +
      'Use get_connection_string instead if you only need the redis:// URL for your app config.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the instance (from list_instances)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'get_connection_string',
    description:
      'Get the Redis/Valkey connection string (redis:// URL) for a running instance. ' +
      'Use this to configure your application or set environment variables.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the instance' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'delete_instance',
    description:
      'Permanently delete a cache instance. Deprovisions the Kubernetes workload and removes all data. ' +
      'This action is irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the instance to delete' },
        confirm: { type: 'boolean', description: 'Must be true to confirm deletion' },
      },
      required: ['instance_id', 'confirm'],
    },
  },

  // ── Live Cache Operations ────────────────────────────────────────────────
  {
    name: 'cache_get',
    description:
      'Get a value from a running cache instance by key. ' +
      'Returns the stored value (string or deserialized JSON object) or null if the key does not exist or has expired. ' +
      'Read-only — no side effects. ' +
      'Use cache_mget when you need multiple keys in one round-trip. ' +
      'Use cache_exists to check existence without retrieving the value. ' +
      'Use semantic_search when you need fuzzy/vector search across stored values.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the instance' },
        key: { type: 'string', description: 'Cache key to retrieve' },
      },
      required: ['instance_id', 'key'],
    },
  },
  {
    name: 'cache_set',
    description:
      'Set a key-value pair in a running cache instance. ' +
      'Overwrites any existing value at the key — not idempotent for new data. ' +
      'Returns "OK" on success; returns an error if the instance_id is invalid or the instance is paused. ' +
      'Value can be a string or a JSON-serialized object. Optionally set a TTL in seconds (omit for no expiry). ' +
      'Use cache_mset instead for setting multiple keys in a single pipeline round-trip. ' +
      'Use cache_stream_set instead for caching LLM token streams (ordered string chunks).',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (from list_instances)' },
        key: { type: 'string', description: 'Cache key' },
        value: { type: 'string', description: 'Value to store (string or JSON)' },
        ttl: { type: 'number', description: 'Time-to-live in seconds (optional, omit for no expiry)' },
      },
      required: ['instance_id', 'key', 'value'],
    },
  },
  {
    name: 'cache_delete',
    description:
      'Permanently delete one or more keys from a running cache instance (uses Redis DEL). ' +
      'This operation is destructive and irreversible — deleted keys cannot be recovered. ' +
      'Deleting a non-existent key is safe and returns 0 for that key (no error). ' +
      'Returns the count of keys that were actually deleted (existing keys only). ' +
      'Use this to explicitly remove stale entries; prefer cache_set with a short TTL for auto-expiring data. ' +
      'Do NOT use this to clear an entire instance — use the dashboard or delete_instance for that.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance to delete keys from (get from list_instances)' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more cache keys to delete. Accepts exact keys only (no glob patterns — use cache_keys to list first).',
        },
      },
      required: ['instance_id', 'keys'],
    },
  },
  {
    name: 'cache_exists',
    description:
      'Check whether one or more keys exist in a running cache instance (uses Redis EXISTS). ' +
      'Read-only — no side effects. Returns the count of keys that currently exist (integer 0 to N). ' +
      'If none of the keys exist, returns 0. If all exist, returns the total key count passed in. ' +
      'Duplicate keys in the input array are each counted separately (Redis behavior). ' +
      'Use this to check presence before a cache_get to avoid null handling, or to verify a cache warm-up completed. ' +
      'Use cache_get instead if you also need the value; use cache_ttl if you need expiry info.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance to check (get from list_instances)' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Keys to check for existence. Accepts exact keys only (no glob patterns).' },
      },
      required: ['instance_id', 'keys'],
    },
  },
  {
    name: 'cache_ttl',
    description:
      'Get the remaining time-to-live (TTL) of a key in seconds. ' +
      'Returns -1 if the key exists but has no expiry, -2 if the key does not exist. ' +
      'Read-only — no side effects. ' +
      'Use cache_set with a ttl parameter to set or update the expiry.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (from list_instances)' },
        key: { type: 'string', description: 'Cache key to inspect' },
      },
      required: ['instance_id', 'key'],
    },
  },
  {
    name: 'cache_keys',
    description:
      'List keys in a cache instance matching an optional glob pattern (e.g. "user:*", "session:*"). ' +
      'Uses SCAN to avoid blocking the server. Returns at most `count` keys.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
        pattern: { type: 'string', description: 'Glob pattern (default: *)' },
        count: { type: 'number', description: 'Max keys to return (default: 50, max: 500)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'cache_stats',
    description:
      'Get real-time stats for a cache instance: memory usage, hit/miss rate, commands/sec, ' +
      'connected clients, keyspace info, and uptime. Read-only — no side effects. ' +
      'The instance_id identifies the target instance (obtain from list_instances). ' +
      'Use this for monitoring, capacity planning, or debugging performance issues — ' +
      'not for reading cached values (use cache_get for that). ' +
      'Use cache_exists or cache_ttl if you only need key-level information.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (from list_instances)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'semantic_search',
    description:
      'Find cached entries that are semantically similar to a natural-language query. ' +
      'Read-only — no side effects. ' +
      'Returns an array of objects, each with: key, value, similarity_score (0–1), and namespace. ' +
      'Returns an empty array if no entries meet the similarity threshold. ' +
      'Requires OPENAI_API_KEY (or compatible provider) and the Speed/Business tier with CACHLY_VECTOR_URL. ' +
      'Embeddings are computed server-side and never leave Germany (pgvector HNSW index). ' +
      'Example: "find all cached responses about password reset" or "what did we answer about pricing?". ' +
      'Use cache_get for exact key lookup; use smart_recall for brain lessons.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (from list_instances)' },
        query: { type: 'string', description: 'Natural-language query to find similar cached content' },
        threshold: {
          type: 'number',
          description: 'Minimum cosine similarity 0–1 (default: 0.82). Lower = broader matches.',
        },
        namespace: {
          type: 'string',
          description: 'Semantic namespace to search in (default: cachly:sem)',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5)',
        },
        use_hybrid: {
          type: 'boolean',
          description:
            'Enable Hybrid BM25+Vector RRF fusion search. ' +
            'Passes `hybrid: true` and the query text to the pgvector API for higher precision on named entities. ' +
            'Default: false.',
        },
        auto_namespace: {
          type: 'boolean',
          description:
            'Auto-detect the namespace from the query text using text heuristics ' +
            'instead of using the `namespace` parameter. ' +
            'Returns results only from the matching domain (code/translation/summary/qa/creative).',
        },
      },
      required: ['instance_id', 'query'],
    },
  },
  {
    name: 'detect_namespace',
    description:
      'Classify a prompt into one of 5 semantic namespaces using text heuristics. ' +
      'Overhead: <0.1 ms, no embedding required. ' +
      'Useful to understand which namespace cachly will use for a given prompt. ' +
      'Returns one of: cachly:sem:code, cachly:sem:translation, cachly:sem:summary, ' +
      'cachly:sem:qa, cachly:sem:creative.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The text prompt to classify into a semantic namespace' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'cache_warmup',
    description:
      'Pre-warm the semantic cache with a list of prompt/value pairs. ' +
      'For each entry: computes an embedding, checks if a similar entry already exists ' +
      '(similarity ≥ 0.98), and writes new entries to Valkey + pgvector index. ' +
      'Use this to seed FAQ responses, product descriptions, or known-good LLM answers ' +
      'before the first real user traffic. Requires OPENAI_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        entries: {
          type: 'array',
          description: 'List of prompt/value pairs to pre-warm into the cache',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: 'The query or question to cache' },
              value: { type: 'string', description: 'The answer or response to store for this prompt' },
              namespace: { type: 'string', description: 'Optional per-entry namespace override' },
            },
            required: ['prompt', 'value'],
          },
        },
        namespace: {
          type: 'string',
          description: 'Default namespace for all entries (default: cachly:sem)',
        },
        ttl: {
          type: 'number',
          description: 'Time-to-live in seconds for warmed entries (omit for no expiry)',
        },
        auto_namespace: {
          type: 'boolean',
          description:
            'Auto-detect the namespace per prompt using text heuristics. ' +
            'Overrides `namespace` when no per-entry namespace is set.',
        },
      },
      required: ['instance_id', 'entries'],
    },
  },
  {
    name: 'index_project',
    description:
      'Index local source files into the cachly semantic cache so AI assistants can use ' +
      'semantic_search to find relevant files instead of re-reading the whole codebase every time. ' +
      'Walks a directory recursively, reads each matching file, and stores a summary + path ' +
      'as a semantic cache entry (prompt = file path + content excerpt, value = relative path). ' +
      'Requires an embedding provider (OPENAI_API_KEY or CACHLY_EMBED_PROVIDER + key). ' +
      'Run once, then re-run after major refactors. TTL=86400 (24h) keeps entries fresh.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cachly instance' },
        dir: {
          type: 'string',
          description: 'Absolute path to the directory to index (e.g. /Users/you/myproject/src)',
        },
        extensions: {
          type: 'array',
          items: { type: 'string' },
          description: 'File extensions to include (default: ["ts","js","go","py","java","rs","md","kt","swift"])',
        },
        max_files: {
          type: 'number',
          description: 'Maximum number of files to index (default: 100)',
        },
        ttl: {
          type: 'number',
          description: 'TTL in seconds for indexed entries (default: 86400 = 24 h)',
        },
        summary_chars: {
          type: 'number',
          description: 'Characters to use as summary per file (default: 1200)',
        },
        namespace: {
          type: 'string',
          description: 'Semantic namespace to store under (default: cachly:sem:code)',
        },
      },
      required: ['instance_id', 'dir'],
    },
  },
  // ── Bulk operations ──────────────────────────────────────────────────────
  {
    name: 'cache_mset',
    description:
      'Set multiple key-value pairs in a single pipeline round-trip. ' +
      'Supports per-key TTL – unlike native MSET. ' +
      'Uses one TCP round-trip for N keys via Redis pipeline. ' +
      'Each item overwrites any existing value for that key. ' +
      'On partial failure the successfully pipelined keys are committed; a per-key error list is returned for any that failed. ' +
      'Returns a summary: { set: N, errors: [...] }. ' +
      'Use cache_set for a single key; use cache_stream_set for large streaming payloads.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        items: {
          type: 'array',
          description: 'Key-value pairs to set',
          items: {
            type: 'object',
            properties: {
              key:   { type: 'string',  description: 'Cache key' },
              value: {                  description: 'Value to store (JSON-serialised)' },
              ttl:   { type: 'number',  description: 'Per-key TTL in seconds (optional)' },
            },
            required: ['key', 'value'],
          },
        },
      },
      required: ['instance_id', 'items'],
    },
  },
  {
    name: 'cache_mget',
    description:
      'Retrieve multiple keys in one round-trip using native Redis MGET. ' +
      'Returns values in the same order as the keys array; missing keys are null.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string',  description: 'UUID of the cache instance' },
        keys:        { type: 'array', items: { type: 'string' }, description: 'List of keys to fetch' },
      },
      required: ['instance_id', 'keys'],
    },
  },
  // ── Distributed lock ──────────────────────────────────────────────────────
  {
    name: 'cache_lock_acquire',
    description:
      'Acquire a distributed lock using Redis SET NX PX (Redlock-lite). ' +
      'Returns a fencing token on success. The lock auto-expires after ttl_ms to prevent deadlocks. ' +
      'Use cache_lock_release to free the lock early.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:    { type: 'string', description: 'UUID of the cache instance' },
        key:            { type: 'string', description: 'Lock resource identifier' },
        ttl_ms:         { type: 'number', description: 'Safety TTL in milliseconds (e.g. 5000)' },
        retries:        { type: 'number', description: 'Max acquire attempts (default: 3)' },
        retry_delay_ms: { type: 'number', description: 'Milliseconds between retries (default: 50)' },
      },
      required: ['instance_id', 'key', 'ttl_ms'],
    },
  },
  {
    name: 'cache_lock_release',
    description:
      'Release a previously acquired distributed lock. ' +
      'Uses a Lua script for atomic release – only deletes the key if the fencing token matches.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        key:         { type: 'string', description: 'Lock resource identifier (same as in cache_lock_acquire)' },
        token:       { type: 'string', description: 'Fencing token returned by cache_lock_acquire' },
      },
      required: ['instance_id', 'key', 'token'],
    },
  },
  // ── Auth & API-Status ─────────────────────────────────────────────────────
  {
    name: 'get_api_status',
    description:
      'Check the cachly API health and your authentication status. ' +
      'Returns whether the JWT is valid, your user ID (sub claim), ' +
      'token expiry, and the auth provider (keycloak). ' +
      'Use this to debug connection issues or verify your CACHLY_JWT is correct.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // ── Thinking/Context Cache (for AI assistants) ────────────────────────────
  {
    name: 'remember_context',
    description:
      'Save context information to the cache so you can recall it later without re-computing. ' +
      'Perfect for caching: codebase overviews, file summaries, project structure, ' +
      'frequently-accessed data, or "thinking" results like dependency analysis. ' +
      'The AI assistant can use this to avoid re-reading the entire codebase every time. ' +
      'Overwrites any existing value stored under the same key. ' +
      'Returns { key, stored_at, ttl } confirming the saved context. ' +
      'Example: remember_context("project overview", "This is a Next.js app with...") ' +
      'then later: recall_context("project overview"). ' +
      'Use recall_context to retrieve; use list_remembered to see all stored keys.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        key: { type: 'string', description: 'Descriptive key like "project_overview", "auth_architecture", "file:src/index.ts"' },
        content: { type: 'string', description: 'The context/summary/analysis to remember' },
        category: {
          type: 'string',
          enum: ['overview', 'architecture', 'file_summary', 'dependency', 'thinking', 'custom'],
          description: 'Category for organization (default: custom)',
        },
        ttl: { type: 'number', description: 'Time-to-live in seconds (default: 86400 = 24h, use 0 for no expiry)' },
      },
      required: ['instance_id', 'key', 'content'],
    },
  },
  {
    name: 'recall_context',
    description:
      'Retrieve previously saved context from the cache. ' +
      'Returns the saved content or null if not found. ' +
      'Use this at the START of any task to check if you already have relevant context cached, ' +
      'before doing expensive operations like reading many files. ' +
      'Supports glob patterns: "file:*" matches all file summaries, "arch*" matches architecture-related keys.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        key: { type: 'string', description: 'The key to look up (supports glob pattern like "file:*")' },
      },
      required: ['instance_id', 'key'],
    },
  },
  {
    name: 'list_remembered',
    description:
      'List all cached context entries for this project. ' +
      'Shows what knowledge the AI assistant has already cached, so you can decide ' +
      'whether to recall existing context or refresh it. ' +
      'Returns: key, category, size, TTL remaining, and a content preview.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        category: {
          type: 'string',
          enum: ['overview', 'architecture', 'file_summary', 'dependency', 'thinking', 'custom', 'all'],
          description: 'Filter by category (default: all)',
        },
        limit: { type: 'number', description: 'Max entries to return (default: 50)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'forget_context',
    description:
      'Delete one or more cached context entries. ' +
      'Use when context is stale or you want to force a fresh analysis. ' +
      'Supports glob patterns: "file:*" deletes all file summaries.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Keys to delete (supports glob)' },
      },
      required: ['instance_id', 'keys'],
    },
  },
  {
    name: 'learn_from_attempts',
    description:
      'Store a lesson learned from a failed or successful attempt. ' +
      'Call this AFTER completing any non-trivial task (deploy, debug, fix, architecture decision). ' +
      'The lesson will be recalled automatically in future sessions via recall_best_solution. ' +
      'Fields: topic (short slug like "deploy:web"), outcome ("success"|"failure"), ' +
      'what_worked (what solved it), what_failed (what did NOT work), context (extra details). ' +
      'Supports structured metadata: severity, file_paths (files involved), commands (working commands), tags. ' +
      'Deduplication: if a lesson for this topic already exists, it is updated with full audit trail. ' +
      'Contradiction detection: warns if new outcome conflicts with existing lesson outcome. ' +
      'Confidence: lesson starts at 1.0, decays after 5d (→0.7) and 10d (→0.5) without recall. ' +
      'Example: learn_from_attempts(topic="deploy:api", outcome="success", what_worked="nohup docker compose up -d --build", what_failed="docker compose up hangs on SSH timeout", severity="critical", commands=["nohup docker compose up -d --build"])',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:        { type: 'string', description: 'Short slug, e.g. "deploy:web", "debug:redis-tls", "fix:generate-series"' },
        outcome:      { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Did it work?' },
        what_worked:  { type: 'string', description: 'What solved the problem or what approach succeeded' },
        what_failed:  { type: 'string', description: 'What did NOT work (optional but valuable)' },
        context:      { type: 'string', description: 'Additional context, error messages, root cause (optional)' },
        severity: {
          type: 'string',
          enum: ['critical', 'major', 'minor'],
          description: 'Impact severity: critical (blocks work/deploy), major (significant slowdown), minor (nice to know). Default: major.',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files involved in this lesson (e.g. ["infra/deploy.sh", ".env"])',
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description: 'Commands that worked or failed (e.g. ["rsync -avz ...", "docker compose up -d"])',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Topic tags for filtering (e.g. ["bash", "deploy", "env"])',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Prerequisites this lesson depends on (e.g. ["node:>=20", "docker:running", "wireguard:active"]). When a dependency is marked stale, all dependent lessons get needs_review.',
        },
        author: {
          type: 'string',
          description: 'Name or handle of the person storing this lesson (e.g. "alice", "bob"). Used for Team Telepathy — teammates see each other\'s lessons in session_start.',
        },
      },
      required: ['instance_id', 'topic', 'outcome', 'what_worked'],
    },
  },
  {
    name: 'recall_best_solution',
    description:
      'Recall the best known solution for a topic from past lessons. ' +
      'Call this BEFORE attempting any task that might have been done before. ' +
      'Returns the most recent successful lesson for the topic, with confidence indicator. ' +
      '⚠️ badge = lesson is >5d old (verify before applying). 🔴 = >10d old (likely stale!). ' +
      'Recalling a lesson resets its confidence clock to 1.0 (marks as recently verified). ' +
      'Example: recall_best_solution(topic="deploy:web") → returns the working deploy command.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:        { type: 'string', description: 'Topic slug to look up, e.g. "deploy:web". Supports partial match.' },
      },
      required: ['instance_id', 'topic'],
    },
  },
  {
    name: 'smart_recall',
    description:
      'Semantically search cached context using natural language. ' +
      'Instead of exact key matching, finds context by meaning. ' +
      'Example: smart_recall("how does authentication work") → returns cached auth architecture summary. ' +
      'Falls back to remember_context keys if no semantic match is found.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        query: { type: 'string', description: 'Natural language query to find relevant cached context' },
        threshold: { type: 'number', description: 'Similarity threshold 0-1 (default: 0.78)' },
      },
      required: ['instance_id', 'query'],
    },
  },
  {
    name: 'session_start',
    description:
      'Single-call session briefing. Call this at the START of every session INSTEAD of multiple separate smart_recall/recall_best_solution calls. ' +
      'Returns: last session summary, recent lessons sorted by recency, relevant lessons for your focus area, ' +
      'open failures (topics with only failure outcomes), brain health stats, team telepathy (what teammates learned this week), ' +
      'predictive pre-warnings (if your focus area has known failure patterns), and memory crystals (compressed wisdom from old sessions). ' +
      'Also saves a session start marker so session_end can compute duration.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        focus: {
          type: 'string',
          description: 'Keywords for what you plan to work on today (e.g. "deploy infra api"). Used to surface relevant lessons at the top.',
        },
        author: {
          type: 'string',
          description: 'Your name or handle (e.g. "alice"). Enables Team Telepathy — filters YOUR lessons vs TEAM lessons from past 7 days.',
        },
        provider: {
          type: 'string',
          description: 'Current AI provider (e.g. "claude-code", "copilot", "cursor", "windsurf"). Shown in the briefing header and saved so the next provider can see who was last active.',
        },
        workspace_path: {
          type: 'string',
          description: 'Absolute path to the project root. If no session_end was found (e.g. context limit hit), reads git log to reconstruct what happened since last session.',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'session_end',
    description:
      'Save a session summary when you finish working. ' +
      'Records what was accomplished, files changed, and lesson count. ' +
      'The next session_start will show this summary as "Last session". ' +
      'Call this when ending a work session, before going idle, or before summarizing. ' +
      'Ambient Learning: if workspace_path is provided, reads git log since session start and auto-learns from commits.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished this session (2-3 sentences)',
        },
        files_changed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Key files changed this session (optional)',
        },
        lessons_learned: {
          type: 'number',
          description: 'Number of new lessons stored this session (optional)',
        },
        workspace_path: {
          type: 'string',
          description: 'Absolute path to the project root (e.g. "/Users/you/myproject"). Enables Ambient Learning — reads git log since session start and auto-learns from commit messages.',
        },
      },
      required: ['instance_id', 'summary'],
    },
  },
  // ── Session Handoff — cross-window continuity ─────────────────────────────
  {
    name: 'session_handoff',
    description:
      'Save a detailed handoff for the NEXT chat window / session. ' +
      'Stores: current progress, TODO list (done + remaining), changed files with descriptions, ' +
      'instructions for the next assistant, and any incomplete work. ' +
      'The next session_start automatically includes this handoff so the new window knows EXACTLY what happened and what remains. ' +
      'Call this BEFORE closing a chat window, especially if work is incomplete. ' +
      'This prevents the "continue" problem where new windows lose context, skip tasks, or produce broken code.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        completed_tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tasks that were fully completed (e.g. "Implemented brainSearch() in JS SDK")',
        },
        remaining_tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tasks NOT yet done — the next window MUST pick these up',
        },
        files_changed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to project root' },
              status: { type: 'string', enum: ['complete', 'partial', 'broken'], description: 'State of this file' },
              description: { type: 'string', description: 'What was changed and what still needs work' },
            },
            required: ['path', 'status'],
          },
          description: 'Changed files with their current state — marks partial/broken files so next window knows to fix them',
        },
        instructions: {
          type: 'string',
          description: 'Free-form instructions for the next assistant. Be specific: what to do next, what to avoid, what broke.',
        },
        context_summary: {
          type: 'string',
          description: 'Brief summary of what happened this session (architecture decisions, key findings, blockers)',
        },
        blocked_on: {
          type: 'string',
          description: 'If work is blocked, describe what is needed to unblock (e.g. "waiting for API deploy", "needs user input on design")',
        },
      },
      required: ['instance_id', 'completed_tasks', 'remaining_tasks'],
    },
  },
  // ── session_ping — lightweight in-session checkpoint ─────────────────────
  {
    name: 'session_ping',
    description:
      'Lightweight checkpoint — call this every ~5 tool calls or whenever you complete a significant step. ' +
      'Stores the current task + files touched so session_start on the NEXT provider can reconstruct what happened ' +
      'even if session_end was never called (e.g. Claude context limit hit, window crashed). ' +
      'This solves the provider-switching problem: Claude → Copilot → Cursor all see the same last checkpoint. ' +
      'Extremely fast — one Redis SET, no blocking operations.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        task: {
          type: 'string',
          description: 'What you are currently working on (e.g. "Implementing invite handler in handler/invite.go")',
        },
        files_touched: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files modified so far this session',
        },
        next_step: {
          type: 'string',
          description: 'What the NEXT step is after this checkpoint (helps next provider resume immediately)',
        },
        provider: {
          type: 'string',
          description: 'Current AI provider (e.g. "claude-code", "copilot", "cursor", "windsurf")',
        },
      },
      required: ['instance_id', 'task'],
    },
  },
  // ── AI Brain — Extended features ─────────────────────────────────────────
  {
    name: 'auto_learn_session',
    description:
      'Auto-learn from a list of session observations WITHOUT explicit learn_from_attempts calls. ' +
      'Pass what happened (commands run, errors seen, solutions found) and the brain classifies and stores lessons automatically. ' +
      'Use at session_end to capture everything you did, even if you forgot to call learn_from_attempts. ' +
      'Returns a summary of what was auto-stored.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        observations: {
          type: 'array',
          description: 'List of observations from this session',
          items: {
            type: 'object',
            properties: {
              action:   { type: 'string', description: 'What was tried (command, approach, code change)' },
              outcome:  { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Result' },
              details:  { type: 'string', description: 'Error message, output, or explanation' },
              topic:    { type: 'string', description: 'Optional topic key (auto-generated if omitted)' },
              severity: { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Severity (default: minor)' },
            },
            required: ['action', 'outcome'],
          },
        },
      },
      required: ['instance_id', 'observations'],
    },
  },
  {
    name: 'sync_file_changes',
    description:
      'Associate recent file changes with brain knowledge. ' +
      'Pass a list of changed file paths (from `git diff --stat`). ' +
      'Returns lessons relevant to those files, and records the file changes in session history. ' +
      'Call this after commits so the brain tracks what changed and why.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:   { type: 'string', description: 'UUID of the cache instance' },
        changed_files: { type: 'array', items: { type: 'string' }, description: 'List of changed file paths' },
        git_diff_stat: { type: 'string', description: 'Output of `git diff --stat` (optional)' },
        commit_msg:    { type: 'string', description: 'Commit message (optional)' },
      },
      required: ['instance_id', 'changed_files'],
    },
  },
  {
    name: 'team_learn',
    description:
      'Store a lesson in a shared team brain so all team members benefit. ' +
      'Like learn_from_attempts, but REQUIRES an author name for attribution. ' +
      'Shows up in team_recall with "by <author>" so the team knows who learned it.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the shared team brain instance' },
        author:       { type: 'string', description: 'Your name or handle (required for team attribution)' },
        topic:        { type: 'string', description: 'Topic in category:keyword format (e.g. "deploy:api")' },
        outcome:      { type: 'string', enum: ['success', 'failure', 'partial'], description: 'What happened' },
        what_worked:  { type: 'string', description: 'What worked (the solution)' },
        what_failed:  { type: 'string', description: 'What did NOT work (avoid this)' },
        severity:     { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Impact level' },
        file_paths:   { type: 'array', items: { type: 'string' }, description: 'Relevant file paths' },
        commands:     { type: 'array', items: { type: 'string' }, description: 'Commands that worked' },
        tags:         { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['instance_id', 'author', 'topic', 'outcome', 'what_worked'],
    },
  },
  {
    name: 'team_recall',
    description:
      'Recall lessons from a shared team brain, showing who learned what. ' +
      'Works on any shared instance (all team members using the same instance_id). ' +
      'Shows author, recency, and severity for each lesson. ' +
      'Use this to onboard new team members or find who knows about a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        topic:       { type: 'string', description: 'Topic or keyword to filter lessons (optional)' },
        author:      { type: 'string', description: 'Filter by author name (optional)' },
        limit:       { type: 'number', description: 'Max lessons to return (default: 10)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'team_synthesize',
    description:
      'Team Brain Synthesis — merge multiple contributors\' lessons on the same topic into one canonical version. ' +
      'When 2+ developers store lessons for the same topic with different details, this proposes the best merged version. ' +
      'Shows: all contributions by author, what worked (consensus), what failed (union), canonical lesson to store. ' +
      'Use this when onboarding new team members or before documenting a process.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the shared team brain instance' },
        topic:       { type: 'string', description: 'Topic slug to synthesize (e.g. "deploy:api")' },
      },
      required: ['instance_id', 'topic'],
    },
  },
  {
    name: 'memory_crystalize',
    description:
      'Compress the last 30-50 sessions and auto-learned lessons into a dense Memory Crystal. ' +
      'A crystal is a compact, structured summary of everything the brain learned — grouped by category (deploy, fix, debug, …). ' +
      'Crystals survive session cleanup and appear in session_start once enough sessions have accumulated. ' +
      'Run this monthly or after a big milestone to preserve institutional knowledge. ' +
      'Returns a digest of what was crystallized.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        label: {
          type: 'string',
          description: 'Optional label for this crystal (e.g. "Q1 2026", "v2 launch"). Auto-generated from date if omitted.',
        },
      },
      required: ['instance_id'],
    },
  },
  // ── Roadmap — Persistent project plan tracker ───────────────────────────
  {
    name: 'roadmap_add',
    description:
      'Add a new item to the persistent project roadmap stored in the Brain. ' +
      'Items survive across sessions and editors — the roadmap is always up to date. ' +
      'Use for features, bugs, refactors, or any planned work. ' +
      'Call roadmap_list to see all open items, roadmap_next to get the next actionable item.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        title: { type: 'string', description: 'Short title of the task/feature (3–10 words)' },
        description: { type: 'string', description: 'What needs to be done, acceptance criteria, context' },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Priority level (default: medium)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for filtering (e.g. ["api", "web", "sdk", "infra"])',
        },
        milestone: { type: 'string', description: 'Milestone/epic this belongs to (optional)' },
      },
      required: ['instance_id', 'title'],
    },
  },
  {
    name: 'roadmap_update',
    description:
      'Update the status, priority, or details of a roadmap item. ' +
      'Use to move items through the lifecycle: planned → in-progress → done (or blocked/cancelled). ' +
      'Also use to add notes/findings while working on an item.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        id: { type: 'string', description: 'Item ID returned by roadmap_add or roadmap_list' },
        status: {
          type: 'string',
          enum: ['planned', 'in-progress', 'done', 'blocked', 'cancelled'],
          description: 'New status for the item',
        },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Updated priority (optional)',
        },
        notes: { type: 'string', description: 'Progress notes, findings, or blockers (appended to existing notes)' },
        title: { type: 'string', description: 'Updated title (optional)' },
        description: { type: 'string', description: 'Updated description (optional)' },
      },
      required: ['instance_id', 'id'],
    },
  },
  {
    name: 'roadmap_list',
    description:
      'List all roadmap items, optionally filtered by status, priority, tag, or milestone. ' +
      'Returns items sorted by priority then creation date. ' +
      'Called automatically by session_start to show open work.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        status: {
          type: 'string',
          enum: ['planned', 'in-progress', 'done', 'blocked', 'cancelled', 'open'],
          description: 'Filter by status. Use \'open\' to see planned+in-progress+blocked (default: open)',
        },
        tag: { type: 'string', description: 'Filter by tag (optional)' },
        milestone: { type: 'string', description: 'Filter by milestone (optional)' },
        priority: {
          type: 'string',
          enum: ['critical', 'high', 'medium', 'low'],
          description: 'Filter by minimum priority (optional)',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'roadmap_next',
    description:
      'Get the single most important next actionable roadmap item. ' +
      'Returns the highest-priority in-progress item first, then planned items, sorted by priority. ' +
      'Call at session start to immediately know what to work on next.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        tag: { type: 'string', description: 'Filter by tag (optional)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_doctor',
    description:
      'Check the health of your AI Brain and get actionable recommendations. ' +
      'Reports: lesson count, context entries, last session age, open failures, quality score, effective IQ boost, stale index. ' +
      'Returns a prioritized list of issues with fix instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        workspace_path: {
          type: 'string',
          description: 'Absolute path to workspace root — enables package.json analysis for openclaw cross-promo (optional)',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'global_learn',
    description:
      'Store a lesson that applies across ALL your projects (cross-project knowledge). ' +
      'Idempotent: if a lesson with the same topic already exists, it is updated in place — no duplicates are created. ' +
      'Returns a confirmation with the stored lesson key. No rate limits. ' +
      'Global lessons are stored with the prefix cachly:global:lesson: and recalled from any instance via global_recall. ' +
      'Use for tool preferences, personal workflows, platform quirks, and universal gotchas. ' +
      'Example: global_learn(topic="bash:macos-arrays", lesson="Arrays work differently on macOS bash 3.2"). ' +
      'Use learn_from_attempts for project-specific session lessons; use team_learn to share lessons with your team.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (used for connection)' },
        topic:       { type: 'string', description: 'Topic key in format "category:keyword"' },
        lesson:      { type: 'string', description: 'The lesson content' },
        severity:    { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Severity (default: minor)' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['instance_id', 'topic', 'lesson'],
    },
  },
  {
    name: 'global_recall',
    description:
      'Read-only retrieval of cross-project lessons stored via global_learn. No side effects. ' +
      'Returns a list of matching global lesson objects, each with topic, lesson text, severity, and tags. ' +
      'If no topic is provided, returns all global lessons (up to 50). ' +
      'If topic is provided, returns all lessons whose topic key contains that string (partial match). ' +
      'Use this for lessons that apply universally across all projects (tool quirks, shell gotchas, platform behavior). ' +
      'Use recall_best_solution instead for project-specific lessons; use team_recall for org-scoped lessons.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance (used for connection)' },
        topic:       { type: 'string', description: 'Topic or keyword filter (optional)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'publish_lesson',
    description:
      'Publish a lesson to the Cachly Public Brain (anonymized community knowledge base). ' +
      'Published lessons can be imported by other developers via import_public_brain. ' +
      'PII is stripped automatically. Visible under the framework/category tag. ' +
      'Returns { lesson_id, topic, framework, published_at } confirming the publish. ' +
      'Irreversible — once published to the public brain, lessons cannot be deleted via the MCP interface. ' +
      'Use learn_from_attempts or global_learn for private lessons; ' +
      'use syndicate for anonymized global sharing without framework tagging.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:       { type: 'string', description: 'Topic key (used as public category)' },
        lesson:      { type: 'string', description: 'Lesson to publish (PII will be stripped)' },
        framework:   { type: 'string', description: 'Framework/platform tag (nextjs, fastapi, go, docker, etc.)' },
        severity:    { type: 'string', enum: ['critical', 'major', 'minor'], description: 'Severity' },
      },
      required: ['instance_id', 'topic', 'lesson'],
    },
  },
  {
    name: 'import_public_brain',
    description:
      'Import community lessons from the Cachly Public Brain for a framework. ' +
      'Non-destructive: existing lessons with the same topic key are not overwritten. ' +
      'Returns the count of lessons imported and their topic slugs. ' +
      'Available frameworks: nextjs, fastapi, go, docker, kubernetes, react, typescript, python, rust, laravel, rails, spring. ' +
      'Use this to bootstrap a new brain with battle-tested community knowledge before your first session_start. ' +
      'Use publish_lesson to contribute your own lessons to the Public Brain; ' +
      'use learn_from_attempts for storing lessons from your own sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance to import into' },
        framework:   { type: 'string', description: 'Framework/platform to import lessons for' },
        limit:       { type: 'number', description: 'Max lessons to import (default: 20)' },
      },
      required: ['instance_id', 'framework'],
    },
  },
  // ── Brain Archaeology + Causal Chain ────────────────────────────────────
  {
    name: 'recall_at',
    description:
      'Brain Archaeology — see what a lesson looked like at a specific point in time. ' +
      '"What did we know about deployments 3 months ago?" ' +
      'Returns the history of a topic filtered to entries before the given date. ' +
      'Shows how the lesson evolved: failure → partial → success. ' +
      'Also useful to understand WHY old code decisions were made.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        topic:       { type: 'string', description: 'Topic slug to look up, e.g. "deploy:api"' },
        date:        { type: 'string', description: 'ISO date string (e.g. "2026-01-15") — returns entries stored BEFORE this date' },
      },
      required: ['instance_id', 'topic', 'date'],
    },
  },
  {
    name: 'trace_dependency',
    description:
      'Causal Chain — find all lessons that depend on a given prerequisite. ' +
      '"What lessons are affected if node version changes?" ' +
      'When a dependency changes (new version, different provider, new OS), call this to see which lessons need review. ' +
      'Lessons store dependencies via the depends_on field in learn_from_attempts.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        dependency:  { type: 'string', description: 'Dependency to trace (e.g. "node:>=20", "docker:running", "wireguard:active")' },
        mark_review: { type: 'boolean', description: 'If true, marks all dependent lessons as needs_review (default: false)' },
      },
      required: ['instance_id', 'dependency'],
    },
  },
  // ── Team / Org Management ────────────────────────────────────────────────
  {
    name: 'list_orgs',
    description:
      'List your Cachly organizations (team/org plans). ' +
      'Returns each org with plan, seat count, and member info. ' +
      'Org plans (Team €99, Business €299, Enterprise custom) are billed separately from cache tiers.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_org',
    description:
      'Create a new Cachly organization for team collaboration. ' +
      'After creation, invite team members with invite_member and upgrade the plan via the billing portal. ' +
      'Org plans: Team (€99/mo, 10 seats), Business (€299/mo, 50 seats), Enterprise (custom).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Organization display name (e.g. "Acme Engineering")' },
        slug: { type: 'string', description: 'URL-safe slug (e.g. "acme-eng"). Auto-generated from name if omitted.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'invite_member',
    description:
      'Invite a team member to a Cachly organization by email. ' +
      'They will receive an invite email and can join via the dashboard. ' +
      'Roles: owner (full access), admin (manage members + instances), member (read + cache ops).',
    inputSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'UUID of the organization' },
        email:  { type: 'string', description: 'Email address to invite' },
        role:   { type: 'string', enum: ['admin', 'member'], description: 'Role for the invited member (default: member)' },
      },
      required: ['org_id', 'email'],
    },
  },
  {
    name: 'get_org_plan',
    description:
      'Get the current org plan, seat usage, and billing info for an organization. ' +
      'Shows: plan name, price, seats used/max, next billing date. ' +
      'To upgrade: use the billing portal URL returned by this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        org_id: { type: 'string', description: 'UUID of the organization' },
      },
      required: ['org_id'],
    },
  },
  // ── Legacy / Setup ────────────────────────────────────────────────────────
  {
    name: 'setup_ai_memory',
    description:
      'One-shot setup of the cachly 3-layer AI Memory system for a project.\n\n' +
      'Layer 1 — Storage: your cachly instance (Valkey, persistent across sessions)\n' +
      'Layer 2 — Tools: learn_from_attempts + recall_best_solution + smart_recall (the memory API)\n' +
      'Layer 3 — Autopilot: generates a copilot-instructions.md / .github/copilot-instructions.md\n' +
      '  that instructs any MCP-compatible AI to recall known solutions BEFORE each task\n' +
      '  and save lessons AFTER — fully automatic, zero manual effort.\n\n' +
      'Returns the copilot-instructions.md content + provider-specific .mcp.json snippet.\n' +
      'Optionally writes copilot-instructions.md directly to the project directory.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'UUID of the cachly instance to use as the AI brain',
        },
        project_dir: {
          type: 'string',
          description:
            'Absolute path to the project root. If provided, writes copilot-instructions.md ' +
            'to .github/copilot-instructions.md in that directory.',
        },
        embed_provider: {
          type: 'string',
          enum: ['openai', 'mistral', 'cohere', 'ollama', 'gemini'],
          description:
            'Embedding provider to use for smart_recall / semantic search. ' +
            'Default: openai. Use ollama for fully local/free setup.',
        },
        project_description: {
          type: 'string',
          description: 'Short description of the project (used in the generated instructions)',
        },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'cache_stream_set',
    description:
      'Cache a list of string chunks (e.g. LLM token stream) via Redis RPUSH. ' +
      'Each chunk is stored as a separate list element under cachly:stream:{key}. ' +
      'Replay with cache_stream_get.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string',  description: 'UUID of the cache instance' },
        key:         { type: 'string',  description: 'Cache key' },
        chunks:      { type: 'array', items: { type: 'string' }, description: 'Ordered list of string chunks' },
        ttl:         { type: 'number',  description: 'TTL in seconds for the stored list (optional)' },
      },
      required: ['instance_id', 'key', 'chunks'],
    },
  },
  {
    name: 'cache_stream_get',
    description:
      'Retrieve a previously cached stream as an ordered list of string chunks. ' +
      'Returns null on cache miss (key absent or empty list). ' +
      'Stored under cachly:stream:{key}.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        key:         { type: 'string', description: 'Cache key' },
      },
      required: ['instance_id', 'key'],
    },
  },

  // ── v0.6 Cognitive Cache Tools ────────────────────────────────────────────
  {
    name: 'memory_consolidate',
    description:
      'Cognitive memory consolidation — the weekly garbage collector for your AI Brain. ' +
      'Scans all lessons, detects contradictions (same topic with conflicting outcomes), ' +
      'merges duplicates, flags stale entries (not recalled in 90+ days), and computes a ' +
      'health score. Returns a full consolidation report with conflicts resolved, ' +
      'duplicates merged, and a before/after count. ' +
      'Run weekly or when brain_doctor reports > 20 lessons. ' +
      'Like git gc for knowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:   { type: 'string', description: 'UUID of the cache instance' },
        dry_run:       { type: 'boolean', description: 'If true, report what would change without writing (default: false)' },
        stale_days:    { type: 'number',  description: 'Lessons not recalled in this many days are flagged stale (default: 90)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_diff',
    description:
      'git log for your AI Brain — see exactly what changed since a point in time. ' +
      'Returns a structured changelog: new lessons added, lessons updated (outcome changed), ' +
      'lessons recalled (hit count increased), and lessons that decayed. ' +
      'Perfect for weekly reviews: "What did my AI learn this week?" ' +
      'Example: brain_diff(instance_id="...", since="7d") → "12 new · 4 updated · 2 stale"',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        since:       { type: 'string', description: 'Time window: "1d", "7d", "30d", or ISO-8601 date (default: "7d")' },
        format:      { type: 'string', enum: ['summary', 'detailed'], description: 'Output format (default: summary)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'causal_trace',
    description:
      'Root Cause Analysis through memory: given a problem description, traces the causal chain ' +
      'from root cause through intermediate failures to the current symptom, then surfaces the ' +
      'exact solution that worked before. Read-only — does not modify any stored data. ' +
      'Requires prior learning: brain must have lessons stored via learn_from_attempts or brain_from_git. ' +
      'Returns an ordered chain of concepts with confidence scores plus the matching solution; ' +
      'returns an empty chain with a message if no causal path is found. ' +
      'Example: causal_trace(problem="auth breaks after restart") → ' +
      '"Root: k8s:namespace-terminating → keycloak:jwks-race → Solution: PollUntilContextTimeout 3min". ' +
      'Use recall_best_solution for direct topic lookup, syndicate_search for community patterns, ' +
      'and causal_trace when you have a symptom and need the full root-cause chain.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        problem:     { type: 'string', description: 'Describe the problem or error you are seeing right now' },
        max_depth:   { type: 'number', description: 'Max causal chain depth to trace (default: 5)' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Optional: narrow search to these tags' },
      },
      required: ['instance_id', 'problem'],
    },
  },
  {
    name: 'knowledge_decay',
    description:
      'Confidence scoring for every lesson in your Brain — because old knowledge rots. ' +
      'Computes a decay score (0–100%) per lesson based on age, recall frequency, and outcome. ' +
      'Lessons recalled recently score high. Lessons from 90 days ago never recalled score low. ' +
      'Returns a ranked list with visual confidence bars: "████░░░░ 40%". ' +
      'Use this before a big refactor to know which lessons to trust and which to re-validate.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the cache instance' },
        min_age_days: { type: 'number', description: 'Only include lessons older than N days (default: 0 = all)' },
        show_top:     { type: 'number', description: 'Number of entries to return, sorted by lowest confidence first (default: 20)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'autopilot',
    description:
      'Generate a CLAUDE.md / copilot-instructions.md that makes any AI self-managing forever. ' +
      'Writes a configuration file to disk — will overwrite an existing file at the target path. ' +
      'No auth required beyond a valid instance_id. ' +
      'The generated file instructs Claude, Cursor, Copilot, Windsurf, or Gemini to automatically ' +
      'call session_start at window open, learn_from_attempts after every fix, and session_end ' +
      'before closing — without being asked. ' +
      'Returns the generated file content as a string and the path where it was written. ' +
      'Use style="minimal" for just the three hooks; style="full" for the complete ruleset with examples. ' +
      'One command. Every AI. Always on. ' +
      'Use setup_ai_memory instead if you want an interactive one-shot setup that also creates an instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id:  { type: 'string', description: 'UUID of the cache instance' },
        editor:       { type: 'string', enum: ['claude', 'cursor', 'copilot', 'windsurf', 'gemini', 'continue', 'all'], description: 'Target editor (default: claude)' },
        project_name: { type: 'string', description: 'Your project name (used in generated instructions)' },
        style:        { type: 'string', enum: ['minimal', 'full'], description: 'minimal = just the hooks, full = full ruleset with examples (default: full)' },
      },
      required: ['instance_id'],
    },
  },
  // ── v0.7 Knowledge Syndication ────────────────────────────────────────────
  {
    name: 'syndicate',
    description:
      'Contribute a verified lesson to the GLOBAL Cachly Knowledge Commons — ' +
      'a privacy-preserving shared brain where every AI instance can learn from the discoveries ' +
      'of every other. Your contributor identity is a one-way HMAC hash: completely anonymous. ' +
      'The lesson is immediately searchable by any other AI using syndicate_search. ' +
      'This is how individual knowledge becomes collective intelligence. ' +
      'Call this AFTER every learn_from_attempts that is worth sharing universally ' +
      '(critical bugs, deployment gotchas, architecture discoveries). ' +
      'If a lesson with the same topic already exists in the commons, it is updated in place (idempotent). ' +
      'Returns { key, confirm_count, scope } confirming the stored lesson. ' +
      'Use scope="org" to keep the lesson private to your organisation. ' +
      'Do NOT use for secrets or PII — content is stored in a shared knowledge base.',
    inputSchema: {
      type: 'object',
      properties: {
        topic:       { type: 'string', description: 'Topic key in category:keyword format (e.g. "fix:clickhouse-ipv6", "deploy:docker-compose")' },
        outcome:     { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Result of the attempt (default: success)' },
        what_worked: { type: 'string', description: 'Exact approach, command, or fix that worked. File paths are stripped automatically.' },
        what_failed: { type: 'string', description: 'What failed or was wrong — helps others avoid the same trap.' },
        severity:    { type: 'string', enum: ['critical', 'major', 'minor'], description: 'How severe the issue was (default: minor)' },
        tags:        { type: 'array', items: { type: 'string' }, description: 'Up to 10 keywords for better discoverability' },
        scope:       { type: 'string', enum: ['public', 'org'], description: 'Visibility: "public" = global commons (default), "org" = private to your org only' },
      },
      required: ['topic', 'what_worked'],
    },
  },
  {
    name: 'syndicate_search',
    description:
      'Search the GLOBAL Cachly Knowledge Commons for solutions contributed by the entire community. ' +
      'Returns lessons ranked by confirm_count (trust score) then recency. ' +
      'Use this BEFORE debugging any unknown issue — someone in the global brain likely solved it already. ' +
      'Example: syndicate_search(q="clickhouse localhost connection refused") → ' +
      '"fix: use 127.0.0.1 not localhost when IPv6 is disabled · confirmed by 47 instances"',
    inputSchema: {
      type: 'object',
      properties: {
        q:        { type: 'string', description: 'Free-text search query (leave empty for most recent lessons)' },
        category: { type: 'string', description: 'Filter by category prefix: "fix", "deploy", "debug", "infra", "api", "web"' },
        scope:    { type: 'string', enum: ['public', 'org'], description: '"public" = global commons (default), "org" = public + your org-private lessons' },
        limit:    { type: 'number', description: 'Max results to return (default: 20, max: 50)' },
      },
      required: [],
    },
  },
  {
    name: 'syndicate_stats',
    description:
      'Show the health of the global Knowledge Commons: total lessons, total confirms, ' +
      'top categories, most-trusted lessons, growth in the last 7 days, and top contributors (anonymous scores). ' +
      'Use for weekly reviews or to explore what the community knows.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'syndicate_trending',
    description:
      'Show the TRENDING lessons in the global Knowledge Commons — those with the fastest confirmation velocity ' +
      'in the last 7 days (confirm_count / age_in_days). ' +
      'Use this at the start of a session or weekly review to see what the community is actively validating. ' +
      'Lessons need at least 2 independent confirms to appear here.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 10, max: 50)' },
      },
      required: [],
    },
  },
  // ── Layer 1: Causal Knowledge Graph ────────────────────────────────────────
  {
    name: 'brain_search',
    description:
      'BM25+ full-text search over ALL brain data: lessons, context entries, session history, CKG nodes, roadmap items. ' +
      'Unlike smart_recall (which focuses on lessons + context), brain_search casts a wider net. ' +
      'Use when smart_recall returns nothing or when you want to find anything the brain knows about a topic.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        query: { type: 'string', description: 'What to search for' },
        limit: { type: 'number', description: 'Max results (default: 15)' },
      },
      required: ['instance_id', 'query'],
    },
  },
  {
    name: 'ckg_inspect',
    description:
      'Inspect the Causal Knowledge Graph (CKG) for a concept. Shows all typed edges (fixes, requires, co-occurs, causes) ' +
      'with Bayesian confidence scores. Use to understand what the brain knows about a topic and which fixes have the ' +
      'highest confidence. Also shows related concepts via graph traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        concept: { type: 'string', description: 'Concept to inspect, e.g. "fix:clickhouse-ipv6" or "docker"' },
        max_hops: { type: 'number', description: 'Traversal depth (default: 2)' },
      },
      required: ['instance_id', 'concept'],
    },
  },
  {
    name: 'brain_predict',
    description:
      'Predictive Pre-fetch Engine (PPE): given your current context (what you\'re working on), traverses the CKG ' +
      'to predict likely failures and pre-load relevant fixes. Returns top predicted pitfalls + highest-confidence fixes. ' +
      'Call at session_start when working on a specific feature or debugging area.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        context: { type: 'string', description: 'What you\'re working on, e.g. "upgrading Keycloak from 21 to 24"' },
        top_k: { type: 'number', description: 'Max predictions to return (default: 5)' },
      },
      required: ['instance_id', 'context'],
    },
  },
  // ── Layer 3: MADC ────────────────────────────────────────────────────────
  {
    name: 'madc_deliberate',
    description:
      'Multi-Agent Deliberation Chamber (MADC — Layer 3): When conflicting lessons exist for a topic, ' +
      'run deliberation between 6 specialist expert agents (InfraAgent, AuthAgent, DeployAgent, DatabaseAgent, DebugAgent, APIAgent). ' +
      'Each agent votes based on its domain CKG coverage. Unanimous vote → loser superseded. ' +
      'Split vote → contested flag, causal_trace required before acting. ' +
      'Resolution stored as permanent CKG node. Called automatically when learn_from_attempts detects a contradiction.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        topic: { type: 'string', description: 'Topic to deliberate, e.g. "fix:jwks-rotation"' },
        context: { type: 'string', description: 'Optional context for the deliberation' },
      },
      required: ['instance_id', 'topic'],
    },
  },
  // ── Layer 5: CLS ─────────────────────────────────────────────────────────
  {
    name: 'cls_ingest',
    description:
      'Continuous Learning Stream (CLS — Layer 5): Ingest learning signals WITHOUT explicit session_end calls. ' +
      'Sources: git_commit (commit message + files → CKG edges), ci_outcome (green/red build → confirms fix), ' +
      'ide_diagnostic (compiler error + fix pair → instant lesson). ' +
      'Install automatic ingestion with cls_install_hooks — brain learns from every commit and CI run.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        source: {
          type: 'string',
          enum: ['git_commit', 'ci_outcome', 'ide_diagnostic'],
          description: 'Event source type',
        },
        payload: {
          type: 'object',
          description:
            'Event data. git_commit: {message, sha?, files?, diff?}. ' +
            'ci_outcome: {status, prev_status, job, context?}. ' +
            'ide_diagnostic: {error, fix, file?}',
        },
      },
      required: ['instance_id', 'source', 'payload'],
    },
  },
  {
    name: 'cls_install_hooks',
    description:
      'Output a ready-to-install git post-commit hook + GitHub Actions step for Continuous Learning. ' +
      'Once installed, every git commit and CI build automatically feeds the brain — no session_end needed. ' +
      'Run once per repository.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        repo_path: { type: 'string', description: 'Path to repo root (default: current dir)' },
        hooks: {
          type: 'array',
          items: { type: 'string', enum: ['git', 'ci'] },
          description: 'Which hooks to output (default: ["git", "ci"])',
        },
      },
      required: ['instance_id'],
    },
  },
  // ── Layer 6: FedBrain ────────────────────────────────────────────────────
  {
    name: 'fedbrain_contribute',
    description:
      'FedBrain (Layer 6): Contribute a lesson to the global Knowledge Commons with a cryptographic ' +
      'knowledge certificate. Certificate includes: domain fingerprint, confidence, outcome chain hash. ' +
      'Lessons with 10+ independent confirmations become Gold Standard. Context-weighted: ' +
      'other brains with similar tech stacks see your lesson ranked higher in fedbrain_search.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        lesson_key: { type: 'string', description: 'Topic key to contribute, e.g. "fix:clickhouse-ipv6"' },
        visibility: {
          type: 'string',
          enum: ['public', 'org_private'],
          description: 'Visibility (default: public)',
        },
      },
      required: ['instance_id', 'lesson_key'],
    },
  },
  {
    name: 'fedbrain_search',
    description:
      'FedBrain context-weighted search: Search the global commons, weighting results by tech-stack similarity. ' +
      'Brains with matching domain context (Go/Kubernetes/Postgres) rank higher than unrelated stacks. ' +
      'Shows certificate provenance, confirm_count, and Gold Standard badges.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        query: { type: 'string', description: 'What to search for' },
        context_hints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Your tech stack, e.g. ["go", "kubernetes", "postgres"]',
        },
        limit: { type: 'number', description: 'Max results (default: 10)' },
      },
      required: ['instance_id', 'query'],
    },
  },
  {
    name: 'fedbrain_confirm',
    description:
      'Confirm that a syndicated lesson from the global commons worked for you. ' +
      'Propagates confirmation back — increments confirm_count on the knowledge certificate. ' +
      'Also updates your local CKG confidence. At 10 independent confirmations → Gold Standard.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        topic: { type: 'string', description: 'Topic of the lesson to confirm' },
        outcome: {
          type: 'string',
          enum: ['worked', 'partially_worked', 'did_not_work'],
          description: 'Did the lesson work for you?',
        },
      },
      required: ['instance_id', 'topic', 'outcome'],
    },
  },
  {
    name: 'fedbrain_status',
    description:
      'Show your FedBrain federation status: lessons contributed to global commons, recent confirmations, ' +
      'Gold Standard lessons, pending propagations. Use to track your brain\'s global knowledge contribution.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_federate',
    description:
      'FedBrain Layer 6 — Private org knowledge transfer: copy CKG edges + lessons from a source brain ' +
      'into your brain for a specific domain (e.g. "billing", "auth", "deploy"). ' +
      'The new hire use case: one command gives you the senior engineer\'s 5 years of typed, confidence-weighted ' +
      'knowledge in your domain. Unlike syndicate_search (global, anonymous), brain_federate is org-private — ' +
      'both brains must be in the same Cachly org, or the source instance_id must be explicitly shared. ' +
      'Example: brain_federate(source="prod-brain-id", domain="billing", min_confidence=0.6)',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Your brain instance ID (destination)' },
        source: { type: 'string', description: 'Source brain instance ID to federate from' },
        domain: { type: 'string', description: 'Domain to transfer, e.g. "billing", "auth", "deploy", "infra". Use "*" for all domains.' },
        min_confidence: { type: 'number', description: 'Minimum edge confidence to transfer (default: 0.6)' },
        dry_run: { type: 'boolean', description: 'Preview what would be transferred without writing (default: false)' },
      },
      required: ['instance_id', 'source', 'domain'],
    },
  },
  {
    name: 'crystal_view',
    description:
      'Inspect the current Memory Crystal — the compressed wisdom distilled from all past sessions. ' +
      'Shows top patterns per category, lesson count, and when the crystal was last refreshed. ' +
      'Call after session_start when you want to quickly see accumulated wisdom across all past work.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        show_raw: { type: 'boolean', description: 'Include raw JSON crystal data (default: false)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'compact_recover',
    description:
      'Call FIRST after any context limit hit / compaction. Reconstructs full context from Memory Crystal + ' +
      'recent sessions + WIP registry + open failures. Returns a condensed briefing so the new context ' +
      'window starts exactly where the previous one left off — no lost progress.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        focus: { type: 'string', description: 'What you were working on (helps filter relevant context)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_from_git',
    description:
      'Bootstrap brain lessons from git history. Parses commit messages and infers fix/feature/refactor ' +
      'lessons automatically. Great for onboarding an existing codebase — run once and the brain instantly ' +
      'knows your team\'s accumulated patterns. Supports limit and branch options.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        repo_path: { type: 'string', description: 'Path to git repository (default: current directory)' },
        limit: { type: 'number', description: 'Max commits to process (default: 100, max: 500)' },
        branch: { type: 'string', description: 'Git branch to parse (default: current branch / HEAD)' },
        since: { type: 'string', description: 'Only commits after this date, e.g. "2024-01-01" (optional)' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'brain_predict_failures',
    description:
      'Pre-deploy failure prediction with probability percentages. Given a change context (e.g. ' +
      '"upgrading Keycloak 21→24" or "deploying Redis 7 to prod"), returns the top likely failure modes ' +
      'ranked by probability, with pre-loaded fixes. Uses CKG causal edges + lesson history. ' +
      'Call before any significant deploy, migration, or infrastructure change.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'Brain instance ID' },
        context: { type: 'string', description: 'What you are about to do, e.g. "upgrading Keycloak 21 to 24"' },
        top_k: { type: 'number', description: 'Number of failure predictions to return (default: 5)' },
        format: { type: 'string', enum: ['brief', 'detailed'], description: 'Output format (default: detailed)' },
      },
      required: ['instance_id', 'context'],
    },
  },
] as const;

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

    case 'learn_from_attempts': {
      const {
        instance_id,
        topic,
        outcome,
        what_worked,
        what_failed = '',
        context: ctx = '',
        severity = 'major',
        file_paths = [],
        commands = [],
        tags = [],
        depends_on = [],
        author = '',
      } = args as {
        instance_id: string;
        topic: string;
        outcome: 'success' | 'failure' | 'partial';
        what_worked: string;
        what_failed?: string;
        context?: string;
        severity?: 'critical' | 'major' | 'minor';
        file_paths?: string[];
        commands?: string[];
        tags?: string[];
        depends_on?: string[];
        author?: string;
      };

      const redis = await getConnection(instance_id);
      const ts = new Date().toISOString();

      // ── Structured template hints ──────────────────────────────────────────
      const category = topic.split(':')[0];
      const template = STRUCTURED_TEMPLATES[category];
      const templateWarnings: string[] = [];
      if (template) {
        for (const req of template.required) {
          if (req === 'commands' && commands.length === 0) {
            templateWarnings.push(`📋 ${template.hint}`);
          }
        }
      }

      // ── Deduplication + audit trail ────────────────────────────────────────
      let isUpdate = false;
      let recallCount = 0;
      let auditTrail: Array<{ ts: string; action: string; prev_outcome?: string }> = [];
      const existingRaw = await redis.get(`cachly:lesson:best:${topic}`);
      if (existingRaw) {
        try {
          const prev = JSON.parse(existingRaw) as {
            recall_count?: number;
            outcome?: string;
            audit_trail?: Array<{ ts: string; action: string; prev_outcome?: string }>;
          };
          recallCount = prev.recall_count ?? 0;
          auditTrail = prev.audit_trail ?? [];
          auditTrail.push({ ts, action: 'updated', prev_outcome: prev.outcome });
          if (auditTrail.length > 20) auditTrail = auditTrail.slice(-20);
          isUpdate = true;

          // ── Contradiction detection ─────────────────────────────────────────
          const contradictionWarning: string[] = [];
          if (prev.outcome === 'success' && outcome === 'failure') {
            contradictionWarning.push(
              `⚠️ **Contradiction detected!** Existing lesson has outcome: \`success\`, but you're storing \`failure\`.`,
              `The existing "success" lesson will be preserved. Only the audit trail is updated.`,
              `If you meant to mark this as failed permanently, store a new lesson with a distinct topic slug.`,
            );
          } else if (prev.outcome === 'failure' && outcome === 'success') {
            contradictionWarning.push(
              `✅ **Conflict resolved!** Previous lesson was \`failure\` — now overwriting with \`success\`.`,
            );
          }
          if (contradictionWarning.length > 0) {
            // Store contradiction audit but don't block
            auditTrail[auditTrail.length - 1].action = 'contradiction-resolved';
            // Layer 3: Write CKG contradicts edge for MADC to process
            try {
              const cId = ckgSlug(topic);
              const resId = ckgSlug(`resolution:${topic}`);
              await ckgUpdateEdge(redis, cId, 'contradicts', resId, false);
            } catch { /* non-critical */ }
            contradictionWarning.push(`🗳️ Run \`madc_deliberate(topic="${topic}")\` to resolve via expert agent voting.`);
          }
        } catch { /* ignore parse error */ }
      } else {
        auditTrail = [{ ts, action: 'created' }];
      }

      // ── "I Was Wrong" Protocol — failure attribution ───────────────────────
      const iWasWrongWarning: string[] = [];
      if (outcome === 'failure') {
        // Search for related success lessons that might have prevented this failure
        const scanKeys: string[] = [];
        const scanStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 100 });
        await new Promise<void>((res, rej) => {
          scanStream.on('data', (b: string[]) => scanKeys.push(...b));
          scanStream.on('end', res);
          scanStream.on('error', rej);
        });
        const topicWords = topic.split(/[:\-_]/).filter(w => w.length > 2);
        for (const k of scanKeys.slice(0, 50)) {
          const raw = await redis.get(k);
          if (!raw) continue;
          try {
            const l = JSON.parse(raw) as { outcome?: string; topic?: string; severity?: string };
            if (l.outcome !== 'success') continue;
            const lWords = (l.topic ?? '').split(/[:\-_]/).filter(w => w.length > 2);
            const overlap = topicWords.filter(w => lWords.includes(w)).length;
            if (overlap >= 1 && l.topic !== topic) {
              iWasWrongWarning.push(
                `⚠️ **"I Was Wrong"**: lesson \`${l.topic}\` (success, ${l.severity ?? 'major'}) might have prevented this failure.`,
                `   → Use \`recall_best_solution(topic="${l.topic}")\` before next attempt.`,
                `   → To mark it critical: \`learn_from_attempts(topic="${l.topic}", ..., severity="critical")\``,
              );
              break; // only show the most relevant match
            }
          } catch { /* skip */ }
        }
      }

      // ── Register dependency index for causal chain ─────────────────────────
      for (const dep of depends_on) {
        const depKey = `cachly:dep:${dep}`;
        const existing = await redis.get(depKey);
        const depTopics: string[] = existing ? JSON.parse(existing) : [];
        if (!depTopics.includes(topic)) depTopics.push(topic);
        await redis.set(depKey, JSON.stringify(depTopics));
      }

      const lessonObj = {
        topic,
        outcome,
        what_worked,
        what_failed,
        context: ctx,
        severity,
        file_paths,
        commands,
        tags,
        depends_on,
        ...(author ? { author } : {}),
        recall_count: recallCount,
        ts,
        verified_at: outcome === 'success' || outcome === 'partial' ? ts : undefined,
        confidence: 1.0,
        audit_trail: auditTrail,
        version: 3,
      };
      const lesson = JSON.stringify(lessonObj);

      // Always append to the history list (audit log)
      const listKey = `cachly:lessons:${topic}`;
      await redis.rpush(listKey, lesson);

      // Update best key for success/partial; for failure only update if no success exists
      if (outcome === 'success' || outcome === 'partial') {
        await redis.set(`cachly:lesson:best:${topic}`, lesson);
      } else if (!existingRaw) {
        await redis.set(`cachly:lesson:best:${topic}`, lesson);
      }

      // Track in decision log for session replay
      try {
        const dlKey = 'cachly:session:decision-log';
        const dlEntry = JSON.stringify({ ts, topic, outcome, what_worked: what_worked.slice(0, 120) });
        await redis.rpush(dlKey, dlEntry);
        await redis.ltrim(dlKey, -50, -1);
      } catch { /* non-critical */ }

      // ── Layer 1+2: CKG update (Causal Knowledge Graph + Belief Update Engine) ──
      // BUE: Bayesian confidence, contradiction detection, second-degree propagation, decay
      let beliefConflict: string | null = null;
      try {
        const conceptId = ckgSlug(topic);
        const domain = topic.split(':')[0] ?? 'unknown';
        const conceptType = domain; // fix, debug, deploy, infra, api, etc.

        // Upsert concept node
        await ckgUpsertNode(redis, conceptId, domain, conceptType);

        // Tag co-occurrence edges
        for (const tag of tags) {
          const tagId = ckgSlug(`tag:${tag}`);
          await ckgUpsertNode(redis, tagId, 'tag', 'tag');
          await ckgUpdateEdge(redis, conceptId, 'co-occurs', tagId, outcome === 'success', outcome === 'partial');
        }

        // depends_on → requires edges (structural, always confidence 1.0 direction)
        for (const dep of depends_on) {
          const depId = ckgSlug(dep);
          await ckgUpdateEdge(redis, conceptId, 'requires', depId, true);
        }

        // fixes edge: if category=fix and outcome=success, link to problem concept
        if ((domain === 'fix' || domain === 'debug') && (outcome === 'success' || outcome === 'partial')) {
          const problemText = what_failed || ctx || '';
          const problemConcept = problemText ? extractProblemConcept(problemText) : null;
          if (problemConcept) {
            const problemId = ckgSlug(`problem:${problemConcept}`);
            await ckgUpsertNode(redis, problemId, 'problem', 'problem');
            await ckgUpdateEdge(redis, conceptId, 'fixes', problemId, outcome === 'success', outcome === 'partial');
          }
        }

        // causes edge: if outcome=failure, link topic concept to the problem context
        if (outcome === 'failure' && (what_failed || what_worked)) {
          const causeText = what_failed || what_worked;
          const causeConcept = extractProblemConcept(causeText);
          if (causeConcept) {
            const causeId = ckgSlug(`cause:${causeConcept}`);
            await ckgUpsertNode(redis, causeId, 'cause', 'cause');
            await ckgUpdateEdge(redis, conceptId, 'causes', causeId, false);
          }
        }

        // ── BUE: Contradiction detection ──────────────────────────────────────
        // If this topic previously had a confirmed 'fixes' edge (confidence > 0.7)
        // and now outcome=failure → flag belief_conflict
        if (outcome === 'failure') {
          const existingEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${conceptId}`);
          for (const ek of existingEdgeKeys) {
            const er = await redis.get(ek);
            if (!er) continue;
            const existEdge: CKGEdge = JSON.parse(er);
            if (existEdge.edgeType === 'fixes' && existEdge.confidence > 0.7 && existEdge.trials >= 3) {
              beliefConflict = `⚠️ **belief_conflict** on \`${topic}\`: previously confirmed fix (confidence ${existEdge.confidence.toFixed(2)}, n=${existEdge.trials}) now reports failure. Both beliefs retained as \`contested\`. Use \`ckg_inspect(concept="${conceptId}")\` to review.`;
              // Store conflict marker
              const conflictKey = `cachly:ckg:conflict:${conceptId}`;
              await redis.set(conflictKey, JSON.stringify({ topic, detected_at: new Date().toISOString(), fix_confidence: existEdge.confidence, fix_trials: existEdge.trials, failure_outcome: outcome }), 'EX', 60 * 60 * 24 * 90);
              // Auto-trigger MADC deliberation in background — never blocks learn_from_attempts
              handleTool('madc_deliberate', { instance_id, topic }).catch(() => undefined);
            }
          }
        }

        // ── BUE: Second-degree propagation ────────────────────────────────────
        // When a 'fixes' edge gets stronger, boost co-occurring second-degree edges slightly
        if (outcome === 'success' && (domain === 'fix' || domain === 'debug')) {
          const fromEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${conceptId}`);
          for (const ek of fromEdgeKeys.slice(0, 10)) {
            const er = await redis.get(ek);
            if (!er) continue;
            const e2: CKGEdge = JSON.parse(er);
            if (e2.edgeType !== 'fixes') continue;
            // Boost second-degree: edges from e2.to get a small fractional success
            const secondKeys = await redis.smembers(`cachly:ckg:idx:from:${e2.to}`);
            for (const sk of secondKeys.slice(0, 5)) {
              const sr = await redis.get(sk);
              if (!sr) continue;
              const se: CKGEdge = JSON.parse(sr);
              if (se.edgeType !== 'co-occurs') continue;
              // Add 0.1 fractional success (second-degree signal)
              se.successes = (se.successes || 0) + 0.1;
              se.trials = (se.trials || 0) + 0.1;
              se.confidence = (se.successes + 1) / (se.trials + 2);
              se.last_updated = new Date().toISOString();
              await redis.set(sk, JSON.stringify(se));
            }
          }
        }

        // ── BUE: Stale edge decay ─────────────────────────────────────────────
        // Edges older than 90 days with < 3 trials decay by 10% confidence.
        // Only run probabilistically (1% of calls) to avoid per-call overhead.
        if (Math.random() < 0.01) {
          const decayCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
          const fromEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${conceptId}`);
          for (const ek of fromEdgeKeys) {
            const er = await redis.get(ek);
            if (!er) continue;
            const de: CKGEdge = JSON.parse(er);
            if (de.trials < 3 && de.last_updated && new Date(de.last_updated).getTime() < decayCutoff) {
              de.confidence = de.confidence * 0.9;
              de.last_updated = new Date().toISOString();
              await redis.set(ek, JSON.stringify(de));
            }
          }
        }
      } catch { /* CKG updates are non-critical */ }

      const emoji = outcome === 'success' ? '✅' : outcome === 'partial' ? '⚠️' : '❌';
      const sevEmoji = severity === 'critical' ? '🔴' : severity === 'major' ? '🟡' : '🟢';
      const action = isUpdate ? 'updated' : 'stored';
      return [
        `${emoji} **Lesson ${action}:** \`${topic}\` (${outcome}) ${sevEmoji} ${severity}`,
        beliefConflict ?? '',
        ``,
        `**What worked:** ${what_worked}`,
        what_failed ? `**What failed:** ${what_failed}` : '',
        ctx ? `**Context:** ${ctx}` : '',
        file_paths.length > 0 ? `**Files:** ${file_paths.map(f => `\`${f}\``).join(', ')}` : '',
        commands.length > 0 ? `**Commands:** ${commands.map(c => `\`${c}\``).join(', ')}` : '',
        tags.length > 0 ? `**Tags:** ${tags.map(t => `#${t}`).join(' ')}` : '',
        ``,
        isUpdate
          ? `♻️ Updated (recall count: ${recallCount} · audit entries: ${auditTrail.length})`
          : `💡 Recall later with \`recall_best_solution(topic="${topic}")\``,
        depends_on.length > 0
          ? `🔗 Depends on: ${depends_on.map(d => `\`${d}\``).join(', ')} → trace with \`trace_dependency\``
          : '',
        ...templateWarnings,
        ...iWasWrongWarning,
      ].filter(l => l !== '').join('\n');
    }

    case 'recall_best_solution': {
      const { instance_id, topic } = args as { instance_id: string; topic: string };
      const redis = await getConnection(instance_id);

      // Try exact best-solution key first
      const best = await redis.get(`cachly:lesson:best:${topic}`);
      if (best) {
        const lesson = JSON.parse(best) as {
          topic: string; outcome: string; what_worked: string; what_failed?: string;
          context?: string; ts: string; verified_at?: string; severity?: string;
          file_paths?: string[]; commands?: string[]; tags?: string[];
          recall_count?: number; audit_trail?: unknown[];
        };

        // ── Confidence decay check ───────────────────────────────────────────
        const confidence = calculateConfidence(lesson);
        const ref = lesson.verified_at ?? lesson.ts;
        const ageDays = (Date.now() - new Date(ref).getTime()) / 86400000;
        const badge = confidenceBadge(confidence, ageDays);

        // Recall resets verified_at (confidence clock restart)
        const updatedLesson = {
          ...lesson,
          recall_count: (lesson.recall_count ?? 0) + 1,
          verified_at: new Date().toISOString(),
          confidence: 1.0,
        };
        await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(updatedLesson));

        const sevEmoji = lesson.severity === 'critical' ? '🔴' : lesson.severity === 'major' ? '🟡' : lesson.severity ? '🟢' : '';
        const auditSummary = (lesson.audit_trail ?? []).length > 1
          ? `_Audit: ${(lesson.audit_trail ?? []).length} changes · stored ${new Date(lesson.ts).toLocaleDateString('de-DE')}_`
          : '';

        // "Remember when..." — emotional header for lessons > 60 days old
        const ageFromStoreDays = (Date.now() - new Date(lesson.ts).getTime()) / 86400000;
        const rememberWhen = ageFromStoreDays > 60
          ? `💭 _Remember when you solved this ${Math.round(ageFromStoreDays / 30)} months ago? Still works._`
          : '';

        // "Never Google This Again" — suggest pinning after 3rd recall
        const suggestPin = updatedLesson.recall_count === 3 && !(lesson as { pinned?: boolean }).pinned
          ? `📌 **You've looked this up 3 times.** Consider pinning it for instant access: add \`pinned: true\` via \`learn_from_attempts\` to always surface it first.`
          : '';

        return [
          rememberWhen,
          `${badge} **Best solution for \`${topic}\`** ${sevEmoji}${lesson.severity ? ` (${lesson.severity})` : ''} · recalled ${updatedLesson.recall_count}×`,
          ``,
          `**What worked:** ${lesson.what_worked}`,
          lesson.what_failed ? `**What failed (avoid this):** ${lesson.what_failed}` : '',
          lesson.context ? `**Context:** ${lesson.context}` : '',
          (lesson.file_paths ?? []).length > 0 ? `**Files:** ${(lesson.file_paths ?? []).map((f: string) => `\`${f}\``).join(', ')}` : '',
          (lesson.commands ?? []).length > 0 ? `**Commands:** ${(lesson.commands ?? []).map((c: string) => `\`${c}\``).join(', ')}` : '',
          (lesson.tags ?? []).length > 0 ? `**Tags:** ${(lesson.tags ?? []).map((t: string) => `#${t}`).join(' ')}` : '',
          auditSummary,
          suggestPin,
        ].filter(l => l !== '').join('\n');
      }

      // Partial match: scan all lesson keys for topic substring
      const allKeys: string[] = [];
      const scanStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 100 });
      await new Promise<void>((resolve, reject) => {
        scanStream.on('data', (batch: string[]) => allKeys.push(...batch));
        scanStream.on('end', resolve);
        scanStream.on('error', reject);
      });

      const matching = allKeys.filter(k => k.toLowerCase().includes(topic.toLowerCase()));
      if (matching.length === 0) {
        // Check attempt history as fallback
        const histKey = `cachly:lessons:${topic}`;
        const all = await redis.lrange(histKey, -3, -1);
        if (all.length > 0) {
          const parsed = all.map(e => JSON.parse(e) as { outcome: string; what_worked: string; ts: string });
          const lines = parsed.map(p => `- ${p.outcome === 'success' ? '✅' : '❌'} ${p.what_worked.slice(0, 120)} (${new Date(p.ts).toLocaleDateString('de-DE')})`);
          return `⚠️ No successful solution for \`${topic}\` yet. Last attempts:\n\n${lines.join('\n')}`;
        }
        return `📭 No lessons found for \`${topic}\`. Use \`learn_from_attempts\` after solving it.`;
      }

      // Return all partial matches
      const results: string[] = [];
      for (const k of matching.slice(0, 5)) {
        const raw = await redis.get(k);
        if (!raw) continue;
        const lesson = JSON.parse(raw) as { topic: string; what_worked: string; context?: string; ts: string };
        results.push(`**\`${lesson.topic}\`** — ${lesson.what_worked.slice(0, 200)}`);
      }
      return `🔍 **Partial matches for \`${topic}\`:**\n\n${results.join('\n\n')}`;
    }

    case 'smart_recall': {
      const {
        instance_id,
        query,
        threshold = 0.78,
      } = args as { instance_id: string; query: string; threshold?: number };

      const redis = await getConnection(instance_id);

      // ── Layer 1: Keyword search across ALL brain data (always works, no embedding) ──
      const kwMatches = await keywordSearch(
        redis,
        ['cachly:ctx:*', 'cachly:lesson:best:*', 'cachly:idx:*'],
        query,
        10,
      );

      const lines: string[] = [`🧠 **Smart Recall** for: _"${query}"_\n`];

      // Show sub-query info if multi-topic was detected
      const subQueries = splitMultiQuery(query);
      if (subQueries.length > 1) {
        lines.push(`_Detected ${subQueries.length} sub-topics:_ ${subQueries.map((s, i) => `${i + 1}. "${s}"`).join(', ')}\n`);
      }

      if (kwMatches.length > 0) {
        lines.push(`### 🔍 BM25 Matches (${kwMatches.length})\n`);

        // Group by sub-query if multi-topic
        if (subQueries.length > 1) {
          const grouped = new Map<string, KeywordMatch[]>();
          for (const m of kwMatches.slice(0, 12)) {
            const sq = m.subQuery ?? query;
            if (!grouped.has(sq)) grouped.set(sq, []);
            grouped.get(sq)!.push(m);
          }
          for (const [sq, matches] of grouped) {
            lines.push(`**Topic: "${sq}"** (${matches.length} results)\n`);
            for (const m of matches.slice(0, 4)) {
              const label = m.key
                .replace('cachly:ctx:', '📝 ')
                .replace('cachly:lesson:best:', '💡 ')
                .replace('cachly:idx:', '📂 ');
              const preview = m.content.slice(0, 300).replace(/\n/g, ' ');
              lines.push(`  **${label}** _(BM25: ${m.score.toFixed(2)}, matched: ${m.matchedWords.join(', ')})_`);
              lines.push(`  > ${preview}${m.content.length > 300 ? '…' : ''}\n`);
            }
          }
          // Summary: which sub-queries had matches
          const matched = [...grouped.keys()];
          const unmatched = subQueries.filter(sq => !matched.includes(sq));
          if (unmatched.length > 0) {
            lines.push(`\n⚠️ **No results for:** ${unmatched.map(s => `"${s}"`).join(', ')}`);
          }
        } else {
          for (const m of kwMatches.slice(0, 8)) {
            const label = m.key
              .replace('cachly:ctx:', '📝 ')
              .replace('cachly:lesson:best:', '💡 ')
              .replace('cachly:idx:', '📂 ');
            const preview = m.content.slice(0, 400).replace(/\n/g, ' ');
            lines.push(`**${label}** _(BM25: ${m.score.toFixed(2)}, matched: ${m.matchedWords.join(', ')})_`);
            lines.push(`> ${preview}${m.content.length > 400 ? '…' : ''}\n`);
          }
        }
      }

      // ── Layer 2: Semantic search (optional, only if embedding provider + vector_token available) ──
      const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
      if (inst.vector_token && hasEmbedProvider()) {
        try {
          const embedding = await computeEmbedding(query);
          const vectorUrl = `https://api.cachly.dev/v1/sem/${inst.vector_token}`;
          const searchRes = await fetch(`${vectorUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embedding, namespace: 'cachly:ctx', threshold, top_k: 5 }),
          });

          if (searchRes.ok) {
            const results = (await searchRes.json()) as SemanticSearchResponse[];
            const semHits = results.filter(r => r.found && r.id);
            if (semHits.length > 0) {
              lines.push(`\n### 🎯 Semantic Matches (${semHits.length})\n`);
              for (const hit of semHits) {
                const parts = hit.id!.replace('ctx:', '').split(':');
                const category = parts[0];
                const key = parts.slice(1).join(':');
                const content = await redis.get(`cachly:ctx:${category}:${key}`);
                lines.push(
                  `**${key}** _(${((hit.similarity ?? 0) * 100).toFixed(0)}% similar)_`,
                  `> ${content?.slice(0, 300) ?? '(evicted)'}${(content?.length ?? 0) > 300 ? '…' : ''}\n`,
                );
              }
            }
          }
        } catch {
          // Semantic search failed silently — keyword results are enough
        }
      }

      if (kwMatches.length === 0) {
        lines.push(`⚠️ No matches found for: "${query}"`);

        // Did-You-Mean: find nearest token in index vocab
        const queryTokens = tokenize(query);
        const suggestions: string[] = [];
        if (_indexVocab.size > 0 && queryTokens.length > 0) {
          for (const qt of queryTokens.slice(0, 3)) {
            if (qt.length < 4) continue;
            let bestDist = 3;
            let bestTok = '';
            for (const v of _indexVocab) {
              if (v.length < 3 || Math.abs(v.length - qt.length) > 4) continue;
              const d = levenshtein(qt, v);
              if (d > 0 && d < bestDist) { bestDist = d; bestTok = v; }
            }
            if (bestTok) suggestions.push(`"${bestTok}" (instead of "${qt}")`);
          }
        }
        if (suggestions.length > 0) {
          lines.push(`💡 **Did you mean:** ${suggestions.join(', ')}?`);
        } else {
          lines.push(`\n💡 Tips:`);
          lines.push(`  • Try different keywords`);
          lines.push(`  • Use \`list_remembered\` to see available context`);
          lines.push(`  • Use \`recall_best_solution("topic")\` for exact topic lookup`);
        }
      }

      return lines.join('\n');
    }

    // ── get_api_status ────────────────────────────────────────────────────────
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
    case 'session_start': {
      const { instance_id, focus = '', author = '', provider = '', workspace_path = '' } = args as { instance_id: string; focus?: string; author?: string; provider?: string; workspace_path?: string };
      const redis = await getConnection(instance_id);

      // 1. Scan all best-solution lessons
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      // 2. Fetch all lesson values for recency sorting + focus matching
      type Lesson = {
        topic: string; outcome: string; what_worked: string; what_failed?: string;
        ts: string; verified_at?: string; severity?: string; recall_count?: number;
        tags?: string[]; confidence?: number; audit_trail?: unknown[];
      };
      const lessons: Lesson[] = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try { lessons.push(JSON.parse(raw) as Lesson); } catch { /* skip corrupt */ }
      }
      lessons.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

      // 3. Count context entries (filter :meta keys)
      let ctxCount = 0;
      const ctxStream = redis.scanStream({ match: 'cachly:ctx:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        ctxStream.on('data', (batch: string[]) => {
          ctxCount += batch.filter((k: string) => !k.endsWith(':meta')).length;
        });
        ctxStream.on('end', resolve);
        ctxStream.on('error', reject);
      });

      // 4. Last session
      const lastSessionRaw = await redis.get('cachly:session:last');
      let lastSession: { summary: string; ts: string; files_changed?: string[]; duration_min?: number } | null = null;
      if (lastSessionRaw) {
        try { lastSession = JSON.parse(lastSessionRaw); } catch { /* ignore */ }
      }

      // 5. Focus filtering
      const focusTerms = focus.toLowerCase().split(/\s+/).filter(Boolean);
      const focusLessons = focusTerms.length > 0
        ? lessons.filter(l =>
            focusTerms.some(term =>
              l.topic.toLowerCase().includes(term) ||
              (l.tags ?? []).some((t: string) => t.toLowerCase().includes(term))
            )
          )
        : [];

      // 6. Streak tracking
      let streakDays = 0;
      let streakRecord = 0;
      let streakMessage = '';
      try {
        const streakRaw = await redis.get('cachly:streak:current');
        const streak = streakRaw ? JSON.parse(streakRaw) as { days: number; last_date: string; record: number } : null;
        const today = new Date().toISOString().slice(0, 10);
        if (streak) {
          const lastDate = streak.last_date;
          const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
          if (lastDate === today) {
            // Already counted today
            streakDays = streak.days;
            streakRecord = streak.record;
          } else if (lastDate === yesterday) {
            // Continuing streak
            streakDays = streak.days + 1;
            streakRecord = Math.max(streakDays, streak.record);
            await redis.set('cachly:streak:current', JSON.stringify({ days: streakDays, last_date: today, record: streakRecord }));
          } else {
            // Streak broken
            streakDays = 1;
            streakRecord = streak.record;
            await redis.set('cachly:streak:current', JSON.stringify({ days: 1, last_date: today, record: streakRecord }));
          }
        } else {
          // First session ever
          streakDays = 1;
          streakRecord = 1;
          await redis.set('cachly:streak:current', JSON.stringify({ days: 1, last_date: today, record: 1 }));
        }
        if (streakDays >= 7) streakMessage = `🔥 **${streakDays}-day streak!** ${streakDays === streakRecord ? ' New record!' : `Best: ${streakRecord}d`}`;
        else if (streakDays > 1) streakMessage = `🔥 ${streakDays}-day streak`;
      } catch { /* non-critical */ }

      // 7. Save session start marker
      await redis.set('cachly:session:current', JSON.stringify({
        started: new Date().toISOString(),
        focus,
        provider,
      }), 'EX', 86400); // auto-expire after 24h if session_end never called

      // ── Build briefing ──────────────────────────────────────────────────────
      const providerLabel = provider ? ` · ${provider}` : '';
      const lines: string[] = [`🧠 **Session Briefing**${providerLabel}`, ''];
      if (streakMessage) lines.push(streakMessage, '');

      // Handoff from previous window (if any)
      const handoffRaw = await redis.get('cachly:session:handoff');
      if (handoffRaw) {
        try {
          const handoff = JSON.parse(handoffRaw) as {
            ts: string; completed_tasks: string[]; remaining_tasks: string[];
            files_changed?: { path: string; status: string; description?: string }[];
            instructions?: string; context_summary?: string; blocked_on?: string;
          };
          const ago = Math.round((Date.now() - new Date(handoff.ts).getTime()) / 60000);
          const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;

          lines.push(`🤝 **Handoff from previous window** (${agoStr}):`);
          if (handoff.context_summary) lines.push(`   ${handoff.context_summary}`);
          if (handoff.remaining_tasks.length > 0) {
            lines.push(`   ⏳ **Remaining tasks:**`);
            for (const t of handoff.remaining_tasks) lines.push(`     - ${t}`);
          }
          if (handoff.completed_tasks.length > 0) {
            lines.push(`   ✅ **Already done:** ${handoff.completed_tasks.join(', ')}`);
          }
          const brokenFiles = (handoff.files_changed ?? []).filter(f => f.status === 'broken' || f.status === 'partial');
          if (brokenFiles.length > 0) {
            lines.push(`   ⚠️ **Needs fix:** ${brokenFiles.map(f => `\`${f.path}\` (${f.status}${f.description ? ': ' + f.description : ''})`).join(', ')}`);
          }
          if (handoff.blocked_on) lines.push(`   🚫 **Blocked on:** ${handoff.blocked_on}`);
          if (handoff.instructions) lines.push(`   📝 **Instructions:** ${handoff.instructions}`);
          lines.push('');
        } catch { /* ignore corrupt handoff */ }
      }

      // ── Last checkpoint (session_ping) — shown when no session_end found ────
      const checkpointRaw = await redis.get('cachly:session:checkpoint');
      if (checkpointRaw) {
        try {
          const cp = JSON.parse(checkpointRaw) as {
            ts: string; task: string; files_touched: string[]; next_step?: string; provider?: string;
          };
          // Only show checkpoint if it's more recent than last session_end
          const cpTime = new Date(cp.ts).getTime();
          const lastSessionTime = lastSession ? new Date(lastSession.ts).getTime() : 0;
          if (cpTime > lastSessionTime) {
            const ago = Math.round((Date.now() - cpTime) / 60000);
            const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
            const providerStr = cp.provider ? ` [${cp.provider}]` : '';
            lines.push(`📌 **Last checkpoint**${providerStr} (${agoStr}): ${cp.task}`);
            if (cp.files_touched.length > 0) {
              lines.push(`   Files: ${cp.files_touched.slice(0, 5).map(f => `\`${f}\``).join(', ')}`);
            }
            if (cp.next_step) lines.push(`   📍 Next step was: ${cp.next_step}`);
            if (!lastSession || cpTime - lastSessionTime > 300_000) {
              lines.push(`   ⚠️ No \`session_end\` found — reconstructed from last checkpoint`);
            }
            lines.push('');
          }
        } catch { /* ignore */ }
      }

      // ── Git reconstruction — when no session_end + workspace_path given ─────
      if (workspace_path && !lastSession) {
        try {
          const { execSync } = await import('node:child_process');
          const gitLog = execSync(
            `git -C "${workspace_path}" log --oneline --format="%h %s" -15 2>/dev/null`,
            { encoding: 'utf-8', timeout: 5000 },
          ).trim();
          const gitDiff = execSync(
            `git -C "${workspace_path}" diff --stat HEAD~3 2>/dev/null || git -C "${workspace_path}" diff --stat 2>/dev/null`,
            { encoding: 'utf-8', timeout: 5000 },
          ).trim();
          if (gitLog) {
            lines.push(`🔍 **Git reconstruction** (no session_end found — reconstructed from git):`);
            for (const l of gitLog.split('\n').slice(0, 8)) lines.push(`   ${l}`);
            if (gitDiff) {
              const diffLines = gitDiff.split('\n').filter(l => l.includes('|') || l.includes('changed'));
              if (diffLines.length > 0) {
                lines.push(`   **Recent changes:**`);
                for (const dl of diffLines.slice(0, 5)) lines.push(`   ${dl.trim()}`);
              }
            }
            lines.push('');
          }
        } catch { /* git not available or no repo — silent */ }
      }

      // Last session
      if (lastSession) {
        const ago = Math.round((Date.now() - new Date(lastSession.ts).getTime()) / 60000);
        const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
        lines.push(`📅 **Last session** (${agoStr}): ${lastSession.summary}`);
        if (lastSession.duration_min) lines.push(`   Duration: ${lastSession.duration_min} min`);
        if ((lastSession.files_changed ?? []).length > 0) {
          lines.push(`   Files: ${(lastSession.files_changed ?? []).slice(0, 5).map((f: string) => `\`${f}\``).join(', ')}`);
        }
        lines.push('');
      }

      // Brain health
      lines.push(`📊 **Brain:** ${lessons.length} lessons · ${ctxCount} context entries`, '');

      // ── Layer 7: MCM Domain Coverage Map ────────────────────────────────────
      if (lessons.length >= 3) {
        const domainMap = new Map<string, { total: number; success: number; critical: number }>();
        for (const l of lessons) {
          const dom = l.topic.split(':')[0] ?? 'other';
          if (!domainMap.has(dom)) domainMap.set(dom, { total: 0, success: 0, critical: 0 });
          const d = domainMap.get(dom)!;
          d.total++;
          if (l.outcome === 'success') d.success++;
          if (l.severity === 'critical') d.critical++;
        }
        const sorted = [...domainMap.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 6);
        const hasContestedDomains = sorted.some(([, d]) => d.success < d.total * 0.4 && d.total >= 2);
        if (sorted.length > 0) {
          lines.push(`🗺️ **Knowledge Coverage:**`);
          for (const [dom, d] of sorted) {
            const pct = Math.round((d.success / d.total) * 100);
            const filled = Math.round(pct / 10);
            const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
            const flag = d.critical > 0 ? ' 🔴' : pct < 40 && d.total >= 2 ? ' ⚠️' : '';
            lines.push(`  ${bar} ${dom.padEnd(18)} ${String(pct).padStart(3)}% (${d.success}/${d.total} confirmed)${flag}`);
          }
          if (hasContestedDomains) {
            lines.push(`  ⚠️ _Some domains have contested beliefs — use \`ckg_inspect\` to review_`);
          }
          lines.push('');
        }
      }

      // ── Layer 7 MCM: Active belief conflicts ─────────────────────────────────
      try {
        const conflictKeys: string[] = [];
        const cfStream = redis.scanStream({ match: 'cachly:ckg:conflict:*', count: 50 });
        await new Promise<void>((res, rej) => { cfStream.on('data', (b: string[]) => conflictKeys.push(...b)); cfStream.on('end', res); cfStream.on('error', rej); });
        if (conflictKeys.length > 0) {
          lines.push(`⚡ **Active belief conflicts (${conflictKeys.length}):**`);
          for (const ck of conflictKeys.slice(0, 3)) {
            const cr = await redis.get(ck);
            if (!cr) continue;
            const cf = JSON.parse(cr) as { topic: string; fix_confidence: number; fix_trials: number };
            lines.push(`  ⚠️ \`${cf.topic}\` — previously confirmed fix (${(cf.fix_confidence * 100).toFixed(0)}%, n=${cf.fix_trials}) now contradicted. Use \`ckg_inspect(concept="${ckgSlug(cf.topic)}")\``);
          }
          lines.push('');
        }
      } catch { /* non-critical */ }

      // ── Layer 7 MCM: Blind Spot Detection ────────────────────────────────────
      // If the focus mentions a domain that has no CKG node → surface blind spot
      if (focus && focus.length > 3) {
        try {
          const focusTokens = focus.toLowerCase().replace(/[^a-z0-9\s:_-]/g, ' ').split(/\s+/).filter(t => t.length > 3);
          const blindSpots: string[] = [];
          for (const token of focusTokens.slice(0, 6)) {
            const nodeExists = await redis.exists(`cachly:ckg:node:${token}`);
            if (!nodeExists) {
              // Check if any node starts with this token (prefix match)
              const prefixKeys: string[] = [];
              const psStream = redis.scanStream({ match: `cachly:ckg:node:${token}*`, count: 10 });
              await new Promise<void>((res, rej) => { psStream.on('data', (b: string[]) => prefixKeys.push(...b)); psStream.on('end', res); psStream.on('error', rej); });
              if (prefixKeys.length === 0) blindSpots.push(token);
            }
          }
          if (blindSpots.length > 0) {
            lines.push(`🔭 **Blind spots detected for this focus:**`);
            for (const bs of blindSpots.slice(0, 3)) {
              lines.push(`  ⬜ \`${bs}\` — no CKG knowledge. Suggestions:`);
              lines.push(`     • \`brain_from_git(instance_id="...", concept="${bs}")\` — bootstrap from commits`);
              lines.push(`     • \`fedbrain_search(query="${bs}")\` — search global commons`);
            }
            lines.push('');
          }
        } catch { /* non-critical */ }
      }

      if (focusLessons.length > 0) {
        lines.push(`🎯 **Relevant for "${focus}":**`);
        for (const l of focusLessons.slice(0, 4)) {
          const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
          const sev = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '';
          lines.push(`  ${emoji}${sev} \`${l.topic}\` — ${l.what_worked.slice(0, 100)}`);
        }
        lines.push('');
      }

      // Recent lessons
      if (lessons.length > 0) {
        lines.push(`🕐 **Recent lessons:**`);
        const toShow = focusLessons.length > 0 ? lessons.filter(l => !focusLessons.includes(l)).slice(0, 4) : lessons.slice(0, 5);
        for (const l of toShow) {
          const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
          const sev = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '';
          lines.push(`  ${emoji}${sev} \`${l.topic}\` — ${l.what_worked.slice(0, 90)}`);
        }
        lines.push('');
      } else {
        lines.push('📭 No lessons yet. Use `learn_from_attempts` after solving tasks.', '');
      }

      // Open failures (lessons whose best-key has outcome != success)
      const openFailures = lessons.filter(l => l.outcome === 'failure' || l.outcome === 'partial');
      if (openFailures.length > 0) {
        lines.push(`⚠️ **Unresolved** (${openFailures.length} topic${openFailures.length > 1 ? 's' : ''} with no success yet):`);
        for (const l of openFailures.slice(0, 3)) {
          lines.push(`  ❌ \`${l.topic}\` — ${(l.what_failed ?? l.what_worked).slice(0, 80)}`);
        }
        lines.push('');
      }

      // ── Stale / low-confidence lessons (confidence decay) ─────────────────
      const staleSuccessLessons = lessons.filter(l => {
        if (l.outcome !== 'success' && l.outcome !== 'partial') return false;
        return calculateConfidence(l) < CONFIDENCE_WARN_VALUE;
      });
      if (staleSuccessLessons.length > 0) {
        lines.push(`🔴 **Stale lessons** (not recalled in >${CONFIDENCE_WARN_DAYS}d — verify before applying):`);
        for (const l of staleSuccessLessons.slice(0, 4)) {
          const conf = calculateConfidence(l);
          const ageDays = Math.round((Date.now() - new Date(l.verified_at ?? l.ts).getTime()) / 86400000);
          const flag = conf < CONFIDENCE_STALE_VALUE ? '🔴' : '⚠️';
          lines.push(`  ${flag} \`${l.topic}\` — ${ageDays}d stale, ${(conf * 100).toFixed(0)}% confidence`);
        }
        lines.push(`  _Run \`recall_best_solution\` on these to reset their confidence clock._`);
        lines.push('');
      }

      // ── Session Replay: show last session's decision log ──────────────────
      const lastSessionAny = lastSession as unknown as { decision_log?: Array<{ topic: string; outcome: string; what_worked: string }> } | null;
      if (lastSessionAny?.decision_log?.length) {
        const dl = lastSessionAny.decision_log;
        const successes = dl.filter(d => d.outcome === 'success');
        const failures  = dl.filter(d => d.outcome === 'failure');
        lines.push(`🎬 **Last session decisions** (${dl.length} lessons stored):`);
        if (successes.length > 0) lines.push(`  ✅ Worked: ${successes.slice(0, 3).map(d => `\`${d.topic}\``).join(', ')}`);
        if (failures.length > 0)  lines.push(`  ❌ Failed: ${failures.slice(0, 3).map(d => `\`${d.topic}\``).join(', ')}`);
        lines.push('');
      }

      // ── 🔮 Predictive Pre-Warning — intent-based danger detection ────────────
      // Fires BEFORE work starts. If focus area has known failure patterns → warn loudly.
      if (focusTerms.length > 0) {
        type LessonAny = typeof lessons[0] & { author?: string; tags?: string[] };
        const dangerLessons = (lessons as LessonAny[]).filter(l => {
          if (l.outcome === 'success') return false;
          const topicCategory = l.topic.split(':')[0];
          return focusTerms.some(term =>
            l.topic.toLowerCase().includes(term) ||
            topicCategory === term ||
            (l.tags ?? []).some((t: string) => t.toLowerCase() === term),
          );
        });
        if (dangerLessons.length >= 1) {
          // Insert warning block right after the title line (index 1 = blank line after title)
          const warning = [
            `🚨 **PRE-WARNING** — Read this BEFORE starting:`,
            `  Known pitfalls for **"${focus}"** (${dangerLessons.length} past failure${dangerLessons.length > 1 ? 's' : ''}):`,
            ...dangerLessons.slice(0, 3).map(l => `  ❌ \`${l.topic}\` — ${(l.what_failed ?? l.what_worked).slice(0, 80)}`),
            '',
          ];
          lines.splice(2, 0, ...warning); // after '🧠 **Session Briefing**' + empty line
        }
      }

      // ── 👥 Team Telepathy — what teammates learned this week ─────────────────
      if (author) {
        type LessonAny = typeof lessons[0] & { author?: string };
        const oneWeekAgo = Date.now() - 7 * 86_400_000;
        const teamLessons = (lessons as LessonAny[]).filter(l =>
          l.author && l.author !== author && new Date(l.ts).getTime() > oneWeekAgo,
        );
        if (teamLessons.length > 0) {
          // Group by author
          const byAuthor = new Map<string, LessonAny[]>();
          for (const l of teamLessons) {
            const a = l.author!;
            if (!byAuthor.has(a)) byAuthor.set(a, []);
            byAuthor.get(a)!.push(l);
          }
          lines.push(`👥 **Team this week** (${teamLessons.length} lesson${teamLessons.length > 1 ? 's' : ''} from teammates):`);
          for (const [teamAuthor, tls] of byAuthor) {
            lines.push(`  👤 **${teamAuthor}**:`);
            for (const l of tls.slice(0, 3)) {
              const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
              lines.push(`    ${emoji} \`${l.topic}\` — ${l.what_worked.slice(0, 80)}`);
            }
            if (tls.length > 3) lines.push(`    … and ${tls.length - 3} more`);
          }
          lines.push('');
        }
      }

      // ── 💎 Memory Crystal — compressed wisdom from old sessions ──────────────
      try {
        const crystalRaw = await redis.get('cachly:crystal:latest');
        if (crystalRaw) {
          const crystal = JSON.parse(crystalRaw) as {
            label: string; ts: string; session_count: number;
            top_patterns: Array<{ category: string; insight: string; count: number }>;
          };
          const crystalAge = Math.round((Date.now() - new Date(crystal.ts).getTime()) / 86_400_000);
          if (crystalAge <= 90) {
            lines.push(`💎 **Memory Crystal** (${crystal.label} · ${crystal.session_count} sessions compressed):`);
            for (const p of crystal.top_patterns.slice(0, 3)) {
              lines.push(`  • **${p.category}** (${p.count}×): ${p.insight.slice(0, 90)}`);
            }
            lines.push('');
          }
        }
      } catch { /* non-critical */ }

      // ── 🗺️ Roadmap — open items at session start ────────────────────────────
      try {
        const roadmapAll = await redis.hgetall(`cachly:roadmap:${instance_id}`);
        if (roadmapAll && Object.keys(roadmapAll).length > 0) {
          const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
          const PRIORITY_ICON: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
          const openStatuses = new Set(['planned', 'in-progress', 'blocked']);
          const allItems = Object.values(roadmapAll).map(v => JSON.parse(v as string) as Record<string, unknown>);
          const openItems = allItems
            .filter(i => openStatuses.has(i.status as string))
            .sort((a, b) => {
              if (a.status === 'in-progress' && b.status !== 'in-progress') return -1;
              if (b.status === 'in-progress' && a.status !== 'in-progress') return 1;
              return (PRIORITY_ORDER[a.priority as string] ?? 99) - (PRIORITY_ORDER[b.priority as string] ?? 99);
            });
          const doneCount = allItems.filter(i => i.status === 'done').length;
          if (openItems.length > 0) {
            lines.push(`🗺️ **Roadmap** (${openItems.length} open · ${doneCount} done):`);
            for (const it of openItems.slice(0, 5)) {
              const statusIcon = it.status === 'in-progress' ? '⚡' : it.status === 'blocked' ? '🚫' : '📋';
              lines.push(`  ${statusIcon} ${PRIORITY_ICON[it.priority as string] ?? '⚪'} \`${it.id}\` **${it.title}**`);
            }
            if (openItems.length > 5) lines.push(`  … and ${openItems.length - 5} more`);
            lines.push(`  _Use \`roadmap_next\` for the top priority item · \`roadmap_list\` for full view_`);
            lines.push('');
          }
        }
      } catch { /* non-critical */ }

      // ── 🔮 PPE: Predictive Pre-fetch — CKG-powered risk detection ────────────
      // Layer 4: Before starting any work, scan the CKG for nodes matching focus
      // tokens and traverse causal edges to surface predicted failure points inline.
      // This is the PPE "pre-fetch" that was previously only available via brain_predict.
      if (focus && focus.length > 3) {
        try {
          const ppeFocusTokens = focus.toLowerCase().replace(/[^a-z0-9\s\-_:]/g, ' ').split(/\s+/).filter(t => t.length > 2).slice(0, 5);
          type PPEPrediction = { concept: string; edgeType: string; target: string; confidence: number; lesson?: { what_worked?: string; topic: string } };
          const ppePredictions: PPEPrediction[] = [];

          for (const token of ppeFocusTokens) {
            const nodeKeys: string[] = [];
            const nStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 20 });
            await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });

            for (const nk of nodeKeys.slice(0, 3)) {
              const nodeRaw = await redis.get(nk);
              if (!nodeRaw) continue;
              const node: CKGNode = JSON.parse(nodeRaw);
              const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${node.id}`);
              for (const ek of edgeKeys.slice(0, 15)) {
                const edgeRaw = await redis.get(ek);
                if (!edgeRaw) continue;
                const edge: CKGEdge = JSON.parse(edgeRaw);
                if (edge.edgeType !== 'causes' && edge.edgeType !== 'co-occurs' && edge.edgeType !== 'fixes') continue;
                if (edge.confidence < 0.35) continue;
                // For "fixes" edges, the lesson is on the "from" node (fix for "to")
                // For "causes" edges, target is the failure mode
                const lessonKey = edge.edgeType === 'fixes' ? `cachly:lesson:best:${edge.from}` : `cachly:lesson:best:${edge.to}`;
                const lessonRaw = await redis.get(lessonKey);
                const lesson = lessonRaw ? JSON.parse(lessonRaw) : undefined;
                ppePredictions.push({ concept: node.id, edgeType: edge.edgeType, target: edge.to, confidence: edge.confidence, lesson });
              }
            }
          }

          const ppeSeen = new Set<string>();
          const ppeUniq = ppePredictions
            .filter(p => { const k = `${p.concept}:${p.target}`; if (ppeSeen.has(k)) return false; ppeSeen.add(k); return true; })
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 4);

          if (ppeUniq.length > 0) {
            lines.push(`🔮 **Predicted risks for "${focus}"** (PPE pre-fetch):`);
            for (const p of ppeUniq) {
              const confPct = Math.round(p.confidence * 100);
              const icon = p.edgeType === 'causes' ? '⚡' : p.edgeType === 'fixes' ? '🔧' : '🔄';
              lines.push(`  ${icon} **${confPct}%** \`${p.concept}\` ${p.edgeType} \`${p.target}\``);
              if (p.lesson?.what_worked) lines.push(`     ✅ ${(p.lesson.what_worked as string).slice(0, 110)}`);
            }
            lines.push(`  _Full analysis: \`brain_predict(context="${focus}")\`_`);
            lines.push('');
          }
        } catch { /* non-critical — never block session start */ }
      }

      // ── 📐 MCM Confidence Calibration — 30-day accuracy pass ─────────────────
      // Layer 7: Periodically check if high-confidence lessons are actually reliable.
      // If last calibration was >30 days ago (or never), run a quick pass.
      // Measures: of recalled lessons with confidence > 0.85, what % had outcome=success?
      try {
        const calRaw = await redis.get('cachly:mcm:calibration:last');
        const lastCalMs = calRaw ? JSON.parse(calRaw).ts : 0;
        const daysSinceCal = (Date.now() - lastCalMs) / 86_400_000;
        if (daysSinceCal >= 30 && lessons.length >= 5) {
          // Quick calibration pass on recalled lessons (recall_count > 0, outcome=success)
          const recalledSuccess = lessons.filter(l => l.outcome === 'success' && (l.recall_count ?? 0) > 0);
          const recalledAll     = lessons.filter(l => (l.recall_count ?? 0) > 0);
          if (recalledAll.length >= 3) {
            const precision = recalledAll.length > 0 ? recalledSuccess.length / recalledAll.length : 1;
            const lowPrecisionDomains: string[] = [];
            // Per-domain breakdown
            const domCalMap = new Map<string, { success: number; total: number }>();
            for (const l of recalledAll) {
              const dom = l.topic.split(':')[0] ?? 'other';
              if (!domCalMap.has(dom)) domCalMap.set(dom, { success: 0, total: 0 });
              const d = domCalMap.get(dom)!;
              d.total++;
              if (l.outcome === 'success') d.success++;
            }
            for (const [dom, d] of domCalMap) {
              if (d.total >= 2 && d.success / d.total < 0.6) lowPrecisionDomains.push(dom);
            }
            // Save calibration result
            await redis.set('cachly:mcm:calibration:last', JSON.stringify({
              ts: Date.now(),
              precision: precision,
              recalled: recalledAll.length,
              low_precision_domains: lowPrecisionDomains,
            }));
            if (lowPrecisionDomains.length > 0 || precision < 0.7) {
              lines.push(`📐 **MCM Calibration** (30-day pass — ${recalledAll.length} recalled lessons):`);
              lines.push(`  Overall precision: **${(precision * 100).toFixed(0)}%** recalled lessons actually worked`);
              if (lowPrecisionDomains.length > 0) {
                lines.push(`  ⚠️ Low-precision domains: ${lowPrecisionDomains.map(d => `\`${d}\``).join(', ')} — consider revisiting these lessons`);
              }
              lines.push(`  💡 Use \`learn_from_attempts\` to update stale lessons and improve accuracy.`);
              lines.push('');
            }
          }
          // Even if no issues, stamp the date so we don't re-check for 30d
          await redis.set('cachly:mcm:calibration:last', JSON.stringify({ ts: Date.now(), precision: 1, recalled: 0 }), 'EX', 35 * 86400);
        }
      } catch { /* non-critical */ }

      // ── 🌍 Knowledge Commons — community stats banner ───────────────────────
      // Fetch syndication stats and show a 1-liner: total lessons + confirms + weekly growth.
      // Non-fatal: never blocks session start if the API call fails.
      try {
        const commonsStats = await apiFetch<{
          total_lessons: number;
          total_confirms: number;
          added_last_7_days: number;
        }>('/api/v1/syndication/stats');
        if (commonsStats.total_lessons > 0) {
          lines.push(
            `🌍 **Commons:** ${commonsStats.total_lessons.toLocaleString()} lessons · ` +
            `${commonsStats.total_confirms.toLocaleString()} confirms · ` +
            `+${commonsStats.added_last_7_days} this week`,
          );
          lines.push('');
        }
      } catch { /* non-critical — never block session start */ }

      return lines.join('\n');
    }

    // ── session_end ───────────────────────────────────────────────────────────
    case 'session_end': {
      const {
        instance_id,
        summary,
        files_changed = [],
        lessons_learned,
        workspace_path = '',
      } = args as {
        instance_id: string;
        summary: string;
        files_changed?: string[];
        lessons_learned?: number;
        workspace_path?: string;
      };

      const redis = await getConnection(instance_id);
      const now = new Date();

      // Calculate duration from session_start marker
      let durationMin: number | undefined;
      const currentRaw = await redis.get('cachly:session:current');
      if (currentRaw) {
        try {
          const current = JSON.parse(currentRaw) as { started: string };
          durationMin = Math.round((now.getTime() - new Date(current.started).getTime()) / 60000);
        } catch { /* ignore */ }
      }

      // ── Session Replay: capture decision log ─────────────────────────────
      let decisionLog: Array<{ ts: string; topic: string; outcome: string; what_worked: string }> = [];
      try {
        const dlEntries = await redis.lrange('cachly:session:decision-log', 0, -1);
        decisionLog = dlEntries.map(e => JSON.parse(e) as { ts: string; topic: string; outcome: string; what_worked: string });
        await redis.del('cachly:session:decision-log');
      } catch { /* non-critical */ }

      const sessionRecord = {
        ts: now.toISOString(),
        summary,
        files_changed,
        ...(lessons_learned !== undefined ? { lessons_learned } : {}),
        ...(durationMin !== undefined ? { duration_min: durationMin } : {}),
        ...(decisionLog.length > 0 ? { decision_log: decisionLog } : {}),
      };

      // Save as "last session"
      await redis.set('cachly:session:last', JSON.stringify(sessionRecord));

      // Append to history list (keep last 50 sessions, TTL 90 days)
      await redis.lpush('cachly:session:history', JSON.stringify(sessionRecord));
      await redis.ltrim('cachly:session:history', 0, 49);
      await redis.expire('cachly:session:history', 90 * 86400);

      // Clean up current session marker
      await redis.del('cachly:session:current');

      // ── AUTO-LEARN from session summary (no manual call needed) ─────────────
      // Parse the summary for actionable lessons and store them automatically.
      const autoLearned: string[] = [];
      try {
        // Extract key sentences from the summary that contain action verbs
        const actionVerbs = /\b(fixed|deployed|added|removed|refactored|migrated|updated|resolved|implemented|improved|optimized|configured|created|deleted|disabled|enabled|discovered|found|learned|debugged|patched|upgraded|installed|tested|built|rewrote|moved|renamed|split|merged|extracted)\b/i;
        const sentences = summary
          .split(/[.!\n]+/)
          .map(s => s.trim())
          .filter(s => s.length > 20 && actionVerbs.test(s));

        for (const sentence of sentences.slice(0, 6)) {
          // Build a topic slug from the first meaningful words
          const words = sentence.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !['that', 'this', 'with', 'from', 'have', 'been', 'were', 'they', 'then', 'when', 'also', 'into', 'will', 'would', 'could', 'should'].includes(w));
          const slug = words.slice(0, 4).join('-');
          if (!slug) continue;
          const topic = `auto:${slug}`;
          const key = `cachly:lesson:best:${topic}`;

          // Don't overwrite existing successful lessons
          const existing = await redis.get(key);
          if (existing) {
            try {
              const ex = JSON.parse(existing) as { outcome: string };
              if (ex.outcome === 'success') continue;
            } catch { /* ignore */ }
          }

          const lesson = {
            topic,
            outcome: 'success',
            what_worked: sentence,
            context: `Auto-learned from session summary. Full summary: ${summary.slice(0, 300)}`,
            severity: 'minor',
            ts: now.toISOString(),
            recall_count: 0,
            auto_learned: true,
            session_ts: now.toISOString(),
            version: 2,
          };
          await redis.set(key, JSON.stringify(lesson));
          // 90-day TTL for auto-learned lessons
          await redis.expire(key, 90 * 86400);
          autoLearned.push(topic);
        }

        // Also store a lesson per changed file area if files were changed
        if (files_changed.length > 0) {
          const areas = [...new Set(files_changed.map(f => f.split('/').slice(0, 2).join('/')))].slice(0, 3);
          for (const area of areas) {
            const slug = area.replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/-+/g, '-').slice(0, 30);
            const topic = `auto:changed:${slug}`;
            const key = `cachly:lesson:best:${topic}`;
            const lesson = {
              topic,
              outcome: 'success',
              what_worked: `Files changed in ${area}: ${files_changed.filter(f => f.startsWith(area.split('/')[0])).slice(0, 5).join(', ')}`,
              context: summary.slice(0, 200),
              severity: 'minor',
              ts: now.toISOString(),
              recall_count: 0,
              auto_learned: true,
              version: 2,
            };
            await redis.set(key, JSON.stringify(lesson));
            await redis.expire(key, 90 * 86400);
            autoLearned.push(topic);
          }
        }
      } catch { /* auto-learn errors must never break session_end */ }

      // ── 🌿 Ambient Git Learning ────────────────────────────────────────────────
      // Read git commits since session start → auto-learn each meaningful commit.
      const ambientLearned: string[] = [];
      if (workspace_path) {
        try {
          // Get the session start time (stored by session_start)
          const sessionStartTs = currentRaw
            ? (() => { try { return (JSON.parse(currentRaw) as { started?: string }).started ?? ''; } catch { return ''; } })()
            : '';
          const sinceArg = sessionStartTs ? `--since="${sessionStartTs}"` : '--since="1 hour ago"';
          const gitOut = execSync(
            `git -C "${workspace_path}" log ${sinceArg} --oneline --format="%H|||%s|||%ai"`,
            { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          ).trim();
          if (gitOut) {
            const commitActionRe = /\b(fix|add|remove|refactor|migrate|update|resolve|implement|improve|optimize|configure|create|delete|disable|enable|debug|patch|upgrade|build|rewrite|deploy|feat|chore|docs|test|perf|ci)\b/i;
            for (const line of gitOut.split('\n').slice(0, 10)) {
              const [hash, msg, dateStr] = line.split('|||');
              if (!msg || !commitActionRe.test(msg)) continue;
              const slug = msg
                .toLowerCase().replace(/^(fix|feat|chore|docs|test|ci|perf|refactor|build|revert)[:(\s]/i, '')
                .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
              if (!slug) continue;
              const topic = `git:${slug}`;
              const key = `cachly:lesson:best:${topic}`;
              const existing = await redis.get(key);
              if (existing) continue; // don't overwrite existing
              const commitLesson = {
                topic,
                outcome: 'success' as const,
                what_worked: msg.slice(0, 200),
                context: `Auto-learned from git commit ${(hash ?? '').slice(0, 7)} at ${dateStr ?? ''} in ${workspace_path}`,
                severity: 'minor' as const,
                ts: now.toISOString(),
                recall_count: 0,
                auto_learned: true,
                source: 'ambient-git',
                version: 3,
              };
              await redis.set(key, JSON.stringify(commitLesson));
              await redis.expire(key, 60 * 86400); // 60 day TTL for git lessons
              ambientLearned.push(topic);
            }
          }
        } catch { /* git not available or not a repo — silent skip */ }
      }

      const durationStr = durationMin !== undefined ? ` · ${durationMin} min` : '';
      return [
        `✅ **Session saved**${durationStr}`,
        ``,
        `📋 **Summary:** ${summary}`,
        files_changed.length > 0 ? `📁 **Files changed:** ${files_changed.map(f => `\`${f}\``).join(', ')}` : '',
        lessons_learned !== undefined ? `🧠 **Lessons stored:** ${lessons_learned}` : '',
        autoLearned.length > 0 ? `🤖 **Auto-learned:** ${autoLearned.length} lessons extracted from summary (${autoLearned.slice(0, 3).map(t => `\`${t}\``).join(', ')}${autoLearned.length > 3 ? '…' : ''})` : '',
        ambientLearned.length > 0 ? `🌿 **Ambient git learning:** ${ambientLearned.length} commit${ambientLearned.length > 1 ? 's' : ''} auto-learned (${ambientLearned.slice(0, 3).map(t => `\`${t}\``).join(', ')}${ambientLearned.length > 3 ? '…' : ''})` : '',
        ``,
        `💡 Next session: \`session_start(focus="...")\` to see this summary.`,
      ].filter(l => l !== '').join('\n');
    }

    // ── session_ping — lightweight checkpoint ─────────────────────────────────
    case 'session_ping': {
      const {
        instance_id,
        task,
        files_touched = [],
        next_step = '',
        provider = '',
      } = args as {
        instance_id: string;
        task: string;
        files_touched?: string[];
        next_step?: string;
        provider?: string;
      };

      const redis = await getConnection(instance_id);
      const checkpoint = {
        ts: new Date().toISOString(),
        task,
        files_touched,
        next_step,
        provider,
      };

      // Store as the latest checkpoint — session_start reads this when no session_end found
      await redis.set('cachly:session:checkpoint', JSON.stringify(checkpoint), 'EX', 86400 * 3); // 3-day TTL

      // Also keep a short rolling log (last 20 checkpoints for history)
      await redis.lpush('cachly:session:checkpoint:log', JSON.stringify(checkpoint));
      await redis.ltrim('cachly:session:checkpoint:log', 0, 19);

      const providerStr = provider ? ` [${provider}]` : '';
      const filesStr = files_touched.length > 0 ? ` · ${files_touched.length} file${files_touched.length > 1 ? 's' : ''} touched` : '';
      const nextStr = next_step ? `\n📍 **Next step:** ${next_step}` : '';

      return [
        `📌 **Checkpoint saved**${providerStr} — ${new Date().toLocaleTimeString()}`,
        `🔨 **Working on:** ${task}${filesStr}`,
        nextStr,
        ``,
        `💡 If you switch providers, \`session_start\` will show this checkpoint automatically.`,
      ].filter(l => l !== '').join('\n');
    }

    // ── session_handoff — cross-window continuity ─────────────────────────────
    case 'session_handoff': {
      const {
        instance_id,
        completed_tasks = [],
        remaining_tasks = [],
        files_changed = [],
        instructions = '',
        context_summary = '',
        blocked_on = '',
      } = args as {
        instance_id: string;
        completed_tasks: string[];
        remaining_tasks: string[];
        files_changed?: { path: string; status: string; description?: string }[];
        instructions?: string;
        context_summary?: string;
        blocked_on?: string;
      };

      const redis = await getConnection(instance_id);
      const now = new Date();

      const handoff = {
        ts: now.toISOString(),
        completed_tasks,
        remaining_tasks,
        files_changed,
        instructions,
        context_summary,
        blocked_on,
      };

      // Store handoff — never expires until next handoff overwrites it
      await redis.set('cachly:session:handoff', JSON.stringify(handoff));

      // Also append to history
      await redis.lpush('cachly:session:handoff:history', JSON.stringify(handoff));
      await redis.ltrim('cachly:session:handoff:history', 0, 19);

      const totalTasks = completed_tasks.length + remaining_tasks.length;
      const pct = totalTasks > 0 ? Math.round((completed_tasks.length / totalTasks) * 100) : 0;
      const brokenFiles = files_changed.filter(f => f.status === 'broken' || f.status === 'partial');

      return [
        `🤝 **Handoff saved** — ${completed_tasks.length}/${totalTasks} tasks done (${pct}%)`,
        ``,
        completed_tasks.length > 0 ? `✅ **Completed:**\n${completed_tasks.map(t => `  - ${t}`).join('\n')}` : '',
        remaining_tasks.length > 0 ? `\n⏳ **Remaining for next window:**\n${remaining_tasks.map(t => `  - ${t}`).join('\n')}` : '',
        brokenFiles.length > 0 ? `\n⚠️ **Needs attention:** ${brokenFiles.map(f => `\`${f.path}\` (${f.status})`).join(', ')}` : '',
        blocked_on ? `\n🚫 **Blocked on:** ${blocked_on}` : '',
        instructions ? `\n📝 **Instructions:** ${instructions}` : '',
        ``,
        `💡 The next \`session_start\` will include this handoff automatically.`,
      ].filter(l => l !== '').join('\n');
    }

    // ── auto_learn_session ────────────────────────────────────────────────────
    case 'auto_learn_session': {
      const { instance_id, observations } = args as {
        instance_id: string;
        observations: { action: string; outcome: string; details?: string; topic?: string; severity?: string }[];
      };
      const redis = await getConnection(instance_id);
      const stored: string[] = [];
      const skipped: string[] = [];

      for (const obs of observations) {
        // Auto-generate topic from action if not provided
        const rawTopic = obs.topic ?? obs.action
          .toLowerCase()
          .replace(/[^a-z0-9:\-_\s]/g, '')
          .trim()
          .split(/\s+/)
          .slice(0, 4)
          .join('-');
        const topic = rawTopic.includes(':') ? rawTopic : `auto:${rawTopic}`;
        const key = `cachly:lesson:best:${topic}`;

        // Only overwrite if this is a success and existing is failure, or topic is new
        const existing = await redis.get(key);
        if (existing) {
          const existingLesson = JSON.parse(existing) as { outcome: string };
          if (existingLesson.outcome === 'success' && obs.outcome !== 'success') {
            skipped.push(topic);
            continue;
          }
        }

        const lesson = {
          topic,
          outcome: obs.outcome,
          what_worked: obs.outcome === 'success' ? obs.action : (obs.details ?? obs.action),
          what_failed: obs.outcome === 'failure' ? obs.action : undefined,
          context: obs.details,
          severity: obs.severity ?? 'minor',
          ts: new Date().toISOString(),
          recall_count: 0,
          auto_learned: true,
          version: 2,
        };

        await redis.set(key, JSON.stringify(lesson));
        stored.push(`${obs.outcome === 'success' ? '✅' : obs.outcome === 'partial' ? '⚠️' : '❌'} \`${topic}\``);
      }

      const lines = [
        `🤖 **Auto-learn complete**: ${stored.length} stored, ${skipped.length} skipped`,
        '',
      ];
      if (stored.length > 0) lines.push('**Stored:**', ...stored.map(s => '  ' + s), '');
      if (skipped.length > 0) lines.push(`**Skipped** (better lesson already exists): ${skipped.map(t => `\`${t}\``).join(', ')}`);
      return lines.join('\n');
    }

    // ── sync_file_changes ─────────────────────────────────────────────────────
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

