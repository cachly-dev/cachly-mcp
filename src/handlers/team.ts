import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import { calculateConfidence, CONFIDENCE_STALE_VALUE, CONFIDENCE_WARN_VALUE,
         CONFIDENCE_WARN_DAYS, CONFIDENCE_STALE_DAYS } from '../confidence.js';
import type { Instance } from './brain.js';
import { safeJsonParse } from '../utils.js';

type GetConnection = (instanceId: string) => Promise<Redis>;
type ApiFetch = <T>(path: string, options?: RequestInit) => Promise<T>;

export const TEAM_TOOL_NAMES = new Set([
  'sync_file_changes', 'team_learn', 'team_confirm', 'team_recall', 'team_synthesize', 'memory_crystalize', 'team_crystallize',
  'brain_doctor', 'recall_at', 'trace_dependency', 'global_learn', 'global_recall',
  'publish_lesson', 'import_public_brain', 'setup_ai_memory',
  'team_assign_role', 'team_whoami', 'team_roster',
  'team_grant_scope', 'team_scopes', 'team_audit',
]);

// ── Role model helpers ────────────────────────────────────────────────────────
// Roles: admin > reviewer > contributor > viewer
// Stored in a Redis hash: cachly:team:roles:{instance_id}  →  handle → role

export type TeamRole = 'admin' | 'reviewer' | 'contributor' | 'viewer';

const ROLE_RANK: Record<TeamRole, number> = {
  admin: 4, reviewer: 3, contributor: 2, viewer: 1,
};

export const ROLE_BADGE: Record<TeamRole, string> = {
  admin: '👑', reviewer: '🛡️', contributor: '✏️', viewer: '👁️',
};

const ROLE_CAPABILITIES: Record<TeamRole, string> = {
  admin:       'assign roles · delete lessons · all reviewer + contributor actions',
  reviewer:    'senior-review lessons (🛡️) · all contributor actions',
  contributor: 'store lessons · peer-review lessons (✔️) · recall',
  viewer:      'recall only — cannot store or review lessons',
};

export const ROLES_KEY = (instanceId: string) => `cachly:team:roles:${instanceId}`;

export async function getRole(redis: import('ioredis').Redis, instanceId: string, handle: string): Promise<TeamRole | null> {
  const raw = await redis.hget(ROLES_KEY(instanceId), handle.toLowerCase()).catch(() => null);
  return (raw as TeamRole | null);
}

/** True when `actorRole` is at least as powerful as `requiredRole`. */
export function hasPermission(actorRole: TeamRole | null, required: TeamRole): boolean {
  if (!actorRole) return false;
  return (ROLE_RANK[actorRole] ?? 0) >= (ROLE_RANK[required] ?? 0);
}

/** The review level a role warrants in team_confirm. */
export function roleToReviewLevel(role: TeamRole | null): 'senior' | 'peer' {
  return role === 'admin' || role === 'reviewer' ? 'senior' : 'peer';
}

// ── RBAC enforcement (W6) ──────────────────────────────────────────────────────
// Governance "activates" once an admin is bootstrapped on a brain (the same
// signal team_assign_role uses). Before that, the team is open and every tool
// behaves exactly as before — so existing single-user and small-team flows are
// untouched. Once an admin exists, write/review tools enforce role minimums.

/** True once at least one admin exists — i.e. governance has been turned on. */
export async function rbacActive(redis: import('ioredis').Redis, instanceId: string): Promise<boolean> {
  const allRoles = await redis.hgetall(ROLES_KEY(instanceId)).catch(() => ({} as Record<string, string>));
  return Object.values(allRoles).includes('admin');
}

/**
 * Enforce that `handle` holds at least `required` — but only when governance is
 * active. Returns null when the action is permitted, or a clear refusal message
 * (never throws — a denied write must not break the agent call). `action` is a
 * short human phrase, e.g. "store team lessons".
 */
export async function requireRole(
  redis: import('ioredis').Redis,
  instanceId: string,
  handle: string,
  required: TeamRole,
  action: string,
): Promise<string | null> {
  if (!(await rbacActive(redis, instanceId))) return null; // open team — allow
  const role = handle ? await getRole(redis, instanceId, handle) : null;
  if (hasPermission(role, required)) return null;
  const have = role ? `${ROLE_BADGE[role]} ${role}` : 'no role';
  return [
    `🔒 **Permission denied** — to ${action} you need at least \`${required}\` ${ROLE_BADGE[required]} (you have: ${have}).`,
    ``,
    `Ask an admin to grant it:`,
    `\`team_assign_role(instance_id="${instanceId}", handle="${handle || '<your-handle>'}", role="${required}", assigned_by="<admin>")\``,
    `_Governance is active on this brain. Run \`team_whoami\` to check your role._`,
  ].join('\n');
}

/** Append an immutable governance-audit entry (role changes, gated actions). */
export async function auditLog(
  redis: import('ioredis').Redis,
  instanceId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const key = `cachly:team:audit:${instanceId}`;
  const rec = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  await redis.rpush(key, rec).catch(() => {});
  await redis.ltrim(key, -500, -1).catch(() => {});
  await redis.expire(key, 365 * 2 * 86400).catch(() => {}); // 2-year retention
}

// ── Team-level visibility scopes (groups) ─────────────────────────────────────
// A named sub-team (e.g. "backend", "security"). Lessons can be scoped to a group
// via `group` on learn_from_attempts; they then only surface in recall for members
// of that group (admins see everything). Orthogonal to lesson-level `private`.
//   cachly:team:groups:{instance}            → set of group names
//   cachly:team:group:{instance}:{group}     → set of member handles

export const GROUPS_INDEX_KEY = (instanceId: string) => `cachly:team:groups:${instanceId}`;
export const GROUP_KEY = (instanceId: string, group: string) =>
  `cachly:team:group:${instanceId}:${group.toLowerCase()}`;

/** Return the set of group names `handle` belongs to (lower-cased). */
export async function getScopes(redis: import('ioredis').Redis, instanceId: string, handle: string): Promise<Set<string>> {
  const groups = await redis.smembers(GROUPS_INDEX_KEY(instanceId)).catch(() => [] as string[]);
  const out = new Set<string>();
  for (const g of groups) {
    const isMember = await redis.sismember(GROUP_KEY(instanceId, g), handle.toLowerCase()).catch(() => 0);
    if (isMember) out.add(g.toLowerCase());
  }
  return out;
}

/**
 * Can a requester (with `requesterScopes`, possibly admin) see a lesson scoped to
 * `lessonGroup`? Team-wide lessons (no group) are always visible; group-scoped
 * lessons require membership. Admins see everything. Pure + testable.
 */
export function lessonVisibleToScope(
  lessonGroup: string | undefined | null,
  requesterScopes: Set<string>,
  isAdmin: boolean,
): boolean {
  if (!lessonGroup) return true;
  if (isAdmin) return true;
  return requesterScopes.has(lessonGroup.toLowerCase());
}

