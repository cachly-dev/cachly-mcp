import type { Redis } from 'ioredis';
import { safeJsonParse } from '../utils.js';
import { STARTER_CORPUS, STARTER_CORPUS_SIZE } from '../starter-corpus.js';

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const SHARE_TOOL_NAMES = new Set([
  'brain_share', 'brain_import', 'brain_share_list', 'brain_unshare', 'brain_discover',
  'brain_seed_starter',
]);

interface StoredLesson {
  topic: string;
  outcome: string;
  what_worked?: string;
  what_failed?: string;
  ctx?: string;
  tags?: string[];
  author?: string;
  service?: string;
  confidence?: number;
  ts?: string;
  version?: number;
}

interface SharePayload {
  share_id?: string;
  title?: string;
  description?: string;
  created_at?: string;
  lesson_count?: number;
  lessons?: StoredLesson[];
  error?: string;
}

async function scanAllLessons(redis: Redis, topicFilter?: string[]): Promise<StoredLesson[]> {
  const keys: string[] = [];
  const stream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
  await new Promise<void>((res, rej) => {
    stream.on('data', (batch: string[]) => keys.push(...batch));
    stream.on('end', res);
    stream.on('error', rej);
  });

  const lessons: StoredLesson[] = [];
  for (const key of keys.slice(0, 500)) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const lesson = safeJsonParse<StoredLesson | null>(raw, null);
    if (!lesson || !lesson.topic) continue;
    if (topicFilter && topicFilter.length > 0) {
      const matches = topicFilter.some(f => lesson.topic.includes(f));
      if (!matches) continue;
    }
    // Strip fields that should not be shared (internal audit trails, etc.)
    lessons.push({
      topic: lesson.topic,
      outcome: lesson.outcome,
      ...(lesson.what_worked ? { what_worked: lesson.what_worked } : {}),
      ...(lesson.what_failed ? { what_failed: lesson.what_failed } : {}),
      ...(lesson.ctx ? { ctx: lesson.ctx } : {}),
      ...(lesson.tags?.length ? { tags: lesson.tags } : {}),
      ...(lesson.author ? { author: lesson.author } : {}),
      ...(lesson.service ? { service: lesson.service } : {}),
      confidence: lesson.confidence ?? 1.0,
      ts: lesson.ts,
    });
  }
  return lessons;
}

