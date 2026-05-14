# Changelog – cachly SDK (mcp)

**Language:** MCP (Model Context Protocol)  
**Package:** `@cachly-dev/mcp-server` on **npm**

> Full cross-SDK release notes: [../CHANGELOG.md](../CHANGELOG.md)

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

