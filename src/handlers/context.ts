import type { Redis } from 'ioredis';
import { computeEmbedding } from '../embeddings.js';
import type { Instance } from './brain.js';

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const CONTEXT_TOOL_NAMES = new Set([
  'remember_context', 'recall_context', 'list_remembered', 'forget_context',
]);

export async function handleContextTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
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
          const res = await fetch(`${vectorUrl}/entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) {
            process.stderr.write(`[cachly] semantic index skipped (HTTP ${res.status}) — smart_recall on this context will be keyword-only\n`);
          }
        } catch (e) {
          // Embedding is optional — keyword recall still works. Log so it's debuggable.
          process.stderr.write(`[cachly] semantic index failed: ${e instanceof Error ? e.message : String(e)} — smart_recall on this context will be keyword-only\n`);
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

    default:
      return null;
  }
}
