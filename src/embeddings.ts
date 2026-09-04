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

// Zeitlimit fuer jeden HTTP-Aufruf an einen Einbettungs-Anbieter.
//
// ── Warum 8 s zu wenig waren (28.08.2026) ────────────────────────────────
//
// Gemessen in den LoCoMo-Durchlaeufen am 25./26.08.2026 auf dem ECHTEN
// Kundenpfad: bge-m3 auf der node-1-CPU braucht fuer Texte um 1800 Zeichen
// zwischen 7 und 21 Sekunden. Das Zeitlimit stand auf 8.
//
// Folge: jeder grosse Lektionstext riss das Limit, und der Volltext-Vektor
// fehlte danach STILL. Die Lektion war gespeichert, der Bedeutungsabgleich
// uebersprang sie fuer immer. Kein Fehler, keine Meldung — nur eine
// Lektion, die nie wieder gefunden wird.
//
// ── Warum es NICHT einfach 30 s sind ─────────────────────────────────────
//
// Weil dasselbe Limit auf zwei Wegen gilt. Der Suchpfad ('kurz') laeuft
// MITTEN im Agenten-Zug: dort waeren 30 s eine halbe Minute Stillstand fuer
// eine Verbesserung, die auch ausfallen darf (die Wortsuche traegt weiter).
// Der Schreibpfad ('lang') laeuft fire-and-forget, dort wartet niemand.
//
// Also: 'kurz' behaelt die 8 s. 'lang' rechnet nach Laenge.
const EMBED_TIMEOUT_MS = Number(process.env.CACHLY_EMBED_TIMEOUT_MS ?? 8_000);

/** Obergrenze fuer den Schreibpfad. Auch ein langer Text ist irgendwann tot. */
const EMBED_TIMEOUT_MAX_MS = Number(process.env.CACHLY_EMBED_TIMEOUT_MAX_MS ?? 45_000);

/**
 * Zuschlag je Zeichen. 12 ms sind aus der Messung: 1800 Zeichen kosteten im
 * schlimmsten Fall 21 s, also 8000 + 1800 x 12 = 29,6 s — die gemessene
 * Spitze plus knapp neun Sekunden Luft.
 *
 * GERATEN ist daran nur die Luft. Die 21 s sind gemessen.
 */
const MS_JE_ZEICHEN = 12;

/**
 * Wie lange dieser eine Aufruf hoechstens dauern darf.
 *
 * Rein und getestet — dieselbe Regel wie bei wiederholungMs: die Politik
 * steht an EINER Stelle, nicht verstreut in den Provider-Zweigen.
 */
