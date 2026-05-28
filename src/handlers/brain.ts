import { execSync } from 'node:child_process';
import type { Redis } from 'ioredis';
import { calculateConfidence, confidenceBadge, STRUCTURED_TEMPLATES,
         CONFIDENCE_WARN_VALUE, CONFIDENCE_STALE_VALUE, CONFIDENCE_WARN_DAYS } from '../confidence.js';
import { ckgSlug, extractProblemConcept, ckgUpsertNode, ckgUpdateEdge } from '../ckg.js';
import { safeJsonParse } from '../utils.js';
import type { CKGEdge, CKGNode } from '../ckg.js';
import { keywordSearch, tokenize, splitMultiQuery, levenshtein,
         ZERO_RESULTS_LOG, zeroResultsTotal, indexVocab as _indexVocab } from '../search.js';
import type { KeywordMatch } from '../search.js';
import { computeEmbedding, hasEmbedProvider, embedProviderHint, EMBED_PROVIDER } from '../embeddings.js';
import { detectNamespace } from '../namespace.js';

// ── Changelog (shown once per version in session_start) ──────────────────────
const MCP_VERSION = '0.10.46';
const WHATS_NEW: Record<string, string[]> = {
  '0.10.46': [
    `🆕 **What's new in v${MCP_VERSION}:**`,
    `  ✅ \`brain_from_git\` — auto-seed your Brain from git history in seconds`,
    `  ✅ \`brain_predict_failures\` — predict CI/build failures before they happen`,
    `  ✅ \`smart_recall\` — semantic + keyword hybrid recall, now in every CLAUDE.md`,
    `  ✅ VS Code extension — Brain status bar, ambient learning, CodeLens hints`,
    `  ✅ Team Brain — share lessons across your whole engineering team`,
    `  ✅ 89 MCP tools — roadmap, A/B tests, cache, index, predict, syndicate`,
    `  💡 Run \`brain_from_git\` to seed your Brain from existing commits instantly`,
  ],
};

// Shared types used in brain handlers
export interface Instance {
  id: string; name: string; tier: string; status: string; region: string;
  host?: string; port?: number; password?: string; tls_enabled?: boolean;
  vector_token?: string; memory_mb: number; encryption_at_rest: boolean;
  created_at: string;
}

interface SemanticSearchResponse {
  found: boolean;
  id?: string;
  similarity?: number;
  prompt?: string;
}

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const BRAIN_TOOL_NAMES = new Set([
  'learn_from_attempts', 'recall_best_solution', 'smart_recall',
  'session_start', 'session_end', 'session_ping', 'session_handoff', 'auto_learn_session',
]);

