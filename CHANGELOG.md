# Changelog – cachly SDK (mcp)

**Language:** MCP (Model Context Protocol)  
**Package:** `@cachly-dev/mcp-server` on **npm**

> Full cross-SDK release notes: [../CHANGELOG.md](../CHANGELOG.md)

---

## [0.7.0] – 2026-05-04

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