export async function handleTeamTool(
  name: string,
  args: Record<string, unknown>,
  getConnection: GetConnection,
  apiFetch: ApiFetch,
): Promise<string | null> {
  switch (name) {
    case 'sync_file_changes': {
      const { instance_id, changed_files, git_diff_stat, commit_msg } = args as {
        instance_id: string;
        changed_files: string[];
        git_diff_stat?: string;
        commit_msg?: string;
      };
      const redis = await getConnection(instance_id);

      // Store file change event in session history
      const changeRecord = {
        ts: new Date().toISOString(),
        files: changed_files,
        commit_msg,
        diff_stat: git_diff_stat?.slice(0, 500),
      };
      await redis.lpush('cachly:session:file_changes', JSON.stringify(changeRecord));
      await redis.ltrim('cachly:session:file_changes', 0, 99);
      await redis.expire('cachly:session:file_changes', 30 * 86400);

      // Find lessons relevant to the changed files
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      type Lesson = { topic: string; what_worked: string; outcome: string; file_paths?: string[] };
      const relevant: string[] = [];
      const sfRaws = lessonKeys.length > 0 ? await redis.mget(...lessonKeys) : [];
      for (const raw of sfRaws) {
        if (!raw) continue;
        const lesson = safeJsonParse<Lesson | null>(raw, null);
        if (!lesson) continue;
        // Match by file_paths stored in lesson OR by topic keywords matching file name
        const topicWords = lesson.topic.toLowerCase().split(/[:\-_]/);
        const fileMatches = changed_files.some(f => {
          const fname = f.split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase() ?? '';
          return topicWords.some(w => w.length > 3 && fname.includes(w))
            || (lesson.file_paths ?? []).some(lf => f.includes(lf) || lf.includes(f));
        });
        if (fileMatches) {
          const emoji = lesson.outcome === 'success' ? '✅' : '⚠️';
          relevant.push(`  ${emoji} \`${lesson.topic}\` — ${lesson.what_worked.slice(0, 80)}`);
        }
      }

      const lines = [
        `📁 **File sync recorded**: ${changed_files.length} files`,
        commit_msg ? `📝 Commit: "${commit_msg}"` : '',
        '',
        `**Changed:** ${changed_files.slice(0, 8).map(f => `\`${f}\``).join(', ')}${changed_files.length > 8 ? ` +${changed_files.length - 8} more` : ''}`,
        '',
      ];
      if (relevant.length > 0) {
        lines.push(`🧠 **Relevant brain lessons (${relevant.length}):**`, ...relevant);
      } else {
        lines.push(`💡 No existing lessons match these files yet. Add them with \`learn_from_attempts\`.`);
      }
      return lines.filter(Boolean).join('\n');
    }

    // ── team_learn ────────────────────────────────────────────────────────────
    case 'team_learn': {
      const { instance_id, author, topic, outcome, what_worked, what_failed, severity, file_paths, commands, tags } = args as {
        instance_id: string; author: string; topic: string; outcome: string;
        what_worked: string; what_failed?: string; severity?: string;
        file_paths?: string[]; commands?: string[]; tags?: string[];
      };
      if (!author || !topic || !outcome || !what_worked) {
        return '❌ Required: author, topic, outcome, what_worked';
      }
      const iid = instance_id;
      if (!iid) return '❌ instance_id required';

      // W6 enforcement: once governance is active, a viewer (recall-only) cannot
      // store team lessons — contributor+ required. Open teams are unaffected.
      const redisTL = await getConnection(iid);
      const learnDenied = await requireRole(redisTL, iid, author, 'contributor', 'store team lessons');
      if (learnDenied) return learnDenied;

      // Store with author attribution via the same learn_from_attempts Redis structure
      const lesson = {
        topic, outcome, what_worked,
        what_failed: what_failed ?? '',
        severity: severity ?? 'minor',
        author,
        file_paths: file_paths ?? [],
        commands: commands ?? [],
        tags: [...(tags ?? []), 'team'],
        timestamp: new Date().toISOString(),
        recall_count: 0,
        version: 2,
      };

      const key = `cachly:lessons:${topic}`;
      await redisTL.rpush(key, JSON.stringify(lesson));
      if (outcome === 'success') {
        await redisTL.set(`cachly:lesson:best:${topic}`, JSON.stringify(lesson));
      }

      return `✅ Team lesson stored by **${author}**: \`${topic}\` (${outcome})\n💡 ${what_worked.slice(0, 120)}`;
    }

    // ── team_confirm — knowledge governance (Phase 3) ─────────────────────────
    // A human reviewer endorses a stored lesson. The endorsement raises the
    // lesson's recall ranking (see src/rerank.ts), so trusted, reviewed knowledge
    // surfaces above unreviewed auto-learned entries.
    case 'team_confirm': {
      const { instance_id, topic, reviewer, level, note = '' } = args as {
        instance_id: string; topic: string; reviewer: string;
        level?: 'senior' | 'peer'; note?: string;
      };
      if (!instance_id) return '❌ instance_id required';
      if (!topic || !reviewer) return '❌ Required: topic, reviewer';
      const redis = await getConnection(instance_id);
      // W6 enforcement: once governance is active, only reviewer+ may confirm
      // lessons (vision: "nur reviewer dürfen team_confirm"). Open teams are
      // unaffected. A denied confirm returns guidance, never throws.
      const confirmDenied = await requireRole(redis, instance_id, reviewer, 'reviewer', 'confirm team lessons');
      if (confirmDenied) return confirmDenied;
      // Role-aware review level: if the reviewer has an assigned role, that determines
      // weight (admin/reviewer → senior, contributor → peer). The caller can still
      // pass `level` explicitly to override (e.g. a guest reviewer without a role).
      // This prevents self-promotion — you can't claim senior by just passing level="senior".
      const assignedRole = await getRole(redis, instance_id, reviewer);
      const autoLevel = roleToReviewLevel(assignedRole);
      // If the caller explicitly asked for 'peer' on a senior-role reviewer,
      // honour that (downgrade is allowed; upgrade is not — unless they have the role).
      const reviewLevel: 'senior' | 'peer' =
        level === 'peer' ? 'peer'
        : level === 'senior' && hasPermission(assignedRole, 'reviewer') ? 'senior'
        : autoLevel;
      const roleNote = assignedRole
        ? ` (role: ${ROLE_BADGE[assignedRole]} ${assignedRole})`
        : ` (no role assigned — peer weight applied)`;

      const key = `cachly:lesson:best:${topic}`;
      const raw = await redis.get(key);
      const lesson = safeJsonParse<Record<string, unknown> | null>(raw, null);
      if (!lesson) {
        return `📭 No best-solution lesson found for \`${topic}\`.\n\nA lesson must exist (store one with \`team_learn\` / \`learn_from_attempts\`) before it can be confirmed.`;
      }

      // Track distinct reviewers so endorsements can't be inflated by one person.
      const endorsersKey = `cachly:lesson:endorsers:${topic}`;
      const isNewEndorser = (await redis.sadd(endorsersKey, reviewer)) === 1;
      await redis.expire(endorsersKey, 365 * 86400);
      const endorsements = await redis.scard(endorsersKey);

      // Senior beats peer; never downgrade an existing senior review to peer.
      const prevLevel = (lesson.review_level as string) ?? '';
      const effectiveLevel = prevLevel === 'senior' ? 'senior' : reviewLevel;

      const updated = {
        ...lesson,
        reviewed_by: reviewer,
        review_level: effectiveLevel,
        endorsements,
        reviewed_at: new Date().toISOString(),
      };
      await redis.set(key, JSON.stringify(updated));

      // Append an immutable review record for the audit trail.
      const reviewLog = {
        reviewer, level: reviewLevel, note: note.slice(0, 280), ts: new Date().toISOString(),
      };
      const logKey = `cachly:lesson:reviews:${topic}`;
      await redis.rpush(logKey, JSON.stringify(reviewLog));
      await redis.ltrim(logKey, -50, -1);
      await redis.expire(logKey, 365 * 86400);

      // Governance audit trail (W6): every confirm is recorded brain-wide so an
      // admin can answer "who endorsed what, and when" for compliance.
      await auditLog(redis, instance_id, {
        action: 'team_confirm', actor: reviewer, topic, level: effectiveLevel,
      });

      const badge = effectiveLevel === 'senior' ? '🛡️ senior-reviewed' : '✔️ peer-reviewed';
      const alreadyNote = isNewEndorser ? '' : ` (already endorsed by ${reviewer} — no change to rank)`;
      return `${badge} — \`${topic}\` confirmed by **${reviewer}**${roleNote} (${endorsements} distinct endorsement${endorsements === 1 ? '' : 's'})${alreadyNote}.\n📈 This lesson now ranks higher in \`smart_recall\` / \`team_recall\`.${note ? `\n📝 ${note.slice(0, 200)}` : ''}`;
    }

    // ── team_recall ───────────────────────────────────────────────────────────
    case 'team_recall': {
      const { instance_id, topic, author, limit = 10 } = args as {
        instance_id: string;
        topic?: string;
        author?: string;
        limit?: number;
      };
      const redis = await getConnection(instance_id);

      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      type TeamLesson = {
        topic: string; outcome: string; what_worked: string;
        ts: string; severity?: string; recall_count?: number;
        author?: string; tags?: string[];
        reviewed_by?: string; review_level?: string; endorsements?: number;
      };
      let lessons: TeamLesson[] = [];
      if (lessonKeys.length > 0) {
        const raws = await redis.mget(...lessonKeys);
        for (const raw of raws) {
          const l = safeJsonParse<TeamLesson | null>(raw ?? null, null);
          if (l) lessons.push(l);
        }
      }

      // Filter
      if (topic) {
        const t = topic.toLowerCase();
        lessons = lessons.filter(l =>
          l.topic.toLowerCase().includes(t) ||
          (l.tags ?? []).some((tag: string) => tag.toLowerCase().includes(t))
        );
      }
      if (author) {
        const a = author.toLowerCase();
        lessons = lessons.filter(l => l.author?.toLowerCase().includes(a));
      }

      // Sort: reviewed lessons first (senior > peer), then by recall_count desc.
      const reviewRank = (l: TeamLesson) => l.reviewed_by ? (l.review_level === 'senior' ? 2 : 1) : 0;
      lessons.sort((a, b) =>
        (reviewRank(b) - reviewRank(a)) || ((b.recall_count ?? 0) - (a.recall_count ?? 0)));
      lessons = lessons.slice(0, limit);

      if (lessons.length === 0) {
        return topic
          ? `📭 No team lessons found for \`${topic}\`.\n\nShared instance: add lessons with \`learn_from_attempts\` and include an \`author\` field.`
          : `📭 No lessons in this brain yet.\n\nAll team members sharing this instance will see lessons here.`;
      }

      const lines = [`👥 **Team Brain** — ${lessons.length} lesson${lessons.length > 1 ? 's' : ''}`, ''];
      for (const l of lessons) {
        const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
        const sev = l.severity === 'critical' ? '🔴 ' : l.severity === 'major' ? '🟡 ' : '';
        const reviewBadge = l.reviewed_by
          ? (l.review_level === 'senior' ? ' 🛡️' : ' ✔️')
          : '';
        const authorStr = l.author ? ` · _by ${l.author}_` : '';
        const reviewStr = l.reviewed_by
          ? ` · reviewed by ${l.reviewed_by}${(l.endorsements ?? 0) > 1 ? ` +${(l.endorsements ?? 0) - 1}` : ''}`
          : '';
        const recallStr = (l.recall_count ?? 0) > 0 ? ` · recalled ${l.recall_count}×` : '';
        const ago = Math.round((Date.now() - new Date(l.ts).getTime()) / 86400000);
        const agoStr = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago}d ago`;
        lines.push(`${emoji} ${sev}**\`${l.topic}\`**${reviewBadge}${authorStr}${reviewStr}${recallStr} · ${agoStr}`);
        lines.push(`   ${l.what_worked.slice(0, 120)}`);
        lines.push('');
      }
      return lines.join('\n');
    }

    // ── team_synthesize — Team Brain Synthesis ────────────────────────────────
    case 'team_synthesize': {
      const { instance_id, topic } = args as { instance_id: string; topic: string };
      const redis = await getConnection(instance_id);

      // Load history list for this topic (all authors' contributions)
      const listKey = `cachly:lessons:${topic}`;
      const all = await redis.lrange(listKey, 0, -1);
      if (all.length < 2) {
        return `📭 Need at least 2 entries for topic \`${topic}\` to synthesize.\n\nCurrently: ${all.length} entr${all.length === 1 ? 'y' : 'ies'}.\n\nHave team members store lessons via \`learn_from_attempts(topic="${topic}", ...)\`.`;
      }

      type Entry = { outcome: string; what_worked: string; what_failed?: string; author?: string; ts: string; severity?: string };
      const entries: Entry[] = all.map(r => { try { return JSON.parse(r) as Entry; } catch { return null; } }).filter((e): e is Entry => e !== null);

      // Group by outcome
      const successes = entries.filter(e => e.outcome === 'success');
      const failures  = entries.filter(e => e.outcome === 'failure');
      const partials  = entries.filter(e => e.outcome === 'partial');

      const authors = [...new Set(entries.map(e => e.author).filter(Boolean))];
      const hasMultiAuthor = authors.length > 1;

      // Build canonical merged version
      // what_worked: pick the most recent success, or longest for most detail
      const bestSuccess = successes.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())[0];
      const whatWorkedCandidates = successes.map(e => e.what_worked).filter(w => w && w.length > 10);
      const canonicalWorked = whatWorkedCandidates.sort((a, b) => b.length - a.length)[0] ?? bestSuccess?.what_worked ?? '';

      // what_failed: union of all unique failure reasons
      const allFailed = [...new Set(
        [...failures, ...partials].map(e => e.what_failed).filter((w): w is string => !!w && w.length > 5)
      )];

      const severities = entries.map(e => e.severity).filter(Boolean);
      const canonicalSeverity = severities.includes('critical') ? 'critical' : severities.includes('major') ? 'major' : 'minor';

      const lines = [
        `🧬 **Team Brain Synthesis: \`${topic}\`**`,
        `_${entries.length} entries from ${authors.length} author${authors.length === 1 ? '' : 's'}${hasMultiAuthor ? ` (${authors.join(', ')})` : ''} · ${successes.length} success · ${failures.length} failure · ${partials.length} partial_`,
        '',
        `**Canonical "what worked":**`,
        `> ${canonicalWorked}`,
        '',
        allFailed.length > 0 ? `**Avoid (combined failures):**` : '',
        ...allFailed.map(f => `> ❌ ${f}`),
        allFailed.length > 0 ? '' : '',
        `**Suggested canonical lesson:**`,
        '```',
        `learn_from_attempts(`,
        `  topic       = "${topic}",`,
        `  outcome     = "success",`,
        `  what_worked = "${canonicalWorked.replace(/"/g, "'")}",`,
        allFailed.length > 0 ? `  what_failed = "${allFailed[0].replace(/"/g, "'")}",` : '',
        `  severity    = "${canonicalSeverity}",`,
        `)`,
        '```',
        '',
        hasMultiAuthor
          ? `💡 _${authors.length} team members contributed to this synthesis. Store the canonical version to replace individual entries._`
          : `💡 _Single author — more value when multiple team members contribute to the same topic._`,
      ].filter(l => l !== undefined).join('\n');
      return lines;
    }

    // ── brain_doctor ──────────────────────────────────────────────────────────
    // ── memory_crystalize ─────────────────────────────────────────────────────
    case 'memory_crystalize': {
      const { instance_id, label: crystalLabel = '' } = args as { instance_id: string; label?: string };
      const redis = await getConnection(instance_id);
      const now = new Date();
      const week = `${now.getFullYear()}-W${String(Math.ceil((now.getDate() - now.getDay() + 10) / 7)).padStart(2, '0')}`;
      const effectiveLabel = crystalLabel || `${now.toISOString().slice(0, 7)} Crystal`;

      // Read session history
      const sessionHistory = await redis.lrange('cachly:session:history', 0, 49);

      // Read all auto-learned lessons
      const allLessonKeys: string[] = [];
      const ls = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((res, rej) => {
        ls.on('data', (b: string[]) => allLessonKeys.push(...b));
        ls.on('end', res);
        ls.on('error', rej);
      });

      type RawLesson = { topic: string; outcome: string; what_worked: string; severity?: string; ts: string; auto_learned?: boolean };
      const allLessons: RawLesson[] = [];
      if (allLessonKeys.length > 0) {
        const raws = await redis.mget(...allLessonKeys);
        for (const raw of raws) {
          const l = safeJsonParse<RawLesson | null>(raw ?? null, null);
          if (l) allLessons.push(l);
        }
      }

      // Group lessons by top-level category
      const categoryMap = new Map<string, RawLesson[]>();
      for (const l of allLessons) {
        const cat = l.topic.split(':')[0] || 'misc';
        if (!categoryMap.has(cat)) categoryMap.set(cat, []);
        categoryMap.get(cat)!.push(l);
      }

      // Build top patterns (most frequent categories with a representative insight)
      const topPatterns: Array<{ category: string; insight: string; count: number }> = [];
      for (const [cat, catLessons] of [...categoryMap.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
        const successLessons = catLessons.filter(l => l.outcome === 'success');
        const best = successLessons[0] ?? catLessons[0];
        if (!best) continue;
        topPatterns.push({
          category: cat,
          insight: best.what_worked.slice(0, 120),
          count: catLessons.length,
        });
      }

      const crystal = {
        label: effectiveLabel,
        ts: now.toISOString(),
        session_count: sessionHistory.length,
        lesson_count: allLessons.length,
        top_patterns: topPatterns,
        categories: [...categoryMap.keys()],
        created_from: `${sessionHistory.length} sessions, ${allLessons.length} lessons`,
      };

      const crystalJson = JSON.stringify(crystal);
      await redis.set('cachly:crystal:latest', crystalJson);
      await redis.expire('cachly:crystal:latest', 90 * 86400);
      await redis.set(`cachly:crystal:${week}`, crystalJson);
      await redis.expire(`cachly:crystal:${week}`, 365 * 86400);

      const lines = [
        `💎 **Memory Crystal created: ${effectiveLabel}**`,
        ``,
        `📊 Compressed: **${sessionHistory.length} sessions** + **${allLessons.length} lessons** → ${topPatterns.length} top patterns`,
        ``,
        `**Top patterns by category:**`,
        ...topPatterns.slice(0, 6).map(p => `  • **${p.category}** (${p.count}×): ${p.insight.slice(0, 90)}`),
        ``,
        `💡 This crystal will appear in every future \`session_start\` briefing.`,
        `💡 Re-run \`memory_crystalize\` monthly to keep it fresh.`,
      ];
      return lines.join('\n');
    }

    // ── team_crystallize (W8) ───────────────────────────────────────────────────
    // The team-wide, causal counter to per-user "Dreaming". Where memory_crystalize
    // compresses ONE brain by category, team_crystallize surfaces what a single-user
    // background process structurally cannot: which fixes solved structurally
    // SIMILAR problems across MULTIPLE people. A pattern only crystallizes when ≥2
    // distinct authors converged on it — that cross-person signal is the moat.
    case 'team_crystallize': {
      const { instance_id, min_authors = 2, label: tcLabel = '' } = args as {
        instance_id: string; min_authors?: number; label?: string;
      };
      const redis = await getConnection(instance_id);
      const now = new Date();
      const minAuthors = Math.max(2, Number(min_authors) || 2);

      // Load every best-lesson with its author + tags (the cross-person signal).
      const keys: string[] = [];
      const stream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((res, rej) => {
        stream.on('data', (b: string[]) => keys.push(...b));
        stream.on('end', res);
        stream.on('error', rej);
      });

      type TCLesson = {
        topic: string; outcome: string; what_worked: string; severity?: string;
        author?: string; tags?: string[]; confirm_count?: number; endorsements?: number;
        review_level?: string; ts?: string;
      };
      const lessons: TCLesson[] = [];
      if (keys.length > 0) {
        const raws = await redis.mget(...keys);
        for (const raw of raws) {
          const l = safeJsonParse<TCLesson | null>(raw ?? null, null);
          if (l && l.outcome === 'success' && l.author) lessons.push(l);
        }
      }

      // Derive a structural "concept key" for each lesson: the topic namespace plus
      // its most significant problem token, so "db:pool-exhaustion" and
      // "payments:connection-pool" can converge via the shared "pool" concept.
      const STOP = new Set(['the','and','for','with','from','that','this','fix','bug','error','issue','use','via','add','set','team']);
      const conceptOf = (l: TCLesson): string => {
        const [ns, ...rest] = l.topic.split(':');
        // Tags are deliberate concept markers — two people who both tag a lesson
        // "pool" intend the same concept even when their topics differ. Prefer a
        // shared, intentional tag over a topic-derived token. Alphabetically-first
        // significant tag keeps the choice deterministic across authors.
        const sigTags = (l.tags ?? [])
          .map(t => t.toLowerCase().trim())
          .filter(t => t.length > 3 && !STOP.has(t))
          .sort();
        if (sigTags.length > 0) return sigTags[0];
        // No usable tag — fall back to the longest topic-tail token.
        const tail = rest.join('-').toLowerCase();
        const tokens = tail.replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/)
          .filter(t => t.length > 3 && !STOP.has(t));
        return tokens.sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? ns;
      };

      type Cluster = {
        concept: string; authors: Set<string>; lessons: TCLesson[];
        namespaces: Set<string>; bestFix: TCLesson;
      };
      const clusters = new Map<string, Cluster>();
      for (const l of lessons) {
        const concept = conceptOf(l);
        let c = clusters.get(concept);
        if (!c) {
          c = { concept, authors: new Set(), lessons: [], namespaces: new Set(), bestFix: l };
          clusters.set(concept, c);
        }
        c.authors.add(l.author!.toLowerCase());
        c.lessons.push(l);
        c.namespaces.add(l.topic.split(':')[0] || 'misc');
        // Best fix = highest community trust (endorsements > confirm_count), senior-reviewed wins ties.
        const score = (x: TCLesson) => (x.endorsements ?? 0) * 10 + (x.confirm_count ?? 0) + (x.review_level === 'senior' ? 5 : 0);
        if (score(l) > score(c.bestFix)) c.bestFix = l;
      }

      // A pattern crystallizes only when enough DISTINCT people converged on it.
      const crossPerson = [...clusters.values()]
        .filter(c => c.authors.size >= minAuthors)
        .sort((a, b) => (b.authors.size - a.authors.size) || (b.lessons.length - a.lessons.length));

      const patterns = crossPerson.slice(0, 10).map(c => ({
        concept: c.concept,
        author_count: c.authors.size,
        authors: [...c.authors],
        lesson_count: c.lessons.length,
        spans: [...c.namespaces],
        convergent_fix: c.bestFix.what_worked.slice(0, 200),
        fix_topic: c.bestFix.topic,
      }));

      // Persist the team crystal alongside (not overwriting) the per-brain crystal.
      const effectiveLabel = tcLabel || `${now.toISOString().slice(0, 7)} Team Crystal`;
      const crystal = {
        label: effectiveLabel, ts: now.toISOString(), kind: 'team',
        contributors: new Set(lessons.map(l => l.author!.toLowerCase())).size,
        analysed: lessons.length, patterns,
      };
      await redis.set('cachly:crystal:team:latest', JSON.stringify(crystal));
      await redis.expire('cachly:crystal:team:latest', 180 * 86400);

      if (patterns.length === 0) {
        return [
          `💠 **Team Crystal — not enough cross-person convergence yet**`,
          ``,
          `Analysed **${lessons.length}** attributed success lessons from **${crystal.contributors}** contributor${crystal.contributors !== 1 ? 's' : ''}, but no concept had **${minAuthors}+ distinct authors** converge on it yet.`,
          ``,
          `This is the one thing a per-user memory can't build — it needs your team to accumulate shared, attributed lessons.`,
          `Keep using \`learn_from_attempts(author="...")\` / \`team_learn\`; re-run as the team grows.`,
        ].join('\n');
      }

      const lines = [
        `💠 **Team Crystal created: ${effectiveLabel}**`,
        ``,
        `🧬 **${patterns.length} cross-person pattern${patterns.length !== 1 ? 's' : ''}** — fixes that ${minAuthors}+ teammates independently converged on.`,
        `_Compressed from ${lessons.length} attributed lessons across ${crystal.contributors} contributors. This is the team-wide, causal layer a per-user "Dreaming" process structurally cannot produce._`,
        ``,
      ];
      for (const p of patterns.slice(0, 6)) {
        const spanNote = p.spans.length > 1 ? ` · spans ${p.spans.map(s => `\`${s}\``).join(', ')}` : '';
        lines.push(
          `### 🧩 \`${p.concept}\` — ${p.author_count} people converged${spanNote}`,
          `**Convergent fix** (from \`${p.fix_topic}\`): ${p.convergent_fix}`,
          `**Who solved it together:** ${p.authors.map(a => `@${a}`).join(', ')} _(ask them — they've each hit this)_`,
          ``,
        );
      }
      lines.push(
        `---`,
        `💡 Surfaces in \`crystal_view\` and onboarding. Re-run \`team_crystallize\` monthly.`,
      );
      return lines.join('\n');
    }

    case 'brain_doctor': {
      const { instance_id, workspace_path: drWorkspacePath = '' } = args as { instance_id: string; workspace_path?: string };
      const redis = await getConnection(instance_id);
      const issues: string[] = [];
      const checks: string[] = [];

      // Count lessons
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      // Count context
      let ctxCount = 0;
      const ctxStream = redis.scanStream({ match: 'cachly:ctx:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        ctxStream.on('data', (batch: string[]) => {
          ctxCount += batch.filter((k: string) => !k.endsWith(':meta')).length;
        });
        ctxStream.on('end', resolve);
        ctxStream.on('error', reject);
      });

      // Load lessons for analysis
      type DrLesson = {
        topic: string; outcome: string; recall_count?: number; ts: string;
        verified_at?: string; severity?: string; audit_trail?: unknown[];
      };
      const lessons: DrLesson[] = [];
      if (lessonKeys.length > 0) {
        const raws = await redis.mget(...lessonKeys);
        for (const raw of raws) {
          const l = safeJsonParse<DrLesson | null>(raw ?? null, null);
          if (l) lessons.push(l);
        }
      }

      // Last session
      const lastSessionRaw = await redis.get('cachly:session:last');
      const lastSession = safeJsonParse<{ ts: string; summary: string } | null>(lastSessionRaw, null);

      // Open failures
      const openFailures = lessons.filter(l => l.outcome === 'failure' || l.outcome === 'partial');
      // Unused lessons (never recalled)
      const unusedLessons = lessons.filter(l => (l.recall_count ?? 0) === 0);
      // Critical lessons
      const criticalLessons = lessons.filter(l => l.severity === 'critical');
      // Confidence decay analysis
      const staleLessons  = lessons.filter(l => l.outcome === 'success' && calculateConfidence(l) < CONFIDENCE_STALE_VALUE);
      const warnLessons   = lessons.filter(l => l.outcome === 'success' && calculateConfidence(l) >= CONFIDENCE_STALE_VALUE && calculateConfidence(l) < CONFIDENCE_WARN_VALUE);
      const withAudit     = lessons.filter(l => (l.audit_trail ?? []).length > 1);
      // Team lessons
      type DrLessonWithAuthor = DrLesson & { author?: string };
      const teamLessons = (lessons as DrLessonWithAuthor[]).filter(l => l.author);
      const uniqueAuthors = new Set((lessons as DrLessonWithAuthor[]).map(l => l.author).filter(Boolean));
      // Effective IQ boost: total recalls / lessons (how much the brain actually helped)
      const totalRecalls = lessons.reduce((sum, l) => sum + (l.recall_count ?? 0), 0);
      const iqBoostPct = lessons.length > 0 ? Math.min(100, Math.round((totalRecalls / lessons.length) * 10)) : 0;

      // Quality score (0-100)
      let score = 50;
      if (lessonKeys.length >= 5)  score += 10;
      if (lessonKeys.length >= 20) score += 10;
      if (ctxCount >= 3)           score += 10;
      if (ctxCount >= 10)          score += 5;
      if (lastSession)             score += 10;
      if (openFailures.length === 0) score += 5;
      const unusedRatio = lessons.length > 0 ? unusedLessons.length / lessons.length : 0;
      if (unusedRatio < 0.5)       score += 10;
      if (staleLessons.length === 0) score += 5;
      if (uniqueAuthors.size >= 2) score += 5; // team collaboration bonus

      const scoreEmoji = score >= 80 ? '🟢' : score >= 50 ? '🟡' : '🔴';
      const iqEmoji = iqBoostPct >= 50 ? '🚀' : iqBoostPct >= 20 ? '📈' : '💤';

      checks.push(`${scoreEmoji} **Brain Quality Score: ${score}/100**`);
      checks.push(`${iqEmoji} **Effective IQ Boost: ${iqBoostPct}%** (${totalRecalls} recalls across ${lessons.length} lessons)`);
      checks.push(`📚 **Lessons:** ${lessonKeys.length} (${criticalLessons.length} critical · ${withAudit.length} with audit trail · ${teamLessons.length} from team)`);
      checks.push(`💾 **Context entries:** ${ctxCount}`);
      checks.push(`🎯 **Confidence:** ${lessons.length - staleLessons.length - warnLessons.length} fresh · ${warnLessons.length} warn · ${staleLessons.length} stale`);
      checks.push(`⏱️ **Decay config:** warn after ${CONFIDENCE_WARN_DAYS}d · stale after ${CONFIDENCE_STALE_DAYS}d`);
      if (uniqueAuthors.size >= 2) {
        checks.push(`👥 **Team:** ${uniqueAuthors.size} contributors (${[...uniqueAuthors].join(', ')})`);
      }

      // Stale index detection
      try {
        const lastIndexRaw = await redis.get('cachly:index:last_run');
        if (lastIndexRaw) {
          const lastIndexAge = Math.round((Date.now() - new Date(lastIndexRaw).getTime()) / 86_400_000);
          if (lastIndexAge > 7) {
            issues.push(`🔄 Index is ${lastIndexAge}d stale — run \`index_project\` to re-sync semantic search`);
          } else {
            checks.push(`🗂️ **Semantic index:** ${lastIndexAge}d old (fresh)`);
          }
        } else {
          issues.push(`💡 No semantic index — run \`index_project(dir="<your-src>")\` to enable semantic search`);
        }
      } catch { /* non-critical */ }

      // Memory crystal status
      try {
        const crystalRaw = await redis.get('cachly:crystal:latest');
        if (crystalRaw) {
          const crystal = JSON.parse(crystalRaw) as { ts: string; label: string };
          const crystalAge = Math.round((Date.now() - new Date(crystal.ts).getTime()) / 86_400_000);
          checks.push(`💎 **Memory Crystal:** ${crystal.label} (${crystalAge}d ago)`);
          if (crystalAge > 30) issues.push(`💡 Memory Crystal is ${crystalAge}d old — re-run \`memory_crystalize\` to compress new sessions`);
        } else if (lessonKeys.length >= 10) {
          issues.push(`💡 ${lessonKeys.length} lessons but no Memory Crystal — run \`memory_crystalize\` to compress wisdom`);
        }
      } catch { /* non-critical */ }

      // openclaw cross-promo (check package.json in workspace)
      if (drWorkspacePath) {
        try {
          const pkgPath = drWorkspacePath.replace(/\/$/, '') + '/package.json';
          const pkgRaw = readFileSync(pkgPath, 'utf-8');
          const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          const hasLLMDep = ['openai', '@anthropic-ai/sdk', '@google/generative-ai', 'mistralai', 'cohere-ai'].some(d => d in allDeps);
          const hasOpenclaw = '@cachly-dev/openclaw' in allDeps;
          if (hasLLMDep && !hasOpenclaw) {
            issues.push(`💡 **openclaw missing:** you use LLM APIs (${Object.keys(allDeps).filter(d => ['openai','@anthropic-ai/sdk'].includes(d)).join(', ')}) but not \`@cachly-dev/openclaw\``);
            issues.push(`   → \`npm install @cachly-dev/openclaw\` cuts LLM costs 60–90% with 3 lines of code`);
          } else if (hasOpenclaw) {
            checks.push(`✅ **@cachly-dev/openclaw installed** (LLM cost caching active)`);
          }
        } catch { /* no package.json or unreadable */ }
      }

      if (lastSession) {
        const ageMin = Math.round((Date.now() - new Date(lastSession.ts).getTime()) / 60000);
        const ageStr = ageMin < 60 ? `${ageMin}m` : ageMin < 1440 ? `${Math.round(ageMin / 60)}h` : `${Math.round(ageMin / 1440)}d`;
        checks.push(`🕐 **Last session:** ${ageStr} ago`);
      } else {
        issues.push('❌ No session history — call `session_start` + `session_end` to start tracking');
      }

      if (lessonKeys.length === 0) {
        issues.push('❌ No lessons — call `learn_from_attempts` after solving bugs');
      } else if (lessonKeys.length < 5) {
        issues.push(`💡 Only ${lessonKeys.length} lessons — add more after each problem solved`);
      }

      if (iqBoostPct === 0 && lessons.length >= 5) {
        issues.push(`💤 **IQ Boost is 0%** — lessons exist but are never recalled. Use \`recall_best_solution\` BEFORE tasks.`);
      }

      if (ctxCount === 0) {
        issues.push('💡 No context — use `remember_context` to cache architecture docs, ADRs, etc.');
      }

      if (openFailures.length > 0) {
        issues.push(`⚠️ ${openFailures.length} unresolved failure${openFailures.length > 1 ? 's' : ''}: ${openFailures.slice(0, 3).map(l => `\`${l.topic}\``).join(', ')}`);
      }

      if (staleLessons.length > 0) {
        issues.push(`🔴 ${staleLessons.length} STALE lesson${staleLessons.length > 1 ? 's' : ''} (>${CONFIDENCE_STALE_DAYS}d, confidence <${CONFIDENCE_STALE_VALUE * 100}%): ${staleLessons.slice(0, 3).map(l => `\`${l.topic}\``).join(', ')}`);
        issues.push(`   → Re-verify with \`recall_best_solution\` to reset confidence clock`);
      }

      if (warnLessons.length > 0) {
        issues.push(`⚠️ ${warnLessons.length} lesson${warnLessons.length > 1 ? 's' : ''} aging (>${CONFIDENCE_WARN_DAYS}d): ${warnLessons.slice(0, 3).map(l => `\`${l.topic}\``).join(', ')}`);
      }

      if (unusedRatio > 0.7 && lessons.length > 5) {
        issues.push(`💡 ${unusedLessons.length} lessons never recalled — verify topics match your workflow`);
      }

      const divider = '─'.repeat(48);
      const lines = [
        `🩺 **Brain Doctor**`,
        `\`${divider}\``,
        '',
        '**📊 Health Checks**',
        ...checks.map(c => '  ' + c),
        '',
      ];
      if (issues.length > 0) {
        lines.push(`**🔧 Action Items** (${issues.length} issue${issues.length > 1 ? 's' : ''})`);
        issues.forEach((item, idx) => lines.push(`  ${idx + 1}. ${item}`));
        lines.push('');
        lines.push(`_Fix the action items above, then re-run \`brain_doctor\` to verify._`);
      } else {
        lines.push('**✅ All checks passed** — Brain is healthy!');
        lines.push('');
        lines.push('_Keep the brain sharp: `session_start` → work → `learn_from_attempts` → `session_end`_');
      }
      return lines.join('\n');
    }

    // ── recall_at — Brain Archaeology ────────────────────────────────────────
    case 'recall_at': {
      const { instance_id, topic, date } = args as { instance_id: string; topic: string; date: string };
      const redis = await getConnection(instance_id);
      const cutoff = new Date(date).getTime();
      if (isNaN(cutoff)) return `❌ Invalid date "${date}". Use ISO format: "2026-01-15"`;

      const listKey = `cachly:lessons:${topic}`;
      const all = await redis.lrange(listKey, 0, -1);
      if (all.length === 0) return `📭 No history found for \`${topic}\`. Lessons are stored via \`learn_from_attempts\`.`;

      const before = all
        .map(raw => { try { return JSON.parse(raw) as { ts: string; outcome?: string; what_worked?: string; what_failed?: string }; } catch { return null; } })
        .filter((l): l is NonNullable<typeof l> => l !== null && new Date(l.ts).getTime() <= cutoff)
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

      if (before.length === 0) {
        const first = safeJsonParse(all[0] ?? null, null as null | { ts?: string });
        const earliest = first?.ts ? new Date(first.ts).toLocaleDateString('de-DE') : 'unknown';
        return `📭 No entries for \`${topic}\` found before **${date}**. Earliest entry: ${earliest}.`;
      }

      const lines = [
        `🏺 **Brain Archaeology: \`${topic}\` before ${date}**`,
        `_${before.length} of ${all.length} total entries shown_`,
        '',
      ];
      for (const l of before.slice(-10)) {
        const emoji = l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌';
        const d = new Date(l.ts).toLocaleDateString('de-DE');
        lines.push(`**${d}** ${emoji} ${l.outcome}`);
        if (l.what_worked) lines.push(`  → ${l.what_worked.slice(0, 100)}`);
        lines.push('');
      }
      lines.push(`_Full evolution: ${all.map(r => { try { const l = JSON.parse(r) as { outcome?: string }; return l.outcome === 'success' ? '✅' : l.outcome === 'partial' ? '⚠️' : '❌'; } catch { return '?'; } }).join(' → ')}_`);
      return lines.join('\n');
    }

    // ── trace_dependency — Causal Chain ──────────────────────────────────────
    case 'trace_dependency': {
      const { instance_id, dependency, mark_review = false } = args as { instance_id: string; dependency: string; mark_review?: boolean };
      const redis = await getConnection(instance_id);

      const depKey = `cachly:dep:${dependency}`;
      const raw = await redis.get(depKey);
      if (!raw) return `📭 No lessons found that depend on \`${dependency}\`.\n\nAdd dependencies via: \`learn_from_attempts(..., depends_on=["${dependency}"])\``;

      const topics: string[] = safeJsonParse<string[]>(raw, []);
      const lines = [
        `🔗 **Causal Chain: \`${dependency}\`** — ${topics.length} dependent lesson${topics.length === 1 ? '' : 's'}`,
        '',
      ];

      for (const t of topics) {
        const lessonRaw = await redis.get(`cachly:lesson:best:${t}`);
        if (!lessonRaw) { lines.push(`  • \`${t}\` _(lesson deleted)_`); continue; }
        const lesson = safeJsonParse(lessonRaw, null as null | { outcome?: string; severity?: string; needs_review?: boolean });
        if (!lesson) { lines.push(`  • \`${t}\` _(lesson corrupted)_`); continue; }
        const emoji = lesson.outcome === 'success' ? '✅' : lesson.outcome === 'partial' ? '⚠️' : '❌';
        const reviewBadge = lesson.needs_review ? ' 🔍 **needs_review**' : '';
        lines.push(`  ${emoji} \`${t}\` (${lesson.severity ?? 'major'})${reviewBadge}`);

        if (mark_review) {
          const updated = { ...lesson, needs_review: true };
          await redis.set(`cachly:lesson:best:${t}`, JSON.stringify(updated));
        }
      }

      if (mark_review) {
        lines.push('', `🔍 All ${topics.length} lessons marked as **needs_review** — verify they still work with the changed dependency.`);
      } else {
        lines.push('', `_Run with \`mark_review: true\` to flag all dependent lessons for re-verification._`);
      }
      return lines.join('\n');
    }

    // ── global_learn ──────────────────────────────────────────────────────────
    case 'global_learn': {
      const { instance_id, topic, lesson, severity = 'minor', tags = [] } = args as {
        instance_id: string;
        topic: string;
        lesson: string;
        severity?: string;
        tags?: string[];
      };
      const redis = await getConnection(instance_id);
      const key = `cachly:global:lesson:${topic}`;
      const record = {
        topic,
        lesson,
        severity,
        tags,
        ts: new Date().toISOString(),
        scope: 'global',
        recall_count: 0,
      };
      // Preserve recall_count on update
      const existing = await redis.get(key);
      if (existing) {
        const prev = safeJsonParse(existing, null as null | { recall_count?: number });
        record.recall_count = prev?.recall_count ?? 0;
      }
      await redis.set(key, JSON.stringify(record));
      return `🌐 **Global lesson stored**: \`${topic}\`\n\n${lesson}\n\nRecallable from any project via \`global_recall(topic="${topic}")\`.`;
    }

    // ── global_recall ─────────────────────────────────────────────────────────
    case 'global_recall': {
      const { instance_id, topic } = args as { instance_id: string; topic?: string };
      const redis = await getConnection(instance_id);
      const keys: string[] = [];
      const gStream = redis.scanStream({ match: 'cachly:global:lesson:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        gStream.on('data', (batch: string[]) => keys.push(...batch));
        gStream.on('end', resolve);
        gStream.on('error', reject);
      });

      type GlobalLesson = { topic: string; lesson: string; severity?: string; ts: string; recall_count?: number };
      let lessons: GlobalLesson[] = [];
      if (keys.length > 0) {
        const raws = await redis.mget(...keys);
        for (const raw of raws) {
          const l = safeJsonParse<GlobalLesson | null>(raw ?? null, null);
          if (l) lessons.push(l);
        }
      }

      if (topic) {
        const t = topic.toLowerCase();
        lessons = lessons.filter(l => l.topic.toLowerCase().includes(t));
      }

      if (lessons.length === 0) {
        return `📭 No global lessons${topic ? ` for \`${topic}\`` : ''}.\n\nAdd cross-project knowledge with \`global_learn(topic="...", lesson="...")\`.`;
      }

      // Increment recall_count
      for (const l of lessons) {
        const k = `cachly:global:lesson:${l.topic}`;
        const raw = await redis.get(k);
        if (raw) {
          const rec = safeJsonParse(raw, null as null | { recall_count?: number });
          if (!rec) continue;
          rec.recall_count = (rec.recall_count ?? 0) + 1;
          await redis.set(k, JSON.stringify(rec));
        }
      }

      const lines = [`🌐 **Global Brain** — ${lessons.length} lesson${lessons.length > 1 ? 's' : ''}`, ''];
      for (const l of lessons) {
        const sev = l.severity === 'critical' ? '🔴 ' : l.severity === 'major' ? '🟡 ' : '';
        lines.push(`${sev}**\`${l.topic}\`**`);
        lines.push(l.lesson.slice(0, 200));
        lines.push('');
      }
      return lines.join('\n');
    }

    // ── publish_lesson ────────────────────────────────────────────────────────
    case 'publish_lesson': {
      const { instance_id, topic, lesson, framework = 'general', severity = 'minor' } = args as {
        instance_id: string;
        topic: string;
        lesson: string;
        framework?: string;
        severity?: string;
      };
      const redis = await getConnection(instance_id);

      // Strip potential PII patterns (emails, tokens, paths)
      const sanitized = lesson
        .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[email]')
        .replace(/\b(sk-|cky_live_|Bearer\s)[A-Za-z0-9_-]{8,}/g, '[token]')
        .replace(/\/Users\/[^\s/]+/g, '/Users/[user]')
        .replace(/\/home\/[^\s/]+/g, '/home/[user]');

      const publicLesson = {
        topic,
        lesson: sanitized,
        framework,
        severity,
        ts: new Date().toISOString(),
        published: true,
        votes: 0,
      };

      // Store locally with public flag (future: sync to Cachly public API)
      const key = `cachly:public:lesson:${framework}:${topic}`;
      await redis.set(key, JSON.stringify(publicLesson), 'EX', 365 * 86400);

      return [
        `📢 **Lesson published!**`,
        ``,
        `**Topic:** \`${topic}\``,
        `**Framework:** ${framework}`,
        `**Content:** ${sanitized.slice(0, 200)}${sanitized.length > 200 ? '…' : ''}`,
        ``,
        `This lesson is now available in the Public Brain for other developers.`,
        `Import it anywhere: \`import_public_brain(framework="${framework}")\``,
      ].join('\n');
    }

    // ── import_public_brain ───────────────────────────────────────────────────
    case 'import_public_brain': {
      const { instance_id, framework, limit = 20 } = args as {
        instance_id: string;
        framework: string;
        limit?: number;
      };
      const redis = await getConnection(instance_id);

      // Community-curated lessons per framework
      const COMMUNITY_LESSONS: Record<string, Array<{ topic: string; lesson: string; severity: string }>> = {
        nextjs: [
          { topic: 'nextjs:image-layout', lesson: 'Use fill + relative parent instead of layout="fill" (deprecated since Next.js 13)', severity: 'major' },
          { topic: 'nextjs:app-router-fetch', lesson: 'fetch() in Server Components is cached by default — add {cache:"no-store"} for dynamic data', severity: 'major' },
          { topic: 'nextjs:metadata-export', lesson: 'Export metadata const or generateMetadata() — never both in same file', severity: 'minor' },
          { topic: 'nextjs:client-boundary', lesson: '"use client" propagates down — keep it at the lowest component, not at page level', severity: 'major' },
          { topic: 'nextjs:env-prefix', lesson: 'Only NEXT_PUBLIC_* env vars are exposed to client — others are server-only', severity: 'critical' },
          { topic: 'nextjs:revalidate', lesson: 'export const revalidate = 0 disables caching for entire route; use revalidatePath() for on-demand', severity: 'minor' },
        ],
        fastapi: [
          { topic: 'fastapi:async-db', lesson: 'Use async session with asyncpg — sync SQLAlchemy blocks the event loop', severity: 'critical' },
          { topic: 'fastapi:pydantic-v2', lesson: 'Pydantic v2: use model_validate() instead of parse_obj(), .dict() → .model_dump()', severity: 'major' },
          { topic: 'fastapi:lifespan', lesson: 'Use lifespan context manager instead of deprecated on_event startup/shutdown', severity: 'minor' },
          { topic: 'fastapi:background-tasks', lesson: 'BackgroundTasks run after response is sent — not in a separate thread pool', severity: 'major' },
          { topic: 'fastapi:cors-order', lesson: 'CORSMiddleware must be added before other middleware to work correctly', severity: 'critical' },
        ],
        go: [
          { topic: 'go:context-cancel', lesson: 'Always call cancel() from context.WithCancel — leak goroutines if not cancelled', severity: 'critical' },
          { topic: 'go:defer-in-loop', lesson: 'defer in a loop runs at function return, not loop iteration — use IIFE or explicit close', severity: 'major' },
          { topic: 'go:nil-interface', lesson: 'nil interface != interface containing nil pointer — use explicit nil checks', severity: 'major' },
          { topic: 'go:goroutine-leak', lesson: 'Goroutines with channel sends block forever if receiver is gone — use select with done chan', severity: 'critical' },
          { topic: 'go:embed-path', lesson: '//go:embed path must be relative and known at compile time — no os.Getenv', severity: 'minor' },
        ],
        docker: [
          { topic: 'docker:layer-cache', lesson: 'Copy package.json before source code — Docker caches layers, npm install only reruns on dep changes', severity: 'major' },
          { topic: 'docker:non-root', lesson: 'Run as non-root user (USER 1001) — some k8s clusters reject root containers by policy', severity: 'critical' },
          { topic: 'docker:build-arg-secret', lesson: 'Never use ARG for secrets — visible in image history. Use --secret mount instead', severity: 'critical' },
          { topic: 'docker:entrypoint-exec', lesson: 'Use exec form ["cmd","arg"] not shell form "cmd arg" — shell form ignores SIGTERM', severity: 'major' },
          { topic: 'docker:multi-stage', lesson: 'Multi-stage builds: copy only built artifacts to final stage — keep image small', severity: 'minor' },
        ],
        kubernetes: [
          { topic: 'k8s:resource-limits', lesson: 'Always set resource limits — unbounded pods cause node evictions and OOMKill', severity: 'critical' },
          { topic: 'k8s:liveness-vs-readiness', lesson: 'Liveness failures restart pod; Readiness failures remove from LB. Use different endpoints', severity: 'major' },
          { topic: 'k8s:imagepullpolicy', lesson: 'imagePullPolicy: Always in production — IfNotPresent can serve stale images', severity: 'major' },
          { topic: 'k8s:configmap-env', lesson: 'ConfigMap changes don\'t restart pods — use rollout restart or mount as volume', severity: 'critical' },
          { topic: 'k8s:pdb', lesson: 'Set PodDisruptionBudget for stateful apps — node drains kill all pods without it', severity: 'major' },
        ],
        react: [
          { topic: 'react:useeffect-deps', lesson: 'Omitting dependencies from useEffect deps array causes stale closure bugs — use exhaustive-deps ESLint rule', severity: 'critical' },
          { topic: 'react:key-index', lesson: 'Never use array index as key in lists — causes subtle re-render bugs on reorder/delete', severity: 'major' },
          { topic: 'react:setState-in-render', lesson: 'setState() during render causes infinite loop — move to useEffect or event handler', severity: 'critical' },
          { topic: 'react:memo-reference', lesson: 'Object/array literals in JSX recreate on every render — useMemo for expensive derived values', severity: 'minor' },
        ],
        typescript: [
          { topic: 'ts:type-guard', lesson: 'Use "x is Type" return type for type guard functions — not "boolean"', severity: 'minor' },
          { topic: 'ts:strict-null', lesson: 'Enable strictNullChecks in tsconfig — catches 90% of runtime null errors at compile time', severity: 'critical' },
          { topic: 'ts:enum-avoid', lesson: 'Prefer union types ("a"|"b") over enum — enums have surprising runtime behavior', severity: 'minor' },
          { topic: 'ts:satisfies', lesson: 'Use "satisfies" operator to validate type without widening — more precise than explicit annotation', severity: 'minor' },
        ],
        python: [
          { topic: 'python:mutable-default', lesson: 'Never use mutable default arguments (def f(x=[])) — shared across all calls. Use None + guard', severity: 'critical' },
          { topic: 'python:walrus-operator', lesson: ':= (walrus) assigns and returns — useful in while/comprehensions but hard to read in complex expr', severity: 'minor' },
          { topic: 'python:asyncio-run', lesson: 'asyncio.run() creates new event loop — calling it inside an existing loop raises RuntimeError', severity: 'major' },
          { topic: 'python:typing-optional', lesson: 'Optional[X] == Union[X, None] — in Python 3.10+ use X | None syntax', severity: 'minor' },
        ],
      };

      const fw = framework.toLowerCase();
      const lessons = COMMUNITY_LESSONS[fw];

      if (!lessons) {
        const available = Object.keys(COMMUNITY_LESSONS).join(', ');
        return `❌ No public brain available for \`${framework}\`.\n\nAvailable: ${available}\n\nOr publish your own: \`publish_lesson(framework="${framework}", ...)\``;
      }

      const toImport = lessons.slice(0, limit);
      let importedCount = 0;

      for (const l of toImport) {
        const key = `cachly:lesson:best:${l.topic}`;
        const existing = await redis.get(key);
        if (!existing) {
          await redis.set(key, JSON.stringify({
            ...l,
            what_worked: l.lesson,
            outcome: 'success',
            ts: new Date().toISOString(),
            recall_count: 0,
            source: 'public_brain',
            version: 2,
          }));
          importedCount++;
        }
      }

      const lines = [
        `📥 **Public Brain imported: ${framework}**`,
        ``,
        `${importedCount} new lessons added (${toImport.length - importedCount} already existed)`,
        ``,
        `**Imported topics:**`,
        ...toImport.map(l => {
          const sev = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '🟡' : '💡';
          return `  ${sev} \`${l.topic}\``;
        }),
        ``,
        `These lessons will now appear in \`session_start\` when relevant.`,
        `Recall any time: \`recall_best_solution(topic="${fw}:...")\``,
      ];
      return lines.join('\n');
    }

    // ── setup_ai_memory ───────────────────────────────────────────────────────
    case 'setup_ai_memory': {
      const {
        instance_id,
        project_dir,
        embed_provider: providerArg = 'openai',
        project_description = 'a software project',
      } = args as {
        instance_id: string;
        project_dir?: string;
        embed_provider?: string;
        project_description?: string;
      };

      const inst = await apiFetch<Instance>(`/api/v1/instances/${instance_id}`);

      // Provider-specific env var instructions
      const providerEnvMap: Record<string, { key: string; hint: string }> = {
        openai:  { key: 'OPENAI_API_KEY',  hint: 'Get at: https://platform.openai.com/api-keys' },
        mistral: { key: 'MISTRAL_API_KEY', hint: 'Get at: https://console.mistral.ai/api-keys' },
        cohere:  { key: 'COHERE_API_KEY',  hint: 'Get at: https://dashboard.cohere.com/api-keys' },
        ollama:  { key: 'OLLAMA_BASE_URL', hint: 'Run: brew install ollama && ollama serve  (free, local, no key needed)' },
        gemini:  { key: 'GEMINI_API_KEY',  hint: 'Get at: https://aistudio.google.com/app/apikey' },
      };
      const provInfo = providerEnvMap[providerArg] ?? providerEnvMap['openai'];
      const hasVector = !!inst.vector_token;

      // Generate .mcp.json snippet
      const mcpJsonSnippet = JSON.stringify({
        mcpServers: {
          cachly: {
            command: 'npx',
            args: ['-y', '@cachly-dev/mcp-server@latest'],
            env: {
              CACHLY_JWT: 'your-api-token-from-cachly.dev/settings',
              [provInfo.key]: providerArg === 'ollama' ? 'http://localhost:11434' : 'your-key-here',
              ...(providerArg !== 'openai' ? { CACHLY_EMBED_PROVIDER: providerArg } : {}),
            },
          },
        },
      }, null, 2);

      // Generate copilot-instructions.md content
      const tier = inst.tier.toUpperCase();
      const smartRecallNote = hasVector
        ? '- `smart_recall("natural language query")` — semantic search (finds by meaning)'
        : '- `recall_context("arch:*")` — exact/glob key lookup (upgrade to Speed/Business for smart_recall)';
      const layerNote = hasVector
        ? `Layer 3 (Semantic): smart_recall uses pgvector HNSW on your ${tier} instance`
        : `Layer 3 (Autopilot): this file — upgrade to Speed/Business tier to unlock smart_recall`;

      const copilotInstructions = `# cachly AI Brain — ${project_description}

> AI memory system powered by [cachly.dev](https://cachly.dev). Works with GitHub Copilot, Claude Code, Cursor, Windsurf, Continue.dev, and any MCP-compatible editor.

---

## 🔴 MANDATORY RULES — Always enforced, no exceptions

### Rule 1 — Session Start (FIRST thing in every window)
Call \`session_start\` **before reading any source files or making any changes**:

\`\`\`
session_start(
  instance_id = "${instance_id}",
  focus       = "<what you plan to work on today>",
)
\`\`\`

Returns: last session summary, handoff from previous window, recent lessons, open failures, brain health.

**If \`session_start\` is unavailable**, fall back:
1. \`smart_recall("recent lessons <topic>")\`
2. \`recall_best_solution("<topic>")\`

### Rule 2 — Learn After Every Fix/Deploy/Discovery (AUTOMATIC — no prompting needed)
After **every** bug fix, deployment, failed attempt, or discovery — call \`learn_from_attempts\` immediately:

\`\`\`
learn_from_attempts(
  instance_id = "${instance_id}",
  topic       = "category:keyword",   # deploy:web | fix:auth | debug:db | infra:docker
  outcome     = "success" | "failure" | "partial",
  what_worked = "exact approach or command that worked",
  what_failed = "what did NOT work (prevents future wasted time)",
  severity    = "critical" | "major" | "minor",
  commands    = ["exact command that worked"],
  file_paths  = ["path/to/changed/file"],
)
\`\`\`

**These events MUST automatically trigger \`learn_from_attempts\`:**
- ✅ Successfully deployed → \`topic="deploy:<component>", outcome="success"\`
- ✅ Fixed a bug → \`topic="fix:<description>", outcome="success"\`
- ✅ Discovered root cause → \`topic="debug:<area>", outcome="partial"\`
- ✅ Tried something that failed → \`topic="<area>", outcome="failure", what_failed="..."\`
- ✅ Found a config quirk → \`topic="infra:<topic>", outcome="success"\`
- ✅ Ran a working command → store it in \`commands=[...]\`

### Rule 3 — Session Handoff (when closing window or task list > 3 items)
\`\`\`
session_handoff(
  instance_id     = "${instance_id}",
  completed_tasks = ["what was done"],
  remaining_tasks = ["what is still to do"],
  files_changed   = [{"path": "src/...", "status": "modified", "description": "what changed"}],
  instructions    = "IMPORTANT: what the next window MUST know to not break things",
  context_summary = "current state of the system",
)
\`\`\`

The next \`session_start\` automatically includes this handoff. The new window sees exactly what's done, what remains, and what NOT to break.

### Rule 4 — Session End (LAST thing before closing)
\`\`\`
session_end(
  instance_id     = "${instance_id}",
  summary         = "What was accomplished (2-3 sentences with specifics)",
  files_changed   = ["list", "of", "changed", "files"],
  lessons_learned = <number of learn_from_attempts calls made>,
)
\`\`\`

> \`session_end\` **automatically extracts and stores lessons** from the summary text — no manual calls needed.

### Rule 5 — Code Index Invalidation (AUTOMATIC)
- \`index_project\` tracks MD5 hashes per file — **skips unchanged files automatically**
- After code changes: next \`index_project\` run re-indexes only modified files
- After delete/rename: run \`index_project\` again to sync
- No manual invalidation needed

---

## Task-type trigger table

| You're about to... | Call BEFORE | Call AFTER |
|---|---|---|
| Deploy anything | \`recall_best_solution("deploy:<component>")\` | \`learn_from_attempts(topic="deploy:...")\` |
| Fix a bug | \`recall_best_solution("fix:<area>")\` | \`learn_from_attempts(topic="fix:...")\` |
| Add a feature | \`session_start(focus="feat:<area>")\` | \`learn_from_attempts(topic="feat:...")\` |
| Infra/server work | \`recall_best_solution("infra:<topic>")\` | \`learn_from_attempts(topic="infra:...")\` |
| Debug an issue | \`smart_recall("<error message or symptom>")\` | \`learn_from_attempts(topic="debug:...")\` |

---

## Available Brain Tools

| Tool | When to use |
|------|-------------|
| \`session_start\` | **FIRST** — mandatory at start of every session |
| \`session_end\` | **LAST** — mandatory at end, auto-learns from summary |
| \`session_handoff\` | When closing window with remaining tasks |
| \`learn_from_attempts\` | **AUTOMATIC** after every fix/deploy/discovery |
| \`recall_best_solution\` | Before any non-trivial task |
| \`remember_context\` | After analyzing code — save findings for future sessions |
${smartRecallNote ? `| \`smart_recall\` | Search brain by meaning/keywords |\n` : ''}\
| \`recall_context\` | Get exact key (supports glob: \`arch:*\`, \`file:*\`) |
| \`brain_search\` | BM25+ full-text search over all brain data |
| \`auto_learn_session\` | Batch-learn from a list of observations (optional) |
| \`index_project\` | Index source files (smart hash, skips unchanged files) |
| \`list_remembered\` | See what's cached in the brain |
| \`forget_context\` | Remove stale context |

---

## Instance Details

- **Instance ID:** \`${instance_id}\`
- **Instance name:** ${inst.name}
- **Tier:** ${tier}
- **${layerNote}**
- **Embedding provider:** ${providerArg}

---

## How the 3-layer system works

\`\`\`
Layer 1 — Storage:  Your cachly Valkey instance (${inst.name}) — persists forever
Layer 2 — Tools:    learn_from_attempts · recall_best_solution · brain_search · session_start/end
Layer 3 — Autopilot: This file — AI reads it and runs tools automatically every session
\`\`\`

Result: Your AI **never solves the same problem twice** and always picks up exactly where it left off. 🚀
`;


      const lines: string[] = [
        `🧠 **cachly AI Memory Setup Complete**`,
        ``,
        `**Instance:** ${inst.name} (${tier}) · ID: \`${instance_id}\``,
        `**Embedding Provider:** ${providerArg}`,
        `**Semantic Search:** ${hasVector ? '✅ pgvector HNSW available' : '⚠️  Not available on ' + tier + ' — upgrade to Speed/Business'}`,
        ``,
        `─────────────────────────────────────────────`,
        `**Step 1 — Add to .mcp.json:**`,
        `\`\`\`json`,
        mcpJsonSnippet,
        `\`\`\``,
        ``,
        `**Step 2 — Set your ${providerArg} key:**`,
        `\`\`\`bash`,
        `export ${provInfo.key}="your-key-here"`,
        `\`\`\``,
        `_(${provInfo.hint})_`,
        ``,
        `─────────────────────────────────────────────`,
        `**Step 3 — copilot-instructions.md (Layer 3 Autopilot):**`,
        ``,
        ...(project_dir
          ? [`🔍 Detecting IDEs in \`${project_dir}\`…`]
          : [`Copy this to \`.github/copilot-instructions.md\` (Copilot), \`CLAUDE.md\` (Claude Code), or \`.cursor/rules\` (Cursor) in your project:`]),
        ``,
        `\`\`\`markdown`,
        copilotInstructions,
        `\`\`\``,
        ``,
        `─────────────────────────────────────────────`,
        `**How the 3 layers work together:**`,
        `  Layer 1 → Your Valkey instance stores all lessons + context (persists forever)`,
        `  Layer 2 → MCP tools (learn_from_attempts, recall_best_solution, smart_recall) read/write it`,
        `  Layer 3 → copilot-instructions.md makes your AI run them automatically`,
        ``,
        `Result: Your AI never solves the same problem twice. 🚀`,
      ];

      // ── IDE auto-detection + file writing ────────────────────────────────
      if (project_dir) {
        const { mkdir, writeFile, access } = await import('node:fs/promises');
        const { constants } = await import('node:fs');

        const exists = async (p: string) => access(p, constants.F_OK).then(() => true).catch(() => false);

        // Detect which IDEs are present based on marker files/dirs
        interface IdeTarget { ide: string; path: string; content: string }
        const targets: IdeTarget[] = [];
        let stopHookWritten = false;

        // GitHub Copilot — always write (universal fallback)
        targets.push({
          ide: 'GitHub Copilot',
          path: join(project_dir, '.github', 'copilot-instructions.md'),
          content: copilotInstructions,
        });

        // Claude Code — CLAUDE.md in project root
        if (await exists(join(project_dir, 'CLAUDE.md')) || await exists(join(project_dir, '.claude'))) {
          targets.push({
            ide: 'Claude Code',
            path: join(project_dir, 'CLAUDE.md'),
            content: copilotInstructions,
          });

          // Claude Code Stop-Hook — auto-saves checkpoint when Claude stops responding
          const claudeDir = join(project_dir, '.claude');
          await mkdir(claudeDir, { recursive: true });
          const stopHook = {
            hooks: {
              Stop: [
                {
                  matcher: '',
                  hooks: [
                    {
                      type: 'command',
                      command: `npx --yes @cachly-dev/mcp-server@latest checkpoint --instance-id ${instance_id}`,
                    },
                  ],
                },
              ],
            },
          };
          const settingsPath = join(claudeDir, 'settings.json');
          let existingSettings: Record<string, unknown> = {};
          try {
            const { readFile: rf } = await import('node:fs/promises');
            existingSettings = JSON.parse(await rf(settingsPath, 'utf-8'));
          } catch { /* new file */ }
          const merged = { ...existingSettings, hooks: (stopHook as Record<string, unknown>).hooks };
          await writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
          stopHookWritten = true;
        }

        // Cursor — .cursor/rules (new format) or .cursorrules (legacy)
        if (
          await exists(join(project_dir, '.cursor')) ||
          await exists(join(project_dir, '.cursorrules'))
        ) {
          const cursorDir = join(project_dir, '.cursor');
          await mkdir(cursorDir, { recursive: true });
          targets.push({
            ide: 'Cursor',
            path: join(cursorDir, 'rules'),
            content: copilotInstructions,
          });
        }

        // Windsurf — .windsurfrules
        if (
          await exists(join(project_dir, '.windsurfrules')) ||
          await exists(join(project_dir, '.windsurf'))
        ) {
          targets.push({
            ide: 'Windsurf',
            path: join(project_dir, '.windsurfrules'),
            content: copilotInstructions,
          });
        }

        // VS Code (Copilot) — already covered by .github/copilot-instructions.md above
        // Continue.dev — .continue/config.json is JSON, not markdown — skip, copilot-instructions handles it

        const written: string[] = [];
        for (const target of targets) {
          const dir = target.path.substring(0, target.path.lastIndexOf('/'));
          await mkdir(dir, { recursive: true });
          await writeFile(target.path, target.content, 'utf-8');
          written.push(`✅ [${target.ide}] → \`${target.path.replace(project_dir, '.')}\``);
        }

        if (stopHookWritten) {
          written.push(`✅ [Claude Code Stop-Hook] → \`.claude/settings.json\` (auto-checkpoint on stop)`);
        }

        lines.push(...written);
      }

      return lines.join('\n');
    }

    // ── team_assign_role ──────────────────────────────────────────────────────
    // Assign a role (admin | reviewer | contributor | viewer) to a team member.
    // Only an existing admin can upgrade another member to admin or reviewer.
    // First call with role="admin" is bootstrapped (no auth required) so the
    // team can establish governance from a fresh brain.
    case 'team_assign_role': {
      const { instance_id, handle, role, assigned_by = '' } = args as {
        instance_id: string; handle: string;
        role: TeamRole; assigned_by?: string;
      };
      if (!instance_id || !handle || !role) return '❌ Required: instance_id, handle, role';
      const cleanRole = (['admin', 'reviewer', 'contributor', 'viewer'] as TeamRole[]).includes(role)
        ? role : null;
      if (!cleanRole) return `❌ Unknown role \`${role}\`. Valid: admin · reviewer · contributor · viewer`;

      const redis = await getConnection(instance_id);

      // Bootstrap: if there are no admins yet, the first assignment is free.
      const allRoles = await redis.hgetall(ROLES_KEY(instance_id)).catch(() => ({} as Record<string, string>));
      const hasAdmin = Object.values(allRoles).includes('admin');

      if (hasAdmin) {
        // After bootstrap, only an admin can assign roles.
        const actorRole = assigned_by ? await getRole(redis, instance_id, assigned_by) : null;
        if (!hasPermission(actorRole, 'admin')) {
          return [
            `❌ **Permission denied** — only an \`admin\` can assign roles.`,
            ``,
            `Ask an existing admin to run:`,
            `\`team_assign_role(instance_id="${instance_id}", handle="${handle}", role="${role}", assigned_by="<their-handle>")\``,
          ].join('\n');
        }
      }

      const prevRole = allRoles[handle.toLowerCase()] ?? null;
      await redis.hset(ROLES_KEY(instance_id), handle.toLowerCase(), cleanRole);
      await redis.expire(ROLES_KEY(instance_id), 365 * 2 * 86400); // 2-year TTL

      // Governance audit trail (W6): record every role change with who made it.
      await auditLog(redis, instance_id, {
        action: 'team_assign_role', actor: assigned_by || '(bootstrap)',
        handle: handle.toLowerCase(), from: prevRole, to: cleanRole,
      });

      const isBootstrap = !hasAdmin;
      const badge = ROLE_BADGE[cleanRole];
      return [
        `${badge} **Role assigned** — **${handle}** is now a \`${cleanRole}\``,
        ``,
        `**Capabilities:** ${ROLE_CAPABILITIES[cleanRole]}`,
        ``,
        isBootstrap ? `_First admin bootstrapped — governance is now active on this brain._` : `_Assigned by ${assigned_by || '(bootstrap)'}_`,
        ``,
        `Run \`team_roster\` to see all current roles.`,
      ].join('\n');
    }

    // ── team_whoami ───────────────────────────────────────────────────────────
    // Shows a team member's own role and what they can do.
    case 'team_whoami': {
      const { instance_id, handle } = args as { instance_id: string; handle: string };
      if (!instance_id || !handle) return '❌ Required: instance_id, handle';
      const redis = await getConnection(instance_id);
      const role = await getRole(redis, instance_id, handle);

      if (!role) {
        const allRoles = await redis.hgetall(ROLES_KEY(instance_id)).catch(() => ({} as Record<string, string>));
        const hasAdmin = Object.values(allRoles).includes('admin');
        return [
          `👁️ **${handle}** has no assigned role on this brain.`,
          ``,
          hasAdmin
            ? `Ask an admin to run \`team_assign_role(handle="${handle}", role="contributor")\` to add you.`
            : `This brain has no roles set up yet. Establish governance:\n\`team_assign_role(handle="${handle}", role="admin")\``,
        ].join('\n');
      }

      const badge = ROLE_BADGE[role];
      return [
        `## ${badge} ${handle} — \`${role}\``,
        ``,
        `**You can:** ${ROLE_CAPABILITIES[role]}`,
        ``,
        `Run \`team_roster\` to see all team members and their roles.`,
      ].join('\n');
    }

    // ── team_roster ───────────────────────────────────────────────────────────
    // Full view of all assigned roles, with last-active info from person nodes.
    case 'team_roster': {
      const { instance_id } = args as { instance_id: string };
      if (!instance_id) return '❌ Required: instance_id';
      const redis = await getConnection(instance_id);

      const allRoles = await redis.hgetall(ROLES_KEY(instance_id)).catch(() => ({} as Record<string, string>));
      if (Object.keys(allRoles).length === 0) {
        return [
          `## 👥 Team Roster`,
          ``,
          `No roles assigned yet. Establish governance with:`,
          `\`team_assign_role(instance_id="${instance_id}", handle="<your-handle>", role="admin")\``,
        ].join('\n');
      }

      // Sort by role rank desc, then handle alpha
      const members = Object.entries(allRoles)
        .map(([h, r]) => ({ handle: h, role: r as TeamRole }))
        .sort((a, b) => ((ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0)) || a.handle.localeCompare(b.handle));

      const lines = [
        `## 👥 Team Roster (${members.length} member${members.length !== 1 ? 's' : ''})`,
        ``,
        `| Role | Handle | Capabilities |`,
        `|---|---|---|`,
      ];
      for (const m of members) {
        const badge = ROLE_BADGE[m.role] ?? '?';
        lines.push(`| ${badge} ${m.role} | **${m.handle}** | ${ROLE_CAPABILITIES[m.role].split(' · ').slice(0, 2).join(', ')} |`);
      }
      lines.push(
        ``,
        `_Manage with \`team_assign_role\`. Any admin can add or change roles._`,
      );
      return lines.join('\n');
    }

    // ── team_audit ────────────────────────────────────────────────────────────
    // Governance/compliance trail (W6): who changed roles, who confirmed which
    // lessons, and when. Admin-gated once governance is active — the audit log is
    // sensitive (it reveals the team's review activity). Newest entries first.
    case 'team_audit': {
      const { instance_id, requester = '', limit = 50 } = args as {
        instance_id: string; requester?: string; limit?: number;
      };
      if (!instance_id) return '❌ Required: instance_id';
      const redis = await getConnection(instance_id);

      const denied = await requireRole(redis, instance_id, requester, 'admin', 'view the governance audit log');
      if (denied) return denied;

      const max = Math.min(Math.max(1, Number(limit) || 50), 200);
      const raw = await redis.lrange(`cachly:team:audit:${instance_id}`, -max, -1).catch(() => [] as string[]);
      if (raw.length === 0) {
        return [
          `## 📜 Governance Audit Log`,
          ``,
          `No governance events recorded yet.`,
          `Events are logged automatically on \`team_assign_role\` and \`team_confirm\`.`,
        ].join('\n');
      }

      type Audit = { action?: string; actor?: string; ts?: string; [k: string]: unknown };
      const entries = raw
        .map(r => safeJsonParse<Audit | null>(r, null))
        .filter((e): e is Audit => e !== null)
        .reverse(); // newest first

      const fmt = (e: Audit): string => {
        const when = e.ts ? new Date(e.ts).toISOString().replace('T', ' ').slice(0, 16) : '?';
        if (e.action === 'team_assign_role') {
          return `| ${when} | 👑 role | **${e.actor}** set \`${e.handle}\`: ${e.from ?? '—'} → **${e.to}** |`;
        }
        if (e.action === 'team_confirm') {
          return `| ${when} | ✅ confirm | **${e.actor}** confirmed \`${e.topic}\` (${e.level}) |`;
        }
        return `| ${when} | ${e.action ?? '?'} | ${e.actor ?? '?'} |`;
      };

      return [
        `## 📜 Governance Audit Log (${entries.length} event${entries.length !== 1 ? 's' : ''})`,
        ``,
        `| When (UTC) | Type | Detail |`,
        `|---|---|---|`,
        ...entries.map(fmt),
        ``,
        `_Immutable trail · 2-year retention · last ${max} events. Admin-only._`,
      ].join('\n');
    }

    // ── team_grant_scope ──────────────────────────────────────────────────────
    // Add (or remove) a member to a named group/sub-team. Group-scoped lessons
    // only surface in recall for members of that group. Admin-gated after the
    // role model is bootstrapped (consistent with team_assign_role).
    case 'team_grant_scope': {
      const { instance_id, handle, group, action = 'add', assigned_by = '' } = args as {
        instance_id: string; handle: string; group: string;
        action?: 'add' | 'remove'; assigned_by?: string;
      };
      if (!instance_id || !handle || !group) return '❌ Required: instance_id, handle, group';
      const grp = String(group).toLowerCase().trim();
      if (!grp) return '❌ `group` must be a non-empty name (e.g. "backend", "security")';

      const redis = await getConnection(instance_id);

      // Admin gate (skipped during bootstrap, i.e. when no admin exists yet).
      const allRoles = await redis.hgetall(ROLES_KEY(instance_id)).catch(() => ({} as Record<string, string>));
      const hasAdmin = Object.values(allRoles).includes('admin');
      if (hasAdmin) {
        const actorRole = assigned_by ? await getRole(redis, instance_id, assigned_by) : null;
        if (!hasPermission(actorRole, 'admin')) {
          return `❌ **Permission denied** — only an \`admin\` can manage group scopes. Ask an admin to set \`assigned_by\`.`;
        }
      }

      if (action === 'remove') {
        await redis.srem(GROUP_KEY(instance_id, grp), handle.toLowerCase());
        return `🔓 **${handle}** removed from group \`${grp}\`.`;
      }

      await redis.sadd(GROUPS_INDEX_KEY(instance_id), grp);
      await redis.sadd(GROUP_KEY(instance_id, grp), handle.toLowerCase());
      await redis.expire(GROUPS_INDEX_KEY(instance_id), 365 * 2 * 86400);
      await redis.expire(GROUP_KEY(instance_id, grp), 365 * 2 * 86400);
      return [
        `🔐 **Scope granted** — **${handle}** is now in group \`${grp}\`.`,
        ``,
        `Lessons stored with \`group="${grp}"\` will surface in recall for ${handle} (and other \`${grp}\` members + admins) only.`,
        ``,
        `Store a scoped lesson: \`learn_from_attempts(topic="...", group="${grp}", ...)\``,
      ].join('\n');
    }

    // ── team_scopes ───────────────────────────────────────────────────────────
    // List all groups + members, or the groups a specific handle belongs to.
    case 'team_scopes': {
      const { instance_id, handle } = args as { instance_id: string; handle?: string };
      if (!instance_id) return '❌ Required: instance_id';
      const redis = await getConnection(instance_id);

      if (handle) {
        const scopes = await getScopes(redis, instance_id, handle);
        if (scopes.size === 0) {
          return `👁️ **${handle}** is in no groups — sees only team-wide + public lessons.`;
        }
        return `🔐 **${handle}** belongs to: ${[...scopes].map(g => `\`${g}\``).join(', ')}`;
      }

      const groups = await redis.smembers(GROUPS_INDEX_KEY(instance_id)).catch(() => [] as string[]);
      if (groups.length === 0) {
        return [
          `## 🔐 Team Scopes`,
          ``,
          `No groups defined yet. Create one by adding a member:`,
          `\`team_grant_scope(instance_id="${instance_id}", handle="alice", group="backend")\``,
        ].join('\n');
      }
      const lines = [`## 🔐 Team Scopes (${groups.length} group${groups.length !== 1 ? 's' : ''})`, ``];
      for (const g of groups.sort()) {
        const members = await redis.smembers(GROUP_KEY(instance_id, g)).catch(() => [] as string[]);
        lines.push(`- **\`${g}\`** (${members.length}): ${members.length ? members.map(m => `**${m}**`).join(', ') : '_empty_'}`);
      }
      lines.push(``, `_Scope a lesson to a group with \`learn_from_attempts(group="...")\`. Members + admins see it; others don't._`);
      return lines.join('\n');
    }

    default:
      return null;
  }
}

