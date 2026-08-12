import { execSync } from 'node:child_process';
import type { Redis } from 'ioredis';
import { calculateConfidence, confidenceBadge, STRUCTURED_TEMPLATES,
         CONFIDENCE_WARN_VALUE, CONFIDENCE_STALE_VALUE, CONFIDENCE_WARN_DAYS } from '../confidence.js';
import { ckgSlug, extractProblemConcept, ckgUpsertNode, ckgUpdateEdge,
         ckgUpsertPersonNode, ckgUpsertFileNode, ckgRecordCollaboration,
         ckgUpsertServiceNode } from '../ckg.js';
import { safeJsonParse, scanKeys } from '../utils.js';
import type { CKGEdge, CKGNode, PersonNode, ServiceNode } from '../ckg.js';
import { getRole, ROLE_BADGE, getScopes, lessonVisibleToScope,
         reviewModeEnabled, storeLessonProposal } from './team.js';
import { keywordSearch, tokenize, splitMultiQuery, levenshtein,
         indexVocab as _indexVocab } from '../search.js';
import { rerankByQuality, qualityMultiplier, extractLessonQuality } from '../rerank.js';
import { computeEmbedding, hasEmbedProvider } from '../embeddings.js';
import { upgradeNudge } from '../upgrade-nudge.js';
import { cachlyUrl } from '../cachly-url.js';