export function zeitlimitMs(text: string, geduld: EmbedGeduld): number {
  // Der Suchpfad haelt den Agenten-Zug auf. Er wartet nie laenger als die
  // Grundzeit, egal wie lang der Text ist.
  if (geduld === 'kurz') return EMBED_TIMEOUT_MS;
  return Math.min(EMBED_TIMEOUT_MAX_MS, EMBED_TIMEOUT_MS + text.length * MS_JE_ZEICHEN);
}

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
async function embeddingEinmal(text: string, geduld: EmbedGeduld, modell?: string): Promise<number[]> {
  const zeitlimit = zeitlimitMs(text, geduld);
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
      // `modell` gewinnt: das Zweitmerkmal der Rangfolge fragt gezielt ein
      // ANDERES Modell an als das konfigurierte (rangfolge-stellschrauben.ts,
      // ZWEIT_MODELL). Der Server reicht das Feld an seinen Anbieter durch.
      if (modell ?? embedConfig.model) body.model = modell ?? embedConfig.model;
      // Mess- und Migrationslaeufe (Karte n9s5dt3h29qz): Die API hat seit dem
      // 19.08. einen dokumentierten Bypass-Schalter fuer genau diesen Verkehr
      // (X-Admin-Key -> middleware.IsAdminBypass) — aber dieser Client konnte
      // ihn nie senden. Gemessen am 01./02.09.: jeder Massen-Ingest lief in
      // 200-300 429er je Welle, der Wachhund meldete die eigene Adresse als
      // Angreifer. Gesetzt wird der Header NUR, wenn CACHLY_ADMIN_KEY in der
      // Umgebung liegt — normale Sessions bleiben normal gedrosselt.
      const adminKey = process.env.CACHLY_ADMIN_KEY ?? '';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${embedConfig.jwt}`,
          ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(zeitlimit),
      });
      if (!res.ok) {
        const errBody = await res.text();
        // Status und Wartewunsch mitgeben, damit die Wiederholung oben
        // entscheiden kann: 429 traegt Retry-After als Header (Sekunden),
        // der Circuit-Breaker-Fall (503) traegt retry_after im JSON-Body.
        let retryAfterSek: number | null = null;
        const header = Number(res.headers.get('retry-after'));
        if (Number.isFinite(header) && header >= 0) retryAfterSek = header;
        else {
          try {
            const b = JSON.parse(errBody) as { retry_after?: number };
            if (typeof b.retry_after === 'number' && b.retry_after >= 0) retryAfterSek = b.retry_after;
          } catch { /* Body war kein JSON — kein Wartewunsch */ }
        }
        throw Object.assign(new Error(`Cachly embed API error ${res.status}: ${errBody.slice(0, 200)}`), {
          status: res.status,
          retryAfterSek,
        });
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
        signal: AbortSignal.timeout(zeitlimit),
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
        signal: AbortSignal.timeout(zeitlimit),
      });
      if (!res.ok) throw new Error(`Cohere embedding error: ${res.statusText}`);
      const json = (await res.json()) as { embeddings: { float: number[][] } };
      return json.embeddings.float[0];
    }

    case 'ollama': {
      const base = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
      const model = modell ?? (embedConfig.model !== 'text-embedding-3-small' ? embedConfig.model : 'nomic-embed-text');
      const res = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: text }),
        signal: AbortSignal.timeout(zeitlimit),
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
          signal: AbortSignal.timeout(zeitlimit),
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
        signal: AbortSignal.timeout(zeitlimit),
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

// ── Wiederholung bei voruebergehenden Fehlern (Karte hcg8neyut0kd) ───────────
//
// Beleg 26.08.2026 (LoCoMo-Smoke, Produktpfad): mitten im Lauf schlug ein
// einzelner Embed-Aufruf mit "fetch failed" fehl — die Lektion wurde ohne
// Volltext-Vektor gespeichert und war fuer den Bedeutungsabgleich unsichtbar;
// eine Suche fiel still auf Woerter zurueck. Ein einzelner Netz-Blip kostete
// dauerhaft Abrufqualitaet, weil es KEINEN Wiederholversuch gab.
//
// Zwei Geduldsstufen, weil die Pfade verschieden viel Zeit haben:
//  - 'kurz' (Standard, Suchpfad): nur schnelle Wiederholungen. Ein Timeout
//    wird NICHT wiederholt (ein langsames Modell wird nicht schneller, und
//    der Suchpfad darf den Agenten-Zug nie aufhalten).
//  - 'lang' (Schreibpfad, fire-and-forget): wartet auch ein volles
//    Rate-Fenster ab (Retry-After bis 61 s) — dort blockiert niemand.

export type EmbedGeduld = 'kurz' | 'lang';

const KURZ_VERSUCHE = 3;
const LANG_VERSUCHE = 4;

/** Ist dieser Fehler von der Art, die beim naechsten Versuch weg sein kann? */
export function istVoruebergehend(fehler: unknown): boolean {
  const f = fehler as { status?: number; name?: string; message?: string; cause?: { code?: string } };
  if (typeof f?.status === 'number') return f.status === 429 || f.status >= 500;
  // Timeouts sind KEIN voruebergehender Fehler im Sinne der Wiederholung:
  // wer 8 s nicht schaffte, schafft sie beim direkten zweiten Anlauf selten —
  // und der Suchpfad haengt sonst ein Mehrfaches des Zeitlimits.
  if (f?.name === 'TimeoutError' || f?.name === 'AbortError') return false;
  if (/fetch failed/i.test(String(f?.message ?? ''))) return true;
  const code = f?.cause?.code ?? '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
}

/**
 * Wartezeit vor Versuch (versuch+1), oder null = nicht wiederholen.
 * Rein und getestet — die Politik steht HIER, nicht verstreut im Wrapper.
 */
export function wiederholungMs(fehler: unknown, versuch: number, geduld: EmbedGeduld): number | null {
  const max = geduld === 'lang' ? LANG_VERSUCHE : KURZ_VERSUCHE;
  if (versuch >= max) return null;
  if (!istVoruebergehend(fehler)) return null;
  const ra = (fehler as { retryAfterSek?: number | null })?.retryAfterSek;
  if (typeof ra === 'number' && Number.isFinite(ra) && ra >= 0) {
    const ms = ra * 1000;
    // 'kurz' wartet kein Rate-Fenster ab: ein Wartewunsch ueber 2 s heisst
    // fuer den Suchpfad "gib auf und lauf ueber Woerter weiter".
    if (geduld === 'kurz') return ms <= 2_000 ? ms : null;
    return Math.min(ms, 61_000); // das 60-s-Fenster plus Puffer
  }
  return geduld === 'lang' ? Math.min(1_000 * 2 ** (versuch - 1), 8_000) : 250 * 2 ** (versuch - 1);
}

/** Siehe embeddingEinmal fuer die Provider; hier sitzt NUR die Wiederholung. */
/**
 * `modell` fragt gezielt ein anderes Modell an als das konfigurierte —
 * gebraucht vom Zweitmerkmal der Rangfolge (ZWEIT_MODELL). Nur die Anbieter
 * `cachly` und `ollama` reichen es durch; bei allen anderen wirft der Aufruf,
 * statt still einen Vektor des FALSCHEN Modells zu liefern (der landete sonst
 * unter dem Zweit-Schluessel und macht jeden Vergleich dort wertlos).
 */
export async function computeEmbedding(text: string, opts?: { geduld?: EmbedGeduld; modell?: string }): Promise<number[]> {
  const geduld = opts?.geduld ?? 'kurz';
  if (opts?.modell && EMBED_PROVIDER !== 'cachly' && EMBED_PROVIDER !== 'ollama') {
    throw new Error(`Anbieter "${EMBED_PROVIDER}" kann kein abweichendes Modell anfragen (verlangt: ${opts.modell}).`);
  }
  let versuch = 0;
  for (;;) {
    versuch++;
    try {
      return await embeddingEinmal(text, geduld, opts?.modell);
    } catch (fehler) {
      const warte = wiederholungMs(fehler, versuch, geduld);
      if (warte === null) throw fehler;
      await new Promise((r) => setTimeout(r, warte));
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
