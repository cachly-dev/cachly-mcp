# Changelog – cachly SDK (mcp)

**Language:** MCP (Model Context Protocol)  
**Package:** `@cachly-dev/mcp-server` on **npm**

> Full cross-SDK release notes: [../CHANGELOG.md](../CHANGELOG.md)

---

## [0.10.103] – 2026-06-05 — *"v4 Move 1 — Closed-loop CI"*

### Added
- **`brain_confirm_ci`** — closed-loop CI self-calibration. Call after every CI run with `job_status` (success/failure/cancelled) and the topics the run covered. Confirmed failures boost lesson confidence +15%; false positives (brain predicted failure but CI passed) reduce it −10%; capped 0.05–0.99.
- **cachly-action `confirm` mode** — new `mode: confirm` step in `cachly-action` auto-posts CI outcome to the Brain at pipeline end.
- **`cachly brain` CLI** — `lessons`, `recall`, `stats`, `ci-confirm`, `federation list/contribute` available from the terminal (`@cachly-dev/cli@0.3.0`).

---

## [0.10.102] – 2026-06-03 — *"CLS git hook actually works"*

### Added
- **`cls-ingest` CLI command** — `npx @cachly-dev/mcp-server@latest cls-ingest '<json>'`
  now exists. Previously the generated git post-commit hook called this command but it
  silently fell into stdio-MCP mode and was killed by timeout; no commit data was ever
  ingested. The new command parses the JSON payload, authenticates via `CACHLY_JWT`, and
  calls the `cls_ingest` tool. Exits 0 silently on any error — a commit is never blocked.
- **`buildClsPostCommitHook(instanceId, apiKey?)` helper** (`src/cls-hook.ts`) —
  centralised, versioned (v2) hook builder shared by `init`, `setup`, and `autopilot`.
  Passes commit message / sha / files via **environment variables** (not JS-source
  interpolation) and calls the CLI via `execFileSync` — immune to apostrophes, shell
  quoting, and `$`/backtick injection.
- **`installClsPostCommitHook(projectDir, instanceId, apiKey?)` helper** — idempotent
  installer with version-aware upgrade: existing v1 hooks are replaced in place; foreign
  hooks without a cachly block are appended to.

### Fixed
- **Hook v1 generated invalid JS on any commit message containing an apostrophe** (`don't`,
  `won't`, etc.) — the interpolation `message:'$MSG'` broke the script. Rewritten in v2.
- All three install sites (`init`, `setup`, `autopilot`) now use the shared installer —
  no more divergence between code paths.

---

## [0.10.81] – 2026-05-30

### Onboarding-Bench (time-to-first-recall, measured) + external dashboard plan

**Measuring the v0.10.80 starter-corpus impact.** Recall-lift was already proven
(`npm run bench`); this release measures the *other* decisive metric —
**time-to-first-recall** — as a cold-start hit rate through the real search engine.

