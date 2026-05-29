import { randomUUID } from 'node:crypto';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { readdir, stat, readFile } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type { Redis } from 'ioredis';
import type { Instance } from './brain.js';
import { computeEmbedding, hasEmbedProvider, embedProviderHint } from '../embeddings.js';
import { detectNamespace } from '../namespace.js';
import { simpleHash } from '../confidence.js';

interface SemanticSearchResponse {
  found: boolean; id?: string; similarity?: number; prompt?: string;
}

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const CACHE_TOOL_NAMES = new Set([
  'cache_get', 'cache_set', 'cache_delete', 'cache_exists', 'cache_ttl', 'cache_keys',
  'cache_stats', 'semantic_search', 'detect_namespace', 'cache_warmup', 'index_project',
  'cache_mset', 'cache_mget', 'cache_lock_acquire', 'cache_lock_release',
  'cache_stream_set', 'cache_stream_get',
]);

export async function handleCacheTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
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
        signal: AbortSignal.timeout(8000),
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
            signal: AbortSignal.timeout(8000),
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
            signal: AbortSignal.timeout(8000),
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
              signal: AbortSignal.timeout(8000),
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

    // ── Bulk / Lock / Stream tools ──────────────────────────────────────────
    case 'cache_mset': {
      const { instance_id, items } = args as { instance_id: string; items: Array<{ key: string; value: unknown; ttl?: number }> };
      if (!Array.isArray(items) || items.length === 0) return '⚠️ No items provided.';
      const redis = await getConnection(instance_id);
      const pipe = redis.pipeline();
      for (const item of items) {
        const serialized = typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
        if (item.ttl && item.ttl > 0) { pipe.set(item.key, serialized, 'EX', item.ttl); }
        else { pipe.set(item.key, serialized); }
      }
      await pipe.exec();
      return `✅ **cache_mset** – ${items.length} key(s) written in one pipeline round-trip.\n` +
        items.map(i => `  • \`${i.key}\`${i.ttl ? ` (TTL ${i.ttl}s)` : ''}`).join('\n');
    }

    case 'cache_mget': {
      const { instance_id, keys } = args as { instance_id: string; keys: string[] };
      if (!Array.isArray(keys) || keys.length === 0) return '⚠️ No keys provided.';
      const redis = await getConnection(instance_id);
      const raws = await redis.mget(...keys);
      const result = keys.map((k, i) => {
        const raw = raws[i];
        if (raw === null) return `  • \`${k}\`: _null (miss)_`;
        return `  • \`${k}\`: ${raw}`;
      });
      return `✅ **cache_mget** – ${keys.length} key(s) fetched in one round-trip.\n` + result.join('\n');
    }

    case 'cache_lock_acquire': {
      const { instance_id, key, ttl_ms = 5000, retries = 3, retry_delay_ms = 50 } =
        args as { instance_id: string; key: string; ttl_ms?: number; retries?: number; retry_delay_ms?: number };
      const redis = await getConnection(instance_id);
      const lockKey = `cachly:lock:${key}`;
      const token = randomUUID();
      for (let attempt = 0; attempt <= retries; attempt++) {
        const result = await redis.set(lockKey, token, 'PX', ttl_ms, 'NX');
        if (result === 'OK') {
          return `🔒 **cache_lock_acquire** – Lock acquired!\n\n  Key:   \`${key}\`\n  Token: \`${token}\`\n  TTL:   ${ttl_ms} ms\n\n💡 Use **cache_lock_release** with this token to release early.`;
        }
        if (attempt < retries) await new Promise(r => setTimeout(r, retry_delay_ms));
      }
      return `❌ **cache_lock_acquire** – Could not acquire lock for \`${key}\` after ${retries + 1} attempts.`;
    }

    case 'cache_lock_release': {
      const { instance_id, key, token } = args as { instance_id: string; key: string; token: string };
      const redis = await getConnection(instance_id);
      const script = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;
      const released = await redis.eval(script, 1, `cachly:lock:${key}`, token);
      return released === 1
        ? `🔓 **cache_lock_release** – Lock \`${key}\` released.`
        : `⚠️ **cache_lock_release** – Lock \`${key}\` expired or token mismatch.`;
    }

    case 'cache_stream_set': {
      const { instance_id, key, chunks, ttl } = args as { instance_id: string; key: string; chunks: string[]; ttl?: number };
      if (!Array.isArray(chunks) || chunks.length === 0) return '⚠️ No chunks provided.';
      const redis = await getConnection(instance_id);
      const listKey = `cachly:stream:${key}`;
      await redis.del(listKey);
      const pipe = redis.pipeline();
      for (const chunk of chunks) pipe.rpush(listKey, chunk);
      if (ttl && ttl > 0) pipe.expire(listKey, ttl);
      await pipe.exec();
      return `✅ **cache_stream_set** – ${chunks.length} chunk(s) stored.\n  Key: \`${key}\`\n${ttl ? `  TTL: ${ttl}s\n` : ''}  Total size: ${chunks.reduce((a, c) => a + c.length, 0)} chars`;
    }

    case 'cache_stream_get': {
      const { instance_id, key } = args as { instance_id: string; key: string };
      const redis = await getConnection(instance_id);
      const listKey = `cachly:stream:${key}`;
      const len = await redis.llen(listKey);
      if (len === 0) return `⚠️ **cache_stream_get** – Cache miss for key \`${key}\`.`;
      const chunks = await redis.lrange(listKey, 0, -1);
      const full = chunks.join('');
      const preview = full.slice(0, 500);
      return `✅ **cache_stream_get** – ${len} chunk(s) retrieved for \`${key}\`.\n\n**Preview** (first 500 chars):\n\`\`\`\n${preview}${preview.length < full.length ? '…' : ''}\n\`\`\``;
    }

    default:
      return null;
  }
}
