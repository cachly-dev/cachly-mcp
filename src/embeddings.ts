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
 * │  Brain works WITHOUT embedding (keyword search + exact key lookup). │
 * │  Embedding is an optional boost for semantic_search/index_project.  │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Mutable config — call setEmbedJwt() when the JWT changes (device flow).
 */

// ── Mutable config (synced with index.ts JWT on device-flow auth) ────────────
export const embedConfig = {
  apiUrl: process.env.CACHLY_API_URL ?? 'https://api.cachly.dev',
  jwt:    process.env.CACHLY_JWT ?? '',
  model:  process.env.CACHLY_EMBED_MODEL ?? '',
};

/** Call this when JWT is refreshed (e.g. after device flow). */
export function setEmbedJwt(jwt: string): void {
  embedConfig.jwt = jwt;
}

// Hard timeout for any embedding-provider HTTP call. Embedding is an OPTIONAL boost
// for semantic recall — a slow/unreachable provider must never hang the agent turn.
// Callers already treat embedding failures as non-fatal (keyword search still works).
const EMBED_TIMEOUT_MS = Number(process.env.CACHLY_EMBED_TIMEOUT_MS ?? 8_000);

// ── Provider auto-detection ───────────────────────────────────────────────────

/**
 * Pick an embedding provider.
 *
 * ── WHAT THIS USED TO DO, AND WHAT IT COST (fixed 23 Aug 2026) ───────────────
 *
 * Until today the order was: OPENAI_API_KEY, then GEMINI, MISTRAL, COHERE,
 * OLLAMA — and only then our own endpoint. A developer who had OPENAI_API_KEY
 * exported for some other tool, which is the common case, got `openai` here.
 * Lesson text and indexed source files then left the EU on the first tool
 * call, and auto-indexing is ON by default (`CACHLY_AUTO_INDEX !== 'false'`,
 * index.ts), so it happened without anyone choosing it.
 *
 * At the same time our landing page said, in German and legally sharper than
 * the English: "Ausschliesslich auf deutschen Servern (Hetzner), nie ausserhalb
 * der EU." Both statements lived in this repository. Which one was true for a
 * given user was decided by an environment variable that user had set for
 * something else entirely.
 *
 * ── WHY THE ORDER IS NOW REVERSED ────────────────────────────────────────────
 *
 * The third-party providers date from a time when embeddings were not part of
 * the product and every user had to bring their own model. That time is over:
 * embeddings run on our own EU infrastructure (bge-m3 on the LLM gateway).
 * There is no longer any reason to send a single byte to OpenAI, Google,
 * Mistral or Cohere — so we no longer do it by accident.
 *
 * `cachly` is now the default whenever a JWT exists. The other providers are
 * still reachable, but ONLY when someone names them explicitly through
 * CACHLY_EMBED_PROVIDER. A deliberate choice stays possible; an accidental one
 * does not.
 *
 * OLLAMA_BASE_URL keeps its auto-detection: a local Ollama sends nothing
 * anywhere, so it raises no data-residency question. It ranks below `cachly`
 * because our endpoint gives every instance the same model, and mixing models
 * makes vectors incomparable.
 *
 * Found in a design-workshop run, role "Der Wortpruefer", by reading each
 * promise on the landing page against the code that would have to keep it.
 */
function detectEmbedProvider(): string {
  // Our own EU endpoint first — no key needed beyond the one the user already
  // has, and the vectors match every other instance.
  if (process.env.CACHLY_JWT) return 'cachly';
  // A local Ollama leaves the machine at all, so it is safe to auto-detect.
  if (process.env.OLLAMA_BASE_URL) return 'ollama';
  // Third-party providers are NOT auto-detected any more. Setting
  // OPENAI_API_KEY for some unrelated tool must not reroute our data.
  return 'none'; // no provider → embedding disabled, brain still works via exact keys
}

export const EMBED_PROVIDER = (process.env.CACHLY_EMBED_PROVIDER ?? detectEmbedProvider()).toLowerCase();

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
export async function computeEmbedding(text: string): Promise<number[]> {
  switch (EMBED_PROVIDER) {
    case 'cachly': {
      // Server-side embedding — the Cachly API computes the embedding
      // using whatever provider is configured on the server. No client-side API key needed.
      if (!embedConfig.jwt) throw new Error(
        'CACHLY_JWT not set.\n\n' +
        'The "cachly" provider uses server-side embeddings via the Cachly API.\n' +
        'Set CACHLY_JWT, or use another provider via CACHLY_EMBED_PROVIDER:\n' +
        '  openai  → OPENAI_API_KEY\n' +
        '  gemini  → GEMINI_API_KEY\n' +
        '  ollama  → OLLAMA_BASE_URL (local, no key needed)'
      );
      const url = `${embedConfig.apiUrl}/api/v1/embed`;
      const body: Record<string, string> = { text };
      if (embedConfig.model) body.model = embedConfig.model;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${embedConfig.jwt}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
      const model = embedConfig.model !== 'text-embedding-3-small' ? embedConfig.model : 'mistral-embed';
      const res = await fetch('https://api.mistral.ai/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: [text] }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Mistral embedding error: ${res.statusText}`);
      const json = (await res.json()) as { data: { embedding: number[] }[] };
      if (!json.data?.[0]?.embedding) throw new Error('Mistral returned empty embedding response');
      return json.data[0].embedding;
    }

    case 'cohere': {
      const key = process.env.COHERE_API_KEY;
      if (!key) throw new Error('COHERE_API_KEY not set');
      const model = embedConfig.model !== 'text-embedding-3-small' ? embedConfig.model : 'embed-english-v3.0';
      const res = await fetch('https://api.cohere.com/v2/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, texts: [text], input_type: 'search_query', embedding_types: ['float'] }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Cohere embedding error: ${res.statusText}`);
      const json = (await res.json()) as { embeddings: { float: number[][] } };
      return json.embeddings.float[0];
    }

    case 'ollama': {
      const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      const model = embedConfig.model !== 'text-embedding-3-small' ? embedConfig.model : 'nomic-embed-text';
      const res = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Ollama embedding error: ${res.statusText}`);
      const json = (await res.json()) as { embedding: number[] };
      return json.embedding;
    }

    case 'gemini': {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error('GEMINI_API_KEY not set');
      const model = embedConfig.model !== 'text-embedding-3-small' ? embedConfig.model : 'text-embedding-004';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] } }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
      const model = embedConfig.model || 'text-embedding-3-small';
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: text }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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
export function hasEmbedProvider(): boolean {
  switch (EMBED_PROVIDER) {
    case 'cachly':  return !!embedConfig.jwt;
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
export function embedProviderHint(): string {
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
