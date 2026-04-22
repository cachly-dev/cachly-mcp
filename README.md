# 🧠 cachly AI Brain — MCP Server

> **Persistent memory for Claude Code, Cursor, GitHub Copilot & Windsurf.**  
> Your AI remembers every lesson, every fix, every architecture decision — forever.

<p align="center">
  <a href="https://github.com/cachly-dev/mcp-server/stargazers">
    <img src="https://img.shields.io/github/stars/cachly-dev/mcp-server?style=social" alt="GitHub Stars" />
  </a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@cachly-dev/mcp-server">
    <img src="https://img.shields.io/npm/v/@cachly-dev/mcp-server?color=red&logo=npm" alt="npm version" />
  </a>
  &nbsp;
  <a href="https://www.npmjs.com/package/@cachly-dev/mcp-server">
    <img src="https://img.shields.io/npm/dw/@cachly-dev/mcp-server?color=blue&label=weekly%20installs" alt="npm downloads" />
  </a>
  &nbsp;
  <a href="https://cachly.dev">
    <img src="https://img.shields.io/badge/Free%20tier-€0%2Fmo-brightgreen" alt="Free tier" />
  </a>
  &nbsp;
  <a href="https://cachly.dev/legal">
    <img src="https://img.shields.io/badge/GDPR-EU%20only-green" alt="GDPR: EU only" />
  </a>
  &nbsp;
  <img src="https://img.shields.io/badge/License-Apache--2.0-yellow" alt="License: Apache-2.0" />
</p>

---

## The Problem

Every morning, you open your AI coding assistant. It doesn't remember yesterday.  
You explain your architecture. You explain the deployment process. You explain the bug you fixed last week.

**The average developer wastes 45 minutes/day re-establishing context.** That's €15,000+ in lost productivity per engineer per year.

## The Fix — One Command

```bash
npx @cachly-dev/mcp-server@latest setup
```

The interactive wizard:
1. Signs you in (free, no credit card required)
2. Picks or creates your AI Brain instance
3. **Auto-detects** Cursor, Windsurf, VS Code, Claude Code, Continue.dev
4. Writes the correct MCP config for every detected editor
5. Creates `CLAUDE.md` with memory rules pre-filled

**Result:** Your AI remembers everything. Always.

---

## Quick Start (Manual)

