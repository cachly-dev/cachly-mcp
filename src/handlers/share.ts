import type { Redis } from 'ioredis';
import { safeJsonParse } from '../utils.js';

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const SHARE_TOOL_NAMES = new Set([
  'brain_share', 'brain_import',
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

    default:
      return null;
  }
}