export async function handleShareTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {

    // ── brain_share ────────────────────────────────────────────────────────────
    case 'brain_share': {
      const {
        instance_id,
        title = 'My Brain Snapshot',
        description = '',
        topic_filter,
        visibility = 'unlisted',
        max_lessons = 100,
        dry_run = false,
      } = args as {
        instance_id: string;
        title?: string;
        description?: string;
        topic_filter?: string[];
        visibility?: 'public' | 'unlisted';
        max_lessons?: number;
        dry_run?: boolean;
      };

      if (!instance_id) return '⚠️ `brain_share` requires `instance_id`.';

      const redis = await getConnection(instance_id);
      const topicFilter = Array.isArray(topic_filter) && topic_filter.length > 0 ? topic_filter : undefined;
      const allLessons = await scanAllLessons(redis, topicFilter);
      const lessons = allLessons.slice(0, max_lessons as number);

      if (lessons.length === 0) {
        return [
          `📤 **brain_share** — nothing to share yet`,
          ``,
          `No lessons found in Brain \`${instance_id}\`${topicFilter ? ` matching topics: ${topicFilter.join(', ')}` : ''}.`,
          ``,
          `Store lessons first with \`learn_from_attempts(topic="...", what_worked="...")\`.`,
        ].join('\n');
      }

      if (dry_run) {
        const sample = lessons.slice(0, 5).map(l => {
          const icon = l.outcome === 'success' ? '✅' : l.outcome === 'failure' ? '❌' : '⚠️';
          return `  ${icon} \`${l.topic}\` — ${(l.what_worked ?? l.what_failed ?? '').slice(0, 80)}`;
        });
        return [
          `📤 **brain_share (DRY RUN)** — would share ${lessons.length} lesson${lessons.length !== 1 ? 's' : ''}`,
          ``,
          `**Title:** ${title}`,
          `**Visibility:** ${visibility}`,
          topicFilter ? `**Topic filter:** ${topicFilter.join(', ')}` : '',
          ``,
          `**Sample lessons (first 5):**`,
          ...sample,
          lessons.length > 5 ? `  _...and ${lessons.length - 5} more_` : '',
          ``,
          `_Remove \`dry_run=true\` to create the public share._`,
        ].filter(l => l !== '').join('\n');
      }

      // POST to API
      let shareId: string | null = null;
      let shareUrl: string | null = null;
      try {
        const result = await apiFetch<SharePayload>('/api/v1/brains/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description, visibility, lessons }),
        });
        shareId = result.share_id ?? null;
        if (shareId) shareUrl = `https://cachly.dev/brain/share/${shareId}`;
      } catch (e) {
        // API endpoint may not be live yet — store locally and return JSON
        const err = (e as Error).message ?? '';
        if (err.includes('404') || err.includes('not found') || err.includes('ECONNREFUSED')) {
          const exportJson = JSON.stringify({ title, description, visibility, lessons, exported_at: new Date().toISOString() }, null, 2);
          return [
            `📤 **brain_share** — exported ${lessons.length} lesson${lessons.length !== 1 ? 's' : ''}`,
            ``,
            `⚠️ The public share API is not yet available. Here is your portable snapshot:`,
            ``,
            `\`\`\`json`,
            exportJson.slice(0, 3000) + (exportJson.length > 3000 ? '\n... (truncated)' : ''),
            `\`\`\``,
            ``,
            `_To import this on another Brain, use \`brain_import\` with the JSON payload._`,
          ].join('\n');
        }
        return `❌ brain_share failed: ${(e as Error).message}`;
      }

      const sample = lessons.slice(0, 5).map(l => {
        const icon = l.outcome === 'success' ? '✅' : l.outcome === 'failure' ? '❌' : '⚠️';
        return `  ${icon} \`${l.topic}\``;
      });

      // Record provenance
      try {
        const prov = JSON.stringify({ share_id: shareId, title, visibility, lesson_count: lessons.length, created_at: new Date().toISOString() });
        await redis.rpush('cachly:brain:shares', prov);
        await redis.ltrim('cachly:brain:shares', -20, -1);
      } catch { /* non-critical */ }

      return [
        `📤 **brain_share** — ${lessons.length} lesson${lessons.length !== 1 ? 's' : ''} shared`,
        ``,
        `**Share ID:** \`${shareId}\``,
        `**URL:**      ${shareUrl}`,
        `**Title:**    ${title}`,
        `**Visible:**  ${visibility}`,
        ``,
        `**Sample lessons:**`,
        ...sample,
        lessons.length > 5 ? `  _...and ${lessons.length - 5} more_` : '',
        ``,
        `**Anyone can import this Brain with:**`,
        `\`brain_import(instance_id="<their-id>", share_id="${shareId}")\``,
        ``,
        `_To list all your shares, run \`brain_share_list\` (coming soon)._`,
      ].filter(l => l !== '').join('\n');
    }

    // ── brain_import ───────────────────────────────────────────────────────────
    case 'brain_import': {
      const {
        instance_id,
        share_id,
        topic_prefix = '',
        min_confidence = 0.0,
        dry_run = false,
        overwrite = false,
      } = args as {
        instance_id: string;
        share_id: string;
        topic_prefix?: string;
        min_confidence?: number;
        dry_run?: boolean;
        overwrite?: boolean;
      };

      if (!instance_id) return '⚠️ `brain_import` requires `instance_id`.';
      if (!share_id) return '⚠️ `brain_import` requires `share_id`. Get one from `brain_share`.';

      // Extract share ID from URL if passed as URL
      const cleanShareId = share_id.replace(/^.*\/brain\/share\//, '').trim();

      // Fetch the public share
      let payload: SharePayload;
      try {
        payload = await apiFetch<SharePayload>(`/api/v1/brains/share/${cleanShareId}`);
      } catch (e) {
        const err = (e as Error).message ?? '';
        if (err.includes('404') || err.includes('not found')) {
          return [
            `❌ **brain_import** — share not found`,
            ``,
            `Share ID \`${cleanShareId}\` does not exist or has been removed.`,
            ``,
            `Ask the Brain owner to re-run \`brain_share\` and share the new ID with you.`,
          ].join('\n');
        }
        return `❌ brain_import failed: ${(e as Error).message}`;
      }

      const lessons = payload.lessons ?? [];
      if (lessons.length === 0) {
        return `⚠️ Share \`${cleanShareId}\` exists but contains no lessons.`;
      }

      const redis = await getConnection(instance_id);
      let imported = 0;
      let skipped = 0;
      let conflicts = 0;
      const importLog: string[] = [];

      for (const lesson of lessons) {
        if ((lesson.confidence ?? 1.0) < (min_confidence as number)) { skipped++; continue; }

        const topic = topic_prefix ? `${topic_prefix}:${lesson.topic}` : lesson.topic;
        const bestKey = `cachly:lesson:best:${topic}`;

        // Check for existing lesson
        if (!overwrite) {
          const existing = await redis.get(bestKey);
          if (existing) { conflicts++; continue; }
        }

        const lessonToStore = JSON.stringify({
          ...lesson,
          topic,
          imported_from: cleanShareId,
          imported_at: new Date().toISOString(),
        });

        if (!dry_run) {
          await redis.set(bestKey, lessonToStore);
          const listKey = `cachly:lessons:${topic}`;
          await redis.rpush(listKey, lessonToStore);
          await redis.ltrim(listKey, -100, -1);
          await redis.expire(listKey, 90 * 86400);
        }

        imported++;
        if (importLog.length < 6) {
          const icon = lesson.outcome === 'success' ? '✅' : lesson.outcome === 'failure' ? '❌' : '⚠️';
          importLog.push(`  ${icon} \`${topic}\` — ${(lesson.what_worked ?? lesson.what_failed ?? '').slice(0, 80)}`);
        }
      }

      // Record import provenance
      if (!dry_run && imported > 0) {
        try {
          const prov = JSON.stringify({
            share_id: cleanShareId, title: payload.title,
            imported: imported, skipped, conflicts,
            topic_prefix, imported_at: new Date().toISOString(),
          });
          await redis.rpush('cachly:brain:imports', prov);
          await redis.ltrim('cachly:brain:imports', -20, -1);
        } catch { /* non-critical */ }
      }

      const dryTag = dry_run ? ' (DRY RUN — no writes)' : '';
      const shareTitle = payload.title ?? cleanShareId;
      const lines = [
        `📥 **brain_import${dryTag}** — from "${shareTitle}"`,
        ``,
        `**Share ID:** \`${cleanShareId}\``,
        `**Lessons imported:** ${imported}`,
        ...(skipped > 0 ? [`**Skipped (low confidence):** ${skipped}`] : []),
        ...(conflicts > 0 ? [`**Skipped (already exist):** ${conflicts}  _(pass \`overwrite=true\` to replace)_`] : []),
        ``,
      ];

      if (importLog.length > 0) {
        lines.push(`**Sample lessons imported:**`, ...importLog);
        if (imported > 6) lines.push(`  _...and ${imported - 6} more_`);
      }

      if (imported > 0 && !dry_run) {
        lines.push(
          ``,
          `✅ Brain updated — use \`smart_recall(query="...")\` to query the new knowledge.`,
        );
      } else if (dry_run) {
        lines.push(``, `_Remove \`dry_run=true\` to actually import these lessons._`);
      } else if (imported === 0 && conflicts > 0) {
        lines.push(
          ``,
          `ℹ️ All lessons already exist in your Brain. Pass \`overwrite=true\` to update them.`,
        );
      }

      return lines.join('\n');
    }

    // ── brain_share_list ───────────────────────────────────────────────────────
    case 'brain_share_list': {
      const { instance_id } = args as { instance_id: string };
      if (!instance_id) return '⚠️ `brain_share_list` requires `instance_id`.';

      const redis = await getConnection(instance_id);

      // Load from local provenance log
      let localShares: Array<{ share_id: string; title: string; visibility: string; lesson_count: number; created_at: string }> = [];
      try {
        const raw = await redis.lrange('cachly:brain:shares', 0, -1);
        localShares = raw.map(r => {
          try { return JSON.parse(r); } catch { return null; }
        }).filter(Boolean);
      } catch { /* non-critical */ }

      // Also try API for authoritative list
      let apiShares: typeof localShares = [];
      try {
        const result = await apiFetch<{ shares?: typeof localShares }>('/api/v1/brains/share');
        apiShares = result.shares ?? [];
      } catch { /* API may not be live yet */ }

      // Merge: API is authoritative; local fills gaps
      const merged = apiShares.length > 0 ? apiShares : localShares;

      if (merged.length === 0) {
        return [
          `📤 **brain_share_list** — no shares yet`,
          ``,
          `You haven't shared any Brain snapshots from this instance.`,
          ``,
          `Create one with: \`brain_share(instance_id="${instance_id}", title="My Patterns")\``,
        ].join('\n');
      }

      const lines = [
        `📤 **Your Brain Shares** (${merged.length})`,
        ``,
        `| # | Title | Lessons | Visibility | Created |`,
        `|---|-------|---------|------------|---------|`,
      ];
      for (const [i, s] of merged.entries()) {
        const d = new Date(s.created_at);
        const created = isNaN(d.getTime()) ? s.created_at : d.toISOString().slice(0, 10);
        const vis = s.visibility === 'public' ? '🌐 public' : '🔗 unlisted';
        lines.push(`| ${i + 1} | ${s.title ?? '—'} | ${s.lesson_count ?? '?'} | ${vis} | ${created} |`);
      }
      const newest = merged[merged.length - 1];
      lines.push(
        ``,
        `**Import command:** \`brain_import(instance_id="<their-id>", share_id="${newest?.share_id ?? '...'}")\``,
        `**Revoke:** \`brain_unshare(instance_id="${instance_id}", share_id="<id>")\``,
      );
      return lines.join('\n');
    }

    // ── brain_unshare ──────────────────────────────────────────────────────────
    case 'brain_unshare': {
      const { instance_id, share_id } = args as { instance_id: string; share_id: string };
      if (!instance_id) return '⚠️ `brain_unshare` requires `instance_id`.';
      if (!share_id) return '⚠️ `brain_unshare` requires `share_id`.';

      // Call API to delete
      try {
        await apiFetch(`/api/v1/brains/share/${share_id}`, { method: 'DELETE' });
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (msg.includes('404') || msg.includes('not found')) {
          return `❌ Share \`${share_id}\` not found — it may have already been removed.`;
        }
        // If API is down, just remove from local log and warn
        if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
          const redis = await getConnection(instance_id);
          try {
            const raw = await redis.lrange('cachly:brain:shares', 0, -1);
            const kept = raw.filter(r => { try { return JSON.parse(r).share_id !== share_id; } catch { return true; } });
            await redis.del('cachly:brain:shares');
            for (const entry of kept) await redis.rpush('cachly:brain:shares', entry);
          } catch { /* non-critical */ }
          return [
            `⚠️ **brain_unshare** — removed from local log`,
            ``,
            `API unreachable — removed \`${share_id}\` from your local share registry.`,
            `The public link may still be accessible until the API confirms deletion.`,
          ].join('\n');
        }
        return `❌ brain_unshare failed: ${msg}`;
      }

      // Remove from local log
      const redis = await getConnection(instance_id);
      try {
        const raw = await redis.lrange('cachly:brain:shares', 0, -1);
        const kept = raw.filter(r => { try { return JSON.parse(r).share_id !== share_id; } catch { return true; } });
        await redis.del('cachly:brain:shares');
        for (const entry of kept) await redis.rpush('cachly:brain:shares', entry);
      } catch { /* non-critical */ }

      return [
        `🗑️ **brain_unshare** — share revoked`,
        ``,
        `Share \`${share_id}\` has been deleted. The public link is no longer accessible.`,
        ``,
        `_Anyone who already imported this Brain keeps their local copy._`,
      ].join('\n');
    }

    // ── brain_discover ─────────────────────────────────────────────────────────
    case 'brain_discover': {
      const {
        query = '',
        topic = '',
        limit = 10,
      } = args as { query?: string; topic?: string; limit?: number };

      // Search public Brain marketplace
      let results: Array<{
        share_id: string;
        title: string;
        description?: string;
        lesson_count: number;
        topics?: string[];
        author?: string;
        created_at: string;
        imports?: number;
      }> = [];

      try {
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        if (topic) params.set('topic', topic);
        params.set('limit', String(limit));
        results = await apiFetch<typeof results>(`/api/v1/brains/discover?${params.toString()}`);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        if (msg.includes('404') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
          return [
            `🔍 **brain_discover** — marketplace not yet live`,
            ``,
            `The public Brain marketplace is coming soon.`,
            ``,
            `**In the meantime:**`,
            `  • Share your Brain: \`brain_share(instance_id="...", visibility="public")\``,
            `  • Import by ID:    \`brain_import(instance_id="...", share_id="<id>")\``,
            `  • Community index: https://cachly.dev/brains`,
          ].join('\n');
        }
        return `❌ brain_discover failed: ${msg}`;
      }

      if (results.length === 0) {
        const hint = query ? `matching "${query}"` : topic ? `in topic "${topic}"` : '';
        return [
          `🔍 **brain_discover** — no public Brains found ${hint}`.trim(),
          ``,
          `Be the first! \`brain_share(instance_id="...", visibility="public")\``,
        ].join('\n');
      }

      const lines = [
        `🔍 **brain_discover**${query ? ` — "${query}"` : ''}${topic ? ` · topic: ${topic}` : ''} (${results.length} result${results.length !== 1 ? 's' : ''})`,
        ``,
      ];

      for (const [i, r] of results.entries()) {
        const d = new Date(r.created_at);
        const created = isNaN(d.getTime()) ? '' : ` · ${d.toISOString().slice(0, 10)}`;
        const importCount = r.imports != null ? ` · ${r.imports} imports` : '';
        const topicStr = r.topics?.length ? ` · topics: ${r.topics.slice(0, 4).join(', ')}` : '';
        const by = r.author ? ` by **${r.author}**` : '';
        lines.push(
          `**${i + 1}. ${r.title}**${by}`,
          `   📚 ${r.lesson_count} lessons${topicStr}${importCount}${created}`,
          r.description ? `   _${r.description.slice(0, 120)}_` : '',
          `   \`brain_import(instance_id="...", share_id="${r.share_id}")\``,
          ``,
        );
      }

      lines.push(`_Browse more at https://cachly.dev/brains_`);
      return lines.filter(l => l !== '   ').join('\n');
    }

    // ── brain_seed_starter ─────────────────────────────────────────────────────
    // Seeds a fresh Brain with curated, universal engineering lessons so the very
    // first query returns a hit — drives time-to-first-recall under 2 minutes.
    case 'brain_seed_starter': {
      const {
        instance_id,
        topic_filter,
        dry_run = false,
        force = false,
      } = args as {
        instance_id: string;
        topic_filter?: string[];
        dry_run?: boolean;
        force?: boolean;
      };

      if (!instance_id) return '⚠️ `brain_seed_starter` requires `instance_id`.';

      const redis = await getConnection(instance_id);

      // Idempotency guard: don't double-seed unless force=true.
      const seededMarker = await redis.get(`cachly:brain:starter_seeded:${instance_id}`);
      if (seededMarker && !force && !dry_run) {
        return [
          `🌱 **brain_seed_starter** — already seeded`,
          ``,
          `This Brain was seeded with the starter corpus on ${seededMarker}.`,
          ``,
          `Pass \`force=true\` to re-seed (existing starter lessons will be refreshed).`,
        ].join('\n');
      }

      const topicFilter = Array.isArray(topic_filter) && topic_filter.length > 0 ? topic_filter : undefined;
      const selected = topicFilter
        ? STARTER_CORPUS.filter(l => topicFilter.some(f => l.topic.includes(f) || l.tags.some(t => t.includes(f))))
        : STARTER_CORPUS;

      if (selected.length === 0) {
        return [
          `🌱 **brain_seed_starter** — no matching starter lessons`,
          ``,
          `No starter lessons match filter: ${topicFilter?.join(', ')}.`,
          `Available topics: ${STARTER_CORPUS.map(l => `\`${l.topic}\``).join(', ')}`,
        ].join('\n');
      }

      if (dry_run) {
        const sample = selected.slice(0, 8).map(l => `  ✅ \`${l.topic}\` — ${l.what_worked.slice(0, 70)}…`);
        return [
          `🌱 **brain_seed_starter (DRY RUN)** — would seed ${selected.length} lesson${selected.length !== 1 ? 's' : ''}`,
          ``,
          ...sample,
          selected.length > 8 ? `  _...and ${selected.length - 8} more_` : '',
          ``,
          `_Remove \`dry_run=true\` to seed these into the Brain._`,
        ].filter(l => l !== '').join('\n');
      }

      const now = new Date().toISOString();
      let seeded = 0;
      let skipped = 0;
      for (const lesson of selected) {
        const bestKey = `cachly:lesson:best:${lesson.topic}`;

        // Never clobber a user's own lesson on the same topic (unless force).
        if (!force) {
          const existing = await redis.get(bestKey);
          if (existing) {
            const parsed = safeJsonParse<{ source?: string } | null>(existing, null);
            // Only skip if it's a real user lesson (not a prior starter seed).
            if (parsed && parsed.source !== 'starter') { skipped++; continue; }
          }
        }

        const lessonToStore = JSON.stringify({
          topic: lesson.topic,
          outcome: lesson.outcome,
          what_worked: lesson.what_worked,
          what_failed: lesson.what_failed,
          ctx: lesson.ctx,
          tags: lesson.tags,
          confidence: lesson.confidence,
          recall_count: 0,
          source: 'starter',
          ts: now,
          verified_at: now,
          version: 3,
        });

        await redis.set(bestKey, lessonToStore);
        const listKey = `cachly:lessons:${lesson.topic}`;
        await redis.rpush(listKey, lessonToStore);
        await redis.ltrim(listKey, -100, -1);
        await redis.expire(listKey, 90 * 86400);
        seeded++;
      }

      // Stamp born_at so time-to-first-recall starts counting from the seed moment.
      await redis.set(`cachly:stats:born_at:${instance_id}`, now, 'EX', 365 * 86400, 'NX').catch(() => {});
      // Mark seeded for idempotency.
      await redis.set(`cachly:brain:starter_seeded:${instance_id}`, now, 'EX', 365 * 86400);

      return [
        `🌱 **brain_seed_starter** — Brain seeded`,
        ``,
        `**${seeded}** universal engineering lesson${seeded !== 1 ? 's' : ''} added${skipped > 0 ? ` (${skipped} skipped — your own lessons take priority)` : ''}.`,
        ``,
        `Your Brain now answers common questions out of the box:`,
        `  • \`smart_recall(query="docker build slow")\``,
        `  • \`smart_recall(query="pod OOMKilled")\``,
        `  • \`smart_recall(query="jwt token rejected")\``,
        ``,
        `_Starter lessons are tagged \`source: "starter"\` and never override your own._`,
        `_They're replaced as you learn project-specific lessons on the same topics._`,
      ].join('\n');
    }

    default:
      return null;
  }
}

/** Exposed for the empty-brain welcome nudge in session_start. */
export { STARTER_CORPUS_SIZE };