// ── Changelog (shown once per version in session_start) ──────────────────────
const MCP_VERSION = '0.10.119';
const WHATS_NEW: Record<string, string[]> = {
  '0.10.119': [
    `🔍 **Explainable briefings — provenance in every warning**`,
    `  📎 \`/briefing\` warnings now carry \`outcome\`, \`author\`, \`learned_at\` and \`matched_on\` (the context tokens that triggered the warning) — editors can show WHY a fix hint fired, not just what it claims.`,
    `  🧰 VS Code 0.12.0 uses this: severity + confidence in the toast, full lesson card with provenance, "Not helpful" per-file suppression, reviewable CLS auto-learns.`,
    `  🧹 CI docs now describe exactly what ships: scan mode uses the REST \`/scan\` endpoint, the GitLab template covers learn/scan/confirm.`,
    `  📊 122 MCP tools`,
  ],
  '0.10.115': [
    `🔧 **\`brain_get_pref\` + \`brain_set_pref\` — persistent Brain preferences**`,
    `  📖 \`brain_get_pref\` reads back any stored preference (omit key to list all).`,
    `  ✏️ \`brain_set_pref\` saves a preference to Redis — survives restarts, scoped per Brain instance.`,
    `  💡 Known key: \`auto_changelog\` — set to "false" to silence the new-lessons digest at session_start.`,
    `  📊 140 MCP tools`,
  ],
  '0.10.114': [
    `📋 **\`brain_changelog\` — weekly knowledge digest in one call**`,
    `  📅 Generates a grouped Markdown changelog of lessons learned in the last N days.`,
    `  👥 Grouped by topic category, annotated with author, recall count, and confidence — paste directly into standup or Slack.`,
    `  ⚙️ Params: \`days\` (default 7), \`max_lessons\` (default 30), \`include_failures\` (default true).`,
    `  📊 138 MCP tools`,
  ],
  '0.10.113': [
    `📈 **Week-over-week savings trend in \`cache_stats\`**`,
    `  📅 \`cache_stats\` now shows **7-day hits** + **WoW trend %** (e.g. \`+23.0% vs prev week\`) so ROI momentum is visible, not just the cumulative total.`,
    `  ⬇️ Goes red (📉) on drops, green (📈) on growth — first week always shows +100% (new).`,
    `  🔧 Backed by new \`CountHitsInWindow\` repo method + \`hits_last_7d\`, \`hits_prev_7d\`, \`week_over_week_pct\` fields in \`SavingsEstimate\`.`,
    `  📊 137 MCP tools`,
  ],
  '0.10.112': [
    `⚙️ **Configurable cost_per_call_usd — accurate ROI for any LLM**`,
    `  💡 New \`set_cost_per_call\` tool: set your real per-call cost (claude-opus-4.8 → $0.02, gpt-5.5 → $0.015, claude-sonnet-4.6 → $0.009, claude-haiku-4.5 → $0.001) so savings estimates in \`cache_stats\` reflect your actual bill.`,
    `  🔧 New API: \`PUT /api/v1/instances/:id/cost-per-call\` — persisted per instance, used by \`cache_stats\`, org savings, and SSE analytics stream.`,
    `  📊 137 MCP tools`,
  ],
  '0.10.111': [
    `🏢 **Org-wide ROI + GitLab CI — the CFO number, aggregated**`,
    `  💰 \`cache_org_stats\` now shows **org-wide Tokenmaxxing ROI**: total savings summed across every instance in your org, monthly projection, top-5 instances by savings. One number for the whole team.`,
    `  🔌 Backed by new API endpoint \`GET /api/v1/orgs/:id/savings\` (org members only)`,
    `  🦊 GitLab CI integration: \`brain-from-ci-gitlab.yml\` — two \`.post\` jobs (on_success/on_failure), same helper script, pipeline never fails because of Brain push`,
    `  🛠️ GitHub Action template fixed: \`secrets.*\` in job-level \`if\` is invalid — guard removed (helper script skips cleanly on missing secrets)`,
    `  📊 136 MCP tools`,
  ],
  '0.10.110': [
    `🏢 **Zero friction: ROI-Projektor, Org-Shared-Cache, CI ready-to-paste**`,
    `  📈 \`cache_stats\` — zero-hit projection calculator: shows expected monthly savings for 5/10/20-dev teams before a single cache hit lands. ROI visible from day 1.`,
    `  🏢 New \`cache_org_stats\` — shared org-level cache stats across multiple instances. Convention-based (\`org:{id}:sem\`), zero API changes needed.`,
    `  🔗 \`cache_set\`/\`cache_get\` now accept optional \`org_id\` — write to personal + org namespace, fall back to org on miss. Fully backwards-compatible.`,
    `  📋 Copy-paste CI integration: \`brain-from-ci-action.yml\` → Brain self-calibrates confidence on every GitHub Actions run. No config beyond two repo secrets.`,
    `  📊 136 MCP tools`,
  ],
  '0.10.109': [
    `💰 **Tokenmaxxing ROI + Closed-loop CI learning**`,
    `  📊 \`cache_stats\` now shows a **Tokenmaxxing ROI** section — total tokens saved, monthly cost projection, and top 3 most-cached prompts. Finally a number you can show the CFO.`,
    `  🔄 New \`brain_from_ci\` — bulk-ingest CI history into the Brain (red→green = learned fix, green→red = CKG causal edge). The brain_from_git equivalent for CI. Bootstrap the Brain from your CI logs in one call.`,
    `  📊 134 MCP tools`,
  ],
  '0.10.108': [
    `🧠 **Focused briefing + trustworthy autopilot**`,
    `  🎯 New \`session_start_summary\` — top-N focused briefing by topic. Scores lessons by relevance × confidence + recall_count + severity + recency. Use it for a quick pre-brief without loading the full Brain.`,
    `  🤝 Autopilot template now explains the data flow upfront ("your own Brain, EU-hosted, no third parties") — no more friction with cautious AI assistants during onboarding`,
    `  📊 132 MCP tools`,
  ],
  '0.10.107': [
    `🎯 **Recall@3 gap closed — the moat proof got sharper (the head-to-head that matters)**`,
    `  🔍 External-corpus Recall@3 **82.1% → 98.2%** · Precision@1 **80.4%** · MRR **89.0%** — now ahead of flat-file memory on every metric`,
    `  🧬 Root-cause fix: documents are no longer indexed with cross-lingual synonyms (the symmetric-expansion bug inflated any doc containing a common word ~28×, burying topic-specific lessons). Queries still expand — a 日本語 query still finds English lessons.`,
    `  ⚖️ Reranker now compresses BM25 with score^0.3 before applying lesson quality, so a proven success can overtake a text-similar failed attempt even when the distractor scores 5–6× higher in raw BM25`,
    `  🛡️ CI bench gate widened to both home + external corpora with committed floors (\`npm run bench:gate\`) — recall quality can never silently regress again`,
    `  📊 121 MCP tools`,
  ],
  '0.10.98': [
    `🌐 **Model-Neutrality as Feature (W9) — "Bring your own model, keep your brain."**`,
    `  🔌 New \`brain_portability()\` — shows your Brain ID, all compatible MCP clients, and ready-to-paste config snippets for each; proves the same Brain works in Claude, Cursor, Copilot, Windsurf, Cline, Zed and more`,
    `  🧠 Your lessons, crystals, and predictions are model-agnostic — no vendor lock-in at the memory layer`,
    `  📖 New docs: cachly.dev/docs/model-neutral — "Same Brain, Any Model" guide with live config examples`,
    `  📊 121 MCP tools (new: \`brain_portability\`)`,
  ],
  '0.10.97': [
    `💠 **Team Crystallize (W8) — the team-wide, causal counter to per-user "Dreaming"**`,
    `  🧬 New \`team_crystallize()\` — surfaces fixes that 2+ teammates *independently converged on*, the one thing a single-user memory structurally can't build`,
    `  🧩 Cross-person clustering: groups structurally similar problems across people & namespaces (e.g. "pool exhaustion" solved the same way in payments, auth & db)`,
    `  👥 Each pattern names who converged — instant "ask @alice and @bob, they both hit this"`,
    `  💎 Shows up in \`crystal_view\` alongside your per-brain crystal`,
    `  📊 120 MCP tools (new: \`team_crystallize\`)`,
  ],
  '0.10.96': [
    `🔐 **Roles & Team-Scopes now ENFORCED (W6) — the enterprise governance layer**`,
    `  🛡️ \`team_confirm\` is now reviewer-gated, \`team_learn\` blocks viewers (recall-only) — roles stop being cosmetic the moment an admin is assigned`,
    `  📜 New \`team_audit\` tool — immutable, admin-only trail of every role change & lesson confirmation, for compliance & security reviews`,
    `  🔓 Zero impact on open teams: governance activates only once you bootstrap an admin; before that everything works exactly as before`,
    `  📊 119 MCP tools (new: \`team_audit\`)`,
  ],
  '0.10.95': [
    `🧠 **Domain Brain Marketplace (W10) — bootstrap your Brain with curated community knowledge**`,
    `  🛒 \`brain_marketplace()\` — browse installable packs of high-trust lessons by domain: ☸️ Kubernetes, 🔐 Auth, 🗄️ Database, ⚛️ React, 💳 Payments & more`,
    `  📦 \`brain_install(slug="k8s")\` — merges a domain's verified lessons into your Brain; live in \`smart_recall\` instantly, even offline`,
    `  🛡️ Idempotent + non-destructive: installed lessons are tagged \`source:"marketplace:<slug>"\` and NEVER override your own`,
    `  🔌 New gRPC \`Subscribe\` RPC — agents get new lessons streamed live the moment they're learned (completes the M2M loop with \`Learn\`)`,
    `  📊 118 MCP tools (new: \`brain_marketplace\`, \`brain_install\`)`,
  ],
  '0.10.94': [
    `🤝 **Person↔Person Collaboration Graph (W5) — "Frag X und Y, die haben das zusammen gelöst"**`,
    `  🕸️ New \`brain_collab_pairs()\` tool: shows every contributor pair who've touched the same files or recalled each other's lessons — ideal for onboarding and bus-factor analysis`,
    `  📡 \`smart_recall\` now wires CKG \`collaborates\` edges live when cross-author reuse fires — collaboration graph grows with every team recall`,
    `  ⚠️ Bus-factor section: flags solo contributors whose knowledge no teammate has yet recalled`,
    `  📊 116 MCP tools (new: \`brain_collab_pairs\`)`,
  ],
  '0.10.93': [
    `🗺️ **\`brain_plan\` — your Brain goes from "what did we learn?" to "what should I do?"**`,
    `  🧭 Give it a task you're about to start ("upgrade Postgres 14→16") and it returns an ordered, grounded action plan: ranked failure modes to avoid, proven fix steps (dependency-aware, with commands), and a pre-flight checklist — all from your own lessons`,
    `  🔬 Generative layer on the CKG: where \`brain_predict\` answers "what might fail?", \`brain_plan\` answers "what, in what order?"`,
    `  📊 115 MCP tools (new: \`brain_plan\`)`,
  ],
  '0.10.92': [
    `👋 **Welcome-back digest — re-entry after a week away now leads with what changed**`,
    `  🌱 \`session_start\` detects a gap ≥ 7 days and surfaces how many lessons your Brain gained while you were gone (git, CI & teammates kept it learning), with the freshest topics`,
    `  🧠 Zero extra latency — the digest is computed from data session_start already loads`,
    `  🔌 New gRPC \`Learn\` RPC (M2M write path) — agents & CI can now teach the Brain directly, byte-compatible with the MCP lesson format`,
    `  📊 115 MCP tools`,
  ],
  '0.10.91': [
    `🕐 **Lesson-anchored time attribution — every recall shows when it was learned and how much it saves**`,
    `  💡 "Brain saved you" banner now includes: when the lesson was learned (e.g. "12 May"), estimated original debug cost by severity (critical=2h, major=1h, minor=20min), and team attribution when a teammate's lesson fires`,
    `  📅 Origin date formatted as "12 May" (same year) or "12 May 2024" (different year) — no clutter`,
    `  👥 Cross-author recalls now show "@author" on the same banner line — the "team knowledge reuse" value is front-and-center`,
    `  📊 115 MCP tools`,
  ],
  '0.10.90': [
    `📊 **External benchmark corpus v2 — the proof is now statistically solid**`,
    `  🧪 Expanded from 8 queries → 61 lessons / 56 queries across 10 real-world engineering domains (k8s, DB, auth, CI, frontend, API, payments, observability, network, Node.js, security, infra)`,
    `  ⚔️  10 adversarial distractors added — failure lessons that share the exact same vocabulary as the query, forcing the quality reranker to earn its lift`,
    `  📈 Results on the larger corpus: cachly +2.9% Precision@1 vs flat-file, +12.5% vs raw BM25 baseline — on a harder dataset, not an easy one`,
    `  📊 115 MCP tools`,
  ],
  '0.10.89': [
    `⚡ **One-command onboarding — \`autopilot\` is now the single canonical setup**`,
    `  🚀 Every surface (README, docs, emails, dashboard, blog) now leads with \`npx @cachly-dev/mcp-server@latest autopilot\` — one command signs you in, configures every editor, and bootstraps from git`,
    `  🧹 Retired the split-brain instructions (legacy \`@cachly-dev/init\` wrapper + the old "three steps") so there's exactly one thing to copy-paste`,
    `  🔧 Fixed a build-breaking duplicate \`export\` on buildClaudeMdBlock that failed CI on v0.10.88`,
    `  🔢 Version hygiene — package.json, server.json, lockfile and MCP_VERSION resynced (server.json/lockfile were stuck at 0.10.85)`,
    `  📊 115 MCP tools`,
  ],
  '0.10.88': [
    `✅ **Honest setup + tested config writer (v0.10.88)**`,
    `  🔒 setup/autopilot now report the truth: if no editor config could be written it exits non-zero with the exact failures instead of falsely claiming "Brain is ready"`,
    `  📊 New setup_config_write_failed telemetry — permission/path failures that block activation are now visible in reporting`,
    `  🧪 24 new unit tests for the config writer (buildServerEnv, buildMcpConfig, mergeMcpConfig, buildClaudeMdBlock) — the merge logic that must never clobber your other MCP servers is now regression-guarded`,
    `  📊 115 MCP tools`,
  ],
  '0.10.87': [
    `🌐 **Multi-editor auth persistence + full activation telemetry (v0.10.87)**`,
    `  ✅ JWT + instance_id now persisted to Cursor (\`~/.cursor/mcp.json\`) and Windsurf configs on auth — no more infinite re-auth for non-Claude-Code users`,
    `  📡 \`device_flow_failed(reason="timeout")\` now fires when sign-in window expires — blind spot in the funnel is gone`,
    `  📡 \`auto_provision_failed\` now fires on network errors too (was only HTTP non-2xx)`,
    `  📡 \`brain_from_git_failed\` fires with error reason when auto-bootstrap throws — no more empty brain with no explanation`,
    `  ✨ Git bootstrap shows lesson count in session_start: "Brain bootstrapped — 23 lessons loaded" — the WOW moment`,
    `  🔧 API: McpEvent stores brain quality metrics (fixes/features/refactors/total) — git learning quality now measurable`,
    `  📊 115 MCP tools`,
  ],
  '0.10.86': [
    `🛡️ **Zero-friction activation — your Brain self-heals into existence**`,
    `  🔧 Auto-provision now runs on *any* tool call, not just at sign-in — if instance creation ever fails once, the next call recovers it automatically`,
    `  🤝 Parallel tool calls on startup are coalesced into one resolve (no more duplicate-instance races)`,
    `  💬 Clearer "instance still starting" message — leads with "just retry", no manual config needed`,
    `  📈 New activation-funnel telemetry: install → sign-in → provision, so silent churn is visible`,
    `  📊 115 MCP tools`,
  ],
  '0.10.85': [
    `🚀 **One-command onboarding — \`npx @cachly-dev/mcp-server@latest autopilot\`**`,
    `  ⚡ Single command does it all: auth → instance → every editor config → CLAUDE.md → Brain bootstrap → health`,
    `  🌱 Seeds the 16-lesson starter corpus when git history is empty — your first smart_recall hits instantly`,
    `  🤖 Fully automatic (zero prompts); \`setup\` remains for interactive, pick-your-editors onboarding`,
  ],
  '0.10.84': [
    `🤖 **M2M & agent-ecosystem reach — cachly for every caller, human or machine**`,
    `  🔑 OAuth2 \`client_credentials\` grant — set CACHLY_CLIENT_ID + CACHLY_CLIENT_SECRET for fully headless auth (CI, agents, AI-to-AI)`,
    `  🗂️ \`npx ... tool-specs --format=openai|anthropic|langchain\` — export all 121 tools in any framework's dialect`,
    `  🌐 \`npx ... openapi\` — OpenAPI 3.1 doc (1 POST path per tool) for Assistants / codegen / Postman`,
    `  🧪 14 new tests: client_credentials helpers, all four spec dialects, OpenAPI required-body inference`,
  ],
  '0.10.83': [
    `🧠 **Brain Viz — 3D graph export**`,
    `  🌐 \`brain_graph(instance_id)\` — exports the Causal Knowledge Graph as a render-ready {nodes, links} payload`,
    `  🎨 Schema \`cachly.brain_graph/v1\`: node kinds (concept/person/file/service) with color groups + size, edges with confidence`,
    `  🖥️ Consumed verbatim by the 3D frontend (react-force-graph-3d / three.js) — the visual brain map`,
    `  🔎 Filters: \`domain\`, \`min_confidence\`, \`max_nodes\` (with truncation flag), \`format="summary"\``,
    `  🧪 10 tests: kind detection, dangling-edge pruning, confidence/domain filters, schema contract`,
    `  📊 115 MCP tools`,
  ],
  '0.10.82': [
    `📡 **Telemetry API contracts — dashboard ingest pipeline prepared**`,
    `  🗂️ \`src/telemetry-types.ts\` — canonical event types + resolved event format (TelemetryEventRaw / TelemetryEventResolved)`,
    `  🔐 \`user_fingerprint\` — non-reversible JWT sub hash, PII-free user clustering for dashboard`,
    `  📊 \`metrics\` block on key events: smart_recall (hit/topic), brain_from_git (fixes/features/total), brain_seed_starter (seeded_count)`,
    `  🚦 Internal API contract documented: GET /internal/telemetry/stream → TelemetryEventResolved[]`,
  ],
  '0.10.81': [
    `⏱️ **Onboarding-Bench — time-to-first-recall, now measured**`,
    `  📐 \`npm run bench:onboarding\` — cold (empty) vs seeded (starter) first-query hit rate via the real search engine`,
    `  📊 Result: first-query hit@1 **0% → 87.5%**, hit@3 **0% → 100%**, MRR **0% → 93.8%**`,
    `  🛡️ CI-defended in \`onboarding-bench.test.ts\` (cold must answer 0%, seeded thresholds enforced)`,
    `  📋 \`PLAN-DASHBOARD.md\` — full build spec for the external Team-Knowledge-Reuse dashboard (separate repo)`,
  ],
  '0.10.80': [
    `🌱 **Starter corpus — first recall in seconds, not sessions**`,
    `  📚 \`brain_seed_starter(instance_id)\` — seed 16 curated universal lessons (Docker cache, JWT skew, K8s OOM, N+1, cache stampede…)`,
    `  🚀 Auto-seeds on first session when git history is empty/shallow — your first \`smart_recall\` returns a real hit`,
    `  🛡️ Tagged \`source:"starter"\`, idempotent, never overrides your own lessons`,
    `  ⏱️ Directly attacks time-to-first-recall (<2 min goal); stamps \`born_at\` on seed`,
    `  🧪 18 new tests: seeding, idempotency, topic_filter, force, user-lesson protection`,
    `  📊 113 MCP tools`,
  ],
  '0.10.79': [
    `🌐 **Brain Marketplace — full shareable Brain lifecycle**`,
    `  📋 \`brain_share_list(instance_id)\` — see all your public shares with lesson counts + share IDs`,
    `  🗑️ \`brain_unshare(share_id)\` — revoke a share; link goes dead immediately`,
    `  🔍 \`brain_discover(query, topic)\` — search public Brains in the cachly marketplace`,
    `  📤 \`publish\` CLI — fancy card + share URL; \`--public\` for discoverable; \`--title\` custom name`,
    `  🧪 stress tests: team_expertise_map with 50 contributors, chain import/unshare, discover fallback`,
    `  📊 112 MCP tools`,
  ],
  '0.10.78': [
    `🌐 **Phase 3: Shareable / Public Brains**`,
    `  📤 \`brain_share(instance_id="...")\` — export a Brain snapshot as a shareable link (public or unlisted)`,
    `  📥 \`brain_import(instance_id="...", share_id="...")\` — import any public Brain into yours (1-line)`,
    `  🔍 Optional topic_filter, min_confidence, topic_prefix — precise control over what gets shared/imported`,
    `  🔒 dry_run mode on both tools — preview before committing`,
    `  🧪 Regression suite added: share handler, buildServerEnv, stdout cleanness`,
    `  📊 109 MCP tools`,
  ],
  '0.10.77': [
    `🩹 **Frictionless onboarding + first-class self-hosting/BYOK**`,
    `  🚀 Editor-launched server now serves all tools even before sign-in — zero-credential device flow finally triggers on first tool call`,
    `  🔒 No more stdout pollution: stdio JSON-RPC stream stays clean when no JWT is set`,
    `  🏠 \`setup --api-url\` / \`init --api-url\` point at a self-hosted backend; URL baked into config only when non-default`,
    `  🧬 \`health\` now shows your BYOK embedding provider + accepts cky_ long-lived keys (was a false "invalid token" failure)`,
  ],
  '0.10.76': [
    `📊 **Agent-trace benchmark + editor matrix + setup timer**`,
    `  📂 New \`agent-traces-corpus.json\` — 22 lessons, 15 queries, realistic AI-agent debug patterns`,
    `  🏆 Benchmark result: **P@1 +66.7%, MRR +9.5% vs flat-file** (adversarial failure-distractors per category)`,
    `  📋 README: first-class editor support matrix (Claude Code, Cursor, Windsurf, VSCode, Cline, Continue.dev, Zed)`,
    `  ⏱️  setup now shows elapsed time + "Brain is ready" banner at the end`,
  ],
  '0.10.75': [
    `🩹 **Setup hardened — works from the VSCode plugin & any non-TTY terminal**`,
    `  🔌 \`setup\` no longer hangs on a non-interactive stdin (VSCode tasks, CI) — auto-detects + runs in automatic mode`,
    `  🔐 Device-flow now uses the API proxy first (the old direct-Keycloak call returned 403) — sign-in actually completes`,
    `  🌐 When auto sign-in is unavailable, the browser opens with a step-by-step API-key guide instead of a silent paste prompt`,
    `  📊 Funnel fix: \`device_flow_completed\` / \`device_flow_failed(reason)\` now emitted from setup too`,
  ],
  '0.10.73': [
    `🔐 **Team visibility scopes + one-command init + external bench**`,
    `  🆕 \`team_grant_scope\` / \`team_scopes\` — scope lessons to a sub-team (group="security"); only members + admins recall them`,
    `  🏷️ \`learn_from_attempts(group="...")\` — orthogonal to private; smart_recall enforces it per requester`,
    `  ⚡ \`init\` is now zero-arg + idempotent (reuses saved creds, only writes what changed, <60s)`,
    `  📦 \`npm run bench:external\` — prove recall-lift on a third-party-labeled corpus (portable JSON format)`,
    `  📊 107 MCP tools`,
  ],
  '0.10.72': [
    `👑 **Role model — admin · reviewer · contributor · viewer (Phase 3)**`,
    `  🆕 \`team_assign_role\` — establish governance; first call bootstraps, admins manage the rest`,
    `  🆕 \`team_whoami\` — see your own role and capabilities`,
    `  🆕 \`team_roster\` — full team role table (👑🛡️✏️👁️)`,
    `  🛡️ \`team_confirm\` is now role-aware — admin/reviewer auto-get senior weight; contributor gets peer; no self-promotion`,
    `  👑 Setup CLI now prompts for governance bootstrap (idempotent). 105 MCP tools`,
  ],
  '0.10.71': [
    `🛡️ **Self-healing auth** — no more silent "0 recalls because the token quietly died"`,
    `  ♻️ Near-expiry tokens auto-refresh into a long-lived key while still valid (zero interaction)`,
    `  🔁 A rejected (401) call self-heals once and retries before surfacing an error`,
    `  📣 If the credential is truly dead, session_start + get_api_status say so plainly + how to fix`,
  ],
  '0.10.70': [
    `🛰️ **Service/System nodes in the graph (Phase 3)** — the brain now models running systems`,
    `  🆕 \`brain_service_map(service="prometheus")\` — who owns it + every failure/fix known`,
    `  🏷️ Tag lessons with \`service="..."\` (\`service_kind="system"\` for infra) — person→operates, file→runs_in edges`,
    `  🚨 Incident triage: a restarting pod → instant "who knows this and what's broken before"`,
    `  📊 102 MCP tools`,
  ],
  '0.10.69': [
    `📁 **Personalized context-aware recall (Phase 3)** — pass \`context_files\` to \`smart_recall\``,
    `  🎯 Lessons learned on your current files bubble up — even when the query doesn't name the file`,
    `  🏷️ \`📁 context match\` badge on every file-boosted result so you know WHY it ranked up`,
    `  ✅ Works alongside keyword, semantic, CKG, and governance signals — a 6th ranking dimension`,
  ],
  '0.10.68': [
    `🤝 **Collaboration graph (Phase 3)** — person↔person edges from shared files`,
    `  👥 \`brain_who_knows\` now shows who the top expert frequently works with`,
    `  🚌 Bus-factor insight: "ask X and Y together — they solved this on shared files"`,
    `  🛡️ Stability: every network call in the agent hot path is now timeout-bounded`,
  ],
  '0.10.64': [
    `📈 **The three decisive metrics, now measurable**`,
    `  ⏱️ \`brain_metrics()\` — time-to-first-recall, recall-lift, team-knowledge-reuse in one view`,
    `  👥 Cross-author reuse tracked: recall a teammate's lesson → counted + surfaced inline`,
    `  🛡️ Stability: scans now capped + timed out (a huge keyspace can't hang the agent)`,
  ],
  '0.10.61': [
    `🎯 **Phase 3C: 100 MCP tools milestone — zero-setup knowledge graph**`,
    `  🔄 \`brain_from_git\` now auto-builds Person+File nodes from git history (zero setup!)`,
    `  🔍 \`skill_gaps()\` — find domains with unresolved failures, missing attribution`,
    `  📊 \`brain_coverage()\` — scored 0-100 health report: lessons · attribution · file coverage`,
  ],
  '0.10.60': [
    `🆕 **Phase 3B: File map + team overview + visibility**`,
    `  📁 \`brain_file_map(file_paths=[...])\` — experts + lessons per file before you touch it`,
    `  🗺️ \`team_expertise_map()\` — full team skills matrix in one table`,
    `  🔒 \`visibility: "private"\` on \`learn_from_attempts\` — private notes never leak to smart_recall`,
    `  📊 98 MCP tools`,
  ],
  '0.10.59': [
    `🆕 **Phase 3A: Org-wide knowledge graph**`,
    `  👥 \`brain_who_knows(topic="...")\` — find your team's experts on any topic instantly`,
    `  🕸️ Person + File nodes auto-built from \`learn_from_attempts(author="...", file_paths=[...])\``,
    `  👤 Author attribution now shown inline in \`smart_recall\` results`,
    `  📊 96 MCP tools · 386 tests green`,
  ],
  '0.10.58': [
    `🧹 Zero lint warnings — all unused imports cleaned across every handler`,
    `✅ Build: 0 errors, 0 warnings · 379 tests green`,
  ],
  '0.10.57': [
    `🆕 **What's new in v${MCP_VERSION}:**`,
    `  🔧 **Critical fix** — corrected the npm bin/main entry path (\`dist/src/index.js\`); 0.10.50–0.10.52 shipped a broken entry point`,
    `  🔧 Version hygiene — synced package.json, server.json, lockfile, MCP_VERSION; \`latest\` now points forward again`,
    `  ✅ Accurate tool count (95) across README, server.json, CLI banners`,
    `  ✅ Includes all Phase 2/3 work: quality reranking, Cachly-Bench, hybrid + CKG recall, team_confirm governance`,
  ],
  '0.10.52': [
    `  ✅ \`smart_recall\` — CKG traversal as Layer 3: finds lessons that FIXED causal-graph-similar problems (🕸️ causal graph badge)`,
    `  ✅ Bench corpus expanded: governance adversarial pair proves review-boost end-to-end (+22% P@1 headline)`,
    `  🔧 Import cleanup: unused symbols removed from brain.ts (no functional change)`,
    `  💡 \`smart_recall\` now shows keyword / semantic / CKG / hybrid match type for every result`,
  ],
  '0.10.51': [
    `  ✅ \`team_confirm\` — human review raises lesson recall ranking (🛡️ senior / ✔️ peer)`,
    `  ✅ Governance-aware recall — confirmed lessons outrank unreviewed auto-learned entries`,
  ],
  '0.10.50': [
    `  ✅ \`smart_recall\` — unified keyword + semantic hybrid list (one ranked result, not two sections)`,
    `  ✅ \`smart_recall\` — "Brain saved you here" banner surfaces time saved inline per proven lesson`,
    `  ✅ Quality reranking — proven successes outrank symptom-dense failures (+11% Precision@1)`,
    `  ✅ Cachly-Bench — IR benchmark with CI regression guard (see BENCH.md for the proof)`,
    `  🔧 Contradiction resolution now persisted to Redis (90-day TTL)`,
    `  💡 Run \`smart_recall\` to see your Brain's recall quality in action`,
  ],
  '0.10.49': [
    `  ✅ \`brain_from_git\` — auto-seed your Brain from git history in seconds`,
    `  ✅ \`brain_predict_failures\` — predict CI/build failures before they happen`,
    `  ✅ VS Code extension — Brain status bar, ambient learning, CodeLens hints`,
    `  ✅ Team Brain — share lessons across your whole engineering team`,
    `  🔧 Stability — auto-expiring memory keys, longer provisioning wait, robust recall`,
  ],
};

