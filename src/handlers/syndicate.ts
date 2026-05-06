import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Redis } from 'ioredis';
import { calculateConfidence } from '../confidence.js';
import { ckgSlug, ckgUpdateEdge } from '../ckg.js';
import type { CKGEdge, CKGNode } from '../ckg.js';
import { keywordSearch, tokenize } from '../search.js';

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const SYNDICATE_TOOL_NAMES = new Set([
  'syndicate', 'syndicate_search', 'syndicate_stats', 'syndicate_trending',
  'brain_search', 'ckg_inspect', 'brain_predict',
]);

export async function handleSyndicateTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
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

    default:
      return null;
  }
}
