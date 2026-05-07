import type { Redis } from 'ioredis';
import { calculateConfidence, confidenceBadge, CONFIDENCE_STALE_VALUE, CONFIDENCE_WARN_VALUE,
         CONFIDENCE_WARN_DAYS } from '../confidence.js';
import { ckgSlug, ckgUpdateEdge } from '../ckg.js';
import type { CKGEdge, CKGNode } from '../ckg.js';
import { keywordSearch } from '../search.js';
import { safeJsonParse } from '../utils.js';

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const ADVANCED_TOOL_NAMES = new Set([
  'memory_consolidate', 'brain_diff', 'causal_trace', 'knowledge_decay', 'autopilot',
]);

export async function handleAdvancedTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
    case 'memory_consolidate': {
      const { instance_id, dry_run = false, stale_days = 90 } = args as {
        instance_id: string; dry_run?: boolean; stale_days?: number;
      };
      const redis = await getConnection(instance_id);
      const now = Date.now();
      const staleMs = stale_days * 86400 * 1000;

      // Scan all lessons
      let cursor = 0;
      const lessonKeys: string[] = [];
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 200);
        cursor = parseInt(next);
        lessonKeys.push(...keys);
      } while (cursor !== 0);

      if (lessonKeys.length === 0) {
        return '🧠 **Brain is empty** — no lessons to consolidate yet. Use `learn_from_attempts` after your next bug fix.';
      }

      type Lesson = { topic: string; outcome: string; what_worked?: string; what_failed?: string; ts: string; recall_count?: number; severity?: string; tags?: string[] };
      const lessons: Map<string, Lesson> = new Map();
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        const lesson = safeJsonParse<Lesson | null>(raw, null);
        if (lesson) lessons.set(k, lesson);
      }

      // Detect duplicates: same topic prefix (e.g. deploy:api vs deploy:api-v2)
      const duplicates: string[][] = [];
      const topicGroups = new Map<string, string[]>();
      for (const [k, l] of lessons) {
        const prefix = l.topic.split(':')[0];
        const group = topicGroups.get(prefix) ?? [];
        group.push(k);
        topicGroups.set(prefix, group);
      }

      // Detect contradictions: same exact topic, different outcomes
      const contradictions: Array<{ topic: string; keys: string[] }> = [];
      const exactTopics = new Map<string, string[]>();
      for (const [k, l] of lessons) {
        const arr = exactTopics.get(l.topic) ?? [];
        arr.push(k);
        exactTopics.set(l.topic, arr);
      }
      for (const [topic, keys] of exactTopics) {
        const outcomes = new Set(keys.map(k => lessons.get(k)?.outcome));
        if (outcomes.size > 1) contradictions.push({ topic, keys });
      }

      // Detect stale: not recalled in stale_days
      const stale: string[] = [];
      for (const [k, l] of lessons) {
        const age = now - new Date(l.ts).getTime();
        const recalls = l.recall_count ?? 0;
        if (age > staleMs && recalls === 0) stale.push(k);
      }

      // Merge duplicates by prefix: keep the success/highest-severity one
      let merged = 0;
      if (!dry_run) {
        for (const [, keys] of topicGroups) {
          if (keys.length < 2) continue;
          const bySuccess = keys.filter(k => lessons.get(k)?.outcome === 'success');
          const winner = bySuccess[0] ?? keys[0];
          for (const k of keys) {
            if (k !== winner) { await redis.del(k); merged++; }
          }
        }
        // Resolve contradictions: keep success, delete failure for same topic
        for (const { keys } of contradictions) {
          const success = keys.find(k => lessons.get(k)?.outcome === 'success');
          if (success) {
            for (const k of keys) {
              if (k !== success) { await redis.del(k); }
            }
          }
        }
        // Flag stale entries with a TTL of 30 days (not deleted, just expiring)
        for (const k of stale) {
          await redis.expire(k, 86400 * 30);
        }
      }

      const lines = [
        `🔬 **Memory Consolidation Report** ${dry_run ? '(dry run — no changes made)' : '✅ Applied'}`,
        ``,
        `📊 **Before:** ${lessonKeys.length} lessons`,
        ``,
        `🔁 **Contradictions detected:** ${contradictions.length}`,
        ...contradictions.slice(0, 5).map(c => `  → \`${c.topic}\`: ${c.keys.length} conflicting entries (kept: success)`),
        contradictions.length > 5 ? `  … and ${contradictions.length - 5} more` : '',
        ``,
        `♻️ **Duplicate clusters:** ${Array.from(topicGroups.values()).filter(v => v.length > 1).length}` +
          (merged > 0 ? ` → ${merged} entries merged` : ''),
        ``,
        `🕰️ **Stale entries (${stale_days}d, 0 recalls):** ${stale.length}` +
          (stale.length > 0 && !dry_run ? ` → set to expire in 30 days` : ''),
        ``,
        `📊 **After:** ${dry_run ? lessonKeys.length : lessonKeys.length - merged} lessons`,
        ``,
        dry_run
          ? `💡 Re-run without dry_run=true to apply changes.`
          : `✨ Brain consolidated. Run \`brain_diff(since="1h")\` to see the delta.`,
      ].filter(s => s !== '').join('\n');
      return lines;
    }

    // ── v0.6 Cognitive Cache: brain_diff ─────────────────────────────────────
    case 'brain_diff': {
      const { instance_id, since = '7d', format = 'summary' } = args as {
        instance_id: string; since?: string; format?: 'summary' | 'detailed';
      };
      const redis = await getConnection(instance_id);

      // Parse since
      let sinceMs: number;
      const match = since.match(/^(\d+)([dhm])$/);
      if (match) {
        const n = parseInt(match[1]);
        const unit = match[2];
        const mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : 60000;
        sinceMs = Date.now() - n * mult;
      } else {
        sinceMs = new Date(since).getTime() || Date.now() - 7 * 86400000;
      }

      // Scan all lessons
      let cursor = 0;
      const lessonKeys: string[] = [];
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 200);
        cursor = parseInt(next);
        lessonKeys.push(...keys);
      } while (cursor !== 0);

      type Lesson = { topic: string; outcome: string; what_worked?: string; ts: string; recall_count?: number; severity?: string };
      const added: Lesson[] = [];
      const updated: Lesson[] = [];
      const recalled: Lesson[] = [];
      const total = lessonKeys.length;

      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        {
          const l = safeJsonParse<Lesson | null>(raw, null);
          if (!l) continue;
          const ts = new Date(l.ts).getTime();
          if (ts >= sinceMs) {
            // Check history to determine add vs update
            const histKey = `cachly:lesson:history:${l.topic}`;
            const histLen = await redis.llen(histKey);
            if (histLen <= 1) added.push(l);
            else updated.push(l);
          }
          if ((l.recall_count ?? 0) > 0) {
            // We can't easily know when last recalled without extra metadata, so include
            // lessons with recalls as "active"
            recalled.push(l);
          }
        }
      }

      const sinceLabel = match ? `last ${since}` : new Date(sinceMs).toLocaleDateString('de-DE');
      const lines: string[] = [
        `📊 **Brain Diff** — ${sinceLabel}`,
        ``,
        `Total lessons in brain: **${total}**`,
        ``,
        `✅ **New** (${added.length}):`,
        ...added.slice(0, format === 'detailed' ? 20 : 5).map(l =>
          `  + \`${l.topic}\` — ${l.outcome} ${l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟠' : '🟢'}`
        ),
        added.length > 5 && format === 'summary' ? `  … and ${added.length - 5} more` : '',
        ``,
        `🔄 **Updated** (${updated.length}):`,
        ...updated.slice(0, format === 'detailed' ? 20 : 5).map(l =>
          `  ~ \`${l.topic}\` — now: ${l.outcome}`
        ),
        updated.length > 5 && format === 'summary' ? `  … and ${updated.length - 5} more` : '',
        ``,
        `🔍 **Active** (recalled at least once): ${recalled.length}`,
        ``,
      ].filter(s => s !== '');

      // ── 10X brain_diff extensions ──────────────────────────────────────────
      // 1. Contested → Established (resolution nodes created in window)
      const resolutionKeys: string[] = [];
      const rsStream = redis.scanStream({ match: 'cachly:ckg:node:resolution-*', count: 100 });
      await new Promise<void>((res, rej) => { rsStream.on('data', (b: string[]) => resolutionKeys.push(...b)); rsStream.on('end', res); rsStream.on('error', rej); });
      const recentResolutions: Array<{ topic: string; resolution: string; ts: string }> = [];
      for (const rk of resolutionKeys) {
        const rr = await redis.get(rk);
        if (!rr) continue;
        {
          const rn = safeJsonParse<{ topic?: string; resolution?: string; ts?: string } | null>(rr, null);
          if (rn?.ts && new Date(rn.ts).getTime() >= sinceMs) recentResolutions.push({ topic: rn.topic ?? rk, resolution: rn.resolution ?? 'unknown', ts: rn.ts });
        }
      }
      if (recentResolutions.length > 0) {
        lines.push(`🗳️ **MADC Resolutions** (${recentResolutions.length} contested beliefs resolved):`);
        for (const r of recentResolutions.slice(0, 5)) {
          const rIcon = r.resolution === 'unanimous_success' ? '✅' : r.resolution === 'unanimous_failure' ? '❌' : '⚠️';
          lines.push(`  ${rIcon} \`${r.topic}\` → ${r.resolution}`);
        }
        lines.push('');
      }

      // 2. New domains bootstrapped (domains in added lessons that weren't in older lessons)
      const existingDomains = new Set(updated.concat(recalled).map(l => l.topic.split(':')[0]));
      const newDomains = [...new Set(added.map(l => l.topic.split(':')[0]))].filter(d => !existingDomains.has(d));
      if (newDomains.length > 0) {
        lines.push(`🌱 **New domains bootstrapped:** ${newDomains.map(d => `\`${d}\``).join(', ')}`, '');
      }

      // 3. FedBrain transfers received in window
      const fedHistRaw = await redis.lrange('cachly:fedbrain:federations', -20, -1);
      type FedEntry = { source: string; domain: string; transferred_at: string; nodes: number; edges: number };
      const recentFeds = fedHistRaw
        .map(r => safeJsonParse<FedEntry | null>(r, null))
        .filter((f): f is FedEntry => f !== null && new Date(f.transferred_at).getTime() >= sinceMs);
      if (recentFeds.length > 0) {
        lines.push(`🧠 **FedBrain transfers received (${recentFeds.length}):**`);
        for (const f of recentFeds.slice(0, 3)) {
          lines.push(`  📥 domain \`${f.domain}\` from \`${f.source.slice(0, 16)}…\` — ${f.nodes} nodes, ${f.edges} edges`);
        }
        lines.push('');
      }

      lines.push(`💡 Run \`memory_consolidate\` to merge duplicates · \`knowledge_decay\` to see confidence scores.`);
      return lines.join('\n');
    }

    // ── v0.6 Cognitive Cache: causal_trace ───────────────────────────────────
    case 'causal_trace': {
      const { instance_id, problem, max_depth = 5, tags: filterTags = [] } = args as {
        instance_id: string; problem: string; max_depth?: number; tags?: string[];
      };
      const redis = await getConnection(instance_id);

      // Normalize problem to keyword tokens
      const tokens = problem.toLowerCase()
        .replace(/[^a-z0-9\s\-_:]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2);

      const SEV_ICON: Record<string, string> = { critical: '🔴', major: '🟠', minor: '🟡' };

      // ── Layer 1: CKG graph traversal (if graph data exists) ─────────────────
      type CKGResult = { conceptId: string; edge: CKGEdge; lesson?: { topic: string; what_worked?: string; ts: string; outcome: string; recall_count?: number; severity?: string } };
      const ckgResults: CKGResult[] = [];
      try {
        for (const token of tokens.slice(0, 4)) {
          // Search for CKG nodes matching this token
          const fromKeys = await redis.smembers(`cachly:ckg:idx:from:${ckgSlug(token)}`);
          const toKeys   = await redis.smembers(`cachly:ckg:idx:to:${ckgSlug(token)}`);
          // Also try pattern: scan nodes containing the token
          const nodeKeys: string[] = [];
          const nStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 50 });
          await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });
          for (const nodeKey of nodeKeys.slice(0, 10)) {
            const nodeRaw = await redis.get(nodeKey);
            if (!nodeRaw) continue;
            const node = safeJsonParse<CKGNode | null>(nodeRaw, null);
            if (!node) continue;
            // Get edges from this node
            const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${node.id}`);
            for (const ek of edgeKeys.slice(0, 20)) {
              const edgeRaw = await redis.get(ek);
              if (!edgeRaw) continue;
              const edge = safeJsonParse<CKGEdge | null>(edgeRaw, null);
              if (!edge) continue;
              if (edge.edgeType !== 'fixes' && edge.edgeType !== 'requires') continue;
              // Find lesson for this concept
              const lessonRaw = await redis.get(`cachly:lesson:best:${edge.from.replace(/-/g, ':').replace(/^fix:/, 'fix:')}`);
              const lesson = lessonRaw ? safeJsonParse<{ topic: string; what_worked?: string; ts: string; outcome: string; recall_count?: number; severity?: string } | null>(lessonRaw, null) ?? undefined : undefined;
              ckgResults.push({ conceptId: node.id, edge, lesson: lesson ?? undefined });
            }
          }
          for (const ek of [...fromKeys, ...toKeys].slice(0, 20)) {
            const edgeRaw = await redis.get(ek);
            if (!edgeRaw) continue;
            const edge = safeJsonParse<CKGEdge | null>(edgeRaw, null);
            if (!edge) continue;
            const lessonRaw = await redis.get(`cachly:lesson:best:${edge.from}`);
            const lesson = lessonRaw ? safeJsonParse<{ topic: string; what_worked?: string; ts: string; outcome: string; recall_count?: number; severity?: string } | null>(lessonRaw, null) ?? undefined : undefined;
            ckgResults.push({ conceptId: edge.from, edge, lesson: lesson ?? undefined });
          }
        }
      } catch { /* CKG traversal non-critical */ }

      // Deduplicate CKG results and sort by confidence
      const ckgSeen = new Set<string>();
      const ckgDeduped = ckgResults.filter(r => {
        const key = `${r.edge.from}:${r.edge.edgeType}:${r.edge.to}`;
        if (ckgSeen.has(key)) return false;
        ckgSeen.add(key);
        return true;
      }).sort((a, b) => b.edge.confidence - a.edge.confidence).slice(0, max_depth);

      // ── Layer 2 (fallback): text similarity over all lessons ─────────────────
      let cursor = 0;
      const lessonKeys: string[] = [];
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:*', 'COUNT', 200);
        cursor = parseInt(next);
        lessonKeys.push(...keys);
      } while (cursor !== 0);

      type Lesson = {
        topic: string; outcome: string; what_worked?: string; what_failed?: string;
        ts: string; recall_count?: number; severity?: string; tags?: string[];
        context?: string;
      };

      // Score each lesson by token overlap with problem description
      const scored: Array<{ score: number; lesson: Lesson; key: string }> = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        {
          const l = safeJsonParse<Lesson | null>(raw, null);
          if (!l) continue;
          if (filterTags.length > 0 && !(l.tags ?? []).some((t: string) => filterTags.includes(t))) continue;
          const haystack = [l.topic, l.what_failed ?? '', l.what_worked ?? '', l.context ?? '']
            .join(' ').toLowerCase();
          const score = tokens.reduce((s, t) => s + (haystack.includes(t) ? 1 : 0), 0);
          if (score > 0) scored.push({ score, lesson: l, key: k });
        }
      }
      scored.sort((a, b) => b.score - a.score);
      const chain = scored.slice(0, max_depth);

      if (chain.length === 0 && ckgDeduped.length === 0) {
        return [
          `🔍 **Causal Trace: "${problem}"**`,
          ``,
          `No matching lessons found in brain.`,
          ``,
          `💡 After you solve this, call:`,
          `\`\`\``,
          `learn_from_attempts(`,
          `  instance_id = "${instance_id}",`,
          `  topic       = "fix:${tokens[0] ?? 'issue'}",`,
          `  outcome     = "success",`,
          `  what_worked = "...",`,
          `  what_failed = "${problem}",`,
          `)`,
          `\`\`\``,
        ].join('\n');
      }

      const lines: string[] = [
        `🔍 **Causal Trace: "${problem}"**`,
        ``,
      ];

      // Show CKG graph results first if available
      if (ckgDeduped.length > 0) {
        lines.push(`### 🕸️ CKG Graph (confidence-ranked)`);
        for (const r of ckgDeduped) {
          const confPct = Math.round(r.edge.confidence * 100);
          const confBar = '▓'.repeat(Math.round(confPct / 10)) + '░'.repeat(10 - Math.round(confPct / 10));
          lines.push(`  ${r.edge.from} **→[${r.edge.edgeType}]→** ${r.edge.to}`);
          lines.push(`  ${confBar} ${confPct}% confidence (${r.edge.successes}/${r.edge.trials} confirmed)`);
          if (r.lesson?.what_worked) lines.push(`  ✅ Fix: ${r.lesson.what_worked.slice(0, 150)}`);
          lines.push('');
        }
      }

      // Build text-based causal chain narrative
      if (chain.length > 0) {
        lines.push(ckgDeduped.length > 0 ? `### 📚 Text Search (${chain.length} related lessons)` : `Found **${chain.length}** related lessons. Reconstructed causal chain:`, '');
        const failures = chain.filter(c => c.lesson.outcome !== 'success');
        const solutions = chain.filter(c => c.lesson.outcome === 'success');

        if (failures.length > 0) {
          lines.push(`**Root causes & failure chain:**`);
          failures.forEach((c, i) => {
            const l = c.lesson;
            const sev = SEV_ICON[l.severity ?? 'minor'] ?? '🟡';
            lines.push(`${i === 0 ? '  Root:' : '   → :'} ${sev} \`${l.topic}\``);
            if (l.what_failed) lines.push(`          ↳ ${l.what_failed.slice(0, 120)}`);
          });
          lines.push('');
        }

        if (solutions.length > 0) {
          lines.push(`**Solutions that worked before:**`);
          solutions.forEach((c, i) => {
            const l = c.lesson;
            const date = new Date(l.ts).toLocaleDateString('de-DE');
            lines.push(`  ${i + 1}. ✅ \`${l.topic}\` — ${date} · recalled ${l.recall_count ?? 0}×`);
            if (l.what_worked) lines.push(`     ${l.what_worked.slice(0, 200)}`);
          });
          lines.push('');
        }

        const topSolution = solutions[0]?.lesson;
        if (topSolution?.what_worked) {
          lines.push(`**⚡ Most likely fix:**`);
          lines.push(`\`\`\``);
          lines.push(topSolution.what_worked.slice(0, 500));
          lines.push(`\`\`\``);
          lines.push('');
        }
      }

      lines.push(`💡 After applying: \`learn_from_attempts(topic="fix:${tokens[0] ?? 'issue'}", outcome="success", ...)\``);
      if (ckgDeduped.length > 0) lines.push(`🕸️ Explore graph: \`ckg_inspect(concept="${tokens[0] ?? 'fix'}")\``);
      return lines.join('\n');
    }


    case 'knowledge_decay': {
      const { instance_id, min_age_days = 0, show_top = 20 } = args as {
        instance_id: string; min_age_days?: number; show_top?: number;
      };
      const redis = await getConnection(instance_id);
      const now = Date.now();
      const minAgeMs = min_age_days * 86400000;

      let cursor = 0;
      const lessonKeys: string[] = [];
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', 'cachly:lesson:best:*', 'COUNT', 200);
        cursor = parseInt(next);
        lessonKeys.push(...keys);
      } while (cursor !== 0);

      type Lesson = { topic: string; outcome: string; ts: string; recall_count?: number; severity?: string };
      type Scored = { topic: string; confidence: number; age_days: number; recalls: number; outcome: string };

      const scores: Scored[] = [];
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        {
          const l = safeJsonParse<Lesson | null>(raw, null);
          if (!l) continue;
          const ageMs = now - new Date(l.ts).getTime();
          if (ageMs < minAgeMs) continue;
          const age_days = Math.floor(ageMs / 86400000);
          const recalls = l.recall_count ?? 0;

          // Confidence formula:
          // base = 100 → decays by 1pt/day after 7 days, floored at 5
          // boost: +5 per recall, capped at +50
          // penalty: failure outcome → -20
          const decayPts = Math.max(0, age_days - 7);
          const base = Math.max(5, 100 - decayPts);
          const recallBoost = Math.min(50, recalls * 5);
          const outcomePenalty = l.outcome === 'failure' ? -20 : 0;
          const confidence = Math.min(100, Math.max(0, base + recallBoost + outcomePenalty));

          scores.push({ topic: l.topic, confidence, age_days, recalls, outcome: l.outcome });
        }
      }

      // Sort by lowest confidence first
      scores.sort((a, b) => a.confidence - b.confidence);
      const shown = scores.slice(0, show_top);

      function bar(pct: number): string {
        const filled = Math.round(pct / 10);
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${pct}%`;
      }

      const avgConf = scores.length > 0
        ? Math.round(scores.reduce((s, e) => s + e.confidence, 0) / scores.length)
        : 0;
      const critical = scores.filter(s => s.confidence < 30).length;
      const healthy = scores.filter(s => s.confidence >= 70).length;

      const lines: string[] = [
        `🧪 **Knowledge Decay Report** — ${scores.length} lessons`,
        ``,
        `Average confidence: **${bar(avgConf)}**`,
        `🔴 Critical (<30%): ${critical}  🟢 Healthy (≥70%): ${healthy}`,
        ``,
        `Lowest confidence lessons (fix these first):`,
        ``,
        ...shown.map((s, i) =>
          `${(i + 1).toString().padStart(2)}. \`${s.topic}\`\n    ${bar(s.confidence)} · ${s.age_days}d old · ${s.recalls} recalls · ${s.outcome}`
        ),
        ``,
        scores.length > show_top ? `… and ${scores.length - show_top} more lessons` : '',
        ``,
        critical > 0
          ? `⚠️ ${critical} lessons are critically stale. Validate them and re-run \`learn_from_attempts\` with updated findings.`
          : `✅ Brain confidence is healthy overall.`,
        ``,
        `💡 Run \`memory_consolidate\` to prune stale entries · \`causal_trace\` to find root causes.`,
      ].filter(s => s !== '');
      return lines.join('\n');
    }

    // ── v0.6 Cognitive Cache: autopilot ──────────────────────────────────────
    case 'autopilot': {
      const { instance_id, editor = 'claude', project_name = 'this project', style = 'full' } = args as {
        instance_id: string; editor?: string; project_name?: string; style?: 'minimal' | 'full';
      };

      const minimal = `## Cachly AI Brain — Autopilot

**Instance:** \`${instance_id}\`

> Sessions are fully automatic. The Brain starts when you call any tool and saves a summary when you close.

### MANDATORY hooks (always fire, no exceptions):
- **Window opens** → call \`session_start(instance_id="${instance_id}", focus="<today's goal>")\`
- **Bug fixed / deployed / discovered** → call \`learn_from_attempts(instance_id="${instance_id}", topic="fix:<area>", outcome="success", what_worked="...")\`
- **Window closes** → call \`session_end(instance_id="${instance_id}", summary="...", files_changed=[...])\`
`;

      const full = `## Cachly AI Brain — Autopilot for ${project_name}

**Instance:** \`${instance_id}\`

---

## 🔴 MANDATORY RULES — No exceptions, no prompting needed

### Rule 1 — Session Start (FIRST thing in every window)
\`\`\`
session_start(
  instance_id = "${instance_id}",
  focus       = "<what you plan to work on today>",
)
\`\`\`
Returns: last session summary, handoff tasks, recent lessons, open failures.

### Rule 2 — Learn After Every Fix/Deploy/Discovery (AUTOMATIC)
**After EVERY** bug fix, deployment, or technical discovery — call immediately:
\`\`\`
learn_from_attempts(
  instance_id = "${instance_id}",
  topic       = "category:keyword",
  outcome     = "success" | "failure" | "partial",
  what_worked = "exact command or approach",
  what_failed = "what failed (if applicable)",
  severity    = "critical" | "major" | "minor",
  commands    = ["the exact command that worked"],
  file_paths  = ["path/to/file"],
  tags        = ["relevant", "tags"],
)
\`\`\`

**Triggers:**
- ✅ Deployed → \`topic="deploy:web", outcome="success"\`
- ✅ Fixed bug → \`topic="fix:auth-race", outcome="success"\`
- ✅ Got error → \`topic="debug:docker", outcome="partial"\`

### Rule 3 — Session End (LAST thing before closing)
\`\`\`
session_end(
  instance_id     = "${instance_id}",
  summary         = "What was accomplished (2-3 sentences)",
  files_changed   = ["list", "of", "changed", "files"],
  lessons_learned = <number of learn_from_attempts calls>,
)
\`\`\`

### Rule 4 — Before any non-trivial task
\`\`\`
smart_recall(
  instance_id = "${instance_id}",
  query       = "<describe what you are about to do>",
)
\`\`\`

---

## ⚡ Cognitive Tools (v0.6)

| When | Call |
|---|---|
| Brain feeling cluttered | \`memory_consolidate(instance_id="${instance_id}")\` |
| Weekly review | \`brain_diff(instance_id="${instance_id}", since="7d")\` |
| Weird bug, no idea why | \`causal_trace(instance_id="${instance_id}", problem="<symptom>")\` |
| Before big refactor | \`knowledge_decay(instance_id="${instance_id}")\` |

---

*Cachly v0.6 · Generated ${new Date().toISOString().slice(0, 10)}*
`;

      const content = style === 'minimal' ? minimal : full;
      const filename = editor === 'copilot'
        ? '.github/copilot-instructions.md'
        : editor === 'continue'
          ? '.continue/cachly-autopilot.md'
          : 'CLAUDE.md';

      return [
        `🤖 **Autopilot instructions generated** for **${editor === 'all' ? 'all editors' : editor}**`,
        ``,
        `**File to create:** \`${filename}\``,
        ``,
        `\`\`\`markdown`,
        content,
        `\`\`\``,
        ``,
        `**How to apply:**`,
        `\`\`\`bash`,
        `# Copy to your project root:`,
        `cat > ${filename} << 'EOF'`,
        content,
        `EOF`,
        `\`\`\``,
        ``,
        `✨ Once this file is in place, **${editor === 'copilot' ? 'GitHub Copilot' : editor === 'continue' ? 'Continue.dev' : 'Claude/Cursor/Windsurf'}** will manage the Brain automatically — no manual calls needed, ever.`,
      ].join('\n');
    }

    // ── v0.7 Knowledge Syndication: syndicate ────────────────────────────────

    default:
      return null;
  }
}