// Shared types used in brain handlers
export interface Instance {
  id: string; name: string; tier: string; status: string; region: string;
  host?: string; port?: number; password?: string; tls_enabled?: boolean;
  vector_token?: string; memory_mb: number; encryption_at_rest: boolean;
  created_at: string;
  // org_id links the instance to an Organization; present when the instance is
  // owned by an org. Used by brain_predict(scope="org") to resolve the org graph.
  org_id?: string;
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
  'session_start', 'session_start_summary', 'session_end', 'session_ping', 'session_handoff', 'auto_learn_session',
  'brain_who_knows', 'brain_file_map', 'team_expertise_map',
  'skill_gaps', 'brain_coverage', 'brain_metrics', 'brain_service_map',
  'brain_collab_pairs', 'brain_portability', 'brain_changelog',
  'brain_set_pref', 'brain_get_pref',
]);

// ── Free-tier Teaser-Gate ──────────────────────────────────────────────────
// When a Free-tier Brain crosses its recall limit, smart_recall still delivers
// the top hits — the magic moment is sacred — but withholds the long tail
// behind an upgrade teaser ("🔒 N more relevant lessons available"). This is a
// DEPTH gate (hide the tail), never an access wall: the #1 result is always
// returned. Usage/limit come from the same authoritative numbers as the Brain
// Health bar (GET /instances/:id/memory), cached briefly to avoid per-call latency.
const UPGRADE_URL = cachlyUrl('/billing', 'upgrade');

interface RecallGate {
  reached: boolean; // true only when the tier has a finite limit AND it's been hit
  limit: number; // -1 = unlimited
  used: number;
  goodwillMessage?: string; // set the month a free user is gifted +250 recalls
}

const _recallGateCache = new Map<string, { gate: RecallGate; expiresAt: number }>();

// ── Recall quota: ONE unit per recall CALL ───────────────────────────────────
// The gate above reads a monthly counter that this function writes. It counts
// calls, not lessons.
//
// It used to be derived from the sum of every lesson's recall_count, and a
// single smart_recall bumps up to five of those — so a free user burned their
// 500 in about a hundred real calls and the number kept climbing past the cap.
// The API's REST recall endpoint counts itself; this is the MCP side of the
// same counter, and without it the cap would simply never be reached here.
const RECALL_QUOTA_TTL_SECONDS = 70 * 24 * 60 * 60;

function recallQuotaKey(now: Date = new Date()): string {
  // UTC month, matching the API's t.UTC().Format("2006-01"). Month-scoping in
  // the key is what makes the quota reset with no cron and no baseline.
  return `cachly:quota:recalls:${now.toISOString().slice(0, 7)}`;
}

async function bumpRecallQuota(redis: Redis): Promise<void> {
  try {
    const key = recallQuotaKey();
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, RECALL_QUOTA_TTL_SECONDS);
  } catch {
    // Accounting must never fail a recall. Under-counting costs us a little
    // revenue; a thrown error costs the user the answer they asked for.
  }
}