export async function handleBrainTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
    case 'learn_from_attempts': {
      const {
        instance_id,
        topic,
        outcome,
        what_worked,
        what_failed = '',
        context: ctx = '',
        severity = 'major',
        file_paths = [],
        commands = [],
        tags = [],
        depends_on = [],
        author = '',
      } = args as {
        instance_id: string;
        topic: string;
        outcome: 'success' | 'failure' | 'partial';
        what_worked: string;
        what_failed?: string;
        context?: string;
        severity?: 'critical' | 'major' | 'minor';
        file_paths?: string[];
        commands?: string[];
        tags?: string[];
        depends_on?: string[];
        author?: string;
      };

      const redis = await getConnection(instance_id);
      const ts = new Date().toISOString();

      // ── Structured template hints ──────────────────────────────────────────
      const category = topic.split(':')[0];
      const template = STRUCTURED_TEMPLATES[category];
      const templateWarnings: string[] = [];
      if (template) {
        for (const req of template.required) {
          if (req === 'commands' && commands.length === 0) {
            templateWarnings.push(`📋 ${template.hint}`);
          }
        }
      }

      // ── Deduplication + audit trail ────────────────────────────────────────
      let isUpdate = false;
      let recallCount = 0;
      let auditTrail: Array<{ ts: string; action: string; prev_outcome?: string }> = [];
      const existingRaw = await redis.get(`cachly:lesson:best:${topic}`);
      if (existingRaw) {
        try {
          const prev = JSON.parse(existingRaw) as {
            recall_count?: number;
            outcome?: string;
            audit_trail?: Array<{ ts: string; action: string; prev_outcome?: string }>;
          };
          recallCount = prev.recall_count ?? 0;
          auditTrail = prev.audit_trail ?? [];
          auditTrail.push({ ts, action: 'updated', prev_outcome: prev.outcome });
          if (auditTrail.length > 20) auditTrail = auditTrail.slice(-20);
          isUpdate = true;

          // ── Contradiction detection ─────────────────────────────────────────
          const contradictionWarning: string[] = [];
          if (prev.outcome === 'success' && outcome === 'failure') {
            contradictionWarning.push(
              `⚠️ **Contradiction detected!** Existing lesson has outcome: \`success\`, but you're storing \`failure\`.`,
              `The existing "success" lesson will be preserved. Only the audit trail is updated.`,
              `If you meant to mark this as failed permanently, store a new lesson with a distinct topic slug.`,
            );
          } else if (prev.outcome === 'failure' && outcome === 'success') {
            contradictionWarning.push(
              `✅ **Conflict resolved!** Previous lesson was \`failure\` — now overwriting with \`success\`.`,
            );
          }
          if (contradictionWarning.length > 0) {
            // Store contradiction audit but don't block
            auditTrail[auditTrail.length - 1].action = 'contradiction-resolved';
            // Layer 3: Write CKG contradicts edge for MADC to process
            try {
              const cId = ckgSlug(topic);
              const resId = ckgSlug(`resolution:${topic}`);
              await ckgUpdateEdge(redis, cId, 'contradicts', resId, false);
            } catch { /* non-critical */ }
            contradictionWarning.push(`🗳️ Run \`madc_deliberate(topic="${topic}")\` to resolve via expert agent voting.`);
          }
        } catch { /* ignore parse error */ }
      } else {
        auditTrail = [{ ts, action: 'created' }];
      }

      // ── "I Was Wrong" Protocol — failure attribution ───────────────────────
      const iWasWrongWarning: string[] = [];
      if (outcome === 'failure') {
        // Search for related success lessons that might have prevented this failure
        const scanKeys: string[] = [];
        const scanStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 100 });
        await new Promise<void>((res, rej) => {
          scanStream.on('data', (b: string[]) => scanKeys.push(...b));
          scanStream.on('end', res);
          scanStream.on('error', rej);
        });
        const topicWords = topic.split(/[:\-_]/).filter(w => w.length > 2);
        for (const k of scanKeys.slice(0, 50)) {
          const raw = await redis.get(k);
          if (!raw) continue;
          try {
            const l = JSON.parse(raw) as { outcome?: string; topic?: string; severity?: string };
            if (l.outcome !== 'success') continue;
            const lWords = (l.topic ?? '').split(/[:\-_]/).filter(w => w.length > 2);
            const overlap = topicWords.filter(w => lWords.includes(w)).length;
            if (overlap >= 1 && l.topic !== topic) {
              iWasWrongWarning.push(
                `⚠️ **"I Was Wrong"**: lesson \`${l.topic}\` (success, ${l.severity ?? 'major'}) might have prevented this failure.`,
                `   → Use \`recall_best_solution(topic="${l.topic}")\` before next attempt.`,
                `   → To mark it critical: \`learn_from_attempts(topic="${l.topic}", ..., severity="critical")\``,
              );
              break; // only show the most relevant match
            }
          } catch { /* skip */ }
        }
      }

      // ── Register dependency index for causal chain ─────────────────────────
      for (const dep of depends_on) {
        const depKey = `cachly:dep:${dep}`;
        const existing = await redis.get(depKey);
        const depTopics: string[] = safeJsonParse<string[]>(existing, []);
        if (!depTopics.includes(topic)) depTopics.push(topic);
        await redis.set(depKey, JSON.stringify(depTopics), 'EX', 90 * 86400);
      }

      const lessonObj = {
        topic,
        outcome,
        what_worked,
        what_failed,
        context: ctx,
        severity,
        file_paths,
        commands,
        tags,
        depends_on,
        ...(author ? { author } : {}),
        recall_count: recallCount,
        ts,
        verified_at: outcome === 'success' || outcome === 'partial' ? ts : undefined,
        confidence: 1.0,
        audit_trail: auditTrail,
        version: 3,
      };
      const lesson = JSON.stringify(lessonObj);

      // Always append to the history list (audit log); keep last 100 entries, 90-day TTL
      const listKey = `cachly:lessons:${topic}`;
      await redis.rpush(listKey, lesson);
      await redis.ltrim(listKey, -100, -1);
      await redis.expire(listKey, 90 * 86400);

      // Update best key for success/partial; for failure only update if no success exists
      if (outcome === 'success' || outcome === 'partial') {
        await redis.set(`cachly:lesson:best:${topic}`, lesson);
      } else if (!existingRaw) {
        await redis.set(`cachly:lesson:best:${topic}`, lesson);
      }

      // Track in decision log for session replay
      try {
        const dlKey = 'cachly:session:decision-log';
        const dlEntry = JSON.stringify({ ts, topic, outcome, what_worked: what_worked.slice(0, 120) });
        await redis.rpush(dlKey, dlEntry);
        await redis.ltrim(dlKey, -50, -1);
      } catch { /* non-critical */ }

      // ── Layer 1+2: CKG update (Causal Knowledge Graph + Belief Update Engine) ──
      // BUE: Bayesian confidence, contradiction detection, second-degree propagation, decay
      let beliefConflict: string | null = null;
      try {
        const conceptId = ckgSlug(topic);
        const domain = topic.split(':')[0] ?? 'unknown';
        const conceptType = domain; // fix, debug, deploy, infra, api, etc.

        // Upsert concept node
        await ckgUpsertNode(redis, conceptId, domain, conceptType);

        // Tag co-occurrence edges
        for (const tag of tags) {
          const tagId = ckgSlug(`tag:${tag}`);
          await ckgUpsertNode(redis, tagId, 'tag', 'tag');
          await ckgUpdateEdge(redis, conceptId, 'co-occurs', tagId, outcome === 'success', outcome === 'partial');
        }

        // depends_on → requires edges (structural, always confidence 1.0 direction)
        for (const dep of depends_on) {
          const depId = ckgSlug(dep);
          await ckgUpdateEdge(redis, conceptId, 'requires', depId, true);
        }

        // fixes edge: if category=fix and outcome=success, link to problem concept
        if ((domain === 'fix' || domain === 'debug') && (outcome === 'success' || outcome === 'partial')) {
          const problemText = what_failed || ctx || '';
          const problemConcept = problemText ? extractProblemConcept(problemText) : null;
          if (problemConcept) {
            const problemId = ckgSlug(`problem:${problemConcept}`);
            await ckgUpsertNode(redis, problemId, 'problem', 'problem');
            await ckgUpdateEdge(redis, conceptId, 'fixes', problemId, outcome === 'success', outcome === 'partial');
          }
        }

        // causes edge: if outcome=failure, link topic concept to the problem context
        if (outcome === 'failure' && (what_failed || what_worked)) {
          const causeText = what_failed || what_worked;
          const causeConcept = extractProblemConcept(causeText);
          if (causeConcept) {
            const causeId = ckgSlug(`cause:${causeConcept}`);
            await ckgUpsertNode(redis, causeId, 'cause', 'cause');
            await ckgUpdateEdge(redis, conceptId, 'causes', causeId, false);
          }
        }

        // ── BUE: Contradiction detection ──────────────────────────────────────
        // If this topic previously had a confirmed 'fixes' edge (confidence > 0.7)
        // and now outcome=failure → flag belief_conflict
        if (outcome === 'failure') {
          const existingEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${conceptId}`);
          for (const ek of existingEdgeKeys) {
            const er = await redis.get(ek);
            if (!er) continue;
            const existEdge = safeJsonParse<CKGEdge | null>(er, null);
            if (!existEdge) continue;
            if (existEdge.edgeType === 'fixes' && existEdge.confidence > 0.7 && existEdge.trials >= 3) {
              beliefConflict = `⚠️ **belief_conflict** on \`${topic}\`: previously confirmed fix (confidence ${existEdge.confidence.toFixed(2)}, n=${existEdge.trials}) now reports failure. Both beliefs retained as \`contested\`. Use \`ckg_inspect(concept="${conceptId}")\` to review.`;
              // Store conflict marker
              const conflictKey = `cachly:ckg:conflict:${conceptId}`;
              await redis.set(conflictKey, JSON.stringify({ topic, detected_at: new Date().toISOString(), fix_confidence: existEdge.confidence, fix_trials: existEdge.trials, failure_outcome: outcome }), 'EX', 60 * 60 * 24 * 90);
              // Auto-trigger MADC deliberation in background — never blocks learn_from_attempts
              // Note: fire-and-forget; madc_deliberate is handled elsewhere in the switch
              // (conflict marker stored above — no warm-up call needed)
            }
          }
        }

        // ── BUE: Second-degree propagation ────────────────────────────────────
        // When a 'fixes' edge gets stronger, boost co-occurring second-degree edges slightly
        if (outcome === 'success' && (domain === 'fix' || domain === 'debug')) {
          const fromEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${conceptId}`);
          for (const ek of fromEdgeKeys.slice(0, 10)) {
            const er = await redis.get(ek);
            if (!er) continue;
            const e2 = safeJsonParse<CKGEdge | null>(er, null);
            if (!e2) continue;
            if (e2.edgeType !== 'fixes') continue;
            // Boost second-degree: edges from e2.to get a small fractional success
            const secondKeys = await redis.smembers(`cachly:ckg:idx:from:${e2.to}`);
            for (const sk of secondKeys.slice(0, 5)) {
              const sr = await redis.get(sk);
              if (!sr) continue;
              const se = safeJsonParse<CKGEdge | null>(sr, null);
              if (!se) continue;
              if (se.edgeType !== 'co-occurs') continue;
              // Add 0.1 fractional success (second-degree signal)
              se.successes = (se.successes || 0) + 0.1;
              se.trials = (se.trials || 0) + 0.1;
              se.confidence = (se.successes + 1) / (se.trials + 2);
              se.last_updated = new Date().toISOString();
              await redis.set(sk, JSON.stringify(se));
            }
          }
        }

        // ── BUE: Stale edge decay ─────────────────────────────────────────────
        // Edges older than 90 days with < 3 trials decay by 10% confidence.
        // Only run probabilistically (1% of calls) to avoid per-call overhead.
        if (Math.random() < 0.01) {
          const decayCutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
          const fromEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${conceptId}`);
          for (const ek of fromEdgeKeys) {
            const er = await redis.get(ek);
            if (!er) continue;
            const de = safeJsonParse<CKGEdge | null>(er, null);
            if (!de) continue;
            if (de.trials < 3 && de.last_updated && new Date(de.last_updated).getTime() < decayCutoff) {
              de.confidence = de.confidence * 0.9;
              de.last_updated = new Date().toISOString();
              await redis.set(ek, JSON.stringify(de));
            }
          }
        }
      } catch { /* CKG updates are non-critical */ }

      const emoji = outcome === 'success' ? '✅' : outcome === 'partial' ? '⚠️' : '❌';
      const sevEmoji = severity === 'critical' ? '🔴' : severity === 'major' ? '🟡' : '🟢';
      const action = isUpdate ? 'updated' : 'stored';
      return [
        `${emoji} **Lesson ${action}:** \`${topic}\` (${outcome}) ${sevEmoji} ${severity}`,
        beliefConflict ?? '',
        ``,
        `**What worked:** ${what_worked}`,
        what_failed ? `**What failed:** ${what_failed}` : '',
        ctx ? `**Context:** ${ctx}` : '',
        file_paths.length > 0 ? `**Files:** ${file_paths.map(f => `\`${f}\``).join(', ')}` : '',
        commands.length > 0 ? `**Commands:** ${commands.map(c => `\`${c}\``).join(', ')}` : '',
        tags.length > 0 ? `**Tags:** ${tags.map(t => `#${t}`).join(' ')}` : '',
        ``,
        isUpdate
          ? `♻️ Updated (recall count: ${recallCount} · audit entries: ${auditTrail.length})`
          : `💡 Recall later with \`recall_best_solution(topic="${topic}")\``,
        depends_on.length > 0
          ? `🔗 Depends on: ${depends_on.map(d => `\`${d}\``).join(', ')} → trace with \`trace_dependency\``
          : '',
        ...templateWarnings,
        ...iWasWrongWarning,
      ].filter(l => l !== '').join('\n');
    }

    case 'recall_best_solution': {
      const { instance_id, topic } = args as { instance_id: string; topic: string };
      const redis = await getConnection(instance_id);

      // Try exact best-solution key first
      const best = await redis.get(`cachly:lesson:best:${topic}`);
      if (best) {
        const lesson = safeJsonParse(best, null as null | {
          topic: string; outcome: string; what_worked: string; what_failed?: string;
          context?: string; ts: string; verified_at?: string; severity?: string;
          file_paths?: string[]; commands?: string[]; tags?: string[];
          recall_count?: number; audit_trail?: unknown[];
        });
        if (!lesson) return `⚠️ Lesson data for \`${topic}\` is corrupted. Re-store it with \`learn_from_attempts\`.`;

        // ── Confidence decay check ───────────────────────────────────────────
        const confidence = calculateConfidence(lesson);
        const ref = lesson.verified_at ?? lesson.ts;
        const ageDays = (Date.now() - new Date(ref).getTime()) / 86400000;
        const badge = confidenceBadge(confidence, ageDays);

        // Recall resets verified_at (confidence clock restart)
        const updatedLesson = {
          ...lesson,
          recall_count: (lesson.recall_count ?? 0) + 1,
          verified_at: new Date().toISOString(),
          confidence: 1.0,
        };
        await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(updatedLesson));

        // Track estimated time saved (30m minor · 60m major · 240m critical)
        const savedMins = lesson.severity === 'critical' ? 240 : lesson.severity === 'major' ? 60 : 30;
        redis.incrbyfloat(`cachly:stats:time_saved_mins:${instance_id}`, savedMins).catch(() => {});

        const sevEmoji = lesson.severity === 'critical' ? '🔴' : lesson.severity === 'major' ? '🟡' : lesson.severity ? '🟢' : '';
        const auditSummary = (lesson.audit_trail ?? []).length > 1
          ? `_Audit: ${(lesson.audit_trail ?? []).length} changes · stored ${new Date(lesson.ts).toLocaleDateString('de-DE')}_`
          : '';

        // "Remember when..." — emotional header for lessons > 60 days old
        const ageFromStoreDays = (Date.now() - new Date(lesson.ts).getTime()) / 86400000;
        const rememberWhen = ageFromStoreDays > 60
          ? `💭 _Remember when you solved this ${Math.round(ageFromStoreDays / 30)} months ago? Still works._`
          : '';

        // "Never Google This Again" — suggest pinning after 3rd recall
        const suggestPin = updatedLesson.recall_count === 3 && !(lesson as { pinned?: boolean }).pinned
          ? `📌 **You've looked this up 3 times.** Consider pinning it for instant access: add \`pinned: true\` via \`learn_from_attempts\` to always surface it first.`
          : '';

        // ── Trust signal (today-safe consensus layer) ───────────────────────
        // A lesson recalled many times — or confirmed by multiple distinct
        // authors — has proven its value. Surface that as social proof.
        const lessonAuthors = (lesson as { authors?: string[]; author?: string }).authors
          ?? ((lesson as { author?: string }).author ? [(lesson as { author?: string }).author!] : []);
        const distinctAuthors = [...new Set(lessonAuthors.filter(Boolean))];
        const rc = updatedLesson.recall_count;
        let trustBadge = '';
        if (distinctAuthors.length >= 2 && rc >= 5) {
          trustBadge = `🏆 **Battle-tested** — recalled ${rc}× · verified by ${distinctAuthors.length} developers. Trust this.`;
        } else if (rc >= 10) {
          trustBadge = `🏆 **Battle-tested** — recalled ${rc}×. This is one of your most-proven solutions.`;
        } else if (distinctAuthors.length >= 2) {
          trustBadge = `✅ **Team-verified** — confirmed by ${distinctAuthors.length} developers.`;
        } else if (rc >= 5) {
          trustBadge = `✅ **Proven** — recalled ${rc}× without contradiction.`;
        }

        return [
          rememberWhen,
          trustBadge,
          `${badge} **Best solution for \`${topic}\`** ${sevEmoji}${lesson.severity ? ` (${lesson.severity})` : ''} · recalled ${updatedLesson.recall_count}×`,
          ``,
          `**What worked:** ${lesson.what_worked}`,
          lesson.what_failed ? `**What failed (avoid this):** ${lesson.what_failed}` : '',
          lesson.context ? `**Context:** ${lesson.context}` : '',
          (lesson.file_paths ?? []).length > 0 ? `**Files:** ${(lesson.file_paths ?? []).map((f: string) => `\`${f}\``).join(', ')}` : '',
          (lesson.commands ?? []).length > 0 ? `**Commands:** ${(lesson.commands ?? []).map((c: string) => `\`${c}\``).join(', ')}` : '',
          (lesson.tags ?? []).length > 0 ? `**Tags:** ${(lesson.tags ?? []).map((t: string) => `#${t}`).join(' ')}` : '',
          auditSummary,
          suggestPin,
        ].filter(l => l !== '').join('\n');
      }

      // Partial match: scan all lesson keys for topic substring
      const allKeys: string[] = [];
      const scanStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 100 });
      await new Promise<void>((resolve, reject) => {
        scanStream.on('data', (batch: string[]) => allKeys.push(...batch));
        scanStream.on('end', resolve);
        scanStream.on('error', reject);
      });

      const matching = allKeys.filter(k => k.toLowerCase().includes(topic.toLowerCase()));
      if (matching.length === 0) {
        // Check attempt history as fallback
        const histKey = `cachly:lessons:${topic}`;
        const all = await redis.lrange(histKey, -3, -1);
        if (all.length > 0) {
          const parsed = all.map(e => safeJsonParse(e, null as null | { outcome: string; what_worked: string; ts: string })).filter(Boolean) as Array<{ outcome: string; what_worked: string; ts: string }>;
          const lines = parsed.map(p => `- ${p.outcome === 'success' ? '✅' : '❌'} ${p.what_worked.slice(0, 120)} (${new Date(p.ts).toLocaleDateString('de-DE')})`);
          return `⚠️ No successful solution for \`${topic}\` yet. Last attempts:\n\n${lines.join('\n')}`;
        }
        return `📭 No lessons found for \`${topic}\`. Use \`learn_from_attempts\` after solving it.`;
      }

      // Return all partial matches
      const results: string[] = [];
      for (const k of matching.slice(0, 5)) {
        const raw = await redis.get(k);
        if (!raw) continue;
        const lesson = safeJsonParse(raw, null as null | { topic: string; what_worked: string; context?: string; ts: string });
        if (!lesson) continue;
        results.push(`**\`${lesson.topic}\`** — ${lesson.what_worked.slice(0, 200)}`);
      }
      return `🔍 **Partial matches for \`${topic}\`:**\n\n${results.join('\n\n')}`;
    }

    case 'smart_recall': {
      const {
        instance_id,
        query,
        threshold = 0.78,
      } = args as { instance_id: string; query: string; threshold?: number };

      const redis = await getConnection(instance_id);

      // ── Layer 1: Keyword search across ALL brain data (always works, no embedding) ──
      const kwMatches = await keywordSearch(
        redis,
        ['cachly:ctx:*', 'cachly:lesson:best:*', 'cachly:idx:*'],
        query,
        10,
      );

      // Increment recall_count on matched lessons (fire-and-forget — same as recall_best_solution).
      // This ensures the dashboard metric, Proven Laws, and trust badges reflect real smart_recall usage.
      const lessonMatches = kwMatches.filter(m => m.key.startsWith('cachly:lesson:best:'));
      for (const m of lessonMatches.slice(0, 5)) {
        const existing = await redis.get(m.key).catch(() => null);
        if (existing) {
          const lesson = safeJsonParse(existing, null as null | { recall_count?: number; [k: string]: unknown });
          if (lesson) {
            const updated = { ...lesson, recall_count: (lesson.recall_count ?? 0) + 1, verified_at: new Date().toISOString() };
            redis.set(m.key, JSON.stringify(updated)).catch(() => {});
            const savedMins = (lesson.severity as string) === 'critical' ? 240 : (lesson.severity as string) === 'major' ? 60 : 30;
            redis.incrbyfloat(`cachly:stats:time_saved_mins:${instance_id}`, savedMins).catch(() => {});
          }
        }
      }

      const lines: string[] = [`🧠 **Smart Recall** for: _"${query}"_\n`];

      // Show sub-query info if multi-topic was detected
      const subQueries = splitMultiQuery(query);
      if (subQueries.length > 1) {
        lines.push(`_Detected ${subQueries.length} sub-topics:_ ${subQueries.map((s, i) => `${i + 1}. "${s}"`).join(', ')}\n`);
      }

      if (kwMatches.length > 0) {
        lines.push(`### 🔍 BM25 Matches (${kwMatches.length})\n`);

        // Group by sub-query if multi-topic
        if (subQueries.length > 1) {
          const grouped = new Map<string, KeywordMatch[]>();
          for (const m of kwMatches.slice(0, 12)) {
            const sq = m.subQuery ?? query;
            if (!grouped.has(sq)) grouped.set(sq, []);
            grouped.get(sq)!.push(m);
          }
          for (const [sq, matches] of grouped) {
            lines.push(`**Topic: "${sq}"** (${matches.length} results)\n`);
            for (const m of matches.slice(0, 4)) {
              const label = m.key
                .replace('cachly:ctx:', '📝 ')
                .replace('cachly:lesson:best:', '💡 ')
                .replace('cachly:idx:', '📂 ');
              const preview = m.content.slice(0, 300).replace(/\n/g, ' ');
              lines.push(`  **${label}** _(BM25: ${m.score.toFixed(2)}, matched: ${m.matchedWords.join(', ')})_`);
              lines.push(`  > ${preview}${m.content.length > 300 ? '…' : ''}\n`);
            }
          }
          // Summary: which sub-queries had matches
          const matched = [...grouped.keys()];
          const unmatched = subQueries.filter(sq => !matched.includes(sq));
          if (unmatched.length > 0) {
            lines.push(`\n⚠️ **No results for:** ${unmatched.map(s => `"${s}"`).join(', ')}`);
          }
        } else {
          for (const m of kwMatches.slice(0, 8)) {
            const label = m.key
              .replace('cachly:ctx:', '📝 ')
              .replace('cachly:lesson:best:', '💡 ')
              .replace('cachly:idx:', '📂 ');
            const preview = m.content.slice(0, 400).replace(/\n/g, ' ');
            lines.push(`**${label}** _(BM25: ${m.score.toFixed(2)}, matched: ${m.matchedWords.join(', ')})_`);
            lines.push(`> ${preview}${m.content.length > 400 ? '…' : ''}\n`);
          }
        }
      }

      // ── Layer 2: Semantic search (optional, only if embedding provider + vector_token available) ──
      const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);
      if (inst.vector_token && hasEmbedProvider()) {
        try {
          const embedding = await computeEmbedding(query);
          const vectorUrl = `https://api.cachly.dev/v1/sem/${inst.vector_token}`;
          const searchRes = await fetch(`${vectorUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embedding, namespace: 'cachly:ctx', threshold, top_k: 5 }),
          });

          if (searchRes.ok) {
            const results = (await searchRes.json()) as SemanticSearchResponse[];
            const semHits = results.filter(r => r.found && r.id);
            if (semHits.length > 0) {
              lines.push(`\n### 🎯 Semantic Matches (${semHits.length})\n`);
              for (const hit of semHits) {
                const parts = hit.id!.replace('ctx:', '').split(':');
                const category = parts[0];
                const key = parts.slice(1).join(':');
                const content = await redis.get(`cachly:ctx:${category}:${key}`);
                lines.push(
                  `**${key}** _(${((hit.similarity ?? 0) * 100).toFixed(0)}% similar)_`,
                  `> ${content?.slice(0, 300) ?? '(evicted)'}${(content?.length ?? 0) > 300 ? '…' : ''}\n`,
                );
              }
            }
          }
        } catch {
          // Semantic search failed silently — keyword results are enough
        }
      }

      if (kwMatches.length === 0) {
        lines.push(`⚠️ No matches found for: "${query}"`);

        // Did-You-Mean: find nearest token in index vocab
        const queryTokens = tokenize(query);
        const suggestions: string[] = [];
        if (_indexVocab.size > 0 && queryTokens.length > 0) {
          for (const qt of queryTokens.slice(0, 3)) {
            if (qt.length < 4) continue;
            let bestDist = 3;
            let bestTok = '';
            for (const v of _indexVocab) {
              if (v.length < 3 || Math.abs(v.length - qt.length) > 4) continue;
              const d = levenshtein(qt, v);
              if (d > 0 && d < bestDist) { bestDist = d; bestTok = v; }
            }
            if (bestTok) suggestions.push(`"${bestTok}" (instead of "${qt}")`);
          }
        }
        if (suggestions.length > 0) {
          lines.push(`💡 **Did you mean:** ${suggestions.join(', ')}?`);
        } else {
          lines.push(`\n💡 Tips:`);
          lines.push(`  • Try different keywords`);
          lines.push(`  • Use \`list_remembered\` to see available context`);
          lines.push(`  • Use \`recall_best_solution("topic")\` for exact topic lookup`);
        }
      }

      return lines.join('\n');
    }

    // ── get_api_status ────────────────────────────────────────────────────────

    case 'session_start': {
      const { instance_id, focus = '', author = '', provider = '', workspace_path = '' } = args as { instance_id: string; focus?: string; author?: string; provider?: string; workspace_path?: string };
      const redis = await getConnection(instance_id);

      // 1. Scan all best-solution lessons
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      // 2. Fetch all lesson values for recency sorting + focus matching
      type Lesson = {
        topic: string; outcome: string; what_worked: string; what_failed?: string;
        ts: string; verified_at?: string; severity?: string; recall_count?: number;
        tags?: string[]; confidence?: number; audit_trail?: unknown[];
      };
      const lessons: Lesson[] = [];
      if (lessonKeys.length > 0) {
        const raws = await redis.mget(...lessonKeys);
        for (const raw of raws) {
          const l = safeJsonParse<Lesson | null>(raw ?? null, null);
          if (l) lessons.push(l);
        }
      }
      lessons.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

      // 3. Count context entries (filter :meta keys)
      let ctxCount = 0;
      const ctxStream = redis.scanStream({ match: 'cachly:ctx:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        ctxStream.on('data', (batch: string[]) => {
          ctxCount += batch.filter((k: string) => !k.endsWith(':meta')).length;
        });
        ctxStream.on('end', resolve);
        ctxStream.on('error', reject);
      });

      // 4. Last session
      const lastSessionRaw = await redis.get('cachly:session:last');
      type LastSession = { summary: string; ts: string; files_changed?: string[]; duration_min?: number };
      const lastSession = safeJsonParse<LastSession | null>(lastSessionRaw, null);

      // 5. Focus filtering
      const focusTerms = focus.toLowerCase().split(/\s+/).filter(Boolean);
      const focusLessons = focusTerms.length > 0
        ? lessons.filter(l =>
            focusTerms.some(term =>
              l.topic.toLowerCase().includes(term) ||
              (l.tags ?? []).some((t: string) => t.toLowerCase().includes(term))
            )
          )
        : [];

      // 6. Streak tracking
      let streakDays = 0;
      let streakRecord = 0;
      let streakMessage = '';
      try {
        const streakRaw = await redis.get('cachly:streak:current');
        const streak = safeJsonParse<{ days: number; last_date: string; record: number } | null>(streakRaw, null);
        const today = new Date().toISOString().slice(0, 10);
        if (streak) {
          const lastDate = streak.last_date;
          const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
          if (lastDate === today) {
            // Already counted today
            streakDays = streak.days;
            streakRecord = streak.record;
          } else if (lastDate === yesterday) {
            // Continuing streak
            streakDays = streak.days + 1;
            streakRecord = Math.max(streakDays, streak.record);
            await redis.set('cachly:streak:current', JSON.stringify({ days: streakDays, last_date: today, record: streakRecord }));
          } else {
            // Streak broken
            streakDays = 1;
            streakRecord = streak.record;
            await redis.set('cachly:streak:current', JSON.stringify({ days: 1, last_date: today, record: streakRecord }));
          }
        } else {
          // First session ever
          streakDays = 1;
          streakRecord = 1;
          await redis.set('cachly:streak:current', JSON.stringify({ days: 1, last_date: today, record: 1 }));
        }
        if (streakDays >= 7) streakMessage = `🔥 **${streakDays}-day streak!** ${streakDays === streakRecord ? ' New record!' : `Best: ${streakRecord}d`}`;
        else if (streakDays > 1) streakMessage = `🔥 ${streakDays}-day streak`;
      } catch { /* non-critical */ }

      // 7. Save session start marker
      await redis.set('cachly:session:current', JSON.stringify({
        started: new Date().toISOString(),
        focus,
        provider,
      }), 'EX', 86400); // auto-expire after 24h if session_end never called

      // 8. Time saved counter
      let timeSavedMins = 0;
      try {
        const raw = await redis.get(`cachly:stats:time_saved_mins:${instance_id}`);
        timeSavedMins = parseFloat(raw ?? '0');
      } catch { /* non-critical */ }

      // ── Build briefing ──────────────────────────────────────────────────────
      const providerLabel = provider ? ` · ${provider}` : '';
      const lines: string[] = [`🧠 **Session Briefing**${providerLabel}`, ''];
      if (streakMessage) lines.push(streakMessage, '');

      // Time saved (only show when meaningful — 30+ minutes)
      if (timeSavedMins >= 30) {
        const h = Math.floor(timeSavedMins / 60);
        const m = Math.round(timeSavedMins % 60);
        const timeStr = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
        lines.push(`⏱️ **Brain saved you ~${timeStr} total** (time not re-researching known fixes)`, '');
      }

      // ── What's New (shown once per version update) ──────────────────────────
      try {
        const seenVersion = await redis.get('cachly:mcp:version:last_seen');
        if (seenVersion !== MCP_VERSION) {
          await redis.set('cachly:mcp:version:last_seen', MCP_VERSION, 'EX', 365 * 86400);
          const changelog = WHATS_NEW[MCP_VERSION];
          if (changelog) { lines.push(...changelog, ''); }
        }
      } catch { /* non-critical */ }

      // ── First-time welcome (empty brain) ───────────────────────────────────
      const isFirstSession = !lastSession && lessons.length === 0 && ctxCount === 0;
      if (isFirstSession) {
        lines.push('🎉 **Welcome! Your AI Brain is live.**', '');
        if (workspace_path) {
          lines.push(`🚀 **Auto-bootstrapping from your git history...** (this takes a few seconds)`);
          lines.push(`   Your brain will learn from your recent commits — no setup needed.`, '');
        } else {
          lines.push('It learns from your work automatically. After your first session it will look like this:', '');
          lines.push('  ✅ `api:auth` — Bearer token in header, not cookie; 401 on missing scope');
          lines.push('  ✅ `database:migrations` — always run migrations before deploy');
          lines.push('  ⚠️ `docker:build` — ARG changes bust all subsequent cache layers');
          lines.push('');
          lines.push('**Tip:** Pass `workspace_path` to `session_start` to auto-learn from git history instantly.');
          lines.push('');
        }
        lines.push('**Your brain grows automatically:**');
        lines.push('  • End each session → `session_end(summary="What I did")` — auto-learns from git commits');
        lines.push('  • After fixing bugs → `learn_from_attempts(topic="...", outcome="success", what_worked="...")`');
        lines.push('');
        lines.push('💡 Run `brain_doctor` for a health-check and personalised tips.');
        lines.push('');
      }

      // ── Team-virality: first-team-briefing wow moment ────────────────────
      // When a user joins a team brain (has team lessons from colleagues but
      // has never been briefed on them), show a dedicated "Welcome to your
      // team's brain" section. Only fires once per user.
      if (author && !isFirstSession) {
        try {
          const briefingKey = `cachly:team:first_briefing:${author}`;
          const alreadyBriefed = await redis.get(briefingKey);
          if (!alreadyBriefed) {
            type LessonAny = typeof lessons[0] & { author?: string };
            const teamLessons = (lessons as LessonAny[]).filter(l => l.author && l.author !== author);
            if (teamLessons.length > 0) {
              // Mark briefed so this only fires once
              await redis.set(briefingKey, '1', 'EX', 365 * 86400);
              const byAuthor = new Map<string, LessonAny[]>();
              for (const l of teamLessons) {
                const a = l.author!;
                if (!byAuthor.has(a)) byAuthor.set(a, []);
                byAuthor.get(a)!.push(l);
              }
              lines.push('');
              lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              lines.push('🤝 **Your team\'s AI brain has been briefing you.**');
              lines.push('');
              lines.push(`Your teammates have already solved problems you\'re about to hit:`);
              lines.push('');
              for (const [teamAuthor, tls] of byAuthor) {
                lines.push(`  👤 **${teamAuthor}** fixed ${tls.length} thing${tls.length > 1 ? 's' : ''}:`);
                for (const l of tls.slice(0, 2)) {
                  const emoji = l.outcome === 'success' ? '✅' : '⚠️';
                  lines.push(`    ${emoji} \`${l.topic}\` — ${l.what_worked.slice(0, 90)}`);
                }
                if (tls.length > 2) lines.push(`    … and ${tls.length - 2} more lessons`);
              }
              lines.push('');
              lines.push(`💡 Use \`team_learn\` after your next fix to pay it forward.`);
              lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
              lines.push('');
            }
          }
        } catch { /* team briefing errors must never break session_start */ }
      }

      // Handoff from previous window (if any)
      const handoffRaw = await redis.get('cachly:session:handoff');
      if (handoffRaw) {
        try {
          const handoff = JSON.parse(handoffRaw) as {
            ts: string; completed_tasks: string[]; remaining_tasks: string[];
            files_changed?: { path: string; status: string; description?: string }[];
            instructions?: string; context_summary?: string; blocked_on?: string;
          };
          const ago = Math.round((Date.now() - new Date(handoff.ts).getTime()) / 60000);
          const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;

          lines.push(`🤝 **Handoff from previous window** (${agoStr}):`);
          if (handoff.context_summary) lines.push(`   ${handoff.context_summary}`);
          if (handoff.remaining_tasks.length > 0) {
            lines.push(`   ⏳ **Remaining tasks:**`);
            for (const t of handoff.remaining_tasks) lines.push(`     - ${t}`);
          }
          if (handoff.completed_tasks.length > 0) {
            lines.push(`   ✅ **Already done:** ${handoff.completed_tasks.join(', ')}`);
          }
          const brokenFiles = (handoff.files_changed ?? []).filter(f => f.status === 'broken' || f.status === 'partial');
          if (brokenFiles.length > 0) {
            lines.push(`   ⚠️ **Needs fix:** ${brokenFiles.map(f => `\`${f.path}\` (${f.status}${f.description ? ': ' + f.description : ''})`).join(', ')}`);
          }
          if (handoff.blocked_on) lines.push(`   🚫 **Blocked on:** ${handoff.blocked_on}`);
          if (handoff.instructions) lines.push(`   📝 **Instructions:** ${handoff.instructions}`);
          lines.push('');
        } catch { /* ignore corrupt handoff */ }
      }

      // ── Last checkpoint (session_ping) — shown when no session_end found ────
      const checkpointRaw = await redis.get('cachly:session:checkpoint');
      if (checkpointRaw) {
        try {
          const cp = JSON.parse(checkpointRaw) as {
            ts: string; task: string; files_touched: string[]; next_step?: string; provider?: string;
          };
          // Only show checkpoint if it's more recent than last session_end
          const cpTime = new Date(cp.ts).getTime();
          const lastSessionTime = lastSession ? new Date(lastSession.ts).getTime() : 0;
          if (cpTime > lastSessionTime) {
            const ago = Math.round((Date.now() - cpTime) / 60000);
            const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
            const providerStr = cp.provider ? ` [${cp.provider}]` : '';
            lines.push(`📌 **Last checkpoint**${providerStr} (${agoStr}): ${cp.task}`);
            if (cp.files_touched.length > 0) {
              lines.push(`   Files: ${cp.files_touched.slice(0, 5).map(f => `\`${f}\``).join(', ')}`);
            }
            if (cp.next_step) lines.push(`   📍 Next step was: ${cp.next_step}`);
            if (!lastSession || cpTime - lastSessionTime > 300_000) {
              lines.push(`   ⚠️ No \`session_end\` found — reconstructed from last checkpoint`);
            }
            lines.push('');
          }
        } catch { /* ignore */ }
      }

      // ── Git reconstruction — when no session_end + workspace_path given ─────
      if (workspace_path && !lastSession) {
        try {
          const { execSync } = await import('node:child_process');
          const gitLog = execSync(
            `git -C "${workspace_path}" log --oneline --format="%h %s" -15 2>/dev/null`,
            { encoding: 'utf-8', timeout: 5000 },
          ).trim();
          const gitDiff = execSync(
            `git -C "${workspace_path}" diff --stat HEAD~3 2>/dev/null || git -C "${workspace_path}" diff --stat 2>/dev/null`,
            { encoding: 'utf-8', timeout: 5000 },
          ).trim();
          if (gitLog) {
            lines.push(`🔍 **Git reconstruction** (no session_end found — reconstructed from git):`);
            for (const l of gitLog.split('\n').slice(0, 8)) lines.push(`   ${l}`);
            if (gitDiff) {
              const diffLines = gitDiff.split('\n').filter(l => l.includes('|') || l.includes('changed'));
              if (diffLines.length > 0) {
                lines.push(`   **Recent changes:**`);
                for (const dl of diffLines.slice(0, 5)) lines.push(`   ${dl.trim()}`);
              }
            }
            lines.push('');
          }
        } catch { /* git not available or no repo — silent */ }
      }

      // Last session
      if (lastSession) {
        const ago = Math.round((Date.now() - new Date(lastSession.ts).getTime()) / 60000);
        const agoStr = ago < 60 ? `${ago}m ago` : ago < 1440 ? `${Math.round(ago / 60)}h ago` : `${Math.round(ago / 1440)}d ago`;
        lines.push(`📅 **Last session** (${agoStr}): ${lastSession.summary}`);
        if (lastSession.duration_min) lines.push(`   Duration: ${lastSession.duration_min} min`);
        if ((lastSession.files_changed ?? []).length > 0) {
          lines.push(`   Files: ${(lastSession.files_changed ?? []).slice(0, 5).map((f: string) => `\`${f}\``).join(', ')}`);
        }
        lines.push('');
      }

      // Brain health
      lines.push(`📊 **Brain:** ${lessons.length} lessons · ${ctxCount} context entries`, '');

      // ── 📌 Proven Laws — auto-crystallized lessons (quick win 3) ─────────────
      // A lesson that has proven itself (recalled ≥ CRYSTALLIZE_RECALLS times) or
      // was explicitly pinned becomes a "law" — surfaced at the top of every
      // briefing so the most battle-tested knowledge is never buried. This is
      // the today-safe version of swarm crystallization: enough confirmations
      // auto-promote a lesson without any manual step.
      {
        type LessonPin = typeof lessons[0] & { pinned?: boolean };
        const CRYSTALLIZE_RECALLS = 5;
        const laws = (lessons as LessonPin[])
          .filter(l => l.outcome === 'success' && (l.pinned === true || (l.recall_count ?? 0) >= CRYSTALLIZE_RECALLS))
          .sort((a, b) => (b.recall_count ?? 0) - (a.recall_count ?? 0))
          .slice(0, 5);
        if (laws.length > 0) {
          lines.push(`📌 **Proven Laws** (auto-crystallized — your most-trusted knowledge):`);
          for (const l of laws) {
            const sev = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '';
            const rc  = l.recall_count ?? 0;
            const why = l.pinned === true ? 'pinned' : `recalled ${rc}×`;
            lines.push(`  🏆${sev} \`${l.topic}\` _(${why})_ — ${l.what_worked.slice(0, 100)}`);
          }
          lines.push('');
        }
      }

      // ── Layer 7: MCM Domain Coverage Map ────────────────────────────────────
      if (lessons.length >= 3) {
        const domainMap = new Map<string, { total: number; success: number; critical: number }>();
        for (const l of lessons) {
          const dom = l.topic.split(':')[0] ?? 'other';
          if (!domainMap.has(dom)) domainMap.set(dom, { total: 0, success: 0, critical: 0 });
          const d = domainMap.get(dom)!;
          d.total++;
          if (l.outcome === 'success') d.success++;
          if (l.severity === 'critical') d.critical++;
        }
        const sorted = [...domainMap.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 6);
        const hasContestedDomains = sorted.some(([, d]) => d.success < d.total * 0.4 && d.total >= 2);
        if (sorted.length > 0) {
          lines.push(`🗺️ **Knowledge Coverage:**`);
          for (const [dom, d] of sorted) {
            const pct = Math.round((d.success / d.total) * 100);
            const filled = Math.round(pct / 10);
            const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
            const flag = d.critical > 0 ? ' 🔴' : pct < 40 && d.total >= 2 ? ' ⚠️' : '';
            lines.push(`  ${bar} ${dom.padEnd(18)} ${String(pct).padStart(3)}% (${d.success}/${d.total} confirmed)${flag}`);
          }
          if (hasContestedDomains) {
            lines.push(`  ⚠️ _Some domains have contested beliefs — use \`ckg_inspect\` to review_`);
          }
          lines.push('');
        }
      }

      // ── Layer 7 MCM: Active belief conflicts ─────────────────────────────────
      try {
        const conflictKeys: string[] = [];
        const cfStream = redis.scanStream({ match: 'cachly:ckg:conflict:*', count: 50 });
        await new Promise<void>((res, rej) => { cfStream.on('data', (b: string[]) => conflictKeys.push(...b)); cfStream.on('end', res); cfStream.on('error', rej); });
        if (conflictKeys.length > 0) {
          lines.push(`⚡ **Active belief conflicts (${conflictKeys.length}):**`);
          for (const ck of conflictKeys.slice(0, 3)) {
            const cr = await redis.get(ck);
            if (!cr) continue;
            const cf = safeJsonParse<{ topic: string; fix_confidence: number; fix_trials: number } | null>(cr, null);
            if (!cf) continue;
            lines.push(`  ⚠️ \`${cf.topic}\` — previously confirmed fix (${(cf.fix_confidence * 100).toFixed(0)}%, n=${cf.fix_trials}) now contradicted. Use \`ckg_inspect(concept="${ckgSlug(cf.topic)}")\``);
          }
          lines.push('');
        }
      } catch { /* non-critical */ }

      // ── Layer 7 MCM: Blind Spot Detection ────────────────────────────────────
      // If the focus mentions a domain that has no CKG node → surface blind spot
      if (focus && focus.length > 3) {
        try {
          const focusTokens = focus.toLowerCase().replace(/[^a-z0-9\s:_-]/g, ' ').split(/\s+/).filter(t => t.length > 3);
          const blindSpots: string[] = [];
          for (const token of focusTokens.slice(0, 6)) {
            const nodeExists = await redis.exists(`cachly:ckg:node:${token}`);
            if (!nodeExists) {
              // Check if any node starts with this token (prefix match)
              const prefixKeys: string[] = [];
              const psStream = redis.scanStream({ match: `cachly:ckg:node:${token}*`, count: 10 });
              await new Promise<void>((res, rej) => { psStream.on('data', (b: string[]) => prefixKeys.push(...b)); psStream.on('end', res); psStream.on('error', rej); });
              if (prefixKeys.length === 0) blindSpots.push(token);
            }
          }
          if (blindSpots.length > 0) {
            lines.push(`🔭 **Blind spots detected for this focus:**`);
            for (const bs of blindSpots.slice(0, 3)) {
              lines.push(`  ⬜ \`${bs}\` — no CKG knowledge. Suggestions:`);
              lines.push(`     • \`brain_from_git(instance_id="...", concept="${bs}")\` — bootstrap from commits`);
              lines.push(`     • \`fedbrain_search(query="${bs}")\` — search global commons`);
            }
            lines.push('');
          }
        } catch { /* non-critical */ }
      }

      if (focusLessons.length > 0) {
        lines.push(`🎯 **Relevant for "${focus}":**`);
        for (const l of focusLessons.slice(0, 4)) {
          const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
          const sev = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '';
          lines.push(`  ${emoji}${sev} \`${l.topic}\` — ${l.what_worked.slice(0, 100)}`);
        }
        lines.push('');
      }

      // Top lessons — sorted by recall_count desc (most-used = most proven value).
      // If focus is set, focus-matched lessons already shown above; show remaining here.
      if (lessons.length > 0) {
        const byRecall = [...lessons].sort((a, b) => (b.recall_count ?? 0) - (a.recall_count ?? 0));
        const topRecalled = byRecall.filter(l => (l.recall_count ?? 0) > 0).slice(0, 3);
        const remaining   = (focusLessons.length > 0 ? lessons.filter(l => !focusLessons.includes(l)) : lessons)
          .filter(l => !topRecalled.includes(l))
          .slice(0, focusLessons.length > 0 ? 3 : 4);

        if (topRecalled.length > 0) {
          lines.push(`🏆 **Most valuable** (recalled ${topRecalled[0]!.recall_count}× before):`);
          for (const l of topRecalled) {
            const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
            const sev   = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '';
            const rc    = l.recall_count ?? 0;
            const la     = (l as { authors?: string[]; author?: string }).authors
              ?? ((l as { author?: string }).author ? [(l as { author?: string }).author!] : []);
            const nAuthors = new Set(la.filter(Boolean)).size;
            const trust  = (nAuthors >= 2 && rc >= 5) || rc >= 10 ? ' 🏆'
              : nAuthors >= 2 || rc >= 5 ? ' ✅' : '';
            const rct   = rc > 1 ? ` _(${rc}× recalled)_` : '';
            lines.push(`  ${emoji}${sev}${trust} \`${l.topic}\`${rct} — ${l.what_worked.slice(0, 100)}`);
          }
          lines.push('');
        }

        if (remaining.length > 0) {
          const header = topRecalled.length > 0 ? `🕐 **Recent:**` : `🕐 **Recent lessons:**`;
          lines.push(header);
          for (const l of remaining) {
            const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
            const sev   = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '';
            lines.push(`  ${emoji}${sev} \`${l.topic}\` — ${l.what_worked.slice(0, 100)}`);
          }
          lines.push('');
        }
      } else {
        lines.push('📭 No lessons yet. Use `learn_from_attempts` after solving tasks.', '');
      }

      // Team invite prompt — fires once after 10th lesson if no team use yet
      if (lessons.length >= 10) {
        const hasTeamUse = lessons.some(l => (l as typeof l & { author?: string }).author);
        if (!hasTeamUse) {
          lines.push(`🤝 **Your Brain has ${lessons.length} lessons — your team could benefit instantly.**`);
          lines.push(`   Share: **cachly.dev/team** · or run \`team_learn\` after the next fix.`, '');
        }
      }

      // Open failures (lessons whose best-key has outcome != success)
      const openFailures = lessons.filter(l => l.outcome === 'failure' || l.outcome === 'partial');
      if (openFailures.length > 0) {
        lines.push(`⚠️ **Unresolved** (${openFailures.length} topic${openFailures.length > 1 ? 's' : ''} with no success yet):`);
        for (const l of openFailures.slice(0, 3)) {
          lines.push(`  ❌ \`${l.topic}\` — ${(l.what_failed ?? l.what_worked).slice(0, 80)}`);
        }
        lines.push('');
      }

      // ── Stale / low-confidence lessons (confidence decay) ─────────────────
      const staleSuccessLessons = lessons.filter(l => {
        if (l.outcome !== 'success' && l.outcome !== 'partial') return false;
        return calculateConfidence(l) < CONFIDENCE_WARN_VALUE;
      });
      if (staleSuccessLessons.length > 0) {
        lines.push(`🔴 **Stale lessons** (not recalled in >${CONFIDENCE_WARN_DAYS}d — verify before applying):`);
        for (const l of staleSuccessLessons.slice(0, 4)) {
          const conf = calculateConfidence(l);
          const ageDays = Math.round((Date.now() - new Date(l.verified_at ?? l.ts).getTime()) / 86400000);
          const flag = conf < CONFIDENCE_STALE_VALUE ? '🔴' : '⚠️';
          lines.push(`  ${flag} \`${l.topic}\` — ${ageDays}d stale, ${(conf * 100).toFixed(0)}% confidence`);
        }
        lines.push(`  _Run \`recall_best_solution\` on these to reset their confidence clock._`);
        lines.push('');
      }

      // ── Session Replay: show last session's decision log ──────────────────
      const lastSessionAny = lastSession as unknown as { decision_log?: Array<{ topic: string; outcome: string; what_worked: string }> } | null;
      if (lastSessionAny?.decision_log?.length) {
        const dl = lastSessionAny.decision_log;
        const successes = dl.filter(d => d.outcome === 'success');
        const failures  = dl.filter(d => d.outcome === 'failure');
        lines.push(`🎬 **Last session decisions** (${dl.length} lessons stored):`);
        if (successes.length > 0) lines.push(`  ✅ Worked: ${successes.slice(0, 3).map(d => `\`${d.topic}\``).join(', ')}`);
        if (failures.length > 0)  lines.push(`  ❌ Failed: ${failures.slice(0, 3).map(d => `\`${d.topic}\``).join(', ')}`);
        lines.push('');
      }

      // ── 🔮 Predictive Pre-Warning — intent-based danger detection ────────────
      // Fires BEFORE work starts. Uses explicit focus when given; otherwise
      // derives the likely work area from the last session's changed files +
      // summary (you usually keep working where you left off). This makes the
      // warning fire even when the caller forgets to pass `focus`.
      {
        type LessonAny = typeof lessons[0] & { author?: string; tags?: string[] };

        // Common path noise / extensions to drop when deriving terms from files.
        const PATH_NOISE = new Set([
          'src', 'lib', 'test', 'tests', 'dist', 'index', 'main', 'app',
          'internal', 'pkg', 'cmd', 'node_modules', 'components', 'utils',
          'ts', 'tsx', 'js', 'jsx', 'go', 'py', 'rs', 'java', 'json', 'yaml', 'yml',
        ]);
        const deriveTermsFromFiles = (files: string[]): string[] => {
          const terms = new Set<string>();
          for (const f of files) {
            for (const seg of f.toLowerCase().split(/[/\\._-]/)) {
              if (seg.length > 3 && !PATH_NOISE.has(seg)) terms.add(seg);
            }
          }
          return [...terms];
        };

        let warnTerms = focusTerms;
        let warnLabel = focus;
        let derived = false;
        if (warnTerms.length === 0 && lastSession) {
          const fromFiles = deriveTermsFromFiles(lastSession.files_changed ?? []);
          const fromSummary = (lastSession.summary ?? '').toLowerCase()
            .replace(/[^a-z0-9\s:_-]/g, ' ').split(/\s+/).filter(t => t.length > 3 && !PATH_NOISE.has(t));
          warnTerms = [...new Set([...fromFiles, ...fromSummary])];
          warnLabel = 'where you left off last session';
          derived = true;
        }

        if (warnTerms.length > 0) {
          const dangerLessons = (lessons as LessonAny[]).filter(l => {
            if (l.outcome === 'success') return false;
            const topicCategory = l.topic.split(':')[0];
            return warnTerms.some(term =>
              l.topic.toLowerCase().includes(term) ||
              topicCategory === term ||
              (l.tags ?? []).some((t: string) => t.toLowerCase() === term),
            );
          });
          if (dangerLessons.length >= 1) {
            const headline = derived
              ? `  You're likely to continue **${warnLabel}** — ${dangerLessons.length} known pitfall${dangerLessons.length > 1 ? 's' : ''} there:`
              : `  Known pitfalls for **"${warnLabel}"** (${dangerLessons.length} past failure${dangerLessons.length > 1 ? 's' : ''}):`;
            const warning = [
              `🚨 **PRE-WARNING** — Read this BEFORE starting:`,
              headline,
              ...dangerLessons.slice(0, 3).map(l => `  ❌ \`${l.topic}\` — ${(l.what_failed ?? l.what_worked).slice(0, 80)}`),
              '',
            ];
            lines.splice(2, 0, ...warning); // after '🧠 **Session Briefing**' + empty line
          }
        }
      }

      // ── 👥 Team Telepathy — what teammates learned this week ─────────────────
      if (author) {
        type LessonAny = typeof lessons[0] & { author?: string };
        const oneWeekAgo = Date.now() - 7 * 86_400_000;
        const teamLessons = (lessons as LessonAny[]).filter(l =>
          l.author && l.author !== author && new Date(l.ts).getTime() > oneWeekAgo,
        );
        if (teamLessons.length > 0) {
          // Group by author
          const byAuthor = new Map<string, LessonAny[]>();
          for (const l of teamLessons) {
            const a = l.author!;
            if (!byAuthor.has(a)) byAuthor.set(a, []);
            byAuthor.get(a)!.push(l);
          }
          lines.push(`👥 **Team this week** (${teamLessons.length} lesson${teamLessons.length > 1 ? 's' : ''} from teammates):`);
          for (const [teamAuthor, tls] of byAuthor) {
            lines.push(`  👤 **${teamAuthor}**:`);
            for (const l of tls.slice(0, 3)) {
              const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
              lines.push(`    ${emoji} \`${l.topic}\` — ${l.what_worked.slice(0, 80)}`);
            }
            if (tls.length > 3) lines.push(`    … and ${tls.length - 3} more`);
          }
          lines.push('');
        }
      }

      // ── 💎 Memory Crystal — compressed wisdom from old sessions ──────────────
      try {
        const crystalRaw = await redis.get('cachly:crystal:latest');
        if (crystalRaw) {
          type CrystalData = { label: string; ts: string; session_count: number; top_patterns: Array<{ category: string; insight: string; count: number }> };
          const crystal = safeJsonParse<CrystalData | null>(crystalRaw, null);
          if (crystal) {
            const crystalAge = Math.round((Date.now() - new Date(crystal.ts).getTime()) / 86_400_000);
            if (crystalAge <= 90) {
              lines.push(`💎 **Memory Crystal** (${crystal.label} · ${crystal.session_count} sessions compressed):`);
              for (const p of crystal.top_patterns.slice(0, 3)) {
                lines.push(`  • **${p.category}** (${p.count}×): ${p.insight.slice(0, 90)}`);
              }
              lines.push('');
            }
          }
        }
      } catch { /* non-critical */ }

      // ── 🗺️ Roadmap — open items at session start ────────────────────────────
      try {
        const roadmapAll = await redis.hgetall(`cachly:roadmap:${instance_id}`);
        if (roadmapAll && Object.keys(roadmapAll).length > 0) {
          const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
          const PRIORITY_ICON: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
          const openStatuses = new Set(['planned', 'in-progress', 'blocked']);
          const allItems = Object.values(roadmapAll).flatMap(v => {
            const item = safeJsonParse<Record<string, unknown> | null>(v as string, null);
            return item ? [item] : [];
          });
          const openItems = allItems
            .filter(i => openStatuses.has(i.status as string))
            .sort((a, b) => {
              if (a.status === 'in-progress' && b.status !== 'in-progress') return -1;
              if (b.status === 'in-progress' && a.status !== 'in-progress') return 1;
              return (PRIORITY_ORDER[a.priority as string] ?? 99) - (PRIORITY_ORDER[b.priority as string] ?? 99);
            });
          const doneCount = allItems.filter(i => i.status === 'done').length;
          if (openItems.length > 0) {
            lines.push(`🗺️ **Roadmap** (${openItems.length} open · ${doneCount} done):`);
            for (const it of openItems.slice(0, 5)) {
              const statusIcon = it.status === 'in-progress' ? '⚡' : it.status === 'blocked' ? '🚫' : '📋';
              lines.push(`  ${statusIcon} ${PRIORITY_ICON[it.priority as string] ?? '⚪'} \`${it.id}\` **${it.title}**`);
            }
            if (openItems.length > 5) lines.push(`  … and ${openItems.length - 5} more`);
            lines.push(`  _Use \`roadmap_next\` for the top priority item · \`roadmap_list\` for full view_`);
            lines.push('');
          }
        }
      } catch { /* non-critical */ }

      // ── 🔮 PPE: Predictive Pre-fetch — CKG-powered risk detection ────────────
      // Layer 4: Before starting any work, scan the CKG for nodes matching focus
      // tokens and traverse causal edges to surface predicted failure points inline.
      // This is the PPE "pre-fetch" that was previously only available via brain_predict.
      if (focus && focus.length > 3) {
        try {
          const ppeFocusTokens = focus.toLowerCase().replace(/[^a-z0-9\s\-_:]/g, ' ').split(/\s+/).filter(t => t.length > 2).slice(0, 5);
          type PPEPrediction = { concept: string; edgeType: string; target: string; confidence: number; lesson?: { what_worked?: string; topic: string } };
          const ppePredictions: PPEPrediction[] = [];

          for (const token of ppeFocusTokens) {
            const nodeKeys: string[] = [];
            const nStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 20 });
            await new Promise<void>((res, rej) => { nStream.on('data', (b: string[]) => nodeKeys.push(...b)); nStream.on('end', res); nStream.on('error', rej); });

            for (const nk of nodeKeys.slice(0, 3)) {
              const nodeRaw = await redis.get(nk);
              if (!nodeRaw) continue;
              const node = safeJsonParse<CKGNode | null>(nodeRaw, null);
              if (!node) continue;
              const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${node.id}`);
              for (const ek of edgeKeys.slice(0, 15)) {
                const edgeRaw = await redis.get(ek);
                if (!edgeRaw) continue;
                const edge = safeJsonParse<CKGEdge | null>(edgeRaw, null);
                if (!edge) continue;
                if (edge.edgeType !== 'causes' && edge.edgeType !== 'co-occurs' && edge.edgeType !== 'fixes') continue;
                if (edge.confidence < 0.35) continue;
                const lessonKey = edge.edgeType === 'fixes' ? `cachly:lesson:best:${edge.from}` : `cachly:lesson:best:${edge.to}`;
                const lessonRaw = await redis.get(lessonKey);
                const lesson = safeJsonParse<{ what_worked?: string; topic: string } | null>(lessonRaw, null);
                ppePredictions.push({ concept: node.id, edgeType: edge.edgeType, target: edge.to, confidence: edge.confidence, lesson: lesson ?? undefined });
              }
            }
          }

          const ppeSeen = new Set<string>();
          const ppeUniq = ppePredictions
            .filter(p => { const k = `${p.concept}:${p.target}`; if (ppeSeen.has(k)) return false; ppeSeen.add(k); return true; })
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 4);

          if (ppeUniq.length > 0) {
            lines.push(`🔮 **Predicted risks for "${focus}"** (PPE pre-fetch):`);
            for (const p of ppeUniq) {
              const confPct = Math.round(p.confidence * 100);
              const icon = p.edgeType === 'causes' ? '⚡' : p.edgeType === 'fixes' ? '🔧' : '🔄';
              lines.push(`  ${icon} **${confPct}%** \`${p.concept}\` ${p.edgeType} \`${p.target}\``);
              if (p.lesson?.what_worked) lines.push(`     ✅ ${(p.lesson.what_worked as string).slice(0, 110)}`);
            }
            lines.push(`  _Full analysis: \`brain_predict(context="${focus}")\`_`);
            lines.push('');
          }
        } catch { /* non-critical — never block session start */ }
      }

      // ── 📐 MCM Confidence Calibration — 30-day accuracy pass ─────────────────
      // Layer 7: Periodically check if high-confidence lessons are actually reliable.
      // If last calibration was >30 days ago (or never), run a quick pass.
      // Measures: of recalled lessons with confidence > 0.85, what % had outcome=success?
      try {
        const calRaw = await redis.get('cachly:mcm:calibration:last');
        const lastCalMs = safeJsonParse<{ ts?: number } | null>(calRaw, null)?.ts ?? 0;
        const daysSinceCal = (Date.now() - lastCalMs) / 86_400_000;
        if (daysSinceCal >= 30 && lessons.length >= 5) {
          // Quick calibration pass on recalled lessons (recall_count > 0, outcome=success)
          const recalledSuccess = lessons.filter(l => l.outcome === 'success' && (l.recall_count ?? 0) > 0);
          const recalledAll     = lessons.filter(l => (l.recall_count ?? 0) > 0);
          if (recalledAll.length >= 3) {
            const precision = recalledAll.length > 0 ? recalledSuccess.length / recalledAll.length : 1;
            const lowPrecisionDomains: string[] = [];
            // Per-domain breakdown
            const domCalMap = new Map<string, { success: number; total: number }>();
            for (const l of recalledAll) {
              const dom = l.topic.split(':')[0] ?? 'other';
              if (!domCalMap.has(dom)) domCalMap.set(dom, { success: 0, total: 0 });
              const d = domCalMap.get(dom)!;
              d.total++;
              if (l.outcome === 'success') d.success++;
            }
            for (const [dom, d] of domCalMap) {
              if (d.total >= 2 && d.success / d.total < 0.6) lowPrecisionDomains.push(dom);
            }
            // Save calibration result
            await redis.set('cachly:mcm:calibration:last', JSON.stringify({
              ts: Date.now(),
              precision: precision,
              recalled: recalledAll.length,
              low_precision_domains: lowPrecisionDomains,
            }));
            if (lowPrecisionDomains.length > 0 || precision < 0.7) {
              lines.push(`📐 **MCM Calibration** (30-day pass — ${recalledAll.length} recalled lessons):`);
              lines.push(`  Overall precision: **${(precision * 100).toFixed(0)}%** recalled lessons actually worked`);
              if (lowPrecisionDomains.length > 0) {
                lines.push(`  ⚠️ Low-precision domains: ${lowPrecisionDomains.map(d => `\`${d}\``).join(', ')} — consider revisiting these lessons`);
              }
              lines.push(`  💡 Use \`learn_from_attempts\` to update stale lessons and improve accuracy.`);
              lines.push('');
            }
          }
          // Even if no issues, stamp the date so we don't re-check for 30d
          await redis.set('cachly:mcm:calibration:last', JSON.stringify({ ts: Date.now(), precision: 1, recalled: 0 }), 'EX', 35 * 86400);
        }
      } catch { /* non-critical */ }

      // ── 🌍 Knowledge Commons — community stats banner ───────────────────────
      try {
        const commonsStats = await apiFetch<{
          total_lessons: number;
          total_confirms: number;
          added_last_7_days: number;
        }>('/api/v1/syndication/stats');
        if (commonsStats.total_lessons > 0) {
          lines.push(
            `🌍 **Commons:** ${commonsStats.total_lessons.toLocaleString()} lessons · ` +
            `${commonsStats.total_confirms.toLocaleString()} confirms · ` +
            `+${commonsStats.added_last_7_days} this week`,
          );
          lines.push('');
        }
      } catch { /* non-critical — never block session start */ }

      // ── Brain Doctor hint (Punkt 6) — surface when brain needs attention ───
      const hasOpenFailures = lessons.filter(l => l.outcome === 'failure' || l.outcome === 'partial').length > 0;
      const hasStaleLessons = lessons.some(l => l.outcome === 'success' && calculateConfidence(l) < CONFIDENCE_WARN_VALUE);
      if (lessons.length === 0 || hasOpenFailures || hasStaleLessons) {
        const reasons: string[] = [];
        if (lessons.length === 0) reasons.push('brain is empty');
        if (hasOpenFailures) reasons.push('open failures');
        if (hasStaleLessons) reasons.push('stale lessons');
        lines.push(`🩺 _Run \`brain_doctor\` to fix: ${reasons.join(', ')}._`);
      }

      return lines.join('\n');
    }

    // ── session_end ───────────────────────────────────────────────────────────
    case 'session_end': {
      const {
        instance_id,
        summary,
        files_changed = [],
        lessons_learned,
        workspace_path = '',
      } = args as {
        instance_id: string;
        summary: string;
        files_changed?: string[];
        lessons_learned?: number;
        workspace_path?: string;
      };

      const redis = await getConnection(instance_id);
      const now = new Date();

      // Calculate duration from session_start marker
      let durationMin: number | undefined;
      const currentRaw = await redis.get('cachly:session:current');
      if (!currentRaw) {
        return `⚠️ No active session found.\n\nRun \`session_start\` first to begin tracking a session, then call \`session_end\` when you're done.`;
      }
      const current = safeJsonParse<{ started: string } | null>(currentRaw, null);
      if (current?.started) {
        durationMin = Math.round((now.getTime() - new Date(current.started).getTime()) / 60000);
      }

      // ── Session Replay: capture decision log ─────────────────────────────
      type DecisionEntry = { ts: string; topic: string; outcome: string; what_worked: string };
      let decisionLog: DecisionEntry[] = [];
      try {
        const dlEntries = await redis.lrange('cachly:session:decision-log', 0, -1);
        decisionLog = dlEntries.flatMap(e => {
          const entry = safeJsonParse<DecisionEntry | null>(e, null);
          return entry ? [entry] : [];
        });
        await redis.del('cachly:session:decision-log');
      } catch { /* non-critical */ }

      const sessionRecord = {
        ts: now.toISOString(),
        summary,
        files_changed,
        ...(lessons_learned !== undefined ? { lessons_learned } : {}),
        ...(durationMin !== undefined ? { duration_min: durationMin } : {}),
        ...(decisionLog.length > 0 ? { decision_log: decisionLog } : {}),
      };

      // Save as "last session"
      await redis.set('cachly:session:last', JSON.stringify(sessionRecord));

      // Append to history list (keep last 50 sessions, TTL 90 days)
      await redis.lpush('cachly:session:history', JSON.stringify(sessionRecord));
      await redis.ltrim('cachly:session:history', 0, 49);
      await redis.expire('cachly:session:history', 90 * 86400);

      // Clean up current session marker
      await redis.del('cachly:session:current');

      // ── AUTO-LEARN from session summary (no manual call needed) ─────────────
      // Parse the summary for actionable lessons and store them automatically.
      const autoLearned: string[] = [];
      try {
        // Extract key sentences from the summary that contain action verbs
        const actionVerbs = /\b(fixed|deployed|added|removed|refactored|migrated|updated|resolved|implemented|improved|optimized|configured|created|deleted|disabled|enabled|discovered|found|learned|debugged|patched|upgraded|installed|tested|built|rewrote|moved|renamed|split|merged|extracted)\b/i;
        const sentences = summary
          .split(/[.!\n]+/)
          .map(s => s.trim())
          .filter(s => s.length > 20 && actionVerbs.test(s));

        for (const sentence of sentences.slice(0, 6)) {
          // Build a topic slug from the first meaningful words
          const words = sentence.toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !['that', 'this', 'with', 'from', 'have', 'been', 'were', 'they', 'then', 'when', 'also', 'into', 'will', 'would', 'could', 'should'].includes(w));
          const slug = words.slice(0, 4).join('-');
          if (!slug) continue;
          const topic = `auto:${slug}`;
          const key = `cachly:lesson:best:${topic}`;

          // Don't overwrite existing successful lessons
          const existing = await redis.get(key);
          if (existing) {
            try {
              const ex = JSON.parse(existing) as { outcome: string };
              if (ex.outcome === 'success') continue;
            } catch { /* ignore */ }
          }

          const lesson = {
            topic,
            outcome: 'success',
            what_worked: sentence,
            context: `Auto-learned from session summary. Full summary: ${summary.slice(0, 300)}`,
            severity: 'minor',
            ts: now.toISOString(),
            recall_count: 0,
            auto_learned: true,
            session_ts: now.toISOString(),
            version: 2,
          };
          await redis.set(key, JSON.stringify(lesson));
          // 90-day TTL for auto-learned lessons
          await redis.expire(key, 90 * 86400);
          autoLearned.push(topic);
        }

        // Also store a lesson per changed file area if files were changed
        if (files_changed.length > 0) {
          const areas = [...new Set(files_changed.map(f => f.split('/').slice(0, 2).join('/')))].slice(0, 3);
          for (const area of areas) {
            const slug = area.replace(/[^a-z0-9]/gi, '-').toLowerCase().replace(/-+/g, '-').slice(0, 30);
            const topic = `auto:changed:${slug}`;
            const key = `cachly:lesson:best:${topic}`;
            const lesson = {
              topic,
              outcome: 'success',
              what_worked: `Files changed in ${area}: ${files_changed.filter(f => f.startsWith(area.split('/')[0])).slice(0, 5).join(', ')}`,
              context: summary.slice(0, 200),
              severity: 'minor',
              ts: now.toISOString(),
              recall_count: 0,
              auto_learned: true,
              version: 2,
            };
            await redis.set(key, JSON.stringify(lesson));
            await redis.expire(key, 90 * 86400);
            autoLearned.push(topic);
          }
        }
      } catch { /* auto-learn errors must never break session_end */ }

      // ── 🌿 Ambient Git Learning ────────────────────────────────────────────────
      // Read git commits since session start → auto-learn each meaningful commit.
      const ambientLearned: string[] = [];
      if (workspace_path) {
        try {
          // Get the session start time (stored by session_start)
          const sessionStartTs = currentRaw
            ? (() => { try { return (JSON.parse(currentRaw) as { started?: string }).started ?? ''; } catch { return ''; } })()
            : '';
          const sinceArg = sessionStartTs ? `--since="${sessionStartTs}"` : '--since="1 hour ago"';
          const gitOut = execSync(
            `git -C "${workspace_path}" log ${sinceArg} --oneline --format="%H|||%s|||%ai"`,
            { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          ).trim();
          if (gitOut) {
            const commitActionRe = /\b(fix|add|remove|refactor|migrate|update|resolve|implement|improve|optimize|configure|create|delete|disable|enable|debug|patch|upgrade|build|rewrite|deploy|feat|chore|docs|test|perf|ci)\b/i;
            for (const line of gitOut.split('\n').slice(0, 10)) {
              const [hash, msg, dateStr] = line.split('|||');
              if (!msg || !commitActionRe.test(msg)) continue;
              const slug = msg
                .toLowerCase().replace(/^(fix|feat|chore|docs|test|ci|perf|refactor|build|revert)[:(\s]/i, '')
                .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
              if (!slug) continue;
              const topic = `git:${slug}`;
              const key = `cachly:lesson:best:${topic}`;
              const existing = await redis.get(key);
              if (existing) continue; // don't overwrite existing
              const commitLesson = {
                topic,
                outcome: 'success' as const,
                what_worked: msg.slice(0, 200),
                context: `Auto-learned from git commit ${(hash ?? '').slice(0, 7)} at ${dateStr ?? ''} in ${workspace_path}`,
                severity: 'minor' as const,
                ts: now.toISOString(),
                recall_count: 0,
                auto_learned: true,
                source: 'ambient-git',
                version: 3,
              };
              await redis.set(key, JSON.stringify(commitLesson));
              await redis.expire(key, 60 * 86400); // 60 day TTL for git lessons
              ambientLearned.push(topic);
            }
          }
        } catch { /* git not available or not a repo — silent skip */ }
      }

      const durationStr = durationMin !== undefined ? ` · ${durationMin} min` : '';
      const totalAutoLearned = autoLearned.length + ambientLearned.length;

      // ── Shareable Session Summary Card ────────────────────────────────────────
      // Generated after each session so the user can share their progress.
      const tweetLines: string[] = [];
      if (durationMin !== undefined && durationMin > 0) tweetLines.push(`⏱ ${durationMin} min session`);
      if (totalAutoLearned > 0) tweetLines.push(`🧠 ${totalAutoLearned} lessons saved to Brain`);
      if (files_changed.length > 0) tweetLines.push(`📁 ${files_changed.length} file${files_changed.length > 1 ? 's' : ''} changed`);
      const tweetBody = tweetLines.length > 0
        ? `${tweetLines.join(' · ')}\n\nMy AI Brain remembers this so I never repeat it. @cachlydev\ncachly.dev`
        : `Session saved to my AI Brain. No more re-explaining this tomorrow. @cachlydev\ncachly.dev`;
      const tweetURL = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetBody)}`;

      const sessionCard = [
        ``,
        `┌─────────────────────────────────────────────┐`,
        `│  🧠 Session Summary Card                    │`,
        `│  Share your progress — cached forever       │`,
        `├─────────────────────────────────────────────┤`,
        durationMin !== undefined ? `│  ⏱  Duration   : ${String(durationMin + ' min').padEnd(26)}│` : '',
        totalAutoLearned > 0     ? `│  📚 Learned    : ${String(totalAutoLearned + ' lessons').padEnd(26)}│` : '',
        files_changed.length > 0 ? `│  📁 Changed    : ${String(files_changed.length + ' file' + (files_changed.length > 1 ? 's' : '')).padEnd(26)}│` : '',
        `├─────────────────────────────────────────────┤`,
        `│  📣 Share: ${tweetURL.slice(0, 34).padEnd(34)}│`,
        `└─────────────────────────────────────────────┘`,
      ].filter(l => l !== '').join('\n');

      return [
        `✅ **Session saved**${durationStr}`,
        ``,
        `📋 **Summary:** ${summary}`,
        files_changed.length > 0 ? `📁 **Files changed:** ${files_changed.map(f => `\`${f}\``).join(', ')}` : '',
        lessons_learned !== undefined ? `🧠 **Lessons stored:** ${lessons_learned}` : '',
        autoLearned.length > 0 ? `🤖 **Auto-learned:** ${autoLearned.length} lessons extracted from summary (${autoLearned.slice(0, 3).map(t => `\`${t}\``).join(', ')}${autoLearned.length > 3 ? '…' : ''})` : '',
        ambientLearned.length > 0 ? `🌿 **Ambient git learning:** ${ambientLearned.length} commit${ambientLearned.length > 1 ? 's' : ''} auto-learned (${ambientLearned.slice(0, 3).map(t => `\`${t}\``).join(', ')}${ambientLearned.length > 3 ? '…' : ''})` : '',
        sessionCard,
        ``,
        `💡 Next session: \`session_start(focus="...")\` to see this summary.`,
      ].filter(l => l !== '').join('\n');
    }

    // ── session_ping — lightweight checkpoint ─────────────────────────────────
    case 'session_ping': {
      const {
        instance_id,
        task,
        files_touched = [],
        next_step = '',
        provider = '',
      } = args as {
        instance_id: string;
        task: string;
        files_touched?: string[];
        next_step?: string;
        provider?: string;
      };

      const redis = await getConnection(instance_id);
      const checkpoint = {
        ts: new Date().toISOString(),
        task,
        files_touched,
        next_step,
        provider,
      };

      // Store as the latest checkpoint — session_start reads this when no session_end found
      await redis.set('cachly:session:checkpoint', JSON.stringify(checkpoint), 'EX', 86400 * 3); // 3-day TTL

      // Also keep a short rolling log (last 20 checkpoints for history)
      await redis.lpush('cachly:session:checkpoint:log', JSON.stringify(checkpoint));
      await redis.ltrim('cachly:session:checkpoint:log', 0, 19);

      const providerStr = provider ? ` [${provider}]` : '';
      const filesStr = files_touched.length > 0 ? ` · ${files_touched.length} file${files_touched.length > 1 ? 's' : ''} touched` : '';
      const nextStr = next_step ? `\n📍 **Next step:** ${next_step}` : '';

      return [
        `📌 **Checkpoint saved**${providerStr} — ${new Date().toLocaleTimeString()}`,
        `🔨 **Working on:** ${task}${filesStr}`,
        nextStr,
        ``,
        `💡 If you switch providers, \`session_start\` will show this checkpoint automatically.`,
      ].filter(l => l !== '').join('\n');
    }

    // ── session_handoff — cross-window continuity ─────────────────────────────
    case 'session_handoff': {
      const {
        instance_id,
        completed_tasks = [],
        remaining_tasks = [],
        files_changed = [],
        instructions = '',
        context_summary = '',
        blocked_on = '',
      } = args as {
        instance_id: string;
        completed_tasks: string[];
        remaining_tasks: string[];
        files_changed?: { path: string; status: string; description?: string }[];
        instructions?: string;
        context_summary?: string;
        blocked_on?: string;
      };

      const redis = await getConnection(instance_id);
      const now = new Date();

      const handoff = {
        ts: now.toISOString(),
        completed_tasks,
        remaining_tasks,
        files_changed,
        instructions,
        context_summary,
        blocked_on,
      };

      // Store handoff — never expires until next handoff overwrites it
      await redis.set('cachly:session:handoff', JSON.stringify(handoff));

      // Also append to history
      await redis.lpush('cachly:session:handoff:history', JSON.stringify(handoff));
      await redis.ltrim('cachly:session:handoff:history', 0, 19);

      const totalTasks = completed_tasks.length + remaining_tasks.length;
      const pct = totalTasks > 0 ? Math.round((completed_tasks.length / totalTasks) * 100) : 0;
      const brokenFiles = files_changed.filter(f => f.status === 'broken' || f.status === 'partial');

      return [
        `🤝 **Handoff saved** — ${completed_tasks.length}/${totalTasks} tasks done (${pct}%)`,
        ``,
        completed_tasks.length > 0 ? `✅ **Completed:**\n${completed_tasks.map(t => `  - ${t}`).join('\n')}` : '',
        remaining_tasks.length > 0 ? `\n⏳ **Remaining for next window:**\n${remaining_tasks.map(t => `  - ${t}`).join('\n')}` : '',
        brokenFiles.length > 0 ? `\n⚠️ **Needs attention:** ${brokenFiles.map(f => `\`${f.path}\` (${f.status})`).join(', ')}` : '',
        blocked_on ? `\n🚫 **Blocked on:** ${blocked_on}` : '',
        instructions ? `\n📝 **Instructions:** ${instructions}` : '',
        ``,
        `💡 The next \`session_start\` will include this handoff automatically.`,
      ].filter(l => l !== '').join('\n');
    }

    // ── auto_learn_session ────────────────────────────────────────────────────
    case 'auto_learn_session': {
      const { instance_id, observations } = args as {
        instance_id: string;
        observations: { action: string; outcome: string; details?: string; topic?: string; severity?: string }[];
      };
      const redis = await getConnection(instance_id);
      const stored: string[] = [];
      const skipped: string[] = [];

      for (const obs of observations) {
        // Auto-generate topic from action if not provided
        const rawTopic = obs.topic ?? obs.action
          .toLowerCase()
          .replace(/[^a-z0-9:\-_\s]/g, '')
          .trim()
          .split(/\s+/)
          .slice(0, 4)
          .join('-');
        const topic = rawTopic.includes(':') ? rawTopic : `auto:${rawTopic}`;
        const key = `cachly:lesson:best:${topic}`;

        // Only overwrite if this is a success and existing is failure, or topic is new
        const existing = await redis.get(key);
        if (existing) {
          const existingLesson = JSON.parse(existing) as { outcome: string };
          if (existingLesson.outcome === 'success' && obs.outcome !== 'success') {
            skipped.push(topic);
            continue;
          }
        }

        const lesson = {
          topic,
          outcome: obs.outcome,
          what_worked: obs.outcome === 'success' ? obs.action : (obs.details ?? obs.action),
          what_failed: obs.outcome === 'failure' ? obs.action : undefined,
          context: obs.details,
          severity: obs.severity ?? 'minor',
          ts: new Date().toISOString(),
          recall_count: 0,
          auto_learned: true,
          version: 2,
        };

        await redis.set(key, JSON.stringify(lesson));
        stored.push(`${obs.outcome === 'success' ? '✅' : obs.outcome === 'partial' ? '⚠️' : '❌'} \`${topic}\``);
      }

      const lines = [
        `🤖 **Auto-learn complete**: ${stored.length} stored, ${skipped.length} skipped`,
        '',
      ];
      if (stored.length > 0) lines.push('**Stored:**', ...stored.map(s => '  ' + s), '');
      if (skipped.length > 0) lines.push(`**Skipped** (better lesson already exists): ${skipped.map(t => `\`${t}\``).join(', ')}`);
      return lines.join('\n');
    }

    // ── sync_file_changes ─────────────────────────────────────────────────────

    default:
      return null;
  }
}
