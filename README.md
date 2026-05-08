# 🧠 cachly AI Brain — MCP Server

> **Persistent memory for Claude Code, Cursor, GitHub Copilot, Windsurf, Cline & Zed.**  
> Your AI remembers every lesson, every fix, every architecture decision — forever.

<p align="center">
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

**The average developer wastes 45 minutes/day re-establishing context.**

---

## One Command. Fully Automatic.

```bash
npx @cachly-dev/mcp-server@latest setup
```

Run it once. It handles everything:

1. **Signs you in** — one click in your browser, no password, no credit card
2. **Detects your editors** — Claude Code, Cursor, Windsurf, VS Code, Copilot, Cline & Zed
3. **Writes the MCP config** for every detected editor automatically
4. **Creates `CLAUDE.md`** with Brain rules so your AI acts autonomously
5. **Installs a git hook** that learns from every commit automatically

**Restart your editor.** From now on your AI arrives pre-briefed — every session.

---

## What happens after setup

Everything runs automatically. You never type a command again:

| Trigger | What the Brain does |
|---------|-------------------|
| First tool call | Session starts, project gets indexed |
| Before every task | AI recalls relevant past lessons automatically |
| During debugging | AI traces root causes through memory |
| Before deploys | AI predicts failure risks from past patterns |
| After every fix | AI stores the lesson automatically |
| Editor closes | Session summary saved for next time |

---

## With vs. Without cachly

| Situation | Without cachly | With cachly |
|-----------|----------------|-------------|
| Session start | "What's your architecture?" | "Ready. 23 lessons, last session: deployed API." |
| Known bug hits again | Re-researches from scratch | "You fixed this March 12, here's the exact command" |
| After holiday / handoff | Context dead | Fully briefed in < 10 seconds |
| New team member | Weeks to onboard | `setup` gives full context instantly |

---

## What makes cachly different

| Feature | What it does |
|---------|-------------|
| **`causal_trace`** | Root Cause Analysis through memory: problem → chain → solution. **No other system can do this.** |
| **`memory_consolidate`** | Weekly garbage collector — detects contradictions, merges duplicates, expires stale lessons |
| **`brain_predict`** | Predicts failures before they happen based on past patterns |
| **Team Brain** | `learn_from_attempts` with `author` param shares fixes across your whole team |
| **Ambient Git** | git hook auto-extracts lessons from every commit. Zero extra calls. |
| **Memory Crystals** | Distills all lessons into a compact snapshot injected at every session start |

**The `causal_trace` moment:**
```
causal_trace(problem="auth breaks after restart")

→ Root: k8s:namespace-terminating
→ Via:  keycloak:jwks-race  
→ Fix:  PollUntilContextTimeout 3min  ← used this March 12, worked
```
*30 minutes of git blame in one call.*

---

## MCP Tools

### 🧠 Session & Memory (most used)

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session summary, open failures, recent lessons, brain health |
| **`session_end`** | Save what you built, auto-extract lessons from summary + ambient git log |
| **`learn_from_attempts`** | Store structured lessons after any fix, deploy, or discovery |
| **`recall_best_solution`** | Best known solution for a topic — with success/failure history |
| **`remember_context`** | Cache architecture findings, decisions, file summaries |
| **`recall_context`** | Get exact context by key (supports glob) |
| **`smart_recall`** | BM25+ full-text search across all brain data — 11 languages |
| **`causal_trace`** | Root cause analysis through memory |
| **`brain_predict`** | Predict likely failures before they happen |
| **`memory_consolidate`** | Deduplicate and expire stale lessons |

### 🌍 Multilingual Brain — Search in Any Language

Search in 11 languages natively (EN, DE, FR, ES, IT, PT, ZH, JA, KO, AR, HE) — no configuration.

```
smart_recall("kontena")  → finds コンテナ docs
smart_recall("deploy")   → finds デプロイ, 部署, 배포, نشر, פריסה
```

### 👥 Team Brain

| Tool | What it does |
|------|-------------|
| `team_learn` / `team_recall` | Share lessons across the team |
| `memory_crystalize` | Distill all lessons into a Crystal snapshot for instant team context |
| `brain_doctor` | Health check: lesson count, IQ boost %, open failures |
| `global_learn` / `global_recall` | Cross-project universal lessons |
| `publish_lesson` / `import_public_brain` | Share/import community knowledge |

### ⚙️ Instance & Cache Management

| Tool | What it does |
|------|-------------|
| `list_instances` / `create_instance` / `delete_instance` | Manage cache instances |
| `cache_get` / `cache_set` / `cache_delete` | Standard cache operations |
| `cache_mget` / `cache_mset` | Bulk pipeline (single round-trip) |
| `semantic_search` | Find cached entries by meaning |

---

## Manual Setup (alternative to the wizard)

If you prefer to add the config by hand:

<details>
<summary><b>Claude Code</b> (<code>~/.claude/mcp.json</code> or <code>.mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "cachly": {
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server@latest"]
    }
  }
}
```
On the first tool call your AI will prompt you to sign in — takes 10 seconds.
</details>

<details>
<summary><b>Cursor / Windsurf / VS Code / Copilot / Cline</b> (<code>.cursor/mcp.json</code> / <code>.mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "cachly": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server@latest"]
    }
  }
}
```
</details>

---

## Pricing

| Tier | RAM | Price | Best for |
|------|-----|-------|----------|
| **Free** | 25 MB | **€0/mo forever** | Dev & side projects |
| **Dev** | 200 MB | €19/mo | Individual developers |
| **Pro** | 900 MB | €49/mo | Teams |
| **Speed** | 900 MB + Dragonfly | €79/mo | AI-heavy workloads |
| **Business** | 7 GB | €199/mo | Scale-ups |

✅ All plans: **German servers · GDPR-compliant · 99.9% SLA · No credit card for Free**

---

## Environment Variables

Set automatically by the setup wizard — only needed for manual configuration.

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | — | API token (set by wizard, or get from cachly.dev) |
| `CACHLY_BRAIN_INSTANCE_ID` | — | Default instance UUID (optional if passed per-call) |
| `CACHLY_API_URL` | `https://api.cachly.dev` | Override for self-hosted |
| `CACHLY_NO_TELEMETRY` | unset | Set to `1` to disable anonymous usage pings |

---

## 🛠️ Ecosystem

| Package | What it does |
|---------|-------------|
| **[`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | ← you are here |
| **[`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw)** | Cut LLM costs 60–90% in JS/TS apps |
| **[`@cachly-dev/cli`](https://www.npmjs.com/package/@cachly-dev/cli)** | Terminal CLI — manage instances and brain |

---

## Links

- 🌐 [cachly.dev](https://cachly.dev) — Dashboard & free signup
- 📖 [Docs](https://cachly.dev/docs/ai-memory) — Full documentation
- 💬 [GitHub Issues](https://github.com/cachly-dev/cachly-mcp/issues) — Bug reports & feature requests
- ⭐ [Star on GitHub](https://github.com/cachly-dev/cachly-mcp) — If cachly saves you time, a star means a lot!
