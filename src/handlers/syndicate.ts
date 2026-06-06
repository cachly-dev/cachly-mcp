import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { Redis } from 'ioredis';
import { calculateConfidence } from '../confidence.js';
import { ckgSlug } from '../ckg.js';
import type { CKGEdge, CKGNode } from '../ckg.js';
import { keywordSearch } from '../search.js';
import { safeJsonParse } from '../utils.js';

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const SYNDICATE_TOOL_NAMES = new Set([
  'syndicate', 'syndicate_search', 'syndicate_stats', 'syndicate_trending',
  'brain_search', 'ckg_inspect', 'brain_predict', 'brain_plan',
  'brain_marketplace', 'brain_install',
  'brain_conflicts', 'brain_resolve_conflict',
  'brain_confirm_ci', 'brain_briefing',
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
        top_contributors?: Array<{
          trust_score: number; lessons_count: number; confirms_received: number;
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
      if (res.top_contributors?.length) {
        lines.push(``, `### 🏅 Top Contributors (anonymous)`);
        for (const c of res.top_contributors) {
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
          const edge = safeJsonParse<CKGEdge | null>(raw, null);
          if (!edge) continue;
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
          const node = safeJsonParse<CKGNode | null>(nodeRaw, null);
          if (!node) continue;
          const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${node.id}`);
          for (const ek of edgeKeys.slice(0, 20)) {
            const edgeRaw = await redis.get(ek);
            if (!edgeRaw) continue;
            const edge = safeJsonParse<CKGEdge | null>(edgeRaw, null);
            if (!edge) continue;
            // Only interested in fixes and co-occurs for prediction
            if (edge.edgeType !== 'fixes' && edge.edgeType !== 'co-occurs' && edge.edgeType !== 'causes') continue;
            const lessonRaw = await redis.get(`cachly:lesson:best:${edge.from}`);
            const lesson = lessonRaw ? safeJsonParse<{ what_worked?: string; topic: string } | null>(lessonRaw, null) ?? undefined : undefined;
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
        {
          type PredLesson = { topic: string; what_worked?: string; what_failed?: string; outcome: string; severity?: string; ts: string; verified_at?: string; recall_count?: number };
          const l = safeJsonParse<PredLesson | null>(raw, null);
          if (!l) continue;
          const haystack = [l.topic, l.what_failed ?? '', l.what_worked ?? ''].join(' ').toLowerCase();
          const score = ctxTokens.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
          if (score >= 1 && l.outcome !== 'failure') {
            const conf = calculateConfidence(l);
            textPredictions.push({ ...l, confidence: conf });
          }
        }
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

    // ── brain_plan: generative planning on top of the CKG ───────────────────────
    // Where brain_predict answers "what might fail?", brain_plan answers "what
    // should I do, in what order?". It reads the same lessons + CKG but reframes
    // them as an actionable plan: ranked failure modes to avoid, ordered steps
    // grounded in proven fixes (dependency-aware), and a pre-flight checklist.
    case 'brain_plan': {
      const { instance_id, task, top_k = 5 } = args as { instance_id: string; task: string; top_k?: number };
      if (!task || !task.trim()) {
        throw new McpError(ErrorCode.InvalidParams, 'task is required');
      }
      const redis = await getConnection(instance_id);

      const taskTokens = task.toLowerCase().replace(/[^a-z0-9\s\-_:]/g, ' ').split(/\s+/).filter(t => t.length > 2);

      type PlanLesson = {
        topic: string; outcome: string; what_worked?: string; what_failed?: string;
        severity?: string; ts: string; verified_at?: string; recall_count?: number;
        commands?: string[]; file_paths?: string[]; depends_on?: string[]; confidence?: number;
      };

      // Scan every best-lesson once and score by token overlap against the task.
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((res, rej) => { lStream.on('data', (b: string[]) => lessonKeys.push(...b)); lStream.on('end', res); lStream.on('error', rej); });

      const scored: Array<{ l: PlanLesson; score: number; confidence: number }> = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        const l = safeJsonParse<PlanLesson | null>(raw, null);
        if (!l) continue;
        const haystack = [l.topic, l.what_worked ?? '', l.what_failed ?? ''].join(' ').toLowerCase();
        const score = taskTokens.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
        if (score >= 1) scored.push({ l, score, confidence: calculateConfidence(l) });
      }

      if (scored.length === 0) {
        return [
          `🗺️ **Brain Plan: "${task}"**`,
          ``,
          `No grounded plan yet — the brain hasn't seen this area.`,
          ``,
          `💡 As you work here and call \`learn_from_attempts\`, brain_plan will assemble`,
          `   an ordered, proven plan from your own history. For now, proceed carefully`,
          `   and capture what works.`,
        ].join('\n');
      }

      // Rank: relevance first, then confidence. Split into failure modes (things
      // that bit us before) vs. proven steps (successful fixes).
      scored.sort((a, b) => (b.score - a.score) || (b.confidence - a.confidence));
      const failureModes = scored.filter(s => s.l.outcome === 'failure' || (s.l.what_failed ?? '').trim().length > 0);
      const provenSteps = scored.filter(s => s.l.outcome === 'success' || s.l.outcome === 'partial');

      const lines = [`🗺️ **Brain Plan: "${task}"**`, '', `_Grounded in ${scored.length} relevant lesson${scored.length !== 1 ? 's' : ''} from your own Brain._`, ''];

      // ── Section 1: failure modes to avoid, ranked by confidence ───────────────
      if (failureModes.length > 0) {
        lines.push(`### ⚠️ Likely failure modes (avoid these)`);
        const sevRank: Record<string, number> = { critical: 0, major: 1, minor: 2 };
        failureModes
          .slice()
          .sort((a, b) => (sevRank[a.l.severity ?? 'minor'] ?? 1) - (sevRank[b.l.severity ?? 'minor'] ?? 1) || b.confidence - a.confidence)
          .slice(0, top_k)
          .forEach(({ l, confidence }) => {
            const sevEmoji = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '🟢';
            const detail = (l.what_failed ?? l.what_worked ?? '').slice(0, 120);
            lines.push(`${sevEmoji} **${Math.round(confidence * 100)}%** \`${l.topic}\`${detail ? ` — ${detail}` : ''}`);
          });
        lines.push('');
      }

      // ── Section 2: ordered, proven steps (dependency-aware) ───────────────────
      if (provenSteps.length > 0) {
        // Order steps so that any step a lesson depends_on comes first. We only
        // have topics + depends_on links; do a light topological pass over the
        // selected set, falling back to relevance order for anything unresolved.
        const selected = provenSteps.slice(0, top_k);
        const byTopic = new Map(selected.map(s => [s.l.topic, s]));
        const ordered: typeof selected = [];
        const placed = new Set<string>();
        const place = (s: typeof selected[number], depth: number) => {
          if (placed.has(s.l.topic) || depth > 10) return;
          for (const dep of s.l.depends_on ?? []) {
            const depEntry = byTopic.get(dep);
            if (depEntry && !placed.has(dep)) place(depEntry, depth + 1);
          }
          if (!placed.has(s.l.topic)) { placed.add(s.l.topic); ordered.push(s); }
        };
        for (const s of selected) place(s, 0);

        lines.push(`### 🔧 Recommended steps (proven fixes, in order)`);
        ordered.forEach(({ l, confidence }, i) => {
          lines.push(`${i + 1}. **${Math.round(confidence * 100)}%** \`${l.topic}\` — ${(l.what_worked ?? '').slice(0, 140)}`);
          const cmds = (l.commands ?? []).slice(0, 2);
          if (cmds.length > 0) lines.push(`   \`\`\`\n   ${cmds.join('\n   ')}\n   \`\`\``);
          if ((l.depends_on ?? []).length > 0) lines.push(`   ↳ depends on: ${(l.depends_on ?? []).map(d => `\`${d}\``).join(', ')}`);
        });
        lines.push('');
      }

      // ── Section 3: pre-flight checklist ──────────────────────────────────────
      const checklist = scored
        .filter(s => (s.l.file_paths ?? []).length > 0 || (s.l.commands ?? []).length > 0)
        .slice(0, 4);
      if (checklist.length > 0) {
        lines.push(`### ✅ Pre-flight checklist`);
        const touchedFiles = [...new Set(checklist.flatMap(s => s.l.file_paths ?? []))].slice(0, 6);
        if (touchedFiles.length > 0) {
          lines.push(`  • Review files that were involved before: ${touchedFiles.map(f => `\`${f}\``).join(', ')}`);
        }
        lines.push(`  • Confirm the top failure mode above can't recur in your change`);
        lines.push(`  • Have a rollback ready for any \`critical\`/\`major\` step`);
        lines.push('');
      }

      lines.push(`💡 After you ship: \`learn_from_attempts(topic="...", outcome="success", ...)\` → the next plan gets sharper.`);
      return lines.join('\n');
    }

    // ── W10: Domain Brains marketplace — brain_marketplace ──────────────────────
    // Browse curated, installable packs of high-trust community lessons by domain.
    case 'brain_marketplace': {
      const { min_confirms = 1 } = args as { min_confirms?: number };
      const params = new URLSearchParams();
      if (min_confirms && min_confirms > 1) params.set('min_confirms', String(min_confirms));

      const res = await apiFetch<{
        brains: Array<{
          slug: string; name: string; icon: string; description: string;
          category: string; lesson_count: number; total_confirms: number;
          curated: boolean; last_updated: string;
        }>;
        count: number;
      }>(`/api/v1/syndication/brains${params.toString() ? `?${params}` : ''}`);

      if (!res.brains || res.brains.length === 0) {
        return [
          `## 🧠 Domain Brain Marketplace`,
          ``,
          `No domain brains are available yet — the marketplace fills as the community`,
          `contributes verified lessons. Be an early contributor:`,
          `\`syndicate(topic="k8s:oom-kill", what_worked="raise memory limit + add probe")\``,
        ].join('\n');
      }

      const lines: string[] = [
        `## 🧠 Domain Brain Marketplace`,
        `*${res.count} installable brain${res.count === 1 ? '' : 's'} · curated from the global Knowledge Commons*`,
        ``,
      ];
      for (const b of res.brains) {
        const badge = b.curated ? '⭐ curated' : 'community';
        lines.push(
          `### ${b.icon} ${b.name}  \`${b.slug}\``,
          `${b.description}`,
          `**${b.lesson_count}** lesson${b.lesson_count === 1 ? '' : 's'} · 🤝 ${b.total_confirms} community confirm${b.total_confirms === 1 ? '' : 's'} · ${badge}`,
          `Install: \`brain_install(slug="${b.slug}")\``,
          ``,
        );
      }
      lines.push(
        `---`,
        `_Installed brains merge into your local Brain and surface in \`smart_recall\` — they never override your own lessons._`,
      );
      return lines.join('\n');
    }

    // ── W10: Domain Brains marketplace — brain_install ──────────────────────────
    // Pull a domain brain's curated lessons into the local Brain so they're
    // available offline in smart_recall. Idempotent + non-destructive: never
    // clobbers the user's own lessons (only prior marketplace installs).
    case 'brain_install': {
      const { instance_id, slug, min_confirms = 1, limit = 200, dry_run = false } = args as {
        instance_id: string; slug?: string; min_confirms?: number; limit?: number; dry_run?: boolean;
      };
      const cleanSlug = typeof slug === 'string' ? slug.trim() : '';
      if (!cleanSlug) {
        throw new McpError(ErrorCode.InvalidParams, 'slug is required — run brain_marketplace() to see available domain brains');
      }

      const params = new URLSearchParams();
      if (min_confirms && min_confirms > 1) params.set('min_confirms', String(min_confirms));
      if (limit && limit !== 200) params.set('limit', String(Math.min(Math.max(1, limit), 500)));

      const pack = await apiFetch<{
        slug: string; name: string; curated: boolean; count: number;
        lessons: Array<{
          topic: string; outcome: string; what_worked: string; what_failed: string;
          severity: string; tags: string; confirm_count: number;
        }>;
      }>(`/api/v1/syndication/brains/${encodeURIComponent(cleanSlug)}${params.toString() ? `?${params}` : ''}`);

      if (!pack.lessons || pack.lessons.length === 0) {
        return `No installable lessons found for domain brain \`${cleanSlug}\`. Run \`brain_marketplace()\` to see what's available.`;
      }

      if (dry_run) {
        return [
          `## 📦 ${pack.name} (DRY RUN)`,
          `Would install **${pack.lessons.length}** lesson${pack.lessons.length === 1 ? '' : 's'} into your Brain.`,
          ``,
          ...pack.lessons.slice(0, 15).map(l => `  • \`${l.topic}\` · 🤝 ${l.confirm_count}`),
          pack.lessons.length > 15 ? `  …and ${pack.lessons.length - 15} more` : '',
          ``,
          `Run without \`dry_run\` to install: \`brain_install(slug="${cleanSlug}")\``,
        ].filter(Boolean).join('\n');
      }

      const redis = await getConnection(instance_id);
      const source = `marketplace:${cleanSlug}`;
      const now = new Date().toISOString();
      let installed = 0;
      let skipped = 0;

      for (const l of pack.lessons) {
        if (!l.topic || !l.what_worked) { skipped++; continue; }
        const bestKey = `cachly:lesson:best:${l.topic}`;

        // Never clobber a user's own lesson (or a prior install from a different brain).
        const existing = await redis.get(bestKey);
        if (existing) {
          const parsed = safeJsonParse<{ source?: string } | null>(existing, null);
          if (parsed && parsed.source !== source) { skipped++; continue; }
        }

        // Tags arrive as a JSON string from the commons; normalise to an array.
        const tags = ((): string[] => {
          const t = safeJsonParse<unknown>(l.tags, []);
          return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
        })();

        const record = JSON.stringify({
          topic: l.topic,
          outcome: l.outcome || 'success',
          what_worked: l.what_worked,
          what_failed: l.what_failed || '',
          severity: l.severity || 'minor',
          tags,
          visibility: 'team',
          confidence: calculateConfidence({ ts: now, verified_at: now, recall_count: l.confirm_count }),
          recall_count: 0,
          source,
          ts: now,
          verified_at: now,
          version: 3,
        });

        await redis.set(bestKey, record);
        const listKey = `cachly:lessons:${l.topic}`;
        await redis.rpush(listKey, record);
        await redis.ltrim(listKey, -100, -1);
        await redis.expire(listKey, 90 * 86400);
        installed++;
      }

      // Stamp born_at so time-to-first-recall counts from the install moment.
      await redis.set(`cachly:stats:born_at:${instance_id}`, now, 'EX', 365 * 86400, 'NX').catch(() => {});

      return [
        `## 📦 Installed: ${pack.name}`,
        ``,
        `**${installed}** lesson${installed === 1 ? '' : 's'} merged into your Brain${skipped > 0 ? ` · ${skipped} skipped (your own lessons take priority)` : ''}.`,
        ``,
        `They're live in \`smart_recall\` now — try a query in this domain:`,
        `  • \`smart_recall(query="${pack.lessons[0]?.topic.split(':').pop() ?? 'your problem'}")\``,
        ``,
        `_Installed lessons are tagged \`source: "${source}"\` and never override your own. Re-run anytime to pull updates._`,
      ].join('\n');
    }

    // ── brain_conflicts: list live belief conflicts + active agents ─────────────
    // Surfaces every unresolved belief_conflict marker (a previously confirmed
    // fix now contradicted by a failure) plus the agents currently writing to
    // this Brain. This is the arbitration inbox for multi-agent teams (Move 4).
    case 'brain_conflicts': {
      const { instance_id } = args as { instance_id: string };
      const redis = await getConnection(instance_id);

      // Scan conflict markers
      type ConflictMarker = {
        topic: string; concept_id?: string; detected_at: string;
        fix_confidence: number; fix_trials: number; failure_outcome: string;
        reported_by?: string; what_failed?: string; resolved?: boolean;
      };
      const conflictKeys: string[] = [];
      const cStream = redis.scanStream({ match: 'cachly:ckg:conflict:*', count: 100 });
      await new Promise<void>((resolve, reject) => {
        cStream.on('data', (batch: string[]) => conflictKeys.push(...batch));
        cStream.on('end', resolve);
        cStream.on('error', reject);
      });

      const conflicts: ConflictMarker[] = [];
      if (conflictKeys.length > 0) {
        const raws = await redis.mget(...conflictKeys);
        for (const raw of raws) {
          const c = safeJsonParse<ConflictMarker | null>(raw ?? null, null);
          if (c && !c.resolved) conflicts.push(c);
        }
      }

      // Scan active agents
      type ActiveAgent = { author: string; last_topic?: string; last_outcome?: string; ts: string };
      const agentKeys: string[] = [];
      const aStream = redis.scanStream({ match: 'cachly:agents:active:*', count: 100 });
      await new Promise<void>((resolve, reject) => {
        aStream.on('data', (batch: string[]) => agentKeys.push(...batch));
        aStream.on('end', resolve);
        aStream.on('error', reject);
      });
      const agents: ActiveAgent[] = [];
      if (agentKeys.length > 0) {
        const raws = await redis.mget(...agentKeys);
        for (const raw of raws) {
          const a = safeJsonParse<ActiveAgent | null>(raw ?? null, null);
          if (a) agents.push(a);
        }
      }

      const lines: string[] = [`## ⚔️ Brain Conflicts & Live Agents`, ``];

      lines.push(`**🤖 Active agents (last 1h):** ${agents.length}`);
      if (agents.length > 0) {
        for (const a of agents.sort((x, y) => y.ts.localeCompare(x.ts)).slice(0, 10)) {
          const ago = Math.round((Date.now() - new Date(a.ts).getTime()) / 60000);
          lines.push(`  - **${a.author}** — last: \`${a.last_topic ?? '?'}\` (${a.last_outcome ?? '?'}, ${ago}m ago)`);
        }
      }
      lines.push('');

      if (conflicts.length === 0) {
        lines.push(`**✅ No unresolved belief conflicts.** The Brain is in consensus.`);
        return lines.join('\n');
      }

      lines.push(`**⚠️ Unresolved belief conflicts:** ${conflicts.length}`);
      lines.push('');
      lines.push(`| Topic | Confirmed fix | Contradicted by | Detected |`);
      lines.push(`|---|---|---|---|`);
      for (const c of conflicts.sort((x, y) => y.detected_at.localeCompare(x.detected_at)).slice(0, 20)) {
        const ago = Math.round((Date.now() - new Date(c.detected_at).getTime()) / 3600000);
        lines.push(`| \`${c.topic}\` | ${(c.fix_confidence * 100).toFixed(0)}% (n=${c.fix_trials}) | ${c.reported_by ?? 'unknown'} | ${ago}h ago |`);
      }
      lines.push('');
      lines.push(`_Arbitrate with \`brain_resolve_conflict(instance_id="${instance_id}", topic="<topic>", winner="success"|"failure")\`._`);

      return lines.join('\n');
    }

    // ── brain_resolve_conflict: arbitrate a belief conflict ─────────────────────
    // Picks a winning side for a contested topic. The losing side's CKG fixes
    // edges are decayed to near-zero confidence and the loser's `best` lesson is
    // archived; the winner is reinforced. The resolution is recorded so the
    // conflict no longer surfaces. Human-in-the-loop is the strongest signal.
    case 'brain_resolve_conflict': {
      const { instance_id, topic, winner, resolved_by = 'human' } = args as {
        instance_id: string; topic: string; winner: 'success' | 'failure'; resolved_by?: string;
      };
      if (!topic || !topic.trim()) {
        throw new McpError(ErrorCode.InvalidParams, 'topic is required');
      }
      if (winner !== 'success' && winner !== 'failure') {
        throw new McpError(ErrorCode.InvalidParams, 'winner must be "success" or "failure"');
      }
      const redis = await getConnection(instance_id);
      const conceptId = ckgSlug(topic);
      const conflictKey = `cachly:ckg:conflict:${conceptId}`;

      const markerRaw = await redis.get(conflictKey);
      if (!markerRaw) {
        return `📭 No active conflict found for \`${topic}\`. Run \`brain_conflicts(instance_id="${instance_id}")\` to list open conflicts.`;
      }

      // ── Decay the losing side's `fixes` edges ─────────────────────────────────
      // winner=success → the fix is real; keep fixes edges, no decay.
      // winner=failure → the fix is wrong; decay fixes edges to 0.1.
      let decayedEdges = 0;
      if (winner === 'failure') {
        const fromKeys = await redis.smembers(`cachly:ckg:idx:from:${conceptId}`);
        for (const ek of fromKeys) {
          const er = await redis.get(ek);
          if (!er) continue;
          const edge = safeJsonParse<CKGEdge | null>(er, null);
          if (!edge || edge.edgeType !== 'fixes') continue;
          edge.confidence = 0.1;
          await redis.set(ek, JSON.stringify(edge));
          decayedEdges++;
        }
      }

      // ── Archive the losing `best` lesson (if its outcome is the losing side) ──
      let archivedLesson = false;
      const bestKey = `cachly:lesson:best:${topic}`;
      const bestRaw = await redis.get(bestKey);
      if (bestRaw) {
        const lesson = safeJsonParse<{ outcome?: string; state?: string; audit_trail?: unknown[]; [k: string]: unknown } | null>(bestRaw, null);
        if (lesson && lesson.outcome === winner) {
          // The surviving lesson matches the winner — reinforce by clearing any provisional state.
          if (lesson.state === 'provisional') {
            lesson.state = 'active';
            lesson.verified_at = new Date().toISOString();
            await redis.set(bestKey, JSON.stringify(lesson));
          }
        } else if (lesson && lesson.outcome && lesson.outcome !== winner) {
          // The stored best lesson is the losing side — archive it.
          lesson.state = 'archived';
          lesson.audit_trail = [
            ...(Array.isArray(lesson.audit_trail) ? lesson.audit_trail : []),
            { ts: new Date().toISOString(), action: 'conflict_loser_archived', resolved_by },
          ];
          await redis.set(bestKey, JSON.stringify(lesson));
          archivedLesson = true;
        }
      }

      // ── Mark the conflict resolved ────────────────────────────────────────────
      const marker = safeJsonParse<Record<string, unknown> | null>(markerRaw, null) ?? {};
      marker.resolved = true;
      marker.winner = winner;
      marker.resolved_by = resolved_by;
      marker.resolved_at = new Date().toISOString();
      await redis.set(conflictKey, JSON.stringify(marker), 'EX', 60 * 60 * 24 * 30);

      return [
        `## ✅ Conflict resolved — \`${topic}\``,
        ``,
        `**Winner:** ${winner === 'success' ? '✅ success (fix is valid)' : '❌ failure (fix retired)'}`,
        `**Resolved by:** ${resolved_by}`,
        ``,
        `- CKG \`fixes\` edges decayed: **${decayedEdges}**`,
        `- Losing lesson archived: **${archivedLesson ? 'yes' : 'no'}**`,
        ``,
        winner === 'failure'
          ? `_The contradicted fix is retired. smart_recall will stop surfacing it; future attempts start fresh._`
          : `_The fix is reaffirmed. The contradicting failure no longer blocks recall._`,
      ].join('\n');
    }

    // ── v4 Move 1: brain_confirm_ci — closed-loop CI learning ────────────────
    case 'brain_confirm_ci': {
      const {
        instance_id,
        job_status,
        topics,
        scan_topics = [],
        source = 'manual',
      } = args as {
        instance_id: string;
        job_status: string;
        topics: string[];
        scan_topics?: string[];
        source?: string;
      };

      if (!job_status || !['success', 'failure', 'cancelled'].includes(job_status)) {
        throw new Error('job_status must be success, failure, or cancelled');
      }
      if (!topics?.length) throw new Error('topics is required');

      if (job_status === 'cancelled') {
        return '⏭️ CI was cancelled — no confidence changes applied.';
      }

      type DeltaResult = {
        updated: number;
        confidence_deltas: Array<{ topic: string; old: number; new: number; delta: number; reason: string }>;
        job_status: string;
      };

      let result: DeltaResult;
      try {
        result = await apiFetch<DeltaResult>(
          `/api/v1/instances/${instance_id}/ci-outcome`,
          {
            method: 'POST',
            body: JSON.stringify({ job_status, topics, scan_topics, source }),
          },
        );
      } catch {
        return `⚠️ Could not reach Brain API — CI outcome not recorded. Will retry on next call.`;
      }

      if (result.updated === 0) {
        return [
          `🤖 **brain_confirm_ci** — CI ${job_status}`,
          '',
          `No confidence changes (no matching predictions for these topics).`,
          `Topics checked: ${topics.slice(0, 5).map(t => `\`${t}\``).join(', ')}${topics.length > 5 ? ` +${topics.length - 5} more` : ''}`,
        ].join('\n');
      }

      const lines = [
        `🤖 **brain_confirm_ci** — CI ${job_status === 'success' ? '✅' : '❌'} · ${result.updated} lesson${result.updated !== 1 ? 's' : ''} updated`,
        '',
        `| Topic | Old | New | Δ | Reason |`,
        `|---|---|---|---|---|`,
      ];
      for (const d of result.confidence_deltas) {
        const sign = d.delta > 0 ? '+' : '';
        const icon = d.reason === 'confirmed_failure' ? '🔴' : '🟡';
        lines.push(`| \`${d.topic}\` | ${(d.old * 100).toFixed(0)}% | ${(d.new * 100).toFixed(0)}% | ${sign}${(d.delta * 100).toFixed(0)}% | ${icon} ${d.reason} |`);
      }
      lines.push('', `_Brain self-calibrated from real CI signal. No manual \`learn_from_attempts\` needed._`);
      return lines.join('\n');
    }

    case 'brain_briefing': {
      const {
        instance_id,
        event_type,
        context,
        threshold,
      } = args as {
        instance_id: string;
        event_type: string;
        context: string;
        threshold?: number;
      };

      if (!['file_open', 'pr_open', 'deploy', 'manual'].includes(event_type)) {
        throw new Error('event_type must be file_open, pr_open, deploy, or manual');
      }
      if (!context?.trim()) throw new Error('context is required');

      type BriefingWarning = { topic: string; confidence: number; severity: string; message: string; fix: string };
      type BriefingResult = {
        event_type: string;
        risk_level: 'low' | 'medium' | 'high';
        warnings: BriefingWarning[];
        matched_lessons: number;
      };

      let result: BriefingResult;
      try {
        result = await apiFetch<BriefingResult>(
          `/api/v1/instances/${instance_id}/briefing`,
          {
            method: 'POST',
            body: JSON.stringify({ event_type, context, ...(threshold !== undefined ? { threshold } : {}) }),
          },
        );
      } catch {
        return `⚠️ Could not reach Brain API — no proactive briefing available right now.`;
      }

      const eventIcon = event_type === 'file_open' ? '📂' : event_type === 'pr_open' ? '🔀' : event_type === 'deploy' ? '🚀' : '🔍';

      if (result.warnings.length === 0) {
        return [
          `${eventIcon} **brain_briefing** — ${event_type} · ✅ no known risk patterns matched`,
          '',
          `Checked against ${result.matched_lessons} related lesson${result.matched_lessons !== 1 ? 's' : ''}. You're clear to proceed.`,
        ].join('\n');
      }

      const riskIcon = result.risk_level === 'high' ? '🔴' : result.risk_level === 'medium' ? '🟡' : '🟢';
      const lines = [
        `${eventIcon} **brain_briefing** — ${event_type} · ${riskIcon} risk: ${result.risk_level.toUpperCase()}`,
        '',
        `The Brain proactively found ${result.warnings.length} known pattern${result.warnings.length !== 1 ? 's' : ''} that may apply here:`,
        '',
        `| Topic | Confidence | Severity | What to watch | Known fix |`,
        `|---|---|---|---|---|`,
      ];
      for (const w of result.warnings) {
        const fix = w.fix ? (w.fix.length > 80 ? w.fix.slice(0, 80) + '…' : w.fix) : '—';
        lines.push(`| \`${w.topic}\` | ${(w.confidence * 100).toFixed(0)}% | ${w.severity} | ${w.message} | ${fix} |`);
      }
      lines.push('', `_Surfaced proactively — no \`smart_recall\` needed. Address the highest-confidence items first._`);
      return lines.join('\n');
    }

    // ── Layer 3: MADC ─────────────────────────────────────────────────────────

    default:
      return null;
  }
}
