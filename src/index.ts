#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
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
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { Redis } from 'ioredis';

// ── Config ────────────────────────────────────────────────────────────────────

const API_URL = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
const JWT = process.env.CACHLY_JWT ?? '';
const EMBED_MODEL = process.env.CACHLY_EMBED_MODEL ?? '';
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
//   • Multilingual stopwords (EN, DE, FR, ES, IT, PT)
//   • Pipeline Redis reads for performance
//

/**
 * Stopwords — filtered out during tokenization.
 * Covers: English, German, French, Spanish, Italian, Portuguese.
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
]);

/** Tokenize text into meaningful keywords. Handles unicode (accented chars). */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-záàâãäåæçéèêëíìîïñóòôõöúùûüýÿßœ0-9:_\-./]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
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

  // Conjunctions (EN + DE + FR + ES)
  const conjParts = query.split(
    /\b(?:and also|also noch|außerdem|plus|additionally|furthermore|de plus|además|inoltre|além disso)\b/i
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

interface DocEntry {
  key: string;
  content: string;
  tokens: string[];
  tokenFreq: Map<string, number>;  // term → count in this doc
  bigrams: Set<string>;            // "term1|term2" adjacency pairs
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
  // ── Step 1: Collect and tokenize all documents ──
  const allKeys: string[] = [];
  for (const pattern of patterns) {
    const stream = redis.scanStream({ match: pattern, count: 200 });
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (batch: string[]) => {
        allKeys.push(...batch.filter((k: string) => !k.endsWith(':meta')));
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  }

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
    docs.push({ key: allKeys[i], content, tokens, tokenFreq, bigrams, timestamp });
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
   * Fuzzy match: tries exact → substring → Levenshtein ≤ 2.
   * Returns [matchedTerm, weight] or null.
   */
  function fuzzyMatch(qt: string, docTermSet: Set<string>): [string, number] | null {
    // Exact
    if (docTermSet.has(qt)) return [qt, 1.0];
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
  return sorted.slice(0, topK);
}

// ── Exported for testing ──────────────────────────────────────────────────────
export { tokenize, splitMultiQuery, levenshtein, recencyBoost, extractTimestamp, STOPWORDS };

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

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!JWT) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'CACHLY_JWT env var not set. Get your API token from https://cachly.dev/settings'
    );
  }
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${JWT}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new McpError(
      ErrorCode.InternalError,
      `cachly API error ${res.status}: ${(body as { error?: string }).error ?? res.statusText}`
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

import { detectNamespace } from './namespace.js';

// ── Tools ─────────────────────────────────────────────────────────────────────

const TOOLS = [
  // ── Instance Management ──────────────────────────────────────────────────
  {
    name: 'list_instances',
    description: 'List all your cachly cache instances with their status and connection details.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_instance',
    description:
      'Create a new managed Valkey/Redis cache instance on cachly.dev. ' +
      'Free tier provisions in ~30 seconds. Paid tiers return a Stripe checkout URL. ' +
      'Available tiers: free (30 MB), dev (256 MB, €8/mo), pro (1 GB, €25/mo), ' +
      'speed (1 GB Dragonfly + Semantic Cache, €39/mo), business (8 GB, €99/mo).',
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
    description: 'Get details and the Redis connection string for a specific cache instance.',
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
      'Returns the value (string or JSON) or null if the key does not exist.',
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
      'Value can be a string or a JSON-serialized object. Optionally set a TTL in seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
        key: { type: 'string', description: 'Cache key' },
        value: { type: 'string', description: 'Value to store (string or JSON)' },
        ttl: { type: 'number', description: 'Time-to-live in seconds (optional, omit for no expiry)' },
      },
      required: ['instance_id', 'key', 'value'],
    },
  },
  {
    name: 'cache_delete',
    description: 'Delete one or more keys from a running cache instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more cache keys to delete',
        },
      },
      required: ['instance_id', 'keys'],
    },
  },
  {
    name: 'cache_exists',
    description: 'Check whether one or more keys exist in the cache. Returns a count of existing keys.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Keys to check' },
      },
      required: ['instance_id', 'keys'],
    },
  },
  {
    name: 'cache_ttl',
    description: 'Get the remaining time-to-live (TTL) of a key in seconds. Returns -1 if no TTL, -2 if the key does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
        key: { type: 'string' },
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
      'connected clients, keyspace info, and uptime.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'semantic_search',
    description:
      'Find cached entries that are semantically similar to a natural-language query. ' +
      'Powered by pgvector HNSW index on cachly infrastructure — embeddings never leave Germany. ' +
      'Requires OPENAI_API_KEY (or compatible) and the Speed/Business tier with CACHLY_VECTOR_URL. ' +
      'Example: "find all cached responses about password reset" or "what did we answer about pricing?"',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string' },
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
      'Uses one TCP round-trip for N keys via Redis pipeline.',
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
      'Example: remember_context("project overview", "This is a Next.js app with...") ' +
      'then later: recall_context("project overview")',
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
      'Deduplication: if a lesson for this topic already exists, it is updated instead of duplicated. ' +
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
      },
      required: ['instance_id', 'topic', 'outcome', 'what_worked'],
    },
  },
  {
    name: 'recall_best_solution',
    description:
      'Recall the best known solution for a topic from past lessons. ' +
      'Call this BEFORE attempting any task that might have been done before. ' +
      'Returns the most recent successful lesson for the topic, or a summary of attempts. ' +
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
      'open failures (topics with only failure outcomes), and brain health stats (lesson count, context count). ' +
      'Also saves a session start marker so session_end can compute duration.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
        focus: {
          type: 'string',
          description: 'Keywords for what you plan to work on today (e.g. "deploy infra api"). Used to surface relevant lessons at the top.',
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
      'Call this when ending a work session, before going idle, or before summarizing.',
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
      },
      required: ['instance_id', 'summary'],
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
    name: 'brain_doctor',
    description:
      'Check the health of your AI Brain and get actionable recommendations. ' +
      'Reports: lesson count, context entries, last session age, open failures, quality score. ' +
      'Returns a prioritized list of issues with fix instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: { type: 'string', description: 'UUID of the cache instance' },
      },
      required: ['instance_id'],
    },
  },
  {
    name: 'global_learn',
    description:
      'Store a lesson that applies across ALL your projects (cross-project knowledge). ' +
      'Global lessons are stored with the prefix cachly:global:lesson: and recalled from any instance via global_recall. ' +
      'Use for tool preferences, personal workflows, platform quirks, and universal gotchas. ' +
      'Example: global_learn(topic="bash:macos-arrays", lesson="Arrays work differently on macOS bash 3.2")',
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
      'Recall cross-project lessons stored via global_learn. ' +
      'Returns all global lessons or those matching a topic filter.',
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
      'PII is stripped automatically. Visible under the framework/category tag.',
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
      'Loads battle-tested, community-curated lessons into your brain instance. ' +
      'Available: nextjs, fastapi, go, docker, kubernetes, react, typescript, python, rust, laravel, rails, spring.',
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

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
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
        body: JSON.stringify({ name: instName, tier }),
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
      const details: string[] = [];
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const redis = await getConnection(instance_id);

      for (const filePath of files) {
        const relPath = relative(dir, filePath);
        let content: string;
        try {
          const s = await stat(filePath);
          if (s.size > 200_000) { skipped++; continue; } // skip files >200 KB
          content = await readFile(filePath, 'utf-8');
        } catch {
          errors++;
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
        `  ✅ Indexed:   **${indexed}** files (keyword-searchable via smart_recall)`,
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
      };

      const redis = await getConnection(instance_id);
      const ts = new Date().toISOString();

      // ── Deduplication: check for existing lesson with same topic ─────────────
      let isUpdate = false;
      let recallCount = 0;
      if (outcome === 'success') {
        const existing = await redis.get(`cachly:lesson:best:${topic}`);
        if (existing) {
          try {
            const prev = JSON.parse(existing) as { recall_count?: number };
            recallCount = (prev.recall_count ?? 0); // preserve existing recall count
            isUpdate = true;
          } catch { /* ignore parse error */ }
        }
      }

      const lesson = JSON.stringify({
        topic,
        outcome,
        what_worked,
        what_failed,
        context: ctx,
        severity,
        file_paths,
        commands,
        tags,
        recall_count: recallCount,
        ts,
        version: 2,
      });

      // Always append to the history list
      const listKey = `cachly:lessons:${topic}`;
      await redis.rpush(listKey, lesson);

      // Update best key only for success/partial (not for failures)
      if (outcome === 'success' || outcome === 'partial') {
        await redis.set(`cachly:lesson:best:${topic}`, lesson);
      }

      const emoji = outcome === 'success' ? '✅' : outcome === 'partial' ? '⚠️' : '❌';
      const sevEmoji = severity === 'critical' ? '🔴' : severity === 'major' ? '🟡' : '🟢';
      const action = isUpdate ? 'updated' : 'stored';
      return [
        `${emoji} **Lesson ${action}:** \`${topic}\` (${outcome}) ${sevEmoji} ${severity}`,
        ``,
        `**What worked:** ${what_worked}`,
        what_failed ? `**What failed:** ${what_failed}` : '',
        ctx ? `**Context:** ${ctx}` : '',
        file_paths.length > 0 ? `**Files:** ${file_paths.map(f => `\`${f}\``).join(', ')}` : '',
        commands.length > 0 ? `**Commands:** ${commands.map(c => `\`${c}\``).join(', ')}` : '',
        tags.length > 0 ? `**Tags:** ${tags.map(t => `#${t}`).join(' ')}` : '',
        ``,
        isUpdate
          ? `♻️ Updated existing lesson (preserved recall count: ${recallCount})`
          : `💡 Recall later with \`recall_best_solution(topic="${topic}")\``,
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
          context?: string; ts: string; severity?: string; file_paths?: string[];
          commands?: string[]; tags?: string[]; recall_count?: number;
        };
        // Increment recall_count
        const updatedLesson = { ...lesson, recall_count: (lesson.recall_count ?? 0) + 1 };
        await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(updatedLesson));

        const sevEmoji = lesson.severity === 'critical' ? '🔴' : lesson.severity === 'major' ? '🟡' : lesson.severity ? '🟢' : '';
        return [
          `✅ **Best solution for \`${topic}\`** ${sevEmoji}${lesson.severity ? ` (${lesson.severity})` : ''} · recalled ${updatedLesson.recall_count}× · ${new Date(lesson.ts).toLocaleDateString('de-DE')}`,
          ``,
          `**What worked:** ${lesson.what_worked}`,
          lesson.what_failed ? `**What failed (avoid this):** ${lesson.what_failed}` : '',
          lesson.context ? `**Context:** ${lesson.context}` : '',
          (lesson.file_paths ?? []).length > 0 ? `**Files:** ${(lesson.file_paths ?? []).map((f: string) => `\`${f}\``).join(', ')}` : '',
          (lesson.commands ?? []).length > 0 ? `**Commands:** ${(lesson.commands ?? []).map((c: string) => `\`${c}\``).join(', ')}` : '',
          (lesson.tags ?? []).length > 0 ? `**Tags:** ${(lesson.tags ?? []).map((t: string) => `#${t}`).join(' ')}` : '',
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
        lines.push(`\n💡 Tips:`);
        lines.push(`  • Try different keywords`);
        lines.push(`  • Use \`list_remembered\` to see available context`);
        lines.push(`  • Use \`recall_best_solution("topic")\` for exact topic lookup`);
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
      const { instance_id, focus = '' } = args as { instance_id: string; focus?: string };
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
        ts: string; severity?: string; recall_count?: number; tags?: string[];
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

      // 6. Save session start marker
      await redis.set('cachly:session:current', JSON.stringify({
        started: new Date().toISOString(),
        focus,
      }), 'EX', 86400); // auto-expire after 24h if session_end never called

      // ── Build briefing ──────────────────────────────────────────────────────
      const lines: string[] = ['🧠 **Session Briefing**', ''];

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

      // Focus-relevant lessons
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

      return lines.join('\n');
    }

    // ── session_end ───────────────────────────────────────────────────────────
    case 'session_end': {
      const {
        instance_id,
        summary,
        files_changed = [],
        lessons_learned,
      } = args as {
        instance_id: string;
        summary: string;
        files_changed?: string[];
        lessons_learned?: number;
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

      const sessionRecord = {
        ts: now.toISOString(),
        summary,
        files_changed,
        ...(lessons_learned !== undefined ? { lessons_learned } : {}),
        ...(durationMin !== undefined ? { duration_min: durationMin } : {}),
      };

      // Save as "last session"
      await redis.set('cachly:session:last', JSON.stringify(sessionRecord));

      // Append to history list (keep last 50 sessions, TTL 90 days)
      await redis.lpush('cachly:session:history', JSON.stringify(sessionRecord));
      await redis.ltrim('cachly:session:history', 0, 49);
      await redis.expire('cachly:session:history', 90 * 86400);

      // Clean up current session marker
      await redis.del('cachly:session:current');

      const durationStr = durationMin !== undefined ? ` · ${durationMin} min` : '';
      return [
        `✅ **Session saved**${durationStr}`,
        ``,
        `📋 **Summary:** ${summary}`,
        files_changed.length > 0 ? `📁 **Files changed:** ${files_changed.map(f => `\`${f}\``).join(', ')}` : '',
        lessons_learned !== undefined ? `🧠 **Lessons stored:** ${lessons_learned}` : '',
        ``,
        `💡 Next session: \`session_start(focus="...")\` to see this summary.`,
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

    // ── brain_doctor ──────────────────────────────────────────────────────────
    case 'brain_doctor': {
      const { instance_id } = args as { instance_id: string };
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
      type Lesson = { topic: string; outcome: string; recall_count?: number; ts: string; severity?: string };
      const lessons: Lesson[] = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        try { lessons.push(JSON.parse(raw) as Lesson); } catch { /* skip */ }
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

      const scoreEmoji = score >= 80 ? '🟢' : score >= 50 ? '🟡' : '🔴';

      checks.push(`${scoreEmoji} **Brain Quality Score: ${score}/100**`);
      checks.push(`📚 **Lessons:** ${lessonKeys.length} (${criticalLessons.length} critical)`);
      checks.push(`💾 **Context entries:** ${ctxCount}`);

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

      if (ctxCount === 0) {
        issues.push('💡 No context — use `remember_context` to cache architecture docs, ADRs, etc.');
      }

      if (openFailures.length > 0) {
        issues.push(`⚠️ ${openFailures.length} unresolved failure${openFailures.length > 1 ? 's' : ''}: ${openFailures.slice(0, 3).map(l => `\`${l.topic}\``).join(', ')}`);
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
        ? '3. Call `smart_recall` with keywords for semantic context search'
        : '3. Call `recall_context` with relevant key patterns like "arch:*" or "file:*"';
      const layerNote = hasVector
        ? `Layer 3 (Semantic): smart_recall uses pgvector HNSW on your ${tier} instance for meaning-based search`
        : `Layer 3 (Autopilot): This file — upgrade to Speed/Business tier to unlock smart_recall`;

      const copilotInstructions = `# cachly AI Memory — ${project_description}

## 3-Layer AI Memory System

- **Layer 1 — Storage:** cachly instance \`${inst.name}\` (${tier}) — persistent Valkey brain, survives restarts
- **Layer 2 — Tools:** learn_from_attempts · recall_best_solution · smart_recall — the memory API
- **Layer 3 — Autopilot (this file):** instructs the AI to run memory tools automatically

## BEFORE every task — check memory first

1. Call \`recall_best_solution\` with the task topic to get known solutions
   - \`recall_best_solution("deploy:web")\` → returns working deploy command
   - \`recall_best_solution("debug:redis-tls")\` → returns root cause + fix
   - If a solution exists, use it — do NOT re-discover from scratch

2. Call \`recall_context\` with the area you're working in
   - \`recall_context("arch:*")\` → cached architecture decisions
   - \`recall_context("file:src/auth*")\` → cached file summaries

${smartRecallNote}
   - \`smart_recall("how does authentication work")\` → returns cached auth notes

4. If nothing is found, proceed normally — then save (see below)

## AFTER every non-trivial task — save to memory

1. Call \`learn_from_attempts\` for deploy/debug/fix tasks:
   - Always set outcome = "success" | "failure" | "partial"
   - Always include what_failed — it prevents future wasted time
   - Example: \`learn_from_attempts(topic="deploy:api", outcome="success", what_worked="nohup docker compose up -d --build", what_failed="direct docker compose hangs on SSH timeout")\`

2. Call \`remember_context\` for code/architecture findings:
   - \`remember_context("arch:auth", "Uses Keycloak with JWT...", category="architecture")\`
   - \`remember_context("file:src/index.ts", "Entry point, registers routes...", category="file_summary")\`

## Instance Details

- Instance ID: \`${instance_id}\`
- Instance name: ${inst.name}
- Tier: ${tier}
- ${layerNote}
- Embedding provider: ${providerArg}

## Quick reference

\`\`\`
recall_best_solution("topic")        # before task
smart_recall("natural language")     # find by meaning
learn_from_attempts(...)             # after task
remember_context("key", "content")   # save analysis
\`\`\`
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
          ? [`Writing to \`${project_dir}/.github/copilot-instructions.md\`…`]
          : [`Copy this to \`.github/copilot-instructions.md\` in your project:`]),
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

      // Optionally write the file
      if (project_dir) {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const githubDir = join(project_dir, '.github');
        await mkdir(githubDir, { recursive: true });
        const filePath = join(githubDir, 'copilot-instructions.md');
        await writeFile(filePath, copilotInstructions, 'utf-8');
        lines.splice(lines.indexOf(`Writing to \`${project_dir}/.github/copilot-instructions.md\`…`) + 1, 0,
          `✅ Written to \`${project_dir}/.github/copilot-instructions.md\``
        );
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

    default:
      return null;
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'cachly-mcp', version: '0.4.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const text = await handleTool(name, (args ?? {}) as Record<string, unknown>);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(ErrorCode.InternalError, (err as Error).message);
  }
});

