import type { Redis } from 'ioredis';

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const ROADMAP_TOOL_NAMES = new Set([
  'roadmap_add', 'roadmap_update', 'roadmap_list', 'roadmap_next',
]);

export async function handleRoadmapTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
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

    default:
      return null;
  }
}
