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

## What happens after setup — everything is automatic

You never type another command. The Brain runs entirely in the background:

| Trigger | What the Brain does automatically |
|---------|----------------------------------|
| First tool call | Session starts, project gets indexed in background |
| Before every task | AI recalls relevant past lessons |
| During debugging | AI traces root causes through causal memory |
| Before deploys | AI predicts failure risks from past patterns |
| After every fix | AI stores the lesson with commands and file paths |
| Every git commit | Hook extracts lessons from commit message |
| Editor closes | Session summary saved for next time |

---

## With vs. Without cachly

| Situation | Without cachly | With cachly |
|-----------|----------------|-------------|
| Session start | "What's your architecture?" | "Ready. 23 lessons, last session: deployed API." |
| Known bug hits again | Re-researches from scratch | "You fixed this March 12, here's the exact command" |
| After holiday / handoff | Context dead | Fully briefed in < 10 seconds |
| New team member | Weeks to onboard | `setup` gives full context instantly |
| Pre-deploy check | Hope nothing breaks | Brain predicts failures before they happen |

---

## What makes cachly different

| Feature | What it does |
|---------|-------------|
| **`causal_trace`** | Root Cause Analysis through memory: problem → chain → solution. **No other system does this.** |
| **`memory_consolidate`** | Weekly garbage collector — detects contradictions, merges duplicates, expires stale lessons |
| **`brain_predict`** | Predicts failures before they happen based on past patterns |
| **Team Brain** | Shared lessons across your whole team with author attribution |
| **Ambient Git** | git hook auto-extracts lessons from every commit. Zero extra calls. |
| **Memory Crystals** | Distills all lessons into a compact snapshot for instant session briefing |
| **11 languages** | BM25+ search in EN, DE, FR, ES, IT, PT, ZH, JA, KO, AR, HE — no config |

**The `causal_trace` moment:**
```
causal_trace(problem="auth breaks after restart")

→ Root: k8s:namespace-terminating
→ Via:  keycloak:jwks-race  
→ Fix:  PollUntilContextTimeout 3min  ← used this March 12, worked
```
*30 minutes of git blame in one call.*

**The `autopilot` command:**  
Run `autopilot` once and it generates a fully self-managing `CLAUDE.md` or `copilot-instructions.md` — tailored to your actual Brain content. Every AI (Claude, Cursor, Copilot, Windsurf, Gemini) gets the full ruleset for your project. No copy-paste, no manual writing. As the Brain learns more, re-run `autopilot` to upgrade the file.

---

## cachly vs. alternatives

| | cachly | mem0 | MemGPT / Letta | Plain CLAUDE.md |
|--|--------|------|----------------|-----------------|
| Persistent memory | ✅ | ✅ | ✅ | Manual |
| MCP server (no code changes) | ✅ | ✅ | ❌ | ✅ |
| Causal root cause analysis | ✅ | ❌ | ❌ | ❌ |
| Fully automatic (no explicit calls) | ✅ | ❌ | ❌ | ❌ |
| Failure prediction | ✅ | ❌ | ❌ | ❌ |
| Team knowledge sharing | ✅ | Paid | ❌ | ❌ |
| Git-ambient learning | ✅ | ❌ | ❌ | ❌ |
| 11-language search | ✅ | ❌ | ❌ | ❌ |
| GDPR / EU servers | ✅ | ❌ | ❌ | ✅ |
| Free tier forever | ✅ | Limited | ❌ | ✅ |

---

## MCP Tools (89 total)