**New: `npm run bench:onboarding`** (`src/bench/onboarding-bench.ts`)
- 16 realistic first-session queries, phrased the way a frustrated developer types
  them (NOT the lesson's topic slug), each mapped to a starter topic.
- Two scenarios over the **real keyword search engine**: `cold` (empty Brain) vs
  `seeded` (starter corpus, which auto-seeds on first session when git history is empty).
- **Result: first-query hit@1 0% → 87.5%, hit@3 0% → 100%, MRR 0% → 93.8%, answered 0% → 100%.**
- Interpretation: an empty Brain returns nothing on the first query (user must do work
  + learn before any recall is possible — time-to-first-recall spans a full work cycle);
  the seeded Brain hits immediately (collapses to seconds). Documented in BENCH.md.

**5 new CI-guard tests** (`src/__tests__/onboarding-bench.test.ts`): cold must answer
0%; seeded must keep hit@3 ≥ 90%, hit@1 ≥ 70%, MRR ≥ 80%; seeding must lift every
metric; every cold-start query maps to a real starter topic; the bench exercises the
whole corpus (no flattering subset).

**New: `PLAN-DASHBOARD.md`** — complete build spec for the external Team-Knowledge-Reuse
dashboard (`cachly-insights`, a separate repo): grounded in the actual funnel events and
`cachly:stats:*` keys the MCP server already emits. Covers data sources, architecture,
TimescaleDB schema, the five dashboard views (activation funnel, TTFR with seeded-vs-cold
cohort split, per-org reuse, brain health, marketplace), GDPR constraints, repo bootstrap
steps, milestones, and the one cross-repo prerequisite (resolved telemetry stream in the
cachly API).

No new tools (still 113). Build: clean `tsc`. Tests: 567 passing (14 suites). Lint: 0 warnings.

## [0.10.80] – 2026-05-30

### Starter corpus — first recall in seconds, attacking time-to-first-recall

**The onboarding gap:** a brand-new Brain (fresh repo, shallow clone, no fix-commits in git history) returned nothing on the user's very first `smart_recall` — so time-to-first-recall never started ticking and the "aha" moment was delayed by a whole session.

**New: curated starter corpus** (`src/starter-corpus.ts`) — 16 universal, high-value, stack-agnostic engineering lessons with proven fixes: Docker layer cache, git force-push safety, flaky-test timing, ESM/CJS interop, JWT clock skew, Postgres migration locks, Redis eviction policy, K8s OOM limits, CORS preflight, dotenv precedence, unhandled rejections, SQL N+1, HTTP retry idempotency, cache stampede, secrets-in-logs, TLS cert expiry. No secrets, no PII, no project-specific paths.

**New tool: `brain_seed_starter(instance_id, topic_filter?, force?, dry_run?)`**
- Seeds the corpus so the very first query hits. Tagged `source:"starter"`, **never overrides your own lessons**, idempotent (won't double-seed without `force`), stamps `born_at` so the metric starts counting.
- `topic_filter` matches by topic OR tag; `dry_run` previews; `force` re-seeds + overwrites.

**Auto-seeding on first session:** when `session_start` auto-bootstraps from git history and that yields **zero** lessons (new/empty repo), the starter corpus is seeded automatically — the user's first real query returns a useful answer instead of an empty brain. The empty-brain welcome also surfaces the `brain_seed_starter` command explicitly.

**113 MCP tools** (up from 112).

**18 new tests** (`src/__tests__/starter-seed.test.ts`): corpus integrity (unique topics, required fields, no-PII scan), seeding to best+history keys, `source:"starter"` tagging, `born_at` stamping, idempotency, `force` re-seed, user-lesson protection, `topic_filter` by topic + tag, no-match path, `dry_run`, and — critically — **the real keyword search engine surfacing the right seeded lesson** for natural queries ("docker build slow", "pod OOMKilled", "jwt token rejected").

Build: clean `tsc`. Tests: 562 passing (all 13 suites). Lint: 0 warnings.

## [0.10.79] – 2026-05-30

### Brain Marketplace — full shareable Brain lifecycle + stress tests

**Three more MCP tools completing the share/import lifecycle:**

- `brain_share_list(instance_id)` — lists all Brain snapshots you've shared, with share IDs, lesson counts, visibility, and creation date. Checks the cachly API first; falls back to the local provenance log.
- `brain_unshare(instance_id, share_id)` — revokes and permanently deletes a public share. Link goes dead immediately. Gracefully removes from local log when API is unreachable.
- `brain_discover(query?, topic?, limit?)` — searches the cachly Brain marketplace for publicly shared Brain snapshots. Returns ranked results with lesson counts, topics, import counts, and a one-line `brain_import` command. Shows a "marketplace coming soon" message with alternative paths when the API isn't live yet.

**`publish` CLI command:**
- `npx @cachly-dev/mcp-server@latest publish [--public] [--title "My Patterns"]` — creates a public Brain snapshot and prints a formatted card with the share URL + import command. `--public` makes it discoverable in the marketplace; default is unlisted (link-only).

**112 MCP tools** (up from 109).

**24 new tests** covering:
- `brain_share_list`: empty state, API results, local-log fallback, missing args
- `brain_unshare`: success, 404, ECONNREFUSED local-log-only removal, missing args
- `brain_discover`: results display, topic filter, empty state, marketplace-not-live fallback
- Full lifecycle integration: share → list → unshare in a single test
- `team_expertise_map` stress test: 50 contributors, top_n cap, sort order, empty/single contributor, 0-lesson contributor, default cap
- `brain_who_knows` regression: multi-contributor ranking, inbound edge traversal
- `brain_coverage` regression: high score with attribution, low score with only failures

Build: clean `tsc`. Tests: 544 passing (all 12 suites). Lint: 0 warnings.

## [0.10.78] – 2026-05-30

### Phase 3: Shareable / Public Brains

**Two new MCP tools — share and import Brain snapshots:**

- `brain_share(instance_id, title?, topic_filter?, visibility?, max_lessons?, dry_run?)` — exports a Brain snapshot as a publicly shareable link. Visibility: `public` (discoverable) or `unlisted` (link-only). Optional topic filter narrows what gets exported. `dry_run=true` previews without creating the link. Falls back to portable JSON when the public share API is not yet live.
- `brain_import(instance_id, share_id, topic_prefix?, min_confidence?, overwrite?, dry_run?)` — imports lessons from any public Brain share into your own instance. Accepts full share URLs or bare IDs. Optional `topic_prefix` prevents naming collisions. `overwrite=false` by default (skips existing lessons). `dry_run=true` shows preview without writing.

**109 MCP tools** (up from 107).

**21 new tests** covering:
- `brain_share`: empty Brain, dry_run, topic_filter, API success + URL return, API 404 fallback to portable JSON, missing args
- `brain_import`: dry_run, full import, topic_prefix, skip-existing, overwrite, min_confidence filter, URL share ID parsing, 404 error, missing args
- Regression: `buildServerEnv` self-host URL logic (omit when default, include when custom, omit when empty)
- Regression: `safeJsonParse` never throws; imported lesson has `imported_from` provenance field

Build: clean `tsc`. Tests: 520 passing (all 11 suites). Lint: 0 warnings.

## [0.10.77] – 2026-05-30

### Frictionless onboarding fix + first-class self-hosting / BYOK

**Critical onboarding fix — editor sign-in finally works without pre-set credentials:**
- When an editor launched cachly as an MCP stdio server **without** a `CACHLY_JWT`, the startup code wrote a setup banner to **stdout** (corrupting the JSON-RPC stream) and called `process.exit(0)` — so no tools were ever served and the documented "sign in on first tool call" path was impossible.
- Now: an MCP-server launch with no JWT emits a single hint to **stderr** and **keeps running**, serving all 107 tools so the zero-credential device flow triggers on the first tool call. Verified end-to-end over stdio (107 tools, clean JSON-RPC stdout).
- The human-in-a-terminal banner path is unchanged (TTY splash + exit).

**Self-hosting is now first-class:**
- `setup --api-url https://cachly.mycorp.internal` and `init --api-url …` point the entire flow (auth, provisioning, config writes) at a private backend.
- `CACHLY_API_URL` is baked into the editor config **only when it differs from the default cloud** — default installs stay clean; self-hosted installs keep talking to your backend on every editor launch. Previously the URL was hardcoded to `api.cachly.dev` in every config writer, silently overriding self-hosters.

**BYOK & health fixes:**
- `health` now has an **Embedding provider** section: shows your BYOK provider (OpenAI / Gemini / Mistral / Cohere / Ollama) or server-side cachly embeddings, and warns if `CACHLY_EMBED_PROVIDER` is set without its key.
- `health` now accepts `cky_` long-lived API keys (what `setup` provisions) — previously it falsely reported "format invalid (expected JWT with 3 parts)".
- README: new **Self-hosting & BYOK** section with the full provider/env-var table.

Build: clean `tsc`. Tests: 499 passing. Lint: 0 warnings.

## [0.10.76] – 2026-05-30

### Agent-trace benchmark · editor support matrix · setup timer

**Real agent-trace benchmark corpus** — closes the last open bench item:
- `src/bench/external/agent-traces-corpus.json` — 22 lessons, 15 queries, modelled after realistic AI-agent debugging patterns: TypeScript/ESM resolution, Docker layer caching, Postgres migration locks, GitHub Actions pnpm caching, Redis eviction policy, Node.js event-emitter leaks, JWT clock-skew, Vitest fake-timer async issues.
- Each category contains an adversarial **symptom-dense failure distractor** competing with the solution-focused proven fix — the hardest real-world recall case. BM25 picks the distractor; quality reranking picks the fix.
- Result: **Precision@1 +66.7%, MRR +9.5% vs flat-file** — the strongest corpus yet. Both corpora now documented in BENCH.md with comparison table.
- `npm run bench:external -- src/bench/external/agent-traces-corpus.json`

**First-class editor support matrix** in README:
- Full table: 8 clients (Claude Code, Cursor, Windsurf, VS Code + Copilot, Cline, Continue.dev, Zed, generic), config path, auto-detect, global vs. project config, notes.
- Second table: which sign-in path applies per scenario (real TTY, VSCode task/non-TTY, runtime device-flow, env-var passthrough).

**Setup: elapsed-time banner** — `setup` now records when it started and prints a "Brain is ready — completed in Xs" box at successful exit. Also emits `elapsed_s` in the `setup_completed` telemetry event for server-side time-to-first-recall tracking.

Build: clean `tsc`. Tests: 499 passing. Lint: 0 warnings.

## [0.10.75] – 2026-05-30

### Fix: non-interactive `setup` no longer hangs (VSCode plugin / CI)

Running `npx … setup` from a VSCode task or integrated non-TTY terminal previously hung
forever at the first `readline` prompt — a question against a non-TTY stdin never
resolves. This was the remaining "broken from the VSCode plugin" symptom after the
0.10.74 device-flow proxy fix.

- `setup` now auto-detects a non-interactive stdin (`process.stdin.isTTY !== true`) and runs in automatic mode (same as `--yes`), printing "Non-interactive terminal detected".
- The web-fallback paste step exits with clear, actionable instructions (`CACHLY_JWT=cky_live_xxx npx … setup`) instead of blocking on a paste that can never arrive. Exits non-zero so the editor surfaces the failure.
- Device-flow polling needs no stdin, so the automatic browser sign-in path works unchanged in non-TTY contexts.

Build: clean `tsc`. Tests: 499 passing. Lint: 0 warnings.

## [0.10.74] – 2026-05-30

### Fix: activation funnel — robust device-flow auth with web fallback

**Root cause:** The `setup` CLI was calling the Keycloak device-flow endpoint directly
(`auth.cachly.dev/…/auth/device`), which returns 403 for all external clients. The
silent fallback asked users to "paste an API token" — without opening a browser or
telling them where to get one — causing 100% abandonment.

**What changed:**
- `setup` now tries the **API proxy** (`/api/v1/auth/device/code` + `/api/v1/auth/device/token`) first, then Keycloak as fallback — the same path that `join-team` already used successfully.
- All device-flow fetch calls now have `AbortSignal.timeout(8000)` (previously missing in setup and poll loop).
- When both paths are unavailable the fallback **opens the browser** automatically, shows a step-by-step guide ("Settings → API Keys → Create"), and only then asks for a paste.
- Added `sendFunnelEvent('device_flow_completed')` to the setup flow (was only fired from the runtime device-flow, creating a metric gap).
- Added `sendFunnelEvent('device_flow_failed', { reason })` with the failure reason (`timeout`, `device_flow_unavailable`, auth error code) for observability.
- Same proxy-first fix applied to `startDeviceFlow()` / `pollDeviceFlow()` (runtime MCP device flow triggered by first tool call without JWT).

Build: clean `tsc`. Tests: 499 passing. Lint: 0 warnings.

## [0.10.73] – 2026-05-29

### Team visibility scopes · idempotent one-command init · external bench — 107 tools

**Team-level visibility scopes (groups)** — closes the last Phase-3 visibility gap (previously only lesson-level `private`):
- `team_grant_scope(handle, group, action?, assigned_by)` — add/remove a member to a named sub-team (e.g. `security`, `backend`). Admin-gated after the role model is bootstrapped.
- `team_scopes(handle?)` — list all groups + members, or one person's memberships.
- `learn_from_attempts(group="...")` scopes a lesson to a group; `smart_recall` enforces it per requester — group-scoped lessons surface only for members of that group (admins see all). Orthogonal to `private` (author-only) and `public`.
- Pure, tested helpers in `team.ts`: `getScopes`, `lessonVisibleToScope`.

**Idempotent one-command `init`** — the onboarding entry ticket:
- Now zero-arg capable: falls back to credentials saved by a prior `setup` (`~/.claude/mcp.json`), so you can `init` any project without copy-pasting tokens.
- Idempotent: only writes config files when the content actually changes ("✓ Already configured · no change").
- Reports elapsed time; re-runnable safely. `setup` remains the first-time device-flow wizard; `init` is the fast re-config command.

**External labeled-corpus benchmark** — the credibility proof on data we didn't write:
- Portable JSON corpus format (`bench/external/`), `loadExternalCorpus` + `parseExternalCorpus` (validated) + `runExternalBenchmark`, reusing the same three-ranker harness via the new `runBenchmarkOn(lessons, queries)`.
- `npm run bench:external [./corpus.json] [--json]`. Bundled sample corpus shows **P@1 +20%, MRR +7.7% vs flat-file** on an independently-shaped set. Third parties can drop in their own labeled set to reproduce the lift claim.

Tool count 105 → 107 synced everywhere. +25 tests (`external-bench.test.ts` + scope suites) → 499 total. 0 lint warnings; clean tsc build.

## [0.10.72] – 2026-05-29

### Role model — admin · reviewer · contributor · viewer (Phase 3) — 105 tools

- **Governance is now first-class.** Three new tools establish and inspect the team role model:
  - `team_assign_role(handle, role, assigned_by)` — bootstrap the first admin freely, then only admins can assign/change roles. Idempotent, bounded TTL.
  - `team_whoami(handle)` — see your own role and exactly what you can do.
  - `team_roster` — full team table sorted by rank (👑 admin · 🛡️ reviewer · ✏️ contributor · 👁️ viewer).
- **`team_confirm` is now role-aware.** The reviewer's assigned role automatically determines review weight — admin/reviewer → `senior` (🛡️, 1.25× rerank boost); contributor/viewer → `peer` (✔️, 1.1×). Self-promotion is blocked: passing `level="senior"` without the reviewer role is silently capped to peer.
- **`brain_who_knows`** shows role badges (👑🛡️✏️) inline next to each expert's name.
- **`setup` CLI** prompts for governance bootstrap at the end (optional; idempotent; skippable). Runs `team_assign_role` for the first admin in the same session.
- Roles stored in `cachly:team:roles:{instance_id}` (Redis hash, 2-year TTL). Pure role helpers exported from `team.ts` so other handlers can look up roles without circular imports.
- +23 tests in a new `roles.test.ts` → 474 total. 0 lint warnings; clean tsc build.

## [0.10.71] – 2026-05-29

### Self-healing auth — no more silent "0 recalls because the token quietly died"

- **The silent-failure mode is closed.** Previously a token that expired (or was about
  to) could leave the brain quietly returning nothing — the user only noticed when
  recalls came back empty. Auth is now diagnosed up front on every API call.
- **Automatic refresh:** a near-expiry token (within 10 min) is exchanged for a fresh
  **long-lived API key while it's still valid** — zero user interaction, persisted to
  `~/.claude/mcp.json` so restarts keep it.
- **Retry-once on 401:** a server-rejected call self-heals and retries before surfacing
  an error, so a recoverable credential never degrades into "0 recalls".
- **Loud when it can't heal:** if the credential is truly dead/missing, `session_start`
  prepends a `⚠️ Brain auth degraded` banner and `get_api_status` shows a
  `🛡️ Self-healing` line with the exact one-step fix.
- New pure, fully-tested core in `auth.ts`: `diagnoseAuth`, `planAuthHeal`,
  `isLongLivedApiKey`. Also synced the long-drifted `CURRENT_VERSION` constant.
- +12 tests → 451 total. 0 lint warnings; clean tsc build.

## [0.10.70] – 2026-05-29

### Service/System nodes in the knowledge graph (Phase 3) — 102 tools

- **The graph now models running systems, not just concepts/people/files.** Tag a lesson
  with `service="prometheus"` (and `service_kind="system"` for infra) and cachly builds a
  Service node, wiring `person→operates`, `file→runs_in`, and `concept→affects` edges.
- **New tool `brain_service_map(service)`** — incident triage in one call: who operates the
  service, every known failure, every proven fix, and which files run in it. When a service
  misbehaves (e.g. a restarting Prometheus pod), instantly surface *"alice owns this; it
  OOMKilled under WAL replay before — bob fixed it by raising the memory limit."*
- Private lessons never leak into the map; bounded scans keep it safe on large keyspaces.
- +6 tests → 439 total. 0 lint warnings; clean tsc build.

## [0.10.69] – 2026-05-29

### Personalized context-aware recall (Phase 3) — 6th ranking signal

- **`smart_recall` now accepts `context_files?: string[]`** — the files you are currently
  editing. Any lesson whose `file_paths` overlap with this list gets a **+15 % score
  boost** and a `📁 context match` badge in the output. File-specific institutional
  knowledge surfaces even when the query doesn't name the file.
- **Personalization banner** at the top of results: *"📁 Personalized — 2 lessons boosted
  because they match your current file context (src/auth/service.ts)"* — transparent about
  why a result ranked up.
- Works alongside all five existing ranking signals (outcome, confidence, proven-ness,
  severity, governance) as a post-merge score multiplier — no changes to BM25 or semantic
  layers. +4 tests → 433 total.

## [0.10.68] – 2026-05-29

### Collaboration graph (Phase 3) — person↔person edges

- **The knowledge graph now models who works with whom.** When two people touch the
  same file (via `learn_from_attempts` or `brain_from_git`), cachly records a
  bidirectional `collaborates` edge between them (`ckgRecordCollaboration`). Bounded
  to the first 25 co-touchers per file so a hot file can't blow up the write path.
- **`brain_who_knows` now surfaces collaborators.** For the top expert on a topic, it
  shows who they frequently work with: *"alice frequently works with bob, carol — ask
  them together."* Bus-factor insight + better onboarding routing.
- Built organically from existing person/file nodes — zero new setup. +4 tests.

## [0.10.67] – 2026-05-29

### Network timeouts everywhere in the agent hot path

- **Every `fetch` an agent can trigger now has a hard timeout.** Previously the 6
  embedding-provider calls (OpenAI/Gemini/Mistral/Cohere/Ollama/cachly) and several
  vector-store calls had **no** `AbortSignal` — a slow or unreachable provider could
  hang the entire agent turn.
- Added `AbortSignal.timeout`: embeddings 8 s (`CACHLY_EMBED_TIMEOUT_MS`), semantic
  search + all `cache.ts`/`context.ts`/`brain.ts`/`tco.ts` vector calls 8 s,
  `apiFetch` already had 15 s. The CLI `health` check is now bounded too.
- A memory tool must **never** block the agent: embedding failures already degrade
  to keyword-only recall; now they also fail *fast*.

## [0.10.66] – 2026-05-29

### Packaging hygiene — ship only the server, no mocks, no foreign code

- **The published npm package was leaking everything.** With no `files` field and
  no `.npmignore`, `npm pack` shipped the entire repo: compiled test mocks
  (`MockRedis`), the benchmark, all TypeScript source, dev scripts, and even an
  **unrelated app** (`apps/travel-chaos-organizer`, incl. its Python backend tests).
  336 files / 4.0 MB.
- **Fixed two ways (belt + suspenders):**
  1. `tsconfig.json` now excludes `__tests__`, `*.test.ts`, `src/bench`, and `apps`
     from the build — so `dist/` no longer contains test mocks or the bench at all.
  2. `package.json` gained a `files` whitelist: only `dist/src`, `dist/packages`
     (the runtime telegram-notify dependency), `scripts/postinstall.js`, and
     `server.json` are published.
- **Result: 71 files / 1.5 MB** (was 336 / 4.0 MB). Verified the built binary still
  starts and the postinstall + telegram-notify paths are intact.
- _Clarification: `MockRedis` / `MiniRedis` were never in the runtime code path —
  they only ever substituted Redis inside tests and the benchmark. The bug was that
  the build + packaging shipped those test artifacts to npm. Production always
  connects to a real Valkey/Dragonfly via `new Redis(...)`._

## [0.10.65] – 2026-05-29

### Flat-file head-to-head in the benchmark (the proof gets honest)

- **Cachly-Bench now compares three rankers**, not two: a `flatfile` ranker
  (naive term-overlap, no IDF, no length norm, **no quality signal**, recency
  tiebreak) joins the BM25 `baseline` and `cachly`. The flat-file ranker is an
  honest — in fact *charitable* — stand-in for "an LLM reading its own memory files."
- **Result:** cachly wins the metrics an agent depends on — **Precision@1 +10.0 %,
  MRR +4.4 % vs. flat-file** (and +22.2 % / +10.9 % vs. BM25). The report and BENCH.md
  are honest about *why* flat-file's Precision@3 / Recall@3 look higher (it ranks the
  whole corpus; we did not rig that away).
- **CI-defended:** a new regression test asserts cachly ≥ flat-file on Precision@1
  and MRR, and that the flat-file simulation isn't trivially weak (MRR > 0.5).

## [0.10.64] – 2026-05-29

### The three decisive metrics, now measurable

- **`brain_metrics(instance_id)`** — new tool (101st). Reports the three metrics
  that decide whether the Brain delivers value:
  1. **Time-to-first-recall** — `born_at` (first learn) → `first_recall_at` (first
     proven recall), both `SET NX` so only the first event wins.
  2. **Recall-lift** — published Cachly-Bench headline (+22.2 % P@1), CI-defended.
  3. **Team-knowledge-reuse** — % of proven recalls that used a *teammate's* lesson.
- **Cross-author reuse tracking.** `smart_recall` gains an optional `author`. When
  you recall a lesson written by someone else, cachly increments
  `cross_author_recalls`, records the distinct reuse pair, and surfaces a
  "👥 Team knowledge reuse" banner inline — the value only a shared brain delivers.

## [0.10.63] – 2026-05-29

### Graceful-degradation stability

- New utilities: `withTimeout`, `scanKeys` (capped + timed-out scan), `normalizeGitPath`.
- `skill_gaps` / `brain_coverage` / `team_expertise_map` / `brain_file_map` now scan
  via `scanKeys` — a huge keyspace can no longer hang the agent turn (3 s cap + key cap).
- `brain_from_git` normalizes git rename paths (`src/{old => new}/f.ts`) so file nodes
  don't fragment on renames. Removed a dead person-node scan in `skill_gaps`.
- +13 utils tests.

## [0.10.62] – 2026-05-29

### Hardened Phase 3 tools

- `brain_who_knows`: reject empty/undefined `topic` (was crashing in `ckgSlug`); clamp `limit` to [1,50].
- `brain_file_map`: filter empty path strings, handle non-array input gracefully.
- +5 stability tests.

## [0.10.61] – 2026-05-29

### Phase 3C: 100 MCP tools milestone — zero-setup knowledge graph

- **`brain_from_git` enhanced.** Now auto-builds Person nodes + File nodes from git
  history. Every commit that brain_from_git ingests now upserts the author as a
  PersonNode and each changed file as a FileNode, with `authored` and `touched` CKG
  edges. Run once and your entire org-wide knowledge graph is populated retroactively
  — no `author` fields needed in individual `learn_from_attempts` calls.
  The git log format is updated to `--name-only` so file attribution happens without
  extra git subprocess calls per commit.
- **`skill_gaps()`** — new tool. Scans all lessons and surfaces knowledge blind spots:
  - 🔴 **critical**: domains with ≥1 failure and 0 success lessons
  - 🟡 **warn**: fewer failures than threshold but still unresolved  
  - 🔵 **info**: domains with ≥3 lessons but no attribution (brain_who_knows can't help)
  Private lessons are excluded from gap analysis.
- **`brain_coverage()`** — new tool. Knowledge-coverage health score 0–100 based on
  4 equally-weighted factors: lesson volume, success ratio, attribution completeness,
  and team engagement. Also computes file coverage ratio vs `git ls-files` when run
  inside a git repo. Use `skill_gaps` to find what to improve.
- **+6 tests** → 400 total.
- **100 MCP tools** (was 98). 🎯

## [0.10.60] – 2026-05-29

### Phase 3B: File knowledge map + team expertise overview + visibility scopes

- **`brain_file_map(file_paths=[...])`** — before touching a file, see who has
  worked on it (from `learn_from_attempts` author+file_paths history) and which
  lessons reference it. Experts shown with medal rankings 🥇🥈🥉 + touch count +
  recency. Related lessons shown with outcome + severity + author badges.
- **`team_expertise_map()`** — full team skills matrix as a markdown table:
  contributor · lesson count · top domains · last active. Zero setup: auto-built
  from `author` fields. Useful for onboarding and knowledge-gap detection.
- **`visibility: "private" | "team" | "public"`** on `learn_from_attempts`:
  `private` lessons are never surfaced in `smart_recall` or team views — only
  accessible via exact `recall_best_solution(topic=...)`. Default remains `"team"`.
- **Resilient `smart_recall`**: `apiFetch` for instance info now has a null guard
  so semantic search degrades gracefully when API is unreachable.
- **+8 tests** covering visibility storage, private filtering in smart_recall,
  brain_file_map expert attribution, and team_expertise_map → 394 total.
- **98 MCP tools** (was 96).

## [0.10.59] – 2026-05-29

### Phase 3A: Org-wide knowledge graph — "Who Knows What?"

- **`brain_who_knows(topic="...")`** — new tool (96th). Queries the org-wide
  knowledge graph to find your team's top experts on any topic. Returns a ranked
  list with lesson count, confidence %, primary domains, and last-active recency.
  Medal rankings: 🥇 🥈 🥉 for top 3.
- **Person nodes auto-built.** Every `learn_from_attempts(author="name", ...)` call
  now upserts a `PersonNode` in the CKG and creates an `authored` edge from the
  person to the lesson concept. No extra setup needed.
- **File nodes auto-built.** `file_paths` in `learn_from_attempts` upsert `FileNode`
  entries + `touched` edges from the author → file. Enables future "who worked on X
  file?" queries.
- **Author attribution in `smart_recall`.** Results now show `👤 author-handle`
  inline whenever the matched lesson carries an author field.
- **`+7` tests** covering `ckgUpsertPersonNode`, `ckgUpsertFileNode`, and the full
  `brain_who_knows` flow including ranking order correctness.
- **96 MCP tools** (was 95).

## [0.10.58] – 2026-05-29

### Zero lint warnings

- Systematic unused-import cleanup across all handler files and index.ts
- ESLint exits clean: 0 errors, 0 warnings
- `eslint.config.js`: added `varsIgnorePattern: '^_'`

## [0.10.57] – 2026-05-29

### Critical: fixed broken npm entry point + version hygiene

- **Fixed the package entry point.** When the shared `telegram-notify` package was
  added to the TypeScript build, tsc began emitting to `dist/src/index.js`, but
  `bin`/`main`/`start` still pointed at `dist/index.js`. Versions **0.10.50–0.10.52
  shipped a non-existent entry point** (`npx @cachly-dev/mcp-server` failed). All
  paths now correctly point to `dist/src/index.js`, verified by running the built
  binary.
- **Version re-sync.** `package.json`, `server.json` (MCP registry manifest, was
  stuck at 0.10.23), `package-lock.json` (was 0.10.49), and `MCP_VERSION` are now
  all `0.10.57`. Bumped ahead of the previously published 0.10.55/0.10.56 so
  `latest` points forward again instead of regressing to 0.10.52.
- **Accurate tool count (95).** README badge, `server.json`, `package.json`, and CLI
  banners claimed 80/89 tools; corrected to the actual 95.

## [0.10.52] – 2026-05-29

- `smart_recall`: CKG traversal as a 3rd retrieval signal — surfaces lessons that
  *fixed* causal-graph-similar problems even when vocabulary differs (🕸️ badge).
- Cachly-Bench corpus expanded with a governance adversarial pair; headline lift
  rose to **Precision@1 +22.2%, MRR +10.9%**.

## [0.10.51] – 2026-05-29

- `team_confirm`: human review (🛡️ senior / ✔️ peer) raises a lesson's recall
  ranking — confirmed knowledge outranks unreviewed auto-learned entries.

## [0.10.50] – 2026-05-29

- `smart_recall`: unified keyword + semantic results into one hybrid-ranked list.
- "Brain saved you here" banner surfaces estimated time saved per proven recall.

## [0.10.49] – 2026-05-29

- Persist JWT after device flow (telemetry showed zero authenticated calls after
  restarts). Quality-aware reranking + Cachly-Bench (the moat proof) introduced.

> Note: 0.10.39–0.10.48 and 0.10.53–0.10.56 were interim/parallel publishes; see
> git history for details. 0.10.57 supersedes all of them.

---

## [0.10.38] – 2026-05-25

### `cachly status` — Brain health at a glance

- New CLI command `npx @cachly-dev/mcp-server@latest status`: shows lessons, recalls, quality score, Brain level, team contributors (with count), and your personal invite link — all in one terminal card.

---

## [0.10.37] – 2026-05-25

### Viral wow moments — invite link + first-recall tweet button

- **`cachly invite` fixed** — previously called a non-existent `/api/v1/team/invite` endpoint (always 404). Now calls `GET /api/v1/referral/me` and shows your personal referral link with pre-written Slack DM + tweet text. One command = shareable invite.
- **First-recall email** — the "Your AI just remembered" email now includes a one-click `𝕏 Share this moment` tweet button and a `🤝 Share with your team` section with your personal referral link (shows only if referral code exists). The highest-value wow moment now has a viral exit.

---

## [0.10.36] – 2026-05-25

### ESLint flat-config (ESLint 10 / v9 API)

- Added `eslint` v9 and `typescript-eslint` v8 as devDependencies.
- Created `eslint.config.js` using ESLint flat-config API — replaces the legacy `--ext .ts` syntax that broke with ESLint 10.
- Updated lint script: `eslint src --ext .ts` → `eslint src`.
- Rules: `no-explicit-any` warn, `no-unused-vars` warns but ignores `_`-prefixed params.

---

## [0.10.35] – 2026-05-25

### Docs catch-up

- Backfilled CHANGELOG entries for 0.10.25–0.10.34 (they were missing).
- README now documents the `index` and `learn-git` CLI commands plus the PR-merge auto-learn GitHub Action tip.

---

## [0.10.34] – 2026-05-25

### `learn-git` CLI — auto-learn from commits (PR-merge ready)

- New command `npx @cachly-dev/mcp-server learn-git [./repo] [--max-commits N]` runs `brain_from_git` over recent commits and fires the `brain_from_git` telemetry event. Building block for PR-merge auto-learning in CI.

---

## [0.10.33] – 2026-05-25

### Close the setup funnel

- The setup wizard now fires `setup_completed` at the end of a successful run (with `instance_id` + JWT attribution), so the onboarding funnel `setup_started → setup_completed` is finally traceable.

---

## [0.10.32] – 2026-05-25

### Viral moments: shareable digest card + team first-briefing

- `cachly digest` now prints a tweet-ready card with a pre-filled X/Twitter URL (lessons, recalls, tokens saved, top lesson, brain level).
- **Team-virality**: when `session_start` runs for a user who has lessons from teammates but has never seen them, a one-time "Your team's AI brain has been briefing you" section surfaces exactly which teammate solved what.

---

## [0.10.31] – 2026-05-25

### Unblock npm publish — tests green

- `vitest.config.ts` excludes `**/__tests__/e2e/**` from the unit-test suite (E2E tests require live credentials and were failing CI, blocking every publish since 0.10.27).
- CLI with no args now writes the setup banner to **stdout** and exits 0 (was stderr + exit 1, invisible to callers).
- `process.exit(0)` guarded with an `_isMain` check so importing modules never trigger early exit.

---

## [0.10.30] – 2026-05-24

### CLAUDE.md delivers a visible briefing

- CLAUDE.md template now calls `session_start` (with `workspace_path`) as the first action of every conversation and `session_end` as the last, so the brain briefing is visible to the user instead of running silently.

---

## [0.10.29] – 2026-05-24

### Fix: recall counting + git bootstrap actually fires

- `smart_recall` (the primary recall tool in CLAUDE.md) now also fires `recall_best_solution` when it returns lessons, so `BrainRecallCount` reflects real usage.
- Auto-session-start now passes `process.cwd()` as `workspace_path` so the git auto-bootstrap introduced in 0.10.28 actually triggers.

---

## [0.10.28] – 2026-05-24

### Auto-bootstrap the brain from git on first session

- On a first session with a `workspace_path`, `brain_from_git` runs automatically and its summary is appended inline to the `session_start` briefing — the brain learns from your repo history with zero setup.

---

## [0.10.27] – 2026-05-24

### Fix: session_start counts as a recall

- `session_start` now fires `recall_best_solution` when the brain has lessons (not the first-session welcome), so the dashboard activation nudge clears and the first-recall email fires for active users.

---

## [0.10.26] – 2026-05-14

### Fix: brain_from_git + brain_predict telemetry

- `brain_from_git` and `brain_predict` telemetry events were dead code paths and never fired; both now correctly send per-tool telemetry.

---

## [0.10.25] – 2026-05-14

### Per-tool telemetry events for all brain tools

- Every brain tool (`session_start`, `session_end`, `learn_from_attempts`, `smart_recall`, `recall_best_solution`) now emits a dedicated telemetry event for accurate funnel + report breakdowns.

---

## [0.10.24] – 2026-05-14

### Funnel visibility + server.json version sync

- `first_call_success` now includes `instance_id` for full per-tenant attribution in the `mcp_events` table.
- `server.json` version bumped to 0.10.24 — Smithery and MCP directory indexes now show the current version.

---

## [0.10.23] – 2026-05-14

### Full activation funnel + UTM tracking

- **`sendFunnelEvent` carries JWT**: all funnel events (`setup_started`, `device_flow_completed`, `first_call_success`) now include the JWT so the backend can resolve them to a tenant. Activation funnel is now fully attributable per user.
- **`cachly share` UTM link**: the generated tweet now includes `https://cachly.dev?ref=share&utm_source=x&utm_medium=social&utm_campaign=cli-share` so shares can be traced back to new signups.

---

## [0.10.22] – 2026-05-14

### Activation telemetry, health Redis ping, join backup

- **`first_call_success` telemetry**: fires once per process on the first successful brain/context tool call. Combined with `setup_started → device_flow_completed → first_call_success`, the full activation funnel is now visible.
- **`cachly health` Redis PING**: section 3 now opens an actual Redis connection and sends `PING` — verifies end-to-end connectivity, not just instance metadata.
- **`cachly join` corrupt JSON**: backs up corrupted config files to `.bak` before overwriting, matching the `mergeMcpConfig` behavior.

---

## [0.10.21] – 2026-05-14

### Stability hardening — corrupt configs, silent auth failures, upgrade validation

- **`mergeMcpConfig` corrupt JSON**: instead of silently overwriting, backs up the corrupted file to `.bak` and prints a warning so the user knows their previous config was preserved.
- **`getConnection` auth failure**: if the `/connection` endpoint returns 401/403, throws an actionable "run `cachly setup` to refresh credentials" error instead of silently attempting a password-less Redis connect that fails with cryptic `NOAUTH`.
- **`upgrade` version validation**: validates that the npm registry response contains a valid semver string before comparing — prevents false "update available" from a malformed registry response.

---

## [0.10.20] – 2026-05-14

### Edge case hardening — silent failures eliminated

- **`getConnection` status messages**: `failed`, `suspended`, and `pending_payment` now each get a specific actionable message instead of the generic "not reachable" fallback. Users know exactly what happened and where to go to fix it.
- **`setup` write errors**: config file write failures now print a clear warning with the OS error and a recovery hint instead of silently succeeding.
- **`join` write errors**: permission and unexpected filesystem errors are surfaced per-file instead of silently swallowed. Expected "editor not installed" cases are still quiet.
- **Auto-provision telemetry**: if free-tier auto-provision returns a non-2xx response, a `auto_provision_failed` telemetry event fires so the team can detect new-user activation failures in real time.

---

## [0.10.19] – 2026-05-14

### Fix: accurate provisioning time estimate

- `getConnection` no longer says "30 seconds" — the message now correctly says "1–3 minutes" for first-time provisioning. This prevents users from thinking their instance failed just because the first tool call waited 25 s and still saw `provisioning`.
- Dashboard instance detail page provisioning banner updated to match ("1–3 minutes" instead of "under 60 seconds").

---

## [0.10.17] – 2026-05-14

### `cachly upgrade` — check for newer versions

- **`cachly upgrade`** — fetches the latest version from the npm registry and compares with the running version. If outdated, shows current vs. latest and the one-liner to update (`npx @cachly-dev/mcp-server@latest setup`). No auth required.
- Added `upgrade` to no-auth bypass list and splash screen.

### Dashboard — Brain Badge widget

- Instance detail page now shows a live badge preview + copy-ready Markdown and HTML snippets directly in the dashboard. No CLI needed.
- Badge renders as `![cachly Brain](https://api.cachly.dev/api/v1/badge/<id>)` — one click to copy.

---

## [0.10.16] – 2026-05-14

### `cachly join` — accept a Brain invite in one command

- **`cachly join <token>`** — the missing half of the invite loop. Accepts a shared Brain invite link:
  1. Fetches invite info (public, no auth) — shows Brain name, tier, expiry
  2. Prompts for confirmation
  3. If no JWT: starts Device Flow sign-in (browser, 10 s)
  4. Writes `CACHLY_BRAIN_INSTANCE_ID` into every detected editor MCP config (`.mcp.json`, `.cursor/mcp.json`, `.windsurf/mcp.json`, `.vscode/mcp.json`, `~/.claude/mcp.json`)
  5. Suggests `cachly badge` as next step
- Added `join` to no-auth bypass list
- Splash screen updated to list `join` command

### MCP Directory metadata

- **`smithery.yaml`** — added `name` + `description` block for Smithery listing quality
- **`glama.json`** — added keywords: `cline`, `zed`, `brain-from-git`, `failure-prediction`, `memory-crystals`, `readme-badge`, `incremental-learning`
- **`server.json`** — version bumped to `0.10.15`

---

## [0.10.15] – 2026-05-14

### Brain Badge

- **`cachly badge`** — new CLI command that outputs the Markdown + HTML snippet for embedding a live lesson-count badge in any README or website. Badge SVG served by `GET /api/v1/badge/:instanceId` (public, no auth, rate-limited 30 req/min, result cached 1 h in instance Valkey). Badge shows lesson count only — no topic names or content.
- **Setup CTA** — both setup flows now print `npx ... badge` as the next suggested action after successful configuration.
- **README** — Brain Badge section added with copy-paste Markdown snippet and explanation. Badge shield added to header.

---

## [0.10.8] – 2026-05-14

### Viral CLI — 6 new commands

- **`cachly demo`** — zero-signup Brain preview. Reads local `.git/` history, classifies commits by type (fix/feat/security/deploy/refactor/perf), and renders an ASCII table showing commit count, date range, contributors, per-category bar charts, and sample security + bug-fix lessons. No account or token required — works before any sign-in.

- **`cachly share`** — shareable ASCII stats card. Fetches live Brain stats (lessons, recalls, tokens/cost saved, Brain level) and generates a tweet-ready text block with `#AIMemory #ClaudeCode #Cursor` hashtags. Requires `CACHLY_JWT`.

- **`cachly digest`** — weekly Brain summary. Displays a formatted summary table: lessons stored, recalls performed, tokens saved, estimated cost saved, Brain level, top team contributors, and top-recalled lessons. Includes a crontab snippet for automated Monday morning delivery. Requires `CACHLY_JWT`.

- **`cachly invite [email]`** — team referral. Accepts an email address as argument or via interactive prompt, then POSTs to `/api/v1/team/invite`. Handles 409 (already a member) gracefully. Requires `CACHLY_JWT`.

- **`cachly health`** — connection check. Validates JWT (decode + expiry), tests API reachability, checks Brain instance status, scans all editor MCP config files (Claude Code, Cursor, Windsurf, VS Code, Zed, Continue), and verifies the git post-commit hook. Exits 1 if any checks fail — CI-friendly.

- **No-args splash screen** — running `npx @cachly-dev/mcp-server@latest` in a TTY now shows a violet-framed help card listing all commands instead of silently starting the MCP server.

### brain_from_git — Incremental mode + progress feedback

- **Incremental by default** — after the first full run, subsequent calls only process commits since the last ingested SHA (stored in Redis with 90-day TTL). Repeated calls on active repos are near-instant.
- **Progress output** — reports progress to stderr every ~10% of commits (`⏳ Processing N/total…`) and prints a completion summary (`✅ brain_from_git complete: N/total commits ingested`).
- New `incremental` boolean parameter (default `true`). Pass `false` to force a full reprocess.

### README

- Complete rewrite: `cachly demo` featured at the very top with embedded ASCII preview output, all 6 CLI commands documented, Zed manual-setup section added, competitor table updated, FAQ expanded with incremental `brain_from_git` Q&A.

---

## [0.10.0] – 2026-05-08

### Zero-Friction Onboarding

- **Global Claude Code config** — `setup` now writes `~/.claude/mcp.json` (global) in addition to project-level `.mcp.json`. cachly is available in every Claude Code project after running setup once — no per-project re-configuration needed. Existing MCP servers in the global config are preserved (merge, not overwrite).

- **Device Flow authentication** — No credentials required in MCP config. On the first tool call without a `CACHLY_JWT`, the server starts an OAuth Device Flow: the AI shows a one-click sign-in URL in chat, polls for completion, exchanges the token for a long-lived API key, and auto-provisions a Brain instance. Fully transparent to the user.

- **Fully automatic sessions** — `session_start` and `session_end` are called automatically (on first tool call and on SIGTERM). Users never need to call them manually.

- **Auto project indexing** — On session start, the project is indexed in the background if the last index is older than 24 hours. Zero extra calls.

### CLAUDE.md Rules — Mandatory Brain Behavior

The CLAUDE.md block written by `setup` now instructs the AI with binding rules (not suggestions):

- `smart_recall` before every task
- `causal_trace` before grepping/reading files when debugging
- `brain_predict` before deploys, migrations, and dependency upgrades
- `remember_context` before editing any file (WIP registry)
- `learn_from_attempts` after every fix, deploy, or discovery

### SEO & Search AI Optimization

- **`llms.txt`** added — AI crawler standard file with complete tool catalog (89 tools + descriptions), competitor comparison, architecture overview. Indexed by Perplexity, ChatGPT Search, Claude web search.
- **README** — FAQ section, competitor table (cachly vs mem0 vs MemGPT vs CLAUDE.md), `autopilot` tool documented prominently.
- **GitHub topics** set: `mcp`, `mcp-server`, `ai-memory`, `persistent-memory`, `claude-code`, `cursor`, `github-copilot`, `causal-trace`, `developer-tools`, `typescript`.
- **package.json** — description and keywords updated: `causal-trace`, `root-cause-analysis`, `failure-prediction`, `long-term-memory`, `llm-memory`, `claude-code-memory`.

### Auth Module

- `jwtExpiryMs`, `checkJwt`, `handleApiError` extracted from `index.ts` into `src/auth.ts`
- 23 unit tests added for auth module (Vitest)
- Publish workflow now runs tests before building

### Bug Fixes

- `safeJsonParse` applied to all `JSON.parse` calls in `advanced.ts` and `syndicate.ts`
- Removed dead warm-up code

---

## [0.9.3] – 2026-05-06

### 🧠 10x Vision Phase 2 — Layers 3, 5 & 6

#### Layer 3 — Multi-Agent Deliberation Chamber (MADC)

New tool: **`madc_deliberate`** — When conflicting lessons exist for a topic, run deliberation between 6 specialist expert agents (InfraAgent, AuthAgent, DeployAgent, DatabaseAgent, DebugAgent, APIAgent). Each agent votes based on its CKG domain coverage. Unanimous → loser superseded. Split → contested flag. Resolutions stored as permanent CKG nodes.

Auto-trigger: `learn_from_attempts` now detects contradictions, writes a `contradicts` CKG edge, and suggests `madc_deliberate` automatically.

#### Layer 5 — Continuous Learning Stream (CLS)

Two new tools for learning **without `session_end`**:

- **`cls_ingest`** — Ingest learning signals from 3 sources: `git_commit` (commit message + files → CKG edges + lesson), `ci_outcome` (green after red → confirmed fix at 75% confidence), `ide_diagnostic` (compiler error + fix pair → instant lesson + CKG `fixes` edge).

- **`cls_install_hooks`** — Outputs a ready-to-paste git post-commit hook + GitHub Actions step. Once installed: every commit and CI run feeds the brain automatically. Zero `session_end` required.

#### Layer 6 — Federation Protocol (FedBrain)

Four new tools for AI-to-AI knowledge transfer with cryptographic provenance:

- **`fedbrain_contribute`** — Contribute a lesson to the global commons with a HMAC-signed knowledge certificate (domain fingerprint + confidence + outcome chain hash).

- **`fedbrain_search`** — Context-weighted search: your domain fingerprint (from contributed lessons + `context_hints`) weights results from brains with matching tech stacks higher. Shows Gold Standard badges (10+ confirms).

- **`fedbrain_confirm`** — Confirm that a syndicated lesson worked. Propagates back to global commons (increments `confirm_count`). Updates local CKG confidence. At 10 independent confirmations → 🏆 Gold Standard.

- **`fedbrain_status`** — Dashboard: contributed lessons, confirm history, Gold Standard count, pending propagations.

#### Summary

| Layer | Tool(s) | What it does |
|-------|---------|--------------|
| 3 (MADC) | `madc_deliberate` | Expert agent voting on contradicting beliefs |
| 5 (CLS) | `cls_ingest`, `cls_install_hooks` | Continuous learning without session_end |
| 6 (FedBrain) | `fedbrain_contribute`, `fedbrain_search`, `fedbrain_confirm`, `fedbrain_status` | Federated knowledge with crypto certificates |

Total tools: **63** (was 54 in v0.9.2)

---

## [0.9.2] – 2026-05-06

### 🧠 10x Vision Phase 1 — Layers 1, 2, 4 & 7

- **Layer 1 (CKG):** Redis-backed Causal Knowledge Graph. Typed edges: `fixes`, `requires`, `co-occurs`, `causes`, `contradicts`.
- **Layer 2 (BUE):** `learn_from_attempts` now writes CKG edges with Bayesian confidence `(s+1)/(t+2)`.
- **Layer 4 (PPE):** `brain_predict` — CKG traversal + text fallback for failure prediction.
- **Layer 7 (MCM):** Domain coverage map in `session_start` with confidence bars.
- New: `brain_search` (BM25+ over all brain data), `ckg_inspect` (BFS with confidence bars).
- `causal_trace` upgraded: CKG graph-first, text similarity fallback.

---



### 🌐 Knowledge Syndication — The Global AI Brain

The first collective intelligence layer for AI memory.
Every instance contributes. Every instance learns. Privacy-preserving by design.

#### New Tools

- **`syndicate`** — Contribute a verified lesson to the **global Knowledge Commons**. Your identity is a one-way HMAC hash — completely anonymous. The lesson is immediately searchable by every other AI brain on the planet. Call this after any `learn_from_attempts` that is worth sharing: critical bugs, deployment gotchas, architecture discoveries. This is how individual knowledge becomes collective intelligence.

- **`syndicate_search`** — Search the **global Knowledge Commons** for solutions discovered by the entire community. Results ranked by `confirm_count` (trust score) then recency. Use this *before* debugging any unknown issue — someone in the global brain likely solved it already. Returns: topic, what worked, what failed, trust bar `████████░░ ×47`.

#### Privacy Design
- Contributors identified only by HMAC-SHA256 of user_id — irreversible, not linkable to any identity
- Absolute file paths stripped from all content before storage
- Community flagging: lessons with 3+ flags are hidden globally
- Trust scoring: `confirm_count` rises as independent instances verify a lesson works

---

## [0.6.1] – 2026-05-04

### 🧠 Cognitive Cache — v0.6 Major Feature

The first AI Memory system with **reasoning over its own knowledge**. No other cache has ever done this.

#### New Tools

- **`memory_consolidate`** — Weekly garbage collector for your AI Brain. Detects contradictions (same topic, different outcomes), merges duplicate lesson clusters, flags stale entries (0 recalls in N days). Like `git gc` for knowledge. Returns a full consolidation report with before/after counts.

- **`brain_diff`** — `git log` for your AI Brain. Shows exactly what changed since a given time window (`"7d"`, `"30d"`, ISO-8601). New lessons, updated lessons, recalled lessons. Perfect for weekly reviews: *"What did my AI learn this week?"*

- **`causal_trace`** — Root Cause Analysis through memory. Given a problem description, scores all lessons by relevance, reconstructs the failure chain (root → intermediate → symptom), and surfaces the exact solution that worked before. *"auth breaks after restart"* → root: `k8s:namespace-terminating` → via: `keycloak:jwks-race` → fix: `PollUntilContextTimeout 3min`. No other system can do this.

- **`knowledge_decay`** — Confidence scoring per lesson. Age × recall-frequency × outcome = decay score (0–100%). Visual bars: `████░░░░░░ 40%`. Lessons recalled recently score high; 90-day-old untouched lessons score low. Run before a big refactor to know which knowledge to trust.

- **`autopilot`** — Generates a `CLAUDE.md` / `copilot-instructions.md` that turns any AI (Claude, Cursor, Copilot, Windsurf, Gemini) into a self-managing Brain operator. No manual `session_start`, `learn_from_attempts`, or `session_end` calls ever again. One command. Every AI. Forever.

---

## [0.5.80] – 2026-05-01



### Added

- **RTL language support (Arabic, Hebrew)** — word-level tokenization with Unicode ranges U+0590–U+05FF (Hebrew) and U+0600–U+06FF (Arabic); Arabic light stemmer strips definite article `ال` and single-char prefix particles (`و`,`ب`,`ل`,`ف`,`ك`)
- **Arabic and Hebrew stopwords** — ~60 high-frequency function words per language added to the STOPWORDS set
- **Romanization matching** — katakana segments now additionally emit Hepburn romaji tokens at index time (e.g. `デプロイ` → `depuroi`), so users can query Japanese docs using romaji
- **Full katakana→romaji converter** — handles digraphs (シャ→sha, チェ→che, ファ→fa), voiced consonants, geminate consonants (ッ), long vowel marks (ー), and loanword combinations
- **Cross-language retrieval** — 130+ tech term synonyms spanning EN↔JA↔ZH↔KO↔AR↔HE; searching `deploy` now finds docs containing `デプロイ`, `部署`, `배포` and vice versa; applies bidirectionally at tokenize time (zero runtime overhead)
- **73 unit tests** all passing — new test suites for `katakanaToRomaji`, `arabicLightStem`, `expandCrossLingual`, RTL tokenization, and cross-lingual expansion

---

## [0.5.36] – 2026-04-22

### Added

- **Roadmap tools** — `roadmap_add`, `roadmap_update`, `roadmap_list`, `roadmap_next` for persistent project planning inside the Brain
- `session_start` now shows open roadmap items automatically

---

## [0.5.35] – 2026-04-20

### Added

- **CJK language support** — Chinese (Simplified + Traditional), Japanese, Korean
- Character bigram extraction for CJK Unicode ranges
- ~140 CJK stopwords (Chinese particles, Japanese hiragana particles, Korean postpositions)

---



### Added

- **`setup` command** — interactive zero-arg CLI wizard (`npx @cachly-dev/mcp-server setup`):
  - Reads `CACHLY_JWT` from env or prompts interactively via readline
  - Fetches instances from API; presents list when multiple exist
  - Auto-detects installed editors (Cursor, Windsurf, VS Code, Continue.dev) by checking for their config directories
  - Writes the correct MCP config file for each detected editor in one step
  - Always writes/updates `CLAUDE.md` (idempotent via `<!-- cachly-brain-start/end -->` markers)
- **`init` command** now idempotent — re-running `npx @cachly-dev/mcp-server init` updates the brain block in `CLAUDE.md` instead of appending a duplicate
- Shared helpers: `buildMcpConfig()`, `buildClaudeMdBlock()`, `writeClaudeMd()` — used by both `setup` and `init`

### Fixed

- `init` no longer duplicates the brain block in `CLAUDE.md` when run multiple times
- Correct package name `@cachly-dev/mcp-server` used consistently (was `@cachly-dev/mcp` in generated configs)

---

## [0.1.1] – 2026-04-07

### Fixed

- Broken `index_project` tool schema – properties were accidentally placed outside the `TOOLS` array
- Unused `openai` variable removed from `cache_warmup` handler
- `readdir` type mismatch (`Dirent<string>` vs. `NonSharedBuffer`) fixed
- Version bumped to `0.3.0` in server metadata

---

## [0.1.0] – 2026-04-07

Initial release.

### Added

- MCP tool: `cache_set` – store a value with optional TTL
- MCP tool: `cache_get` – retrieve a cached value
- MCP tool: `cache_delete` – remove a key
- MCP tool: `semantic_search` – vector-similarity lookup for LLM response caching
- MCP tool: `cache_clear` – flush namespace or entire cache
- Compatible with Claude Desktop, Cursor, Windsurf, and any MCP-capable host
- API-key-based authentication
- EU data residency (German servers, DSGVO compliant)

### Known limitations

- ~~Streaming tools not yet supported~~ (tracked for a future release)

---

## [Unreleased]

See [../CHANGELOG.md](../CHANGELOG.md) for upcoming features.