// Graceful shutdown – close all Redis connections
process.on('SIGTERM', async () => {
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

### At the START of every session (one call):
\`\`\`
session_start(
  instance_id = "${instanceId}",
  focus       = "<what you plan to work on today>",
)
\`\`\`

### At the END of every session:
\`\`\`
session_end(
  instance_id     = "${instanceId}",
  summary         = "What was accomplished (2-3 sentences)",
  files_changed   = ["src/..."],
  lessons_learned = 1,
)
\`\`\`

### After fixing any bug or learning something new:
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
  tags        = ["tag1", "tag2"],
)
\`\`\`
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

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise(res => rl.question(q, ans => res(ans.trim())));

  console.log('\n🧠  cachly AI Brain — Interactive Setup');
  console.log('────────────────────────────────────────\n');

  // ── Step 1: API token ──────────────────────────────────────────────────────
  let token = process.env.CACHLY_JWT ?? '';
  if (token) {
    console.log('✓  Using token from CACHLY_JWT env var\n');
  } else {
    console.log('Step 1: Get your API token at https://cachly.dev/setup-ai\n');
    token = await ask('   Paste API token (cky_live_...): ');
    if (!token) { console.error('\nToken is required. Aborting.\n'); rl.close(); process.exit(1); }
    console.log('');
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
    console.error(`\n\nFailed to fetch instances: ${(e as Error).message}`);
    console.error('Check your token and try again.\n');
    rl.close(); process.exit(1);
  }
  console.log(` found ${instances.length}\n`);

  if (instances.length === 0) {
    console.error('No running instances found. Create one at https://cachly.dev/instances\n');
    rl.close(); process.exit(1);
  }

  let instance = instances[0];
  if (instances.length > 1) {
    console.log('Step 2: Pick your Brain instance:\n');
    instances.forEach((inst, idx) =>
      console.log(`   ${idx + 1}. ${inst.name.padEnd(24)} ${inst.tier.padEnd(10)} ${inst.region}`)
    );
    const raw = await ask(`\n   Pick [1-${instances.length}] (Enter = 1): `);
    const idx = parseInt(raw || '1', 10) - 1;
    instance = instances[Math.max(0, Math.min(instances.length - 1, idx))];
  }
  console.log(`✓  Instance: ${instance.name} (${instance.id.slice(0, 8)}…)\n`);

  // ── Step 3: Detect editors ────────────────────────────────────────────────
  const cwd = process.cwd();
  const detected: string[] = [];
  // Claude Code: always include (CLAUDE.md is universal)
  detected.push('claude');
  if (existsSync(resolve(cwd, '.cursor')))   detected.push('cursor');
  if (existsSync(resolve(cwd, '.windsurf'))) detected.push('windsurf');
  if (existsSync(resolve(cwd, '.vscode')))   detected.push('copilot');
  if (existsSync(resolve(cwd, '.continue'))) detected.push('continue');

  const editorLabel = (e: string) =>
    ({ claude: 'Claude Code', cursor: 'Cursor', windsurf: 'Windsurf', copilot: 'GitHub Copilot', continue: 'Continue.dev' })[e] ?? e;

  console.log(`Step 3: Detected editors: ${detected.map(editorLabel).join(', ')}`);
  const editorsRaw = await ask(`   Configure for which? [all / ${detected.join('/')}] (Enter = all): `);
  const editorsToSetup = !editorsRaw || editorsRaw.toLowerCase() === 'all'
    ? detected
    : editorsRaw.split(/[,\s]+/).map(s => s.toLowerCase()).filter(s => EDITOR_FILES[s]);
  console.log('');

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
  console.log(`${mdLabel}: CLAUDE.md`);

  rl.close();
  console.log(`\n🧠  Done! Restart your editor — the \`cachly\` MCP tools will appear.`);
  console.log(`    Your AI now has persistent memory across every session.\n`);
  process.exit(0);
}

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

