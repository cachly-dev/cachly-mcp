/**
 * First-contact response builder for `brain_from_git` (roadmap P1-5:
 * "Onboarding-Magie messen & polieren").
 *
 * The very first `brain_from_git` run is a new user's first contact with the
 * Brain, and it decides whether they ever reach the "aha". The response must,
 * in one message:
 *   (a) summarize what was just learned (counts by category + severity),
 *   (b) prove recall already works — show the top hit of a real search that
 *       ran against a topic seeded seconds ago,
 *   (c) hand the user 2-3 copy-pasteable next queries, and
 *   (d) degrade gracefully for empty/small repos (clear guidance, not empty stats).
 *
 * Pure string building — no I/O, no schema/tool changes — so the onboarding
 * bench and its CI test can assert the exact first-contact response shape.
 */

export interface FirstContactProof {
  /** The query that was run internally against the freshly seeded lessons. */
  query: string;
  /** Topic of the top hit. */
  topic: string;
  /** Short snippet of the top hit's lesson. */
  snippet: string;
}

export interface FirstContactReportInput {
  repoDir: string;
  revRange: string;
  processed: number;
  ingested: number;
  skipped: number;
  /** Wall-clock time the seeding run took. */
  durationMs: number;
  isIncremental: boolean;
  lastSha?: string;
  instanceId: string;
  /** category → count, sorted descending by the caller. */
  categories: Array<[string, number]>;
  /** severity → count (optional), sorted descending by the caller. */
  severities?: Array<[string, number]>;
  /** Proof-of-value: top hit of an internal search against a just-seeded topic. */
  proof?: FirstContactProof | null;
  /** Copy-pasteable follow-up queries (see suggestRecallQueries). */
  suggestedQueries: string[];
  /** Optional context for the empty case (e.g. "No commits found on branch X"). */
  emptyReason?: string;
}

/** Below this many ingested lessons we treat the repo as "small" and add growth guidance. */
export const SMALL_SEED_THRESHOLD = 5;

export function formatSeedDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(ms, 1)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Turn seeded topics (`category:some-domain`) into up to `max` copy-pasteable
 * `smart_recall` calls a brand-new user can paste as their literal next message.
 * Deduplicates by domain so three "fix:*" topics don't yield three identical queries.
 */
export function suggestRecallQueries(topics: string[], instanceId: string, max = 3): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const topic of topics) {
    const domain = (topic.includes(':') ? topic.slice(topic.indexOf(':') + 1) : topic)
      .replace(/[-_]+/g, ' ')
      .trim();
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(`smart_recall(instance_id="${instanceId}", query="${domain}")`);
    if (out.length >= max) break;
  }
  return out;
}

/** Steps that take an empty/tiny Brain to a first recall hit in under a minute. */
function growthSteps(instanceId: string): string[] {
  return [
    `  1. \`brain_seed_starter(instance_id="${instanceId}")\` — load 16 curated engineering lessons instantly`,
    `  2. \`smart_recall(instance_id="${instanceId}", query="docker build slow")\` — see your first recall hit`,
    `  3. \`learn_from_attempts(...)\` after your next fix — the Brain grows with every lesson from here on`,
  ];
}

export function buildFirstContactReport(r: FirstContactReportInput): string {
  const lines: string[] = [];
  lines.push(`🔁 **brain_from_git: ${r.repoDir}**`);
  if (r.isIncremental && r.lastSha) {
    lines.push(`🔄 Incremental mode — only new commits since \`${r.lastSha.slice(0, 8)}\` were processed`);
  }
  lines.push('');
  lines.push(
    `📂 Branch: \`${r.revRange}\`  |  Processed: **${r.processed}** commits  |  ` +
    `Ingested: **${r.ingested}** lessons  |  Skipped: ${r.skipped}  |  ` +
    `⏱️ Seeding took ${formatSeedDuration(r.durationMs)}`,
  );
  lines.push('');

  // ── Empty repo / nothing ingested — guidance instead of empty stats ─────────
  if (r.ingested === 0) {
    if (r.emptyReason) lines.push(`⚠️ ${r.emptyReason}`);
    lines.push(`🌱 **Nothing to learn from this git history yet** — normal for fresh, shallow, or squash-only repos.`);
    lines.push(`Get to your first recall in under a minute:`);
    lines.push(...growthSteps(r.instanceId));
    return lines.join('\n');
  }

  // ── (a) Seeded summary — what the Brain just learned ────────────────────────
  lines.push(`**What your Brain just learned (by category):**`);
  lines.push(r.categories.map(([k, v]) => `  • **${k}** (${v})`).join('\n'));
  if (r.severities && r.severities.length > 0) {
    lines.push(`**By severity:** ${r.severities.map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }

  // ── (b) Proof of value — a real recall against a just-seeded topic ──────────
  if (r.proof) {
    lines.push('');
    lines.push(`🎯 **Proof — your first recall already works.** We just searched your fresh Brain for:`);
    lines.push(`   "${r.proof.query}"`);
    lines.push(`   → Top hit: **${r.proof.topic}** — ${r.proof.snippet}`);
  }

  // ── (c) Suggested next queries — copy-pasteable ──────────────────────────────
  if (r.suggestedQueries.length > 0) {
    lines.push('');
    lines.push(`**Try these next (copy-paste):**`);
    for (const q of r.suggestedQueries) lines.push(`  • \`${q}\``);
  }

  // ── (d) Small-repo guidance ──────────────────────────────────────────────────
  if (r.ingested < SMALL_SEED_THRESHOLD) {
    lines.push('');
    lines.push(`🌱 **Small git history — only ${r.ingested} lesson${r.ingested === 1 ? '' : 's'} so far.** Top it up:`);
    lines.push(...growthSteps(r.instanceId));
  }

  lines.push('');
  lines.push(`💡 New lessons are stored with confidence 0.55 (auto-inferred).`);
  lines.push(`💡 As you confirm them via \`learn_from_attempts\`, confidence rises automatically.`);
  lines.push(`🔍 Explore: \`brain_search(query="fix")\`  |  \`ckg_inspect(concept="deploy")\``);
  lines.push(`💾 Next run will automatically continue from the latest commit (incremental mode).`);
  return lines.join('\n');
}