### 🧠 Session & Memory (most used)

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session summary, open failures, recent lessons, brain health |
| **`session_end`** | Save what you built, auto-extract lessons from summary + git log |
| **`learn_from_attempts`** | Store structured lessons after any fix, deploy, or discovery |
| **`recall_best_solution`** | Best known solution for a topic — with success/failure history |
| **`remember_context`** | Cache architecture findings, decisions, file summaries |
| **`recall_context`** | Get exact context by key (supports glob) |
| **`smart_recall`** | BM25+ full-text search across all brain data — 11 languages |
| **`causal_trace`** | Root cause analysis through memory |
| **`brain_predict`** | Predict likely failures before they happen |
| **`memory_consolidate`** | Deduplicate and expire stale lessons |
| **`compact_recover`** | Full context recovery after hitting context window limit |

### 👥 Team Brain

| Tool | What it does |
|------|-------------|
| `team_learn` / `team_recall` | Share lessons across the team with author attribution |
| `team_synthesize` | Merge conflicting lessons into one canonical version |
| `madc_deliberate` | 6 specialist AI agents vote to resolve contradictory lessons |
| `memory_crystalize` | Distill all lessons into a Crystal for instant team context |
| `brain_doctor` | Health check: lesson count, IQ boost %, open failures |
| `autopilot` | Generate a self-managing `CLAUDE.md` / `copilot-instructions.md` from Brain content |
| `global_learn` / `global_recall` | Cross-project universal lessons |
| `publish_lesson` / `import_public_brain` | Share/import community knowledge |

### 🌍 Knowledge Commons (Global)

| Tool | What it does |
|------|-------------|
| `syndicate` | Contribute verified lesson to global Knowledge Commons |
| `syndicate_search` | Search community solutions by tech stack |
| `fedbrain_contribute` | Contribute with cryptographic provenance certificate |
| `fedbrain_search` | Context-weighted global search |

### ⚙️ Cache & Infrastructure

| Tool | What it does |
|------|-------------|
| `list_instances` / `create_instance` / `delete_instance` | Manage Brain instances |
| `cache_get` / `cache_set` / `cache_delete` | Standard cache operations |
| `cache_mget` / `cache_mset` | Bulk pipeline (single round-trip) |
| `semantic_search` | Find cached entries by meaning |
| `index_project` | Index source files for semantic retrieval |

### 📋 Roadmap & Planning

| Tool | What it does |
|------|-------------|
| `roadmap_add` / `roadmap_update` | Persistent project roadmap stored in Brain |
| `roadmap_list` / `roadmap_next` | List items or get the single most important next action |

---

## FAQ

**Does my AI need to call `session_start` manually?**  
No. Sessions start and end automatically on the first tool call and when the editor closes.

**What happens to memory if I switch projects?**  
Memory is scoped per Brain instance. You can have one instance per project, or one shared instance across projects.

**Can my whole team share the same Brain?**  
Yes. `team_learn` / `team_recall` share lessons with author attribution. `memory_crystalize` gives any new team member instant full context.

**What is a Memory Crystal?**  
A compressed snapshot of all lessons distilled into a compact briefing. Injected at every session start so the AI arrives pre-briefed even with a cold context window.

**What is causal_trace and why is it unique?**  
Given any error or problem, `causal_trace` walks the Causal Knowledge Graph (CKG) to find: the root cause, intermediate causes, and the exact fix that worked — including the date and commands used. No other memory system builds or queries a causal graph.

**How does cachly learn from git commits?**  
The `setup` wizard installs a git post-commit hook. After each commit, the hook calls `cls_ingest` with the commit message and changed files. The Brain extracts lessons automatically — no `session_end` required.

**What happens if I hit the context window limit mid-session?**  
Call `compact_recover`. It reconstructs full context from the Memory Crystal + recent sessions + WIP registry entries — typically restoring full context in one tool call.

**Is my code sent to cachly servers?**  
No code content is stored. cachly stores: lesson text, commit messages, session summaries, and key-value context entries. All data is on German servers, GDPR-compliant.

**Does cachly work without an internet connection?**  
No — cachly is a managed cloud service. The MCP server is a thin client; the Brain runs on cachly's infrastructure.

---

## Manual Setup (alternative to the wizard)

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