async function getRecallGate(instanceId: string, apiFetch: ApiFetch): Promise<RecallGate> {
  const cached = _recallGateCache.get(instanceId);
  if (cached && cached.expiresAt > Date.now()) return cached.gate;
  try {
    const mem = await apiFetch<{
      total_recall_count?: number;
      recall_limit?: number;
      goodwill_message?: string;
    }>(`/api/v1/instances/${instanceId}/memory`);
    const limit = mem?.recall_limit ?? -1;
    const used = mem?.total_recall_count ?? 0;
    const gate: RecallGate = {
      reached: limit > 0 && used >= limit,
      limit,
      used,
      goodwillMessage: mem?.goodwill_message,
    };
    _recallGateCache.set(instanceId, { gate, expiresAt: Date.now() + 60_000 });
    return gate;
  } catch {
    // Stats unavailable → never gate (fail open: value delivery beats monetization).
    return { reached: false, limit: -1, used: 0 };
  }
}

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
        visibility = 'team',
        service = '',
        service_kind = 'service',
        group = '',
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
        visibility?: 'public' | 'team' | 'private';
        service?: string;
        service_kind?: 'service' | 'system';
        group?: string;
      };

      const redis = await getConnection(instance_id);
      const ts = new Date().toISOString();

      // ── Lessons-Review workflow (P1-1) ─────────────────────────────────────
      // When the org enabled pending-mode on this (shared) brain, team-visible
      // lessons become proposals awaiting owner/admin approval instead of
      // landing in the recall keyspace. Private notes stay direct — they never
      // surface in team recall anyway. Flag absent = direct write, as before.
      if (visibility !== 'private' && await reviewModeEnabled(redis, instance_id)) {
        return storeLessonProposal(redis, topic, {
          topic, outcome, what_worked, what_failed, context: ctx, severity,
          file_paths, commands, tags, depends_on,
          ...(author ? { author } : {}),
          ...(service ? { service } : {}),
          ...(group ? { group: String(group).toLowerCase().trim() } : {}),
          visibility, recall_count: 0, ts, confidence: 1.0, version: 3,
        });
      }

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
      let lastRecalledAt: string | undefined;
      let auditTrail: Array<{ ts: string; action: string; prev_outcome?: string }> = [];
      const existingRaw = await redis.get(`cachly:lesson:best:${topic}`);
      if (existingRaw) {
        try {
          const prev = JSON.parse(existingRaw) as {
            recall_count?: number;
            last_recalled_at?: string;
            outcome?: string;
            audit_trail?: Array<{ ts: string; action: string; prev_outcome?: string }>;
          };
          recallCount = prev.recall_count ?? 0;
          lastRecalledAt = prev.last_recalled_at; // learn never stamps it — only recall does
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
            // Persist a queryable resolution record — so contradiction history survives
            // (CKG edges alone aren't easily auditable). Bounded + TTL'd like other history.
            try {
              const resolutionKey = `cachly:contradictions:${topic}`;
              const direction = prev.outcome === 'success' && outcome === 'failure'
                ? 'kept-success' : 'overwrote-failure';
              await redis.rpush(resolutionKey, JSON.stringify({
                ts, prev_outcome: prev.outcome, new_outcome: outcome, direction,
              }));
              await redis.ltrim(resolutionKey, -50, -1);
              await redis.expire(resolutionKey, 180 * 86400);
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
        ...(service ? { service } : {}),
        ...(group ? { group: String(group).toLowerCase().trim() } : {}),
        visibility,
        recall_count: recallCount,
        ...(lastRecalledAt ? { last_recalled_at: lastRecalledAt } : {}),
        ts,
        verified_at: outcome === 'success' || outcome === 'partial' ? ts : undefined,
        confidence: 1.0,
        audit_trail: auditTrail,
        version: 3,
      };
      const lesson = JSON.stringify(lessonObj);

      // Metric 1 (time-to-first-recall): mark the moment the Brain first gained
      // knowledge. SET NX so only the very first learn wins. Fire-and-forget.
      redis.set(`cachly:stats:born_at:${instance_id}`, ts, 'EX', 365 * 86400, 'NX').catch(() => {});

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
              beliefConflict = `⚠️ **belief_conflict** on \`${topic}\`: previously confirmed fix (confidence ${existEdge.confidence.toFixed(2)}, n=${existEdge.trials}) now reports failure. Both beliefs retained as \`contested\`. Use \`brain_resolve_conflict(instance_id="...", topic="${topic}", winner="success"|"failure")\` to arbitrate, or \`ckg_inspect(concept="${conceptId}")\` to review.`;
              // Store conflict marker — records WHICH agent reported the contradiction
              // so multi-agent arbitration can show both sides (Move 4).
              const conflictKey = `cachly:ckg:conflict:${conceptId}`;
              await redis.set(conflictKey, JSON.stringify({
                topic,
                concept_id: conceptId,
                detected_at: new Date().toISOString(),
                fix_confidence: existEdge.confidence,
                fix_trials: existEdge.trials,
                failure_outcome: outcome,
                reported_by: author || 'unknown',
                what_failed: what_failed || '',
                resolved: false,
              }), 'EX', 60 * 60 * 24 * 90);
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

      // ── Phase 3A: People + File nodes in knowledge graph ──────────────────────
      // Builds the "who knows what" map automatically from author + file_paths.
      // Person → authored → Concept edges power brain_who_knows queries.
      if (author) {
        // Agent activity registry (Move 4): track which agents are actively
        // writing to this Brain, keyed by author, with a 1h TTL. Powers
        // brain_conflicts' "who is live" view and multi-agent arbitration.
        redis.set(
          `cachly:agents:active:${author}`,
          JSON.stringify({ author, last_topic: topic, last_outcome: outcome, ts: new Date().toISOString() }),
          'EX', 60 * 60,
        ).catch(() => {});
        try {
          const domain = topic.split(':')[0] ?? 'unknown';
          const personId = await ckgUpsertPersonNode(redis, author, domain);
          const conceptId = ckgSlug(topic);
          await ckgUpdateEdge(redis, personId, 'authored', conceptId, outcome === 'success', outcome === 'partial');
          for (const fp of file_paths.slice(0, 8)) {
            const fileId = await ckgUpsertFileNode(redis, fp);
            await ckgUpdateEdge(redis, personId, 'touched', fileId, true);
            // Phase 3: link this author to everyone else who touched the same file.
            await ckgRecordCollaboration(redis, fileId, personId);
          }
        } catch { /* non-critical */ }
      }

      // ── Phase 3: Service/System nodes ─────────────────────────────────────────
      // When a lesson names the service/system it concerns (e.g. "prometheus",
      // "cachly-web"), wire it into the graph: person→operates→service,
      // concept→affects→service, file→runs_in→service. This is what lets
      // brain_service_map answer "who owns X and what's gone wrong with X before".
      if (service && typeof service === 'string' && service.trim()) {
        try {
          const domain = topic.split(':')[0] ?? 'unknown';
          const kind = service_kind === 'system' ? 'system' : 'service';
          const serviceId = await ckgUpsertServiceNode(redis, service.trim(), domain, kind);
          const conceptId = ckgSlug(topic);
          // concept → affects → service (outcome decides edge confidence)
          await ckgUpdateEdge(redis, conceptId, 'affects', serviceId, outcome === 'success', outcome === 'partial');
          if (author) {
            const personId = `person:${ckgSlug(author)}`;
            await ckgUpdateEdge(redis, personId, 'operates', serviceId, true);
          }
          for (const fp of file_paths.slice(0, 8)) {
            const fileId = `file:${ckgSlug(fp)}`;
            await ckgUpdateEdge(redis, fileId, 'runs_in', serviceId, true);
          }
        } catch { /* non-critical */ }
      }

      // ── Ambient team propagation: if author is set + outcome is success,
      // auto-store as a team lesson so knowledge is shared without a separate
      // team_learn call. Tags gain 'team'; the lesson is attributed to the author.
      // This makes team knowledge sharing the default, not the opt-in.
      if (author && (outcome === 'success' || outcome === 'partial')) {
        const teamLesson = {
          topic, outcome, what_worked,
          what_failed: what_failed ?? '',
          severity,
          author,
          file_paths,
          commands,
          tags: [...new Set([...tags, 'team'])],
          timestamp: new Date().toISOString(),
          recall_count: 0,
          version: 2,
          auto_propagated: true,
        };
        const teamListKey = `cachly:lessons:${topic}`;
        redis.rpush(teamListKey, JSON.stringify(teamLesson)).catch(() => {});
      }

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
        (author && (outcome === 'success' || outcome === 'partial'))
          ? `👥 Auto-shared with team (by _${author}_) — visible in \`team_recall\``
          : '',
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

        // Recall resets verified_at (confidence clock restart) and stamps
        // last_recalled_at so the recall-quality dashboard can measure recency.
        const recalledAt = new Date().toISOString();
        const updatedLesson = {
          ...lesson,
          recall_count: (lesson.recall_count ?? 0) + 1,
          verified_at: recalledAt,
          last_recalled_at: recalledAt,
          confidence: 1.0,
        };
        await redis.set(`cachly:lesson:best:${topic}`, JSON.stringify(updatedLesson));

        // A targeted lookup is a recall too, and costs the same one quota unit
        // as a broad smart_recall — the user asked the brain a question either way.
        void bumpRecallQuota(redis);

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
          // what_worked may be empty for unresolved failure lessons (the API
          // accepts empty what_worked when outcome=failure) — skip the line.
          lesson.what_worked ? `**What worked:** ${lesson.what_worked}` : '',
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
        author: requester = '',
        context_files: rawContextFiles = [],
      } = args as { instance_id: string; query: string; threshold?: number; author?: string; context_files?: unknown[] };
      const contextFiles: string[] = Array.isArray(rawContextFiles)
        ? rawContextFiles.filter((f): f is string => typeof f === 'string')
        : [];

      const redis = await getConnection(instance_id);

      // Team-level visibility scopes: resolve the requester's group memberships +
      // admin status once, so group-scoped lessons only surface for members/admins.
      let requesterScopes = new Set<string>();
      let requesterIsAdmin = false;
      if (requester) {
        requesterScopes = await getScopes(redis, instance_id, requester).catch(() => new Set<string>());
        const reqRole = await getRole(redis, instance_id, requester).catch(() => null);
        requesterIsAdmin = reqRole === 'admin';
      }

      // ── Layer 1: Keyword search across ALL brain data (always works, no embedding) ──
      // Wider candidate pool (25) lets the quality reranker rescue relevant lessons that
      // BM25 alone would rank 11–25 due to vocabulary mismatch. Final slice to 5 happens below.
      const rawMatches = await keywordSearch(
        redis,
        ['cachly:ctx:*', 'cachly:lesson:best:*', 'cachly:idx:*'],
        query,
        25,
      );

      // ── Layer 1.5: Quality-aware rerank — proven success lessons outrank
      // text-similar failed attempts (the moat; see src/rerank.ts + Cachly-Bench). ──
      const kwMatches = rerankByQuality(rawMatches);

      // One quota unit for this call, regardless of how many lessons it surfaced.
      void bumpRecallQuota(redis);

      // Increment recall_count on matched lessons (fire-and-forget) + collect "Brain saved you here" signal.
      type RecalledLesson = { topic: string; severity: string; recall_count: number; savedMins: number; ts?: string; author?: string };
      const savedHere: RecalledLesson[] = [];
      // Exclude archived lessons — they are kept for audit but must not surface in recall.
      const lessonMatches = kwMatches.filter(m => m.key.startsWith('cachly:lesson:best:'));
      let crossAuthorThisCall = 0;
      let successRecallsThisCall = 0;
      for (const m of lessonMatches.slice(0, 5)) {
        const existing = await redis.get(m.key).catch(() => null);
        if (existing) {
          const lesson = safeJsonParse(existing, null as null | { recall_count?: number; outcome?: string; severity?: string; author?: string; ts?: string; state?: string; [k: string]: unknown });
          // Skip archived lessons — brain_hygiene moves them here; they should not resurface.
          if (lesson?.state === 'archived') continue;
          if (lesson) {
            const recalledAt = new Date().toISOString();
            const updated = { ...lesson, recall_count: (lesson.recall_count ?? 0) + 1, verified_at: recalledAt, last_recalled_at: recalledAt };
            redis.set(m.key, JSON.stringify(updated)).catch(() => {});
            const sev = lesson.severity as string;
            const savedMins = sev === 'critical' ? 240 : sev === 'major' ? 60 : 30;
            redis.incrbyfloat(`cachly:stats:time_saved_mins:${instance_id}`, savedMins).catch(() => {});

            // Metric 3 (team-knowledge-reuse): a recall of a lesson authored by
            // someone OTHER than the requester is cross-author reuse — the value
            // only cachly delivers. Track total proven recalls + cross-author ones.
            redis.incr(`cachly:stats:recalls_total:${instance_id}`).catch(() => {});
            if (lesson.author && requester && lesson.author !== requester) {
              crossAuthorThisCall++;
              redis.incr(`cachly:stats:cross_author_recalls:${instance_id}`).catch(() => {});
              redis.sadd(`cachly:stats:reuse_pairs:${instance_id}`, `${requester}<-${lesson.author}`).catch(() => {});
              // W5: wire person↔person CKG collaborates edges from knowledge-reuse events.
              // This feeds brain_collab_pairs and enriches brain_who_knows with reuse-based edges.
              const reqPersonId = `person:${ckgSlug(requester)}`;
              const authPersonId = `person:${ckgSlug(lesson.author!)}`;
              ckgUpdateEdge(redis, reqPersonId, 'collaborates', authPersonId, true).catch(() => {});
              ckgUpdateEdge(redis, authPersonId, 'collaborates', reqPersonId, true).catch(() => {});
            }

            if (lesson.outcome === 'success') successRecallsThisCall++;

            // Surface banner for proven successes (recall_count >= 1 means it's been validated)
            if (lesson.outcome === 'success' && (lesson.recall_count ?? 0) >= 1) {
              savedHere.push({
                topic: m.key.replace('cachly:lesson:best:', ''),
                severity: sev ?? 'major',
                recall_count: (lesson.recall_count ?? 0) + 1,
                savedMins,
                ts: lesson.ts,
                author: lesson.author,
              });
            }
          }
        }
      }

      // Metric 1 (time-to-first-recall): stamp the first time recall returned a
      // successful lesson. SET NX so only the first successful recall wins.
      // Deliberately NOT gated on savedHere: savedHere requires a pre-existing
      // recall_count >= 1, which would delay the stamp until the SECOND recall
      // and inflate every TTFR percentile derived from it.
      if (successRecallsThisCall > 0) {
        redis.set(`cachly:stats:first_recall_at:${instance_id}`, new Date().toISOString(), 'EX', 365 * 86400, 'NX').catch(() => {});
      }

      // ── Layer 2: Semantic search (parallel, optional) ────────────────────────
      // Semantic recall is a Premium depth layer: free tier keeps full keyword +
      // CKG recall (the magic moment), paid tiers add embedding-based retrieval.
      const inst = await apiFetch<Instance | null>(`/api/v1/instances/${instance_id}`).catch(() => null);
      const tierIsFree = !inst?.tier || inst.tier.toLowerCase() === 'free';
      type SemHit = { key: string; similarity: number; content: string };
      const semHits: SemHit[] = [];
      if (!tierIsFree && inst?.vector_token && hasEmbedProvider()) {
        try {
          const embedding = await computeEmbedding(query);
          const vectorUrl = `https://api.cachly.dev/v1/sem/${inst!.vector_token}`;
          const searchRes = await fetch(`${vectorUrl}/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embedding, namespace: 'cachly:ctx', threshold, top_k: 5 }),
            signal: AbortSignal.timeout(8000),
          });
          if (searchRes.ok) {
            const results = (await searchRes.json()) as SemanticSearchResponse[];
            for (const hit of results.filter(r => r.found && r.id)) {
              const parts = hit.id!.replace('ctx:', '').split(':');
              const category = parts[0];
              const key = parts.slice(1).join(':');
              const redisKey = `cachly:ctx:${category}:${key}`;
              const content = await redis.get(redisKey).catch(() => null);
              semHits.push({ key: redisKey, similarity: hit.similarity ?? 0, content: content ?? '(evicted)' });
            }
          }
        } catch {
          // Semantic search failed silently — keyword results are enough
        }
      }

      // ── Layer 3: Hybrid merge — one unified ranked list ──────────────────────
      // BM25 quality scores (already reranked) are re-normalized to [0,1] for merging.
      type HybridResult = {
        key: string; content: string; hybridScore: number;
        bm25Score?: number; semScore?: number; ckgScore?: number; matchedWords?: string[];
        matchType: 'keyword' | 'semantic' | 'ckg' | 'hybrid'; subQuery?: string;
        contextBoost?: boolean;
      };

      const bm25Scores = kwMatches.map(m => m.score);
      const bm25Min = bm25Scores.length ? Math.min(...bm25Scores) : 0;
      const bm25Range = bm25Scores.length ? (Math.max(...bm25Scores) - bm25Min) || 1 : 1;
      const bm25Norm = (s: number) => (s - bm25Min) / bm25Range;

      const hybridMap = new Map<string, HybridResult>();
      for (const m of kwMatches) {
        const n = bm25Norm(m.score);
        hybridMap.set(m.key, {
          key: m.key, content: m.content, bm25Score: n,
          hybridScore: n * (semHits.length > 0 ? 0.7 : 1.0),
          matchedWords: m.matchedWords, matchType: 'keyword', subQuery: m.subQuery,
        });
      }
      for (const hit of semHits) {
        const existing = hybridMap.get(hit.key);
        if (existing) {
          existing.semScore = hit.similarity;
          existing.hybridScore = (existing.bm25Score ?? 0) * 0.6 + hit.similarity * 0.4;
          existing.matchType = 'hybrid';
        } else {
          hybridMap.set(hit.key, {
            key: hit.key, content: hit.content, semScore: hit.similarity,
            hybridScore: hit.similarity * 0.5, matchType: 'semantic',
          });
        }
      }
      // ── Layer 3: CKG traversal — follow "fixes" edges to find lessons that solved
      // structurally similar problems, even when vocabulary differs ───────────────
      try {
        const qTokens = tokenize(query).filter(t => t.length >= 4).slice(0, 4);
        const candidateNodeIds = new Set<string>();
        for (const token of qTokens) {
          const nodeStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 20 });
          await new Promise<void>((res, rej) => {
            nodeStream.on('data', (batch: string[]) => {
              for (const k of batch.slice(0, 5)) candidateNodeIds.add(k.replace('cachly:ckg:node:', ''));
            });
            nodeStream.on('end', res);
            nodeStream.on('error', rej);
          });
        }

        const seenFroms = new Set<string>();
        for (const nodeId of [...candidateNodeIds].slice(0, 12)) {
          const inboundEdgeKeys = await redis.smembers(`cachly:ckg:idx:to:${nodeId}`);
          for (const ek of inboundEdgeKeys.slice(0, 6)) {
            const er = await redis.get(ek);
            if (!er) continue;
            const edge = safeJsonParse<CKGEdge | null>(er, null);
            if (!edge || edge.edgeType !== 'fixes' || edge.confidence < 0.35) continue;
            if (seenFroms.has(edge.from)) continue;
            seenFroms.add(edge.from);

            const lessonKey = `cachly:lesson:best:${edge.from}`;
            const existing = hybridMap.get(lessonKey);
            if (existing) {
              // Already found by BM25/semantic — boost with causal confirmation
              existing.ckgScore = Math.max(existing.ckgScore ?? 0, edge.confidence);
              existing.hybridScore = existing.hybridScore * 0.88 + edge.confidence * 0.12;
              if (existing.matchType === 'keyword') existing.matchType = 'hybrid';
            } else {
              const content = await redis.get(lessonKey).catch(() => null);
              if (!content) continue;
              hybridMap.set(lessonKey, {
                key: lessonKey, content,
                ckgScore: edge.confidence,
                hybridScore: edge.confidence * 0.30, // CKG-only: lower than text hits
                matchType: 'ckg',
              });
            }
          }
        }
      } catch { /* non-critical — keyword + semantic always available */ }

      // ── Layer 4: File-context personalization ────────────────────────────────
      // When the caller provides the files they are currently working on, lessons
      // that were learned in the context of those files get a score boost. This
      // surfaces file-specific institutional knowledge even when the query words
      // don't mention the file name — the structural advantage of a graph brain.
      if (contextFiles.length > 0) {
        const ctxSet = new Set(contextFiles.map(f => f.replace(/\\/g, '/')));
        for (const r of hybridMap.values()) {
          if (!r.key.startsWith('cachly:lesson:best:')) continue;
          const ld = safeJsonParse<{ file_paths?: unknown }>(r.content, {});
          const fps = Array.isArray(ld.file_paths)
            ? (ld.file_paths as unknown[]).filter((f): f is string => typeof f === 'string').map(f => f.replace(/\\/g, '/'))
            : [];
          if (fps.some(f => ctxSet.has(f))) {
            r.hybridScore *= 1.15;
            r.contextBoost = true;
          }
        }
      }

      // Apply lesson quality to the NON-keyword-only paths. Keyword & hybrid
      // entries already carry quality from the Layer-1.5 BM25 rerank
      // (rerankByQuality above), so re-multiplying them would double-count. But a
      // proven, senior-reviewed, high-severity success found ONLY via embeddings
      // (matchType 'semantic') or the causal graph (matchType 'ckg') previously
      // got zero quality lift — it ranked purely on similarity/edge-confidence.
      // Weight just those two so a trustworthy lesson isn't buried behind a
      // shallow-but-similar one.
      for (const r of hybridMap.values()) {
        if (r.matchType !== 'semantic' && r.matchType !== 'ckg') continue;
        const lq = extractLessonQuality({ key: r.key, content: r.content });
        if (lq) r.hybridScore *= qualityMultiplier(lq);
      }

      // Filter private lessons (recall_best_solution only) + enforce team scopes:
      // group-scoped lessons surface only for members of that group (admins see all).
      const hybridResults = [...hybridMap.values()]
        .filter(r => {
          if (!r.key.startsWith('cachly:lesson:best:')) return true;
          const ld = safeJsonParse<{ visibility?: string; group?: string }>(r.content, {});
          if (ld.visibility === 'private') return false;
          if (!lessonVisibleToScope(ld.group, requesterScopes, requesterIsAdmin)) return false;
          return true;
        })
        .sort((a, b) => b.hybridScore - a.hybridScore);

      // ── Teaser-Gate: free tier over its recall limit hides the long tail ──────
      const recallGate = await getRecallGate(instance_id, apiFetch);
      // Hard gate: once a free user is over their (monthly, goodwill-adjusted)
      // recall limit, the long tail is fully withheld until they upgrade or the
      // month resets. We still show the single highest-value proven lesson below
      // as a teaser so the tool isn't dead and the value is obvious.
      const gateActive = recallGate.reached;
      const visibleCount = gateActive ? 0 : 8;

      // ── Build output ──────────────────────────────────────────────────────────
      const lines: string[] = [`🧠 **Smart Recall** for: _"${query}"_\n`];

      // Warm goodwill note — shown the month a free user is gifted +250 recalls.
      if (recallGate.goodwillMessage) {
        lines.push(`${recallGate.goodwillMessage}\n`);
      }

      // "Brain saved you here" banner — surfaces value inline for proven recalled lessons
      const SORDER: Record<string, number> = { critical: 0, major: 1, minor: 2 };
      const topLesson = savedHere.sort((a, b) => (SORDER[a.severity] ?? 1) - (SORDER[b.severity] ?? 1))[0];
      if (topLesson) {
        const fmtMins = (m: number) => m >= 60 ? `${m / 60}h` : `${m}min`;
        const learnedStr = (() => {
          if (!topLesson.ts) return null;
          const d = new Date(topLesson.ts);
          if (isNaN(d.getTime())) return null;
          const now = new Date();
          const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
          const sameYear = d.getFullYear() === now.getFullYear();
          return sameYear ? `${d.getDate()} ${months[d.getMonth()]}` : `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
        })();
        const debugCostMins = topLesson.severity === 'critical' ? 120 : topLesson.severity === 'major' ? 60 : 20;
        const authorStr = topLesson.author && topLesson.author !== requester ? ` · by @${topLesson.author}` : '';
        const learnedPart = learnedStr ? ` · learned ${learnedStr} (was a ${fmtMins(debugCostMins)} debug)` : '';
        lines.push(`> 💡 **Brain saved you ~${fmtMins(topLesson.savedMins)} here** — \`${topLesson.topic}\`${learnedPart} · recalled ${topLesson.recall_count}×${authorStr}\n`);
      }
      if (crossAuthorThisCall > 0) {
        lines.push(`> 👥 **Team knowledge reuse** — ${crossAuthorThisCall} of these lesson${crossAuthorThisCall !== 1 ? 's were' : ' was'} written by a teammate. This is the value only a shared brain delivers.\n`);
      }

      // File-context personalization banner
      const ctxBoosted = hybridResults.filter(r => r.contextBoost).length;
      if (ctxBoosted > 0) {
        lines.push(`> 📁 **Personalized** — ${ctxBoosted} lesson${ctxBoosted !== 1 ? 's' : ''} boosted because ${ctxBoosted !== 1 ? 'they match' : 'it matches'} your current file context (${contextFiles.slice(0, 3).join(', ')}${contextFiles.length > 3 ? ', …' : ''})\n`);
      }

      // Show sub-query info if multi-topic was detected
      const subQueries = splitMultiQuery(query);
      if (subQueries.length > 1) {
        lines.push(`_Detected ${subQueries.length} sub-topics:_ ${subQueries.map((s, i) => `${i + 1}. "${s}"`).join(', ')}\n`);
      }

      if (hybridResults.length > 0) {
        const hasCKG = hybridResults.some(r => r.ckgScore !== undefined);
        const modeLabel = semHits.length > 0 && hasCKG
          ? `keyword + semantic + CKG hybrid`
          : semHits.length > 0
          ? `keyword + semantic hybrid`
          : hasCKG
          ? `keyword + CKG hybrid`
          : `keyword`;
        lines.push(`### 🔍 Results (${hybridResults.length} — ${modeLabel})\n`);

        // Group by sub-query for multi-topic queries
        if (subQueries.length > 1) {
          const grouped = new Map<string, HybridResult[]>();
          for (const r of hybridResults.slice(0, gateActive ? 0 : 12)) {
            const sq = r.subQuery ?? query;
            if (!grouped.has(sq)) grouped.set(sq, []);
            grouped.get(sq)!.push(r);
          }
          for (const [sq, results] of grouped) {
            lines.push(`**Topic: "${sq}"** (${results.length} results)\n`);
            for (const r of results.slice(0, 4)) {
              const label = r.key.replace('cachly:ctx:', '📝 ').replace('cachly:lesson:best:', '💡 ').replace('cachly:idx:', '📂 ');
              const scorePart = r.matchType === 'ckg'
                ? `CKG: ${(r.ckgScore ?? 0).toFixed(2)}, 🕸️ causal graph`
                : r.ckgScore !== undefined && r.bm25Score !== undefined
                ? `BM25: ${(r.bm25Score).toFixed(2)}, CKG: ${(r.ckgScore).toFixed(2)}, 🔀 hybrid`
                : r.matchType === 'hybrid'
                ? `BM25: ${(r.bm25Score ?? 0).toFixed(2)}, sem: ${((r.semScore ?? 0) * 100).toFixed(0)}%, 🔀 hybrid`
                : r.matchType === 'semantic'
                ? `sem: ${((r.semScore ?? 0) * 100).toFixed(0)}%, 🎯 semantic`
                : `BM25: ${(r.bm25Score ?? 0).toFixed(2)}, matched: ${r.matchedWords?.join(', ')}`;
              const preview = r.content.slice(0, 300).replace(/\n/g, ' ');
              lines.push(`  **${label}** _(${scorePart})_`);
              // Lesbares Brain (docs/produkt/team-puls.md P1): plain-language layer
              // stored at lesson:human:<topic> — display-only, ranking untouched.
              if (r.key.startsWith('cachly:lesson:best:')) {
                const hRaw = (await redis.get(r.key.replace('lesson:best:', 'lesson:human:')).catch(() => null))
                  ?? (await redis.get(r.key.replace('cachly:lesson:best:', 'lesson:human:')).catch(() => null));
                const h = hRaw ? safeJsonParse<{ title?: string; summary?: string }>(hRaw, {}) : {};
                if (h.title) lines.push(`  📖 **${h.title}** — ${h.summary ?? ''}`);
              }
              lines.push(`  > ${preview}${r.content.length > 300 ? '…' : ''}\n`);
            }
          }
          const matched = [...grouped.keys()];
          const unmatched = subQueries.filter(sq => !matched.includes(sq));
          if (unmatched.length > 0) {
            lines.push(`\n⚠️ **No results for:** ${unmatched.map(s => `"${s}"`).join(', ')}`);
          }
        } else {
          for (const r of hybridResults.slice(0, visibleCount)) {
            const label = r.key.replace('cachly:ctx:', '📝 ').replace('cachly:lesson:best:', '💡 ').replace('cachly:idx:', '📂 ');
            let authorBadge = '';
            if (r.key.startsWith('cachly:lesson:best:')) {
              const ld = safeJsonParse<{ author?: string }>(r.content, {});
              if (ld.author) authorBadge = ` · 👤 ${ld.author}`;
            }
            const contextBadge = r.contextBoost ? ` · 📁 context match` : '';
            const scorePart = r.matchType === 'hybrid'
              ? `BM25: ${(r.bm25Score ?? 0).toFixed(2)}, sem: ${((r.semScore ?? 0) * 100).toFixed(0)}%, 🔀 hybrid`
              : r.matchType === 'semantic'
              ? `sem: ${((r.semScore ?? 0) * 100).toFixed(0)}%, 🎯 semantic`
              : `BM25: ${(r.bm25Score ?? 0).toFixed(2)}, matched: ${r.matchedWords?.join(', ')}`;
            const preview = r.content.slice(0, 400).replace(/\n/g, ' ');
            lines.push(`**${label}**${authorBadge}${contextBadge} _(${scorePart})_`);
            // Lesbares Brain (docs/produkt/team-puls.md P1): plain-language layer.
            if (r.key.startsWith('cachly:lesson:best:')) {
              const hRaw = (await redis.get(r.key.replace('lesson:best:', 'lesson:human:')).catch(() => null))
                ?? (await redis.get(r.key.replace('cachly:lesson:best:', 'lesson:human:')).catch(() => null));
              const h = hRaw ? safeJsonParse<{ title?: string; summary?: string }>(hRaw, {}) : {};
              if (h.title) lines.push(`📖 **${h.title}** — ${h.summary ?? ''}`);
            }
            lines.push(`> ${preview}${r.content.length > 400 ? '…' : ''}\n`);
          }
        }

        // ── Hard gate footer: over the recall limit, the tail is withheld ──────
        if (gateActive) {
          const withheld = Math.max(0, hybridResults.length - visibleCount);
          lines.push(
            `🔒 **Free recall limit reached** (${recallGate.used}/${recallGate.limit} this month). ` +
              `${withheld} relevant lesson${withheld !== 1 ? 's' : ''} withheld. ` +
              `Your limit resets next month, or unlock your full Brain now → ${UPGRADE_URL}\n`,
          );
        }
      } else {
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

      // Upgrade nudge — surfaces the free-tier quota BEFORE the wall, once
      // per session and right next to the value it just proved.
      const recallGate = await getRecallGate(instance_id, apiFetch);
      const nudge = upgradeNudge({ used: recallGate.used, limit: recallGate.limit, savedMins: timeSavedMins });
      if (nudge) lines.push(nudge, '');

      // ── Welcome-back digest (gap ≥ 7 days) ──────────────────────────────────
      // When the user has been away a week or more, lead with a short "what
      // happened while you were gone" digest. All data is already loaded above
      // (lastSession + lessons), so this adds zero Redis round-trips. The point
      // is re-entry value: the brain kept compounding (git/CI/teammates) and we
      // surface the growth before anything else competes for attention.
      if (lastSession?.ts) {
        const lastTs = new Date(lastSession.ts).getTime();
        const daysAway = Math.floor((Date.now() - lastTs) / 86_400_000);
        if (daysAway >= 7 && !Number.isNaN(lastTs)) {
          const newSinceAway = lessons.filter(l => {
            const t = new Date(l.ts).getTime();
            return !Number.isNaN(t) && t > lastTs;
          });
          lines.push(`👋 **Welcome back** — it's been ${daysAway} days since your last session.`);
          if (newSinceAway.length > 0) {
            // lessons is already recency-sorted desc, so take the freshest few.
            const topNew = newSinceAway.slice(0, 3).map(l => `\`${l.topic}\``).join(', ');
            lines.push(`   🌱 Your Brain grew by **${newSinceAway.length} lesson${newSinceAway.length !== 1 ? 's' : ''}** while you were gone (git, CI & teammates kept it learning): ${topNew}${newSinceAway.length > 3 ? ', …' : ''}`);
          } else {
            lines.push(`   🧠 ${lessons.length} lesson${lessons.length !== 1 ? 's' : ''} held steady and ready — recall anything with \`smart_recall\`.`);
          }
          lines.push(`   💡 Full breakdown: \`npx @cachly-dev/mcp-server@latest digest\``, '');
        }
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
        lines.push('🌱 **Want answers right now?** Seed 16 universal engineering lessons so your first');
        lines.push('   `smart_recall` returns a hit instead of nothing:');
        lines.push(`   \`brain_seed_starter(instance_id="${instance_id}")\``);
        lines.push('   _(Docker cache, JWT skew, K8s OOM, N+1 queries, cache stampede… — never overrides your own lessons.)_');
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
              lines.push(`Your teammates have already solved problems you're about to hit:`);
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

      // ── Auto-Changelog — new lessons since last session ──────────────────────
      // Appended at the end so it never competes with the core briefing.
      // Skipped on: first session, no new lessons, or when disabled via prefs.
      try {
        const autoChangelogPref = await redis.get(`cachly:prefs:auto_changelog:${instance_id}`).catch(() => null);
        const autoChangelogEnabled = autoChangelogPref !== 'false';
        if (autoChangelogEnabled && lastSession?.ts && !isFirstSession) {
          const lastTs = new Date(lastSession.ts).getTime();
          if (!Number.isNaN(lastTs)) {
            const newLessons = lessons.filter(l => {
              const t = new Date(l.ts).getTime();
              return !Number.isNaN(t) && t > lastTs;
            });
            if (newLessons.length > 0) {
              const ago = Math.round((Date.now() - lastTs) / 60000);
              const agoStr = ago < 60 ? `${ago}m` : ago < 1440 ? `${Math.round(ago / 60)}h` : `${Math.round(ago / 1440)}d`;
              lines.push('');
              lines.push(`📋 **${newLessons.length} new lesson${newLessons.length !== 1 ? 's' : ''} since your last session** (${agoStr} ago):`);
              // Group by category
              const catMap = new Map<string, typeof newLessons>();
              for (const l of newLessons.slice(0, 20)) {
                const cat = l.topic.includes(':') ? l.topic.split(':')[0] : 'general';
                const arr = catMap.get(cat) ?? [];
                arr.push(l);
                catMap.set(cat, arr);
              }
              for (const [cat, catLessons] of catMap) {
                lines.push(`  **${cat}**`);
                for (const l of catLessons) {
                  const icon = l.outcome === 'failure' ? '❌' : l.severity === 'critical' ? '🚨' : l.severity === 'major' ? '⚠️' : '✅';
                  const body = (l.outcome === 'failure' ? l.what_failed : l.what_worked) ?? '';
                  lines.push(`    ${icon} \`${l.topic}\`${body ? ` — ${body.slice(0, 80)}` : ''}`);
                }
              }
              if (newLessons.length > 20) {
                lines.push(`  … and ${newLessons.length - 20} more. Call \`brain_changelog\` for the full list.`);
              }
              lines.push(`  _Disable auto-changelog: \`brain_set_pref(instance_id="${instance_id}", key="auto_changelog", value="false")\`_`);
            }
          }
        }
      } catch { /* changelog must never block session_start */ }

      return lines.join('\n');
    }

    // ── session_start_summary ─────────────────────────────────────────────────
    case 'session_start_summary': {
      const {
        instance_id,
        focus,
        top_n: topNRaw = 10,
        author = '',
      } = args as { instance_id: string; focus: string; top_n?: number; author?: string };

      if (!focus || !focus.trim()) {
        throw new Error('focus is required for session_start_summary');
      }

      const topN = Math.min(Math.max(1, Math.floor(Number(topNRaw) || 10)), 25);
      const redis = await getConnection(instance_id);

      // 1. Scan all best-solution lessons (same as session_start)
      const lessonKeys: string[] = [];
      const lStream = redis.scanStream({ match: 'cachly:lesson:best:*', count: 200 });
      await new Promise<void>((resolve, reject) => {
        lStream.on('data', (batch: string[]) => lessonKeys.push(...batch));
        lStream.on('end', resolve);
        lStream.on('error', reject);
      });

      type SummaryLesson = {
        topic: string; outcome: string; what_worked: string; what_failed?: string;
        ts: string; verified_at?: string; severity?: string; recall_count?: number;
        tags?: string[]; confidence?: number;
      };
      const lessons: SummaryLesson[] = [];
      if (lessonKeys.length > 0) {
        const raws = await redis.mget(...lessonKeys);
        for (const raw of raws) {
          const l = safeJsonParse<SummaryLesson | null>(raw ?? null, null);
          if (l) lessons.push(l);
        }
      }

      // 2. If brain has 0 lessons return graceful empty message
      if (lessons.length === 0) {
        return [
          `🧠 Brain Summary — no lessons yet`,
          ``,
          `Your brain is empty. Use \`learn_from_attempts\` after solving tasks to build it up.`,
          `💡 Tip: \`brain_seed_starter(instance_id="${instance_id}")\` to bootstrap with 16 universal lessons.`,
        ].join('\n');
      }

      // 3. If lessons.length <= top_n, return all of them (no need to score)
      const needsRanking = lessons.length > topN;

      // 4. Score lessons for relevance to focus
      const focusWords = focus.toLowerCase().split(/\s+/).filter(Boolean);
      const nowMs = Date.now();

      const scored = lessons.map(l => {
        // Keyword relevance: topic or tags contain focus words
        const inTopic = focusWords.filter(w => l.topic.toLowerCase().includes(w)).length;
        const inTags  = focusWords.filter(w => (l.tags ?? []).some(t => t.toLowerCase().includes(w))).length;
        const relevance = (inTopic * 2) + inTags;

        // Recall-count bonus (proven-ness, log-scaled, capped)
        const rc = Math.max(0, l.recall_count ?? 0);
        const recallBonus = Math.min(1.5, Math.log1p(rc) / 10);

        // Severity bonus
        const sevBonus = l.severity === 'critical' ? 1.0 : l.severity === 'major' ? 0.5 : 0;

        // Recency bonus: lessons updated in the last 30 days get up to +0.5
        const ageDays = (nowMs - new Date(l.verified_at ?? l.ts).getTime()) / 86_400_000;
        const recencyBonus = ageDays < 30 ? 0.5 * (1 - ageDays / 30) : 0;

        // Outcome bonus: success > partial > failure
        const outcomeBonus = l.outcome === 'success' ? 0.5 : l.outcome === 'partial' ? 0.2 : 0;

        const score = relevance + recallBonus + sevBonus + recencyBonus + outcomeBonus;
        return { lesson: l, score };
      });

      // Sort descending by score, then by recency as tiebreak
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.lesson.ts).getTime() - new Date(a.lesson.ts).getTime();
      });

      const selected = (needsRanking ? scored.slice(0, topN) : scored).map(s => s.lesson);
      const total = lessons.length;
      const shown = selected.length;

      // 5. Build concise briefing
      const divider = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
      const header = needsRanking
        ? `🧠 Brain Summary — top ${shown} of ${total} lessons for "${focus}"`
        : `🧠 Brain Summary — all ${shown} lesson${shown !== 1 ? 's' : ''} for "${focus}"`;

      const summaryLines: string[] = [header, divider, ''];

      for (const l of selected) {
        const sevIcon = l.severity === 'critical' ? '🔴' : l.severity === 'major' ? '⚠️' : '✅';
        const sevLabel = l.severity ? `[${l.severity}] ` : '[minor] ';
        const rc = l.recall_count ?? 0;
        const rcStr = rc > 0 ? ` (✓ recalled ${rc}×)` : '';
        const snippet = l.what_worked.slice(0, 110);
        summaryLines.push(`${sevIcon} ${sevLabel}\`${l.topic}\` — ${snippet}${rcStr}`);
      }

      summaryLines.push('');
      if (needsRanking) {
        summaryLines.push(`💡 Showing top ${shown} of ${total} lessons · \`session_start\` for full briefing`);
      } else {
        summaryLines.push(`💡 All ${shown} lesson${shown !== 1 ? 's' : ''} shown · \`session_start\` for full briefing`);
      }

      return summaryLines.join('\n');
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
          // Give auto-learned lessons the same baseline confidence field the
          // quality rerank / decay logic expect, so they are ranked like any
          // other lesson instead of being treated as signal-less.
          confidence: 1.0,
          recall_count: 0,
          auto_learned: true,
          version: 2,
        };
        const lessonStr = JSON.stringify(lesson);

        await redis.set(key, lessonStr);

        // Make auto-learned lessons FIRST-CLASS, not just a bare best-key pointer:
        // append to the topic history (audit + consolidation source) and register
        // the concept in the Causal Knowledge Graph so causal_trace / brain_predict
        // / memory_consolidate can see them. Mirrors the learn_from_attempts path;
        // best-effort so a graph hiccup never fails the learn.
        const listKey = `cachly:lessons:${topic}`;
        await redis.rpush(listKey, lessonStr);
        await redis.ltrim(listKey, -100, -1);
        await redis.expire(listKey, 90 * 86400);
        try {
          const domain = topic.split(':')[0] ?? 'auto';
          const conceptId = ckgSlug(topic);
          await ckgUpsertNode(redis, conceptId, domain, domain);
          // A successful action that resolved a described problem becomes
          // causal-traceable via a `fixes` edge.
          if (obs.outcome === 'success' || obs.outcome === 'partial') {
            const problemConcept = obs.details ? extractProblemConcept(obs.details) : null;
            if (problemConcept) {
              const problemId = ckgSlug(`problem:${problemConcept}`);
              await ckgUpsertNode(redis, problemId, 'problem', 'problem');
              await ckgUpdateEdge(redis, conceptId, 'fixes', problemId, obs.outcome === 'success', obs.outcome === 'partial');
            }
          }
        } catch { /* CKG is best-effort */ }

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

    // ── brain_who_knows ───────────────────────────────────────────────────────
    // Phase 3A: Org-wide people intelligence. Returns ranked list of contributors
    // whose authored edges in the CKG match the query topic.
    case 'brain_who_knows': {
      const {
        instance_id,
        topic,
        limit = 10,
      } = args as { instance_id: string; topic: string; limit?: number };

      if (!topic || typeof topic !== 'string' || !topic.trim()) {
        return '⚠️ `brain_who_knows` requires a non-empty `topic`. Example: `brain_who_knows(topic="kubernetes deployment")`.';
      }
      const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 50));

      const redis = await getConnection(instance_id);

      // Step 1: Find candidate concept node IDs matching the query
      const querySlug = ckgSlug(topic);
      const qTokens = tokenize(topic).filter((t: string) => t.length >= 3).slice(0, 5);

      const candidateConceptIds = new Set<string>([querySlug]);
      for (const token of qTokens.slice(0, 3)) {
        const nodeStream = redis.scanStream({ match: `cachly:ckg:node:*${token}*`, count: 30 });
        await new Promise<void>((res, rej) => {
          nodeStream.on('data', (batch: string[]) => {
            for (const k of batch.slice(0, 10)) {
              const nodeId = k.replace('cachly:ckg:node:', '');
              if (!nodeId.startsWith('person:') && !nodeId.startsWith('file:'))
                candidateConceptIds.add(nodeId);
            }
          });
          nodeStream.on('end', res);
          nodeStream.on('error', rej);
        });
      }

      // Step 2: Traverse authored edges (person → concept) to find experts
      type PersonScore = {
        handle: string; lessonCount: number; totalConfidence: number;
        domains: Set<string>; lastActive: string;
      };
      const personScores = new Map<string, PersonScore>();

      for (const conceptId of [...candidateConceptIds].slice(0, 25)) {
        const inboundEdgeKeys = await redis.smembers(`cachly:ckg:idx:to:${conceptId}`);
        for (const ek of inboundEdgeKeys) {
          const er = await redis.get(ek);
          if (!er) continue;
          const edge = safeJsonParse<CKGEdge | null>(er, null);
          if (!edge || edge.edgeType !== 'authored') continue;

          const personNodeRaw = await redis.get(`cachly:ckg:node:${edge.from}`);
          if (!personNodeRaw) continue;
          const personNode = safeJsonParse<PersonNode | null>(personNodeRaw, null);
          if (!personNode || personNode.type !== 'person') continue;

          const existing = personScores.get(edge.from);
          if (existing) {
            existing.lessonCount++;
            existing.totalConfidence += edge.confidence;
            existing.domains.add(personNode.domain);
            if (edge.last_updated > existing.lastActive) existing.lastActive = edge.last_updated;
          } else {
            personScores.set(edge.from, {
              handle: personNode.handle,
              lessonCount: 1,
              totalConfidence: edge.confidence,
              domains: new Set([personNode.domain]),
              lastActive: personNode.last_active ?? edge.last_updated,
            });
          }
        }
      }

      if (personScores.size === 0) {
        return [
          `## 👥 Who Knows About \`${topic}\`?`,
          ``,
          `No attributed lessons found yet.`,
          ``,
          `Knowledge attribution builds automatically — add \`author="name"\` to \`learn_from_attempts\` calls:`,
          `\`learn_from_attempts(topic="${topic}", author="your-handle", ...)\``,
        ].join('\n');
      }

      // Step 3: Sort by expertise score (lesson count × avg confidence)
      const ranked = [...personScores.entries()]
        .map(([id, s]) => ({
          id,
          handle: s.handle,
          lessonCount: s.lessonCount,
          avgConfidence: s.totalConfidence / s.lessonCount,
          domains: [...s.domains].slice(0, 3).join(', '),
          lastActive: s.lastActive,
        }))
        .sort((a, b) => (b.lessonCount * b.avgConfidence) - (a.lessonCount * a.avgConfidence))
        .slice(0, safeLimit);

      // Step 4: For the top expert, find frequent collaborators (person↔person edges).
      const topCollaborators: string[] = [];
      const topExpert = ranked[0];
      if (topExpert) {
        try {
          const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${topExpert.id}`);
          const collabs: Array<{ handle: string; trials: number }> = [];
          for (const ek of edgeKeys) {
            const er = await redis.get(ek);
            if (!er) continue;
            const edge = safeJsonParse<CKGEdge | null>(er, null);
            if (!edge || edge.edgeType !== 'collaborates') continue;
            const pr = await redis.get(`cachly:ckg:node:${edge.to}`);
            const pn = pr ? safeJsonParse<PersonNode | null>(pr, null) : null;
            if (pn?.handle) collabs.push({ handle: pn.handle, trials: edge.trials });
          }
          collabs.sort((a, b) => b.trials - a.trials);
          for (const c of collabs.slice(0, 3)) topCollaborators.push(c.handle);
        } catch { /* non-critical */ }
      }

      const lines = [
        `## 👥 Who Knows About \`${topic}\`?`,
        ``,
        `**${ranked.length}** contributor${ranked.length !== 1 ? 's' : ''} with relevant lessons:`,
        ``,
      ];

      for (const [i, p] of ranked.entries()) {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const conf = (p.avgConfidence * 100).toFixed(0);
        const daysSince = Math.floor((Date.now() - new Date(p.lastActive).getTime()) / 86400000);
        const recency = daysSince < 1 ? 'today' : daysSince < 7 ? `${daysSince}d ago` : daysSince < 30 ? `${Math.floor(daysSince / 7)}w ago` : `${Math.floor(daysSince / 30)}mo ago`;
        // Show role badge if assigned (non-blocking — role lookup is best-effort)
        const roleVal = await getRole(redis, instance_id, p.handle).catch(() => null);
        const roleBadge = roleVal ? ` ${ROLE_BADGE[roleVal]}` : '';
        lines.push(
          `${medal} **${p.handle}**${roleBadge} — ${p.lessonCount} lesson${p.lessonCount !== 1 ? 's' : ''} · ${conf}% confidence · last active ${recency}`,
          `   _domains: ${p.domains}_`,
          ``,
        );
      }

      if (topCollaborators.length > 0 && topExpert) {
        lines.push(
          `🤝 **${topExpert.handle}** frequently works with: ${topCollaborators.map(h => `**${h}**`).join(', ')}`,
          `   _(ask them together — they've solved structurally similar things on shared files)_`,
          ``,
        );
      }

      lines.push(
        `---`,
        `_Attribution grows with every \`learn_from_attempts(author="...", ...)\` call._`,
      );

      return lines.join('\n');
    }

    // ── brain_file_map ────────────────────────────────────────────────────────
    // Phase 3B: "What do we know about these files?" — experts + lessons per file.
    case 'brain_file_map': {
      const {
        instance_id,
        file_paths = [],
      } = args as { instance_id: string; file_paths: string[] };

      // Defensive: accept only a non-empty array of non-empty strings.
      const cleanPaths = (Array.isArray(file_paths) ? file_paths : [])
        .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        .map(p => p.trim());
      if (!cleanPaths.length) return '⚠️ Pass at least one file path. Example: `brain_file_map(file_paths=["src/auth/jwt.ts"])`.';

      const redis = await getConnection(instance_id);
      const lines: string[] = [
        `## 📁 File Knowledge Map`,
        ``,
        `_What cachly knows about the files you're about to touch:_`,
        ``,
      ];

      for (const fp of cleanPaths.slice(0, 10)) {
        lines.push(`### \`${fp}\``);

        // ── Experts via CKG file nodes ─────────────────────────────────────
        const fileId = `file:${ckgSlug(fp)}`;
        const inbound = await redis.smembers(`cachly:ckg:idx:to:${fileId}`);
        type ExpertEntry = { handle: string; touches: number; lastSeen: string };
        const experts: ExpertEntry[] = [];
        for (const ek of inbound) {
          const er = await redis.get(ek);
          if (!er) continue;
          const edge = safeJsonParse<CKGEdge | null>(er, null);
          if (!edge || edge.edgeType !== 'touched') continue;
          const personRaw = await redis.get(`cachly:ckg:node:${edge.from}`);
          if (!personRaw) continue;
          const pn = safeJsonParse<PersonNode | null>(personRaw, null);
          if (!pn || pn.type !== 'person') continue;
          experts.push({ handle: pn.handle, touches: edge.trials, lastSeen: edge.last_updated });
        }
        experts.sort((a, b) => b.touches - a.touches);

        if (experts.length > 0) {
          const expLine = experts.slice(0, 5).map((e, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            const days = Math.floor((Date.now() - new Date(e.lastSeen).getTime()) / 86400000);
            const ago = days < 1 ? 'today' : days < 7 ? `${days}d ago` : `${Math.floor(days / 7)}w ago`;
            return `${medal} **${e.handle}** (${e.touches}× · ${ago})`;
          }).join(' · ');
          lines.push(`**Experts:** ${expLine}`);
        } else {
          lines.push(`**Experts:** _None yet — add \`author\` to \`learn_from_attempts\` calls_`);
        }

        // ── Related lessons via BM25 on filename tokens ────────────────────
        const tokens = fp.replace(/[^a-z0-9]/gi, ' ').split(/\s+/).filter(t => t.length >= 4);
        const lessonQuery = tokens.slice(0, 3).join(' ');
        const relatedLessons: string[] = [];
        if (lessonQuery) {
          try {
            const hits = await keywordSearch(redis, ['cachly:lesson:best:*'], lessonQuery, 4);
            for (const h of hits) {
              const ld = safeJsonParse<{
                topic?: string; outcome?: string; what_worked?: string;
                severity?: string; author?: string; visibility?: string;
              }>(h.content, {});
              if (ld.visibility === 'private') continue;
              const emoji = ld.outcome === 'success' ? '✅' : ld.outcome === 'partial' ? '⚠️' : '❌';
              const sev = ld.severity === 'critical' ? ' 🔴' : ld.severity === 'major' ? ' 🟡' : '';
              const by = ld.author ? ` · 👤 ${ld.author}` : '';
              const topic = h.key.replace('cachly:lesson:best:', '');
              relatedLessons.push(`  - ${emoji} \`${topic}\`${sev}${by} — ${(ld.what_worked ?? '').slice(0, 100)}`);
            }
          } catch { /* non-critical */ }
        }
        // Also: exact file_paths match via lesson scan
        if (relatedLessons.length < 2) {
          const allLessonKeys = await scanKeys(redis, 'cachly:lesson:best:*', { max: 1500 });
          for (const k of allLessonKeys.slice(0, 300)) {
            const raw = await redis.get(k);
            if (!raw) continue;
            const ld = safeJsonParse<{
              topic?: string; outcome?: string; what_worked?: string;
              severity?: string; author?: string; visibility?: string; file_paths?: string[];
            }>(raw, {});
            if (ld.visibility === 'private') continue;
            if (!(ld.file_paths ?? []).includes(fp)) continue;
            const topic = k.replace('cachly:lesson:best:', '');
            if (relatedLessons.some(l => l.includes(`\`${topic}\``))) continue;
            const emoji = ld.outcome === 'success' ? '✅' : ld.outcome === 'partial' ? '⚠️' : '❌';
            const sev = ld.severity === 'critical' ? ' 🔴' : ld.severity === 'major' ? ' 🟡' : '';
            const by = ld.author ? ` · 👤 ${ld.author}` : '';
            relatedLessons.push(`  - ${emoji} \`${topic}\`${sev}${by} — ${(ld.what_worked ?? '').slice(0, 100)}`);
          }
        }

        if (relatedLessons.length > 0) {
          lines.push(`**Related lessons:**`);
          lines.push(...relatedLessons.slice(0, 5));
        } else {
          lines.push(`**Related lessons:** _None yet_`);
        }
        lines.push(``);
      }

      lines.push(
        `---`,
        `_Attribution builds with \`learn_from_attempts(file_paths=[...], author="...")\`. Run this before committing to track what changed and why._`,
      );
      return lines.join('\n');
    }

    // ── team_expertise_map ────────────────────────────────────────────────────
    // Phase 3B: Full team expertise overview — who knows what, at a glance.
    case 'team_expertise_map': {
      const {
        instance_id,
        top_n = 20,
      } = args as { instance_id: string; top_n?: number };

      const redis = await getConnection(instance_id);

      // Scan all person nodes (capped + timed out so a huge keyspace can't hang the agent)
      const personKeys = await scanKeys(redis, 'cachly:ckg:node:person:*', { max: 2000 });

      if (personKeys.length === 0) {
        return [
          `## 🗺️ Team Expertise Map`,
          ``,
          `No contributors yet.`,
          ``,
          `Add \`author="handle"\` to any \`learn_from_attempts\` call to start building the map.`,
        ].join('\n');
      }

      type PersonEntry = { handle: string; lessonCount: number; domains: Map<string, number>; lastActive: string };
      const people: PersonEntry[] = [];

      for (const pk of personKeys) {
        const raw = await redis.get(pk);
        if (!raw) continue;
        const pn = safeJsonParse<PersonNode | null>(raw, null);
        if (!pn || pn.type !== 'person') continue;

        // Count authored lessons + collect domains from authored edges
        const outEdgeKeys = await redis.smembers(`cachly:ckg:idx:from:${pn.id}`);
        const domainCounts = new Map<string, number>();
        let lessonCount = 0;
        for (const ek of outEdgeKeys) {
          const er = await redis.get(ek);
          if (!er) continue;
          const edge = safeJsonParse<CKGEdge | null>(er, null);
          if (!edge || edge.edgeType !== 'authored') continue;
          lessonCount++;
          const domain = edge.to.split(':')[0] ?? 'unknown';
          domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
        }
        people.push({ handle: pn.handle, lessonCount, domains: domainCounts, lastActive: pn.last_active });
      }

      people.sort((a, b) => b.lessonCount - a.lessonCount);
      const topPeople = people.slice(0, top_n);

      const lines = [
        `## 🗺️ Team Expertise Map`,
        ``,
        `**${topPeople.length}** contributor${topPeople.length !== 1 ? 's' : ''} tracked:`,
        ``,
        `| # | Handle | Lessons | Top domains | Last active |`,
        `|---|--------|---------|-------------|-------------|`,
      ];

      for (const [i, p] of topPeople.entries()) {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
        const days = Math.floor((Date.now() - new Date(p.lastActive).getTime()) / 86400000);
        const ago = days < 1 ? 'today' : days < 7 ? `${days}d ago` : days < 30 ? `${Math.floor(days / 7)}w ago` : `${Math.floor(days / 30)}mo ago`;
        const domainStr = [...p.domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, c]) => `${d}(${c})`).join(', ') || '—';
        lines.push(`| ${medal} | **${p.handle}** | ${p.lessonCount} | ${domainStr} | ${ago} |`);
      }

      lines.push(
        ``,
        `---`,
        `_Use \`brain_who_knows(topic="...")\` to find the expert for a specific problem._`,
      );
      return lines.join('\n');
    }

    // ── skill_gaps ────────────────────────────────────────────────────────────
    // Phase 3C: Show knowledge blind spots — domains/files with no success lessons,
    // no attribution, or only failures.
    case 'skill_gaps': {
      const {
        instance_id,
        min_failures = 1,
      } = args as { instance_id: string; min_failures?: number };

      const redis = await getConnection(instance_id);

      // Scan all best lessons (capped + timed out)
      const lessonKeys = await scanKeys(redis, 'cachly:lesson:best:*', { max: 3000 });

      type DomainStats = { successes: number; failures: number; attributed: number; topics: string[] };
      const domainMap = new Map<string, DomainStats>();
      let totalAttributed = 0;
      let totalPrivate = 0;

      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        const l = safeJsonParse<{
          topic?: string; outcome?: string; author?: string; visibility?: string;
        }>(raw, {});
        const domain = (l.topic ?? '').split(':')[0] ?? 'unknown';
        const s = domainMap.get(domain) ?? { successes: 0, failures: 0, attributed: 0, topics: [] };
        if (l.outcome === 'success' || l.outcome === 'partial') s.successes++;
        else s.failures++;
        if (l.author) { s.attributed++; totalAttributed++; }
        if (l.visibility === 'private') totalPrivate++;
        s.topics.push(l.topic ?? '');
        domainMap.set(domain, s);
      }

      // Identify gaps
      type Gap = { domain: string; type: string; severity: string; detail: string };
      const gaps: Gap[] = [];

      for (const [domain, s] of domainMap) {
        if (s.failures >= min_failures && s.successes === 0) {
          gaps.push({
            domain, type: 'unresolved failures',
            severity: s.failures >= 3 ? '🔴 critical' : '🟡 warn',
            detail: `${s.failures} failure${s.failures !== 1 ? 's' : ''}, 0 solutions — use \`learn_from_attempts\` to store what fixed it`,
          });
        }
        if (s.successes + s.failures >= 3 && s.attributed === 0) {
          gaps.push({
            domain, type: 'no attribution',
            severity: '🔵 info',
            detail: `${s.successes + s.failures} lessons with no \`author\` field — attribution lost, \`brain_who_knows\` can't help here`,
          });
        }
      }

      const lines = [
        `## 🔍 Skill Gaps — Knowledge Blind Spots`,
        ``,
        `**${lessonKeys.length}** lessons scanned · **${totalAttributed}** attributed · **${gaps.length}** gap${gaps.length !== 1 ? 's' : ''} found`,
        totalPrivate > 0 ? `_(${totalPrivate} private lessons excluded from gap analysis)_` : '',
        ``,
      ].filter(Boolean);

      if (gaps.length === 0) {
        lines.push(`✅ No significant knowledge gaps detected. All domains with failures have at least one success lesson.`);
      } else {
        const bySev = [
          ...gaps.filter(g => g.severity.includes('critical')),
          ...gaps.filter(g => g.severity.includes('warn')),
          ...gaps.filter(g => g.severity.includes('info')),
        ];
        for (const g of bySev.slice(0, 15)) {
          lines.push(`${g.severity} **\`${g.domain}\`** — ${g.type}`);
          lines.push(`  ${g.detail}`);
          lines.push(``);
        }
        if (gaps.length > 15) lines.push(`_…and ${gaps.length - 15} more gaps. Fix critical ones first._`);
      }

      lines.push(
        `---`,
        `_Fix gaps with \`learn_from_attempts(topic="${gaps[0]?.domain ?? 'your:topic'}", outcome="success", what_worked="...")\`_`,
        `_Add \`author="name"\` to every call to enable \`brain_who_knows\` + \`team_expertise_map\`._`,
      );

      return lines.join('\n');
    }

    // ── brain_coverage ────────────────────────────────────────────────────────
    // Phase 3C: Knowledge-coverage health score for the repository.
    case 'brain_coverage': {
      const {
        instance_id,
        repo_path = '.',
      } = args as { instance_id: string; repo_path?: string };

      const redis = await getConnection(instance_id);

      // Count lessons, person + file nodes (each capped + timed out, gathered in parallel)
      const [lessonKeys, personKeys, fileKeys] = await Promise.all([
        scanKeys(redis, 'cachly:lesson:best:*', { max: 5000 }),
        scanKeys(redis, 'cachly:ckg:node:person:*', { max: 2000 }),
        scanKeys(redis, 'cachly:ckg:node:file:*', { max: 5000 }),
      ]);

      // Get git file count for comparison (optional — non-critical if not a git repo)
      let gitFileCount = 0;
      let _gitFileCountLabel = 'n/a';
      try {
        const { execSync } = await import('node:child_process');
        const { resolve } = await import('node:path');
        const repoDir = resolve(repo_path);
        const output = execSync('git ls-files', { cwd: repoDir, encoding: 'utf-8', stdio: 'pipe' });
        gitFileCount = output.trim().split('\n').filter(Boolean).length;
        _gitFileCountLabel = String(gitFileCount);
      } catch { /* not a git repo — skip */ }

      // Lesson quality breakdown
      let successCount = 0; let failureCount = 0; let attributedCount = 0;
      const domainSet = new Set<string>();
      for (const k of lessonKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        const l = safeJsonParse<{ outcome?: string; author?: string; topic?: string }>(raw, {});
        if (l.outcome === 'success' || l.outcome === 'partial') successCount++;
        else failureCount++;
        if (l.author) attributedCount++;
        domainSet.add((l.topic ?? '').split(':')[0] ?? 'unknown');
      }

      const fileCoverage = gitFileCount > 0
        ? `${Math.round((fileKeys.length / gitFileCount) * 100)}% (${fileKeys.length}/${gitFileCount} files)`
        : `${fileKeys.length} files tracked`;

      const attributionPct = lessonKeys.length > 0
        ? Math.round((attributedCount / lessonKeys.length) * 100)
        : 0;

      const overallScore = Math.round(
        (Math.min(1, lessonKeys.length / 50) * 25) +          // lesson volume (25 pts)
        (Math.min(1, successCount / Math.max(1, lessonKeys.length)) * 25) + // success ratio (25 pts)
        (Math.min(1, attributionPct / 100) * 25) +            // attribution completeness (25 pts)
        (Math.min(1, personKeys.length / 5) * 25)             // team engagement (25 pts)
      );

      const scoreEmoji = overallScore >= 80 ? '🟢' : overallScore >= 50 ? '🟡' : '🔴';

      return [
        `## 📊 Brain Coverage Report`,
        ``,
        `${scoreEmoji} **Overall score: ${overallScore}/100**`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Total lessons | **${lessonKeys.length}** (${successCount} success · ${failureCount} failure) |`,
        `| Problem domains | **${domainSet.size}** |`,
        `| Attribution | **${attributedCount}/${lessonKeys.length}** (${attributionPct}%) |`,
        `| Contributors | **${personKeys.length}** tracked in knowledge graph |`,
        `| File coverage | **${fileCoverage}** |`,
        ``,
        `**Score breakdown (each 0–25):**`,
        `- Lesson volume: **${Math.round(Math.min(1, lessonKeys.length / 50) * 25)}/25** _(target: 50+ lessons)_`,
        `- Success ratio: **${Math.round(Math.min(1, successCount / Math.max(1, lessonKeys.length)) * 25)}/25** _(target: all lessons resolved)_`,
        `- Attribution: **${Math.round(Math.min(1, attributionPct / 100) * 25)}/25** _(target: 100% attributed)_`,
        `- Team engagement: **${Math.round(Math.min(1, personKeys.length / 5) * 25)}/25** _(target: 5+ contributors)_`,
        ``,
        `---`,
        `_Boost score: run \`brain_from_git\` · add \`author\` to \`learn_from_attempts\` · fix gaps with \`skill_gaps\`_`,
      ].join('\n');
    }

    // ── brain_metrics ─────────────────────────────────────────────────────────
    // The three decisive metrics (PROGRESS.md §3 / VISION_10X.md §4):
    //   1. Time-to-first-recall  — onboarding friction
    //   2. Recall-lift           — the moat proof (vs. raw BM25)
    //   3. Team-knowledge-reuse  — the value only a shared brain delivers
    case 'brain_metrics': {
      const { instance_id } = args as { instance_id: string };
      const redis = await getConnection(instance_id);

      const [bornAt, firstRecallAt, recallsTotalRaw, crossAuthorRaw, timeSavedRaw, reusePairs] =
        await Promise.all([
          redis.get(`cachly:stats:born_at:${instance_id}`).catch(() => null),
          redis.get(`cachly:stats:first_recall_at:${instance_id}`).catch(() => null),
          redis.get(`cachly:stats:recalls_total:${instance_id}`).catch(() => null),
          redis.get(`cachly:stats:cross_author_recalls:${instance_id}`).catch(() => null),
          redis.get(`cachly:stats:time_saved_mins:${instance_id}`).catch(() => null),
          redis.smembers(`cachly:stats:reuse_pairs:${instance_id}`).catch(() => [] as string[]),
        ]);

      // ── Metric 1: Time-to-first-recall ──────────────────────────────────────
      let ttfrLine: string;
      if (bornAt && firstRecallAt) {
        const ms = new Date(firstRecallAt).getTime() - new Date(bornAt).getTime();
        const mins = Math.max(0, Math.round(ms / 60000));
        const human = mins < 1 ? '<1 min' : mins < 60 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`;
        const target = ms <= 2 * 60000 ? '🟢 under 2 min target' : ms <= 60 * 60000 ? '🟡 over 2 min' : '🔴 over 1 h';
        ttfrLine = `**${human}** from first lesson → first proven recall · ${target}`;
      } else if (bornAt && !firstRecallAt) {
        ttfrLine = `🟡 Brain has knowledge but no proven recall yet — try \`smart_recall\``;
      } else {
        ttfrLine = `⚪ Not enough data yet — store a lesson, then recall it`;
      }

      // ── Metric 2: Recall-lift (the moat proof) ──────────────────────────────
      // Published headline from Cachly-Bench (CI-defended in rerank.test.ts).
      const recallLiftLine = `**+33.3 % Precision@1**, **+13.6 % MRR**, **+9.9 % nDCG@5** vs. raw BM25 · external-corpus Recall@3 **98.2%**`;

      // ── Metric 3: Team-knowledge-reuse ──────────────────────────────────────
      const recallsTotal = Number(recallsTotalRaw ?? 0);
      const crossAuthor = Number(crossAuthorRaw ?? 0);
      const reusePct = recallsTotal > 0 ? Math.round((crossAuthor / recallsTotal) * 100) : 0;
      const reuseTarget = reusePct >= 30 ? '🟢 above 30 % target' : recallsTotal === 0 ? '⚪ no recalls yet' : '🟡 below 30 % target';
      const timeSaved = Math.round(Number(timeSavedRaw ?? 0));
      const timeSavedHuman = timeSaved < 60 ? `${timeSaved} min` : `${(timeSaved / 60).toFixed(1)} h`;

      const lines = [
        `## 📈 Brain Metrics — the three that decide everything`,
        ``,
        `### 1. Time-to-first-recall _(onboarding friction)_`,
        ttfrLine,
        ``,
        `### 2. Recall-lift _(the moat proof)_`,
        recallLiftLine,
        `_Reproduce: \`npm run bench\` · CI-defended in \`rerank.test.ts\` · details in BENCH.md_`,
        ``,
        `### 3. Team-knowledge-reuse _(the value only a shared brain delivers)_`,
        `**${reusePct}%** of proven recalls used a teammate's lesson (${crossAuthor}/${recallsTotal}) · ${reuseTarget}`,
        reusePairs.length > 0 ? `**${reusePairs.length}** distinct reuse relationship${reusePairs.length !== 1 ? 's' : ''} across the team` : '',
        ``,
        `---`,
        `⏱️ **${timeSavedHuman}** total saved not re-researching known fixes.`,
        recallsTotal === 0
          ? `_Tip: pass \`author="your-handle"\` to \`smart_recall\` so cross-author reuse can be tracked._`
          : `_These numbers compound: every learned lesson and every teammate raises all three._`,
      ].filter(Boolean);

      return lines.join('\n');
    }

    // ── brain_service_map ───────────────────────────────────────────────────────
    // Phase 3: "Who owns this service, and what's gone wrong with it before?"
    // Bridges a running system (e.g. a restarting prometheus pod) to the people who
    // operate it, the files that run in it, and the lessons learned operating it.
    case 'brain_service_map': {
      const {
        instance_id,
        service,
      } = args as { instance_id: string; service: string };

      if (!service || typeof service !== 'string' || !service.trim()) {
        return '⚠️ `brain_service_map` requires a non-empty `service`. Example: `brain_service_map(service="prometheus")`.';
      }
      const redis = await getConnection(instance_id);
      const serviceId = `service:${ckgSlug(service.trim())}`;

      const nodeRaw = await redis.get(`cachly:ckg:node:${serviceId}`).catch(() => null);
      const node = nodeRaw ? safeJsonParse<ServiceNode | null>(nodeRaw, null) : null;

      // Inbound edges: person→operates, concept→affects, file→runs_in
      const inbound = await redis.smembers(`cachly:ckg:idx:to:${serviceId}`).catch(() => [] as string[]);
      const operators: Array<{ handle: string; trials: number }> = [];
      const files: Array<{ path: string; trials: number }> = [];
      const concepts: Array<{ id: string; confidence: number }> = [];
      for (const ek of inbound) {
        const er = await redis.get(ek).catch(() => null);
        if (!er) continue;
        const edge = safeJsonParse<CKGEdge | null>(er, null);
        if (!edge) continue;
        if (edge.edgeType === 'operates') {
          const pr = await redis.get(`cachly:ckg:node:${edge.from}`).catch(() => null);
          const pn = pr ? safeJsonParse<PersonNode | null>(pr, null) : null;
          if (pn?.handle) operators.push({ handle: pn.handle, trials: edge.trials });
        } else if (edge.edgeType === 'runs_in') {
          const fr = await redis.get(`cachly:ckg:node:${edge.from}`).catch(() => null);
          const fn = fr ? safeJsonParse<{ path?: string } | null>(fr, null) : null;
          if (fn?.path) files.push({ path: fn.path, trials: edge.trials });
        } else if (edge.edgeType === 'affects') {
          concepts.push({ id: edge.from, confidence: edge.confidence });
        }
      }
      operators.sort((a, b) => b.trials - a.trials);
      files.sort((a, b) => b.trials - a.trials);
      concepts.sort((a, b) => b.confidence - a.confidence);

      // Lessons tagged to this service (scan + filter; bounded).
      type SvcLesson = { topic: string; outcome?: string; severity?: string; author?: string; what_worked?: string; visibility?: string };
      const lessons: SvcLesson[] = [];
      const lessonKeys = await scanKeys(redis, 'cachly:lesson:best:*', { max: 1500 });
      const svcLower = service.trim().toLowerCase();
      for (const k of lessonKeys.slice(0, 400)) {
        const raw = await redis.get(k).catch(() => null);
        if (!raw) continue;
        const ld = safeJsonParse<SvcLesson & { service?: string }>(raw, {} as SvcLesson);
        if (ld.visibility === 'private') continue;
        if ((ld.service ?? '').toLowerCase() !== svcLower) continue;
        lessons.push({ ...ld, topic: k.replace('cachly:lesson:best:', '') });
      }

      if (!node && lessons.length === 0 && operators.length === 0) {
        return [
          `## 🛰️ Service Map — \`${service}\``,
          ``,
          `Nothing known about this service yet.`,
          ``,
          `Tag lessons with the service they concern so the brain can build this map:`,
          `\`learn_from_attempts(topic="...", service="${service}", author="you", file_paths=[...])\``,
        ].join('\n');
      }

      const kindLabel = node?.kind === 'system' ? '🖥️ system' : '🛰️ service';
      const lines: string[] = [
        `## ${node?.kind === 'system' ? '🖥️' : '🛰️'} Service Map — \`${service}\``,
        ``,
        node ? `_${kindLabel} · ${node.count} lesson${node.count !== 1 ? 's' : ''} referenced · domain: ${node.domain}_` : `_No graph node yet — built from tagged lessons below._`,
        ``,
      ];

      // Operators (who owns it)
      if (operators.length > 0) {
        const owners = operators.slice(0, 5).map((o, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          return `${medal} **${o.handle}** (${o.trials}×)`;
        }).join(' · ');
        lines.push(`**Operators:** ${owners}`, ``);
      } else {
        lines.push(`**Operators:** _None attributed — add \`author\` when learning about this service_`, ``);
      }

      // Recent failures first — the triage gold for an incident
      const failures = lessons.filter(l => l.outcome === 'failure');
      const successes = lessons.filter(l => l.outcome !== 'failure');
      if (failures.length > 0) {
        lines.push(`**⚠️ Known failures (${failures.length}):**`);
        for (const l of failures.slice(0, 6)) {
          const sev = l.severity === 'critical' ? ' 🔴' : l.severity === 'major' ? ' 🟡' : '';
          const by = l.author ? ` · 👤 ${l.author}` : '';
          lines.push(`  - ❌ \`${l.topic}\`${sev}${by} — ${(l.what_worked ?? '').slice(0, 100)}`);
        }
        lines.push(``);
      }
      if (successes.length > 0) {
        lines.push(`**✅ Proven fixes (${successes.length}):**`);
        for (const l of successes.slice(0, 6)) {
          const emoji = l.outcome === 'partial' ? '⚠️' : '✅';
          const by = l.author ? ` · 👤 ${l.author}` : '';
          lines.push(`  - ${emoji} \`${l.topic}\`${by} — ${(l.what_worked ?? '').slice(0, 100)}`);
        }
        lines.push(``);
      }

      // Files that run in this service
      if (files.length > 0) {
        lines.push(`**Files in this service:** ${files.slice(0, 8).map(f => `\`${f.path}\``).join(', ')}`, ``);
      }

      lines.push(
        `---`,
        `_Tag lessons with \`service="${service}"\` to keep this map current. For infra, pass \`service_kind="system"\`._`,
      );
      return lines.join('\n');
    }

    // ── brain_collab_pairs ───────────────────────────────────────────────────
    // W5: Person↔Person Collaboration Graph. Shows who works with whom on the
    // team — built from (a) shared file-touches during learn_from_attempts and
    // (b) cross-author knowledge-reuse events from smart_recall. Answers the
    // onboarding question: "Frag X und Y — they solved that together."
    case 'brain_collab_pairs': {
      const { instance_id, min_weight = 1 } = args as { instance_id: string; min_weight?: number };
      const redis = await getConnection(instance_id);
      const minW = typeof min_weight === 'number' && min_weight >= 1 ? Math.floor(min_weight) : 1;

      // Collect all person nodes.
      const personKeys = await scanKeys(redis, 'cachly:ckg:node:person:*', { max: 500 });
      type PInfo = { id: string; handle: string; domain: string; count: number };
      const persons = new Map<string, PInfo>();
      for (const k of personKeys) {
        const raw = await redis.get(k);
        if (!raw) continue;
        const pn = safeJsonParse<PersonNode | null>(raw, null);
        if (!pn || pn.type !== 'person') continue;
        persons.set(pn.id, { id: pn.id, handle: pn.handle, domain: pn.domain, count: pn.count });
      }

      if (persons.size === 0) {
        return [
          `## 🤝 Team Collaboration Graph`,
          ``,
          `No contributors found yet.`,
          ``,
          `The graph builds automatically as teammates store lessons with \`author="name"\`:`,
          `\`learn_from_attempts(topic="...", author="alice", file_paths=["src/auth.ts"], ...)\``,
        ].join('\n');
      }

      // Collect unique A↔B pairs with combined trial count.
      type Pair = { a: PInfo; b: PInfo; trials: number; confidence: number };
      const pairMap = new Map<string, Pair>();

      for (const [personId, pInfo] of persons) {
        const edgeKeys = await redis.smembers(`cachly:ckg:idx:from:${personId}`);
        for (const ek of edgeKeys) {
          const er = await redis.get(ek);
          if (!er) continue;
          const edge = safeJsonParse<CKGEdge | null>(er, null);
          if (!edge || edge.edgeType !== 'collaborates') continue;
          const otherInfo = persons.get(edge.to);
          if (!otherInfo) continue;

          // Canonical pair key: alphabetically smaller id first.
          const [idA, idB] = personId < edge.to ? [personId, edge.to] : [edge.to, personId];
          const pairKey = `${idA}||${idB}`;
          const existing = pairMap.get(pairKey);
          if (existing) {
            existing.trials += edge.trials;
          } else {
            const [pA, pB] = personId < edge.to ? [pInfo, otherInfo] : [otherInfo, pInfo];
            pairMap.set(pairKey, { a: pA, b: pB, trials: edge.trials, confidence: edge.confidence });
          }
        }
      }

      const pairs = [...pairMap.values()]
        .filter(p => p.trials >= minW)
        .sort((a, b) => b.trials - a.trials);

      // Find solo contributors (no collaborators).
      const connectedIds = new Set<string>();
      for (const p of pairs) { connectedIds.add(p.a.id); connectedIds.add(p.b.id); }
      const soloPersons = [...persons.values()].filter(p => !connectedIds.has(p.id));

      const lines: string[] = [
        `## 🤝 Team Collaboration Graph`,
        ``,
      ];

      if (pairs.length === 0) {
        lines.push(
          `No collaboration pairs yet (min weight: ${minW}).`,
          ``,
          `Pairs appear when two contributors touch the same file in \`learn_from_attempts\``,
          `or when someone recalls a teammate's lesson via \`smart_recall(requester="...")\`.`,
        );
      } else {
        lines.push(`**${pairs.length} collaboration pair${pairs.length !== 1 ? 's' : ''}** across ${connectedIds.size} contributor${connectedIds.size !== 1 ? 's' : ''}:`, ``);

        for (const p of pairs.slice(0, 20)) {
          const conf = (p.confidence * 100).toFixed(0);
          const sharedDomains = [p.a.domain, p.b.domain]
            .filter((d, i, arr) => d && arr.indexOf(d) === i)
            .map(d => `\`${d}\``)
            .join(', ');
          lines.push(
            `### @${p.a.handle} ↔ @${p.b.handle}`,
            `- **${p.trials} collaboration event${p.trials !== 1 ? 's' : ''}** · ${conf}% confidence`,
            `- Domains: ${sharedDomains || '_unknown_'}`,
            `> 💬 _"Frag **@${p.a.handle}** und **@${p.b.handle}** — they've solved problems together in these areas."_`,
            ``,
          );
        }

        if (pairs.length > 20) {
          lines.push(`_...and ${pairs.length - 20} more pairs. Use \`min_weight\` to filter._`, ``);
        }
      }

      if (soloPersons.length > 0) {
        lines.push(
          `---`,
          `### ⚠️ Bus Factor Alert — No Collaborators Yet`,
          ``,
          `${soloPersons.length} contributor${soloPersons.length !== 1 ? 's have' : ' has'} knowledge that no teammate has recalled or co-touched:`,
          ``,
          ...soloPersons.slice(0, 10).map(p => `- **@${p.handle}** — ${p.count} lesson${p.count !== 1 ? 's' : ''} · domain: \`${p.domain}\``),
          ``,
          `_Tip: pair these contributors with teammates on shared files to reduce bus factor._`,
        );
      }

      lines.push(
        ``,
        `---`,
        `_Collaboration edges build from \`learn_from_attempts(author=..., file_paths=[...])\` and \`smart_recall(requester=...)\` cross-author reuse._`,
      );
      return lines.join('\n');
    }

    // ── brain_portability ─────────────────────────────────────────────────────

    case 'brain_portability': {
      const { instance_id } = args as { instance_id: string };

      const clients = [
        {
          name: 'Claude Code',
          slug: 'claude-code',
          icon: '🤖',
          configPath: '~/.claude/settings.json',
          configBlock: JSON.stringify({
            mcpServers: {
              cachly: {
                command: 'npx',
                args: ['@cachly-dev/mcp-server@latest'],
                env: { CACHLY_JWT: '<cky_live_...>', CACHLY_BRAIN_INSTANCE_ID: instance_id },
              },
            },
          }, null, 2),
        },
        {
          name: 'Cursor',
          slug: 'cursor',
          icon: '🖱️',
          configPath: '~/.cursor/mcp.json',
          configBlock: JSON.stringify({
            mcpServers: {
              cachly: {
                command: 'npx',
                args: ['@cachly-dev/mcp-server@latest'],
                env: { CACHLY_JWT: '<cky_live_...>', CACHLY_BRAIN_INSTANCE_ID: instance_id },
              },
            },
          }, null, 2),
        },
        {
          name: 'Windsurf',
          slug: 'windsurf',
          icon: '🏄',
          configPath: '~/.windsurf/mcp.json',
          configBlock: JSON.stringify({
            mcpServers: {
              cachly: {
                command: 'npx',
                args: ['@cachly-dev/mcp-server@latest'],
                env: { CACHLY_JWT: '<cky_live_...>', CACHLY_BRAIN_INSTANCE_ID: instance_id },
              },
            },
          }, null, 2),
        },
        {
          name: 'GitHub Copilot (VS Code)',
          slug: 'copilot',
          icon: '🐙',
          configPath: '.vscode/mcp.json (workspace)',
          configBlock: JSON.stringify({
            servers: {
              cachly: {
                type: 'stdio',
                command: 'npx',
                args: ['@cachly-dev/mcp-server@latest'],
                env: { CACHLY_JWT: '<cky_live_...>', CACHLY_BRAIN_INSTANCE_ID: instance_id },
              },
            },
          }, null, 2),
        },
        {
          name: 'Cline',
          slug: 'cline',
          icon: '⚡',
          configPath: '~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
          configBlock: JSON.stringify({
            mcpServers: {
              cachly: {
                command: 'npx',
                args: ['@cachly-dev/mcp-server@latest'],
                env: { CACHLY_JWT: '<cky_live_...>', CACHLY_BRAIN_INSTANCE_ID: instance_id },
              },
            },
          }, null, 2),
        },
        {
          name: 'Zed',
          slug: 'zed',
          icon: '⚡',
          configPath: '~/.config/zed/settings.json',
          configBlock: JSON.stringify({
            context_servers: {
              cachly: {
                command: { path: 'npx', args: ['@cachly-dev/mcp-server@latest'] },
                env: { CACHLY_JWT: '<cky_live_...>', CACHLY_BRAIN_INSTANCE_ID: instance_id },
              },
            },
          }, null, 2),
        },
        {
          name: 'Continue',
          slug: 'continue',
          icon: '▶️',
          configPath: '~/.continue/config.json',
          configBlock: JSON.stringify({
            mcpServers: [
              {
                name: 'cachly',
                command: 'npx @cachly-dev/mcp-server@latest',
                env: { CACHLY_JWT: '<cky_live_...>', CACHLY_BRAIN_INSTANCE_ID: instance_id },
              },
            ],
          }, null, 2),
        },
      ];

      const lines: string[] = [
        `## 🌐 Brain Portability — Same Brain, Any Model`,
        ``,
        `> _"Bring your own model, keep your brain."_`,
        ``,
        `**Your Brain ID:** \`${instance_id}\``,
        ``,
        `Replace \`<cky_live_...>\` below with your own API key (get one at https://cachly.dev/setup-ai) — the Brain ID alone does not authenticate you.`,
        ``,
        `This Brain ID is model-agnostic. Every lesson you've learned, every Memory Crystal you've distilled,`,
        `and every prediction from your Causal Knowledge Graph is accessible from **any MCP-compatible AI client**.`,
        ``,
        `---`,
        ``,
        `### Compatible Clients (${clients.length} supported)`,
        ``,
      ];

      for (const c of clients) {
        lines.push(
          `#### ${c.icon} ${c.name}`,
          `Config: \`${c.configPath}\``,
          ``,
          '```json',
          c.configBlock,
          '```',
          ``,
        );
      }

      lines.push(
        `---`,
        ``,
        `### What travels with you`,
        ``,
        `| Data | Model-neutral? |`,
        `|------|---------------|`,
        `| Lessons (learn_from_attempts) | ✅ Full access in all clients |`,
        `| Memory Crystals (memory_crystalize) | ✅ Included in every session_start |`,
        `| Causal Knowledge Graph (brain_predict) | ✅ Same graph, same predictions |`,
        `| Team lessons (team_learn, team_confirm) | ✅ Team is per-Brain, not per-model |`,
        `| Domain Brain Marketplace installs | ✅ Installed once, available everywhere |`,
        `| Session handoffs (session_handoff) | ✅ Cross-client continuity |`,
        ``,
        `---`,
        ``,
        `### One-command setup for any new client`,
        ``,
        '```bash',
        `npx @cachly-dev/mcp-server@latest autopilot`,
        '```',
        ``,
        `Autopilot detects all installed editors and writes the config for each — with your \`${instance_id}\` Brain ID pre-filled.`,
        ``,
        `---`,
        `_Docs: cachly.dev/docs/model-neutral • Your Brain, Any Model_`,
      );

      return lines.join('\n');
    }

    // ── brain_changelog ───────────────────────────────────────────────────────
    // Generates a human-readable Markdown changelog of recent lessons.
    // Useful for weekly standups, sprint reviews, or async team updates.
    case 'brain_changelog': {
      const {
        instance_id,
        days = 7,
        max_lessons = 30,
        include_failures = true,
      } = args as {
        instance_id: string;
        days?: number;
        max_lessons?: number;
        include_failures?: boolean;
      };

      const redis = await getConnection(instance_id);
      const cutoff = Date.now() - Number(days) * 86_400_000;

      const keys: string[] = await scanKeys(redis, 'cachly:lesson:best:*', { max: 4000, timeoutMs: 4000 });
      type RawLesson = {
        topic?: string;
        outcome?: string;
        what_worked?: string;
        what_failed?: string;
        severity?: string;
        author?: string;
        ts?: string;
        recall_count?: number;
        confidence?: number;
        tags?: string[];
      };

      const recent: (RawLesson & { topic: string })[] = [];
      for (const k of keys) {
        const raw = await redis.get(k).catch(() => null);
        if (!raw) continue;
        const lesson = safeJsonParse<RawLesson>(raw, {});
        const ts = lesson.ts ? new Date(lesson.ts).getTime() : 0;
        if (ts < cutoff) continue;
        if (!include_failures && lesson.outcome === 'failure') continue;
        const topic = k.replace('cachly:lesson:best:', '');
        recent.push({ ...lesson, topic });
      }

      recent.sort((a, b) => {
        const ta = a.ts ? new Date(a.ts).getTime() : 0;
        const tb = b.ts ? new Date(b.ts).getTime() : 0;
        return tb - ta;
      });
      const lessons = recent.slice(0, Number(max_lessons));

      if (lessons.length === 0) {
        return [
          `## 📋 Brain Changelog — last ${days} day${Number(days) !== 1 ? 's' : ''}`,
          ``,
          `_No new lessons learned in this window. Your Brain already knows everything it knows — add new lessons with \`learn_from_attempts\`._`,
        ].join('\n');
      }

      const groups = new Map<string, typeof lessons>();
      for (const l of lessons) {
        const cat = l.topic.includes(':') ? l.topic.split(':')[0] : 'general';
        const arr = groups.get(cat) ?? [];
        arr.push(l);
        groups.set(cat, arr);
      }

      const severityEmoji = (s?: string) =>
        s === 'critical' ? '🚨' : s === 'major' ? '⚠️' : s === 'minor' ? '💡' : '✨';
      const outcomeEmoji = (o?: string) =>
        o === 'failure' ? '❌' : o === 'partial' ? '🔶' : '✅';

      const dateStr = new Date().toISOString().slice(0, 10);
      const lines: string[] = [
        `## 📋 Brain Changelog — ${dateStr} (last ${days} day${Number(days) !== 1 ? 's' : ''})`,
        ``,
        `_${lessons.length} lesson${lessons.length !== 1 ? 's' : ''} learned across ${groups.size} topic area${groups.size !== 1 ? 's' : ''}_`,
        ``,
      ];

      for (const [cat, catLessons] of Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length)) {
        lines.push(`### ${cat}`);
        lines.push('');
        for (const l of catLessons) {
          const icon = l.outcome === 'failure' ? outcomeEmoji(l.outcome) : severityEmoji(l.severity);
          const body = l.outcome === 'failure' ? l.what_failed : l.what_worked;
          const meta: string[] = [];
          if (l.author) meta.push(`by **${l.author}**`);
          if (l.recall_count) meta.push(`${l.recall_count} recall${l.recall_count !== 1 ? 's' : ''}`);
          if (l.confidence !== undefined) meta.push(`${Math.round(l.confidence * 100)}% confidence`);
          lines.push(`- ${icon} **${l.topic}**${body ? ` — ${body}` : ''}`);
          if (meta.length) lines.push(`  _${meta.join(' · ')}_`);
        }
        lines.push('');
      }

      lines.push(
        '---',
        `_Generated from Brain \`${instance_id}\` · Share this in your standup or Slack_`,
      );

      return lines.join('\n');
    }

    // ── brain_set_pref ────────────────────────────────────────────────────────
    case 'brain_set_pref': {
      const {
        instance_id,
        key,
        value,
      } = args as { instance_id: string; key: string; value: string };

      if (!key || !key.trim()) throw new Error('key is required');

      const redis = await getConnection(instance_id);
      const redisKey = `cachly:prefs:${key.trim()}:${instance_id}`;
      await redis.set(redisKey, String(value));

      return `✅ Preference \`${key}\` set to \`${value}\` for this Brain instance.`;
    }

    // ── brain_get_pref ────────────────────────────────────────────────────────
    case 'brain_get_pref': {
      const { instance_id, key } = args as { instance_id: string; key?: string };
      const redis = await getConnection(instance_id);
      if (key && key.trim()) {
        const val = await redis.get(`cachly:prefs:${key.trim()}:${instance_id}`).catch(() => null);
        return val === null
          ? `ℹ️ Preference \`${key}\` is not set (using default).`
          : `🔧 Preference \`${key}\` = \`${val}\``;
      }
      const prefKeys = await scanKeys(redis, `cachly:prefs:*:${instance_id}`, { max: 200, timeoutMs: 2000 });
      if (prefKeys.length === 0) return 'ℹ️ No preferences set for this Brain instance.';
      const vals = await redis.mget(...prefKeys);
      const lines = ['🔧 **Brain preferences:**', ''];
      for (let i = 0; i < prefKeys.length; i++) {
        const k = prefKeys[i].replace('cachly:prefs:', '').replace(`:${instance_id}`, '');
        lines.push(`- \`${k}\` = \`${vals[i] ?? '(null)'}\``);
      }
      return lines.join('\n');
    }

    // ── sync_file_changes ─────────────────────────────────────────────────────

    default:
      return null;
  }
}