**Step 1 — Get your free credentials** at [cachly.dev](https://cachly.dev) (25 MB free, forever, no credit card).

**Step 2 — Add to your editor's MCP config:**

<details>
<summary><b>Claude Code</b> (<code>~/.claude/mcp.json</code> or <code>.mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "cachly": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server@latest"],
      "env": {
        "CACHLY_JWT": "your-jwt-token",
        "CACHLY_INSTANCE_ID": "your-instance-id"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Cursor / Windsurf / VS Code</b> (<code>.cursor/mcp.json</code> / <code>.mcp.json</code>)</summary>

```json
{
  "servers": {
    "cachly": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server@latest"],
      "env": {
        "CACHLY_JWT": "your-jwt-token",
        "CACHLY_INSTANCE_ID": "your-instance-id"
      }
    }
  }
}
```
</details>

**Step 3 — Add to `CLAUDE.md` / `.github/copilot-instructions.md`:**

```markdown
## AI Brain Rules (cachly)
- Call session_start BEFORE reading any files or making changes
- Call learn_from_attempts AFTER every fix, deploy, or discovery
- Call session_end when closing the window
```

---

## With vs. Without cachly

| Situation | Without cachly | With cachly |
|-----------|----------------|-------------|
| Session start | "What's your architecture?" | "Ready. 23 lessons, last session: deployed API." |
| Known bug hits again | Re-researches from scratch | "You fixed this on March 12, here's the exact command" |
| After holiday / team handoff | Context dead | Fully briefed in < 10 seconds |
| Repeated LLM patterns | Pays for each re-discovery | Cached by meaning, ~1,200 tokens saved per hit |
| New team member | Weeks to onboard | `session_start` gives full context instantly |

---

## 51 MCP Tools

### 🧠 Session & Memory (most used)

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session summary, open failures, recent lessons, brain health |
| **`session_end`** | Save what you built, auto-extract lessons from summary + ambient git log |
| **`session_handoff`** | Hand off remaining tasks to next window, with context |
| **`auto_learn_session`** | Batch-learn from a list of observations |
| **`sync_file_changes`** | Sync changed files into brain index |
| **`learn_from_attempts`** | Store structured lessons after any fix, deploy, or discovery |
| **`recall_best_solution`** | Best known solution for a topic — with success/failure history |
| **`recall_at`** | Recall a lesson at a specific point in time |
| **`remember_context`** | Cache architecture findings, decisions, file summaries |
| **`recall_context`** | Get exact context by key (supports glob) |
| **`list_remembered`** | See all cached context entries |
| **`forget_context`** | Remove stale context |
| **`smart_recall`** | BM25+ full-text search across all brain data |
| **`setup_ai_memory`** | Interactive wizard to configure AI memory |

### 💡 Legendary Brain Features

| Feature | How it works |
|---------|-------------|
| **Team Telepathy** | Multi-dev Brain: the `author` param on `learn_from_attempts` shares fixes across the whole team. Every `session_start` shows colleagues' lessons. |
| **Ambient Git Learning** | Pass `workspace_path` to `session_end` — it auto-reads `git log`, stores recent commits as Brain lessons. Zero extra calls. |
| **Memory Crystals** | `memory_crystalize` distills all lessons into a compact Crystal injected at every `session_start`. AI arrives pre-loaded with team knowledge. |
| **IQ Boost** | `brain_doctor` reports `iq_boost_pct` — how much smarter your AI gets vs. baseline from cached lessons. |

### ⚙️ Instance Management

| Tool | What it does |
|------|-------------|
| `list_instances` | List all your cache instances |
| `create_instance` | Spin up a new instance (free or paid) |
| `get_connection_string` | Get the `redis://` URL for your app |
| `delete_instance` | Remove an instance |
| `get_real_time_stats` | Memory, hit rate, ops/sec |

### 🗄️ Cache Operations

| Tool | What it does |
|------|-------------|
| `cache_get` / `cache_set` / `cache_delete` | Standard cache operations |
| `cache_mget` / `cache_mset` | Bulk pipeline (single round-trip) |
| `cache_lock_acquire` / `cache_lock_release` | Distributed Redlock-lite |
| `cache_stream_set` / `cache_stream_get` | LLM token stream caching |

### 🔍 Semantic Cache

| Tool | What it does |
|------|-------------|
| `semantic_search` | Find cached entries by meaning (pgvector HNSW, EU-hosted) |
| `semantic_warmup` | Pre-warm cache with prompt/response pairs |
| `detect_namespace` | Auto-classify prompt into code/qa/summary/translation/creative |

### 👥 Team Brain

| Tool | What it does |
|------|-------------|
| `team_learn` / `team_recall` | Share lessons across the team |
| `team_synthesize` | Consolidate multiple lessons into one authoritative version |
| `memory_crystalize` | Distill all lessons into a Crystal snapshot for instant team context |
| `brain_doctor` | Health check: lesson count, IQ boost %, open failures, quality score |
| `global_learn` / `global_recall` | Cross-project universal lessons |
| `publish_lesson` / `import_public_brain` | Share/import community knowledge |
| `trace_dependency` | Causal chain — find lessons affected by a dependency change |
| `list_orgs` / `create_org` | Manage team organizations |
| `invite_member` / `get_org_plan` | Invite a developer to your org by email |

---

## Pricing

| Tier | RAM | Price | Best for |
|------|-----|-------|----------|
| **Free** | 25 MB | **€0/mo forever** | Dev & side projects |
| **Dev** | 200 MB | €19/mo | Individual developers |
| **Pro** | 900 MB | €49/mo | Teams |
| **Speed** | 900 MB + Dragonfly + Semantic Cache | €79/mo | AI-heavy workloads |
| **Business** | 7 GB | €199/mo | Scale-ups |

✅ All plans: **German servers · GDPR-compliant · 99.9% SLA · No credit card for Free tier**

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | — | **Required.** Your API token from [cachly.dev](https://cachly.dev) |
| `CACHLY_INSTANCE_ID` | — | Default instance UUID (optional if you pass per-call) |
| `CACHLY_API_URL` | `https://api.cachly.dev` | Override for self-hosted |
| `CACHLY_NO_TELEMETRY` | unset | Set to `1` to disable anonymous usage pings |
| `CACHLY_NO_UPDATE_CHECK` | unset | Set to `1` to disable the version-check on startup |

---

## 🛠️ Ecosystem

| Package | What it does |
|---------|-------------|
| **[`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | ← you are here — AI Brain MCP tools for Claude Code, Cursor, Copilot, Windsurf |
| **[`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw)** | JS/TS SDK — cut LLM costs 60–90% with semantic cache + BM25 in your own app, 3 lines of code |
| **[`@cachly-dev/init`](https://www.npmjs.com/package/@cachly-dev/init)** | One-command setup wizard: auto-detects all your editors and writes the correct MCP config — `npx @cachly-dev/init` |
| **[`@cachly-dev/cli`](https://www.npmjs.com/package/@cachly-dev/cli)** | Terminal CLI — manage instances, cache data, brain lessons: `npm i -g @cachly-dev/cli` |
| **[`@cachly-dev/sdk`](https://www.npmjs.com/package/@cachly-dev/sdk)** | Node.js/TypeScript SDK — use managed Redis, semantic cache & AI memory directly in your app |

---

## Links

- 🌐 [cachly.dev](https://cachly.dev) — Dashboard & free signup
- 📖 [AI Brain docs](https://cachly.dev/docs/ai-memory) — Full documentation
- 💬 [GitHub Issues](https://github.com/cachly-dev/mcp-server/issues) — Bug reports & feature requests
- ⭐ [Star on GitHub](https://github.com/cachly-dev/mcp-server) — If cachly saves you time, a star means a lot!
- 📦 [npm](https://www.npmjs.com/package/@cachly-dev/mcp-server)
