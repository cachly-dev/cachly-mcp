# 🧠 cachly AI Brain — MCP Server

> **Your AI forgets everything between sessions. cachly fixes that.**  
> Stop re-teaching your stack every morning. cachly gives your AI a permanent brain — pre-briefed every session, learns from every commit, never makes the same mistake twice. Works whether you write 10 lines or 10,000.

<p align="center">
  <a href="https://www.npmjs.com/package/@cachly-dev/mcp-server">
    <img src="https://img.shields.io/npm/v/@cachly-dev/mcp-server?color=violet&logo=npm" alt="npm version" />
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
    <img src="https://img.shields.io/badge/GDPR-EU%20servers-green" alt="GDPR: EU servers" />
  </a>
  &nbsp;
  <img src="https://img.shields.io/badge/95%20MCP%20tools-violet" alt="95 MCP tools" />
  &nbsp;
  <img src="https://img.shields.io/badge/License-Apache--2.0-yellow" alt="License: Apache-2.0" />
  &nbsp;
  <a href="https://cachly.dev">
    <img src="https://img.shields.io/badge/Brain%20badge-embed%20in%20README-7c3aed" alt="Brain badge" />
  </a>
</p>

---

## Try it right now — no account needed

```bash
npx @cachly-dev/mcp-server@latest demo
```

Run it in any project folder. It scans your git history and shows a preview of what your AI would know — YOUR bugs fixed, YOUR patterns, YOUR past decisions. No account needed.

```
┌─────────────────────────────────────────────────────────────┐
│  Brain Preview — What your AI would know                    │
├─────────────────────────────────────────────────────────────┤
│  Commits: 847   Lessons: 634   Contributors: 7              │
│  Date range: 2024-01-12 → 2026-05-14                        │
├─────────────────────────────────────────────────────────────┤
│  Category breakdown:                                        │
│  fix        ████████████████████  312                       │
│  feat       ███████████████       189                       │
│  security   ██                     18                       │
│  deploy     ██                     15                       │
├─────────────────────────────────────────────────────────────┤
│  Security fixes your AI would know:                         │
│  • fix(auth): JWT expiry check before signature validation  │
│  • security: sanitize webhook payload before JSON.parse     │
├─────────────────────────────────────────────────────────────┤
│  Bug fixes your AI would remember:                          │
│  • fix: Redis pub/sub race condition under high concurrency │
│  • fix: k8s readinessProbe threshold too low for cold start │
│  • fix: Stripe idempotency_key missing on retry path        │
│  • fix: tRPC context not forwarded to background jobs       │
├─────────────────────────────────────────────────────────────┤
│  With cachly, your AI arrives pre-briefed every session.    │
│  No more re-explaining. No more repeated mistakes.          │
└─────────────────────────────────────────────────────────────┘

  Make this permanent (free, 1–5 minutes):
  $ npx @cachly-dev/mcp-server@latest setup

  Works with: Claude Code · Cursor · Windsurf · Copilot · Cline · Zed
  Free forever · GDPR · German servers · No credit card
```

---

## Already in Claude / Cursor / Copilot? Just paste this

Skip the setup guide — copy the prompt below and paste it directly into your AI. It will run the command and configure everything automatically:

```
Set up cachly for this project. Run this in the terminal:
  npx @cachly-dev/mcp-server@latest setup

It gives you persistent memory across sessions — your AI recalls past
decisions, avoids repeated bugs, and arrives briefed every time you
open it. Follow the browser login (one click, no credit card), then
restart your editor. Free forever.
```

Your AI will execute the command, detect your editors, write the config, and brief itself on your project.

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
5. **Reads your git history** — extracts lessons from years of commits before your first session
6. **Installs a git hook** — learns from every future commit automatically

**Restart your editor.** From now on your AI arrives pre-briefed — every session.

---

## What happens after setup — everything is automatic

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

## CLI Commands

```bash
npx @cachly-dev/mcp-server@latest demo      # Preview your Brain (no account needed)
npx @cachly-dev/mcp-server@latest setup     # Wire up all your AI editors (1–5 minutes)
npx @cachly-dev/mcp-server@latest health    # Check token, API, editors, git hook
npx @cachly-dev/mcp-server@latest digest    # Weekly Brain summary — shareable
npx @cachly-dev/mcp-server@latest share     # Generate a shareable stats card + tweet
npx @cachly-dev/mcp-server@latest badge     # Get a live README badge for your Brain
npx @cachly-dev/mcp-server@latest invite    # Invite a teammate to share your Brain
npx @cachly-dev/mcp-server@latest index .   # Index a project's code into the Brain (CI-friendly)
npx @cachly-dev/mcp-server@latest learn-git # Auto-learn lessons from recent git commits (PR-merge ready)
```

> **Tip — auto-learn on every merged PR:** run `learn-git` in CI via the
> [cachly-brain-setup GitHub Action](https://github.com/cachly-dev/cachly/tree/main/sdk/github-action)
> with `mode: learn`. Each merged PR teaches your Brain automatically — no manual calls.

---

## Brain Badge — show your lessons live

Add a live lesson-count badge to any README — updates every hour, no auth required:

```bash
npx @cachly-dev/mcp-server@latest badge
```

Outputs your personal Markdown snippet:

```markdown
[![cachly Brain](https://api.cachly.dev/api/v1/badge/YOUR_INSTANCE_ID)](https://cachly.dev)
```

Drop it in your repo's README and anyone visiting sees how many lessons your AI has accumulated. The badge endpoint is public, rate-limited, and only exposes the lesson count — no topic names, no content.

---

## What makes cachly different

| Feature | What it does |
|---------|-------------|
| **`causal_trace`** | Root Cause Analysis through memory: problem → chain → solution. **No other system does this.** |
| **`brain_from_git`** | Reads your entire git history and loads every lesson before your first session. Incremental on repeat runs. |
| **`brain_predict`** | Predicts failures before they happen based on past incident patterns |
| **`memory_consolidate`** | Weekly garbage collector — detects contradictions, merges duplicates, expires stale lessons |
| **Team Brain** | Shared lessons across your whole team with author attribution |
| **Ambient Git** | git hook auto-extracts lessons from every commit. Zero extra calls. |
| **Memory Crystals** | Distills all lessons into a compact snapshot for instant session briefing |
| **11 languages** | BM25+ search in EN, DE, FR, ES, IT, PT, ZH, JA, KO, AR, HE — no config |

**`causal_trace` in action:**
```
causal_trace(problem="auth breaks after restart")

→ Root: k8s:namespace-terminating
→ Via:  keycloak:jwks-race
→ Fix:  PollUntilContextTimeout 3min  ← used this March 12, worked
```
*30 minutes of git blame in one call.*

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

## MCP Tools (80 total)

### 🧠 Session & Memory (most used)

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session summary, open failures, recent lessons, brain health |
| **`session_end`** | Save what you built, auto-extract lessons from summary + git log |
| **`learn_from_attempts`** | Store structured lessons after any fix, deploy, or discovery |
| **`recall_best_solution`** | Best known solution for a topic — with success/failure history |
| **`remember_context`** | Cache architecture findings, decisions, file summaries |
| **`smart_recall`** | BM25+ full-text search across all brain data — 11 languages |
| **`causal_trace`** | Root cause analysis through memory |
| **`brain_predict`** | Predict likely failures before they happen |
| **`brain_from_git`** | Bootstrap from git history — incremental, only new commits each run |
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
| `autopilot` | Generate a self-managing `CLAUDE.md` from Brain content |
| `global_learn` / `global_recall` | Cross-project universal lessons |

### 🌍 Knowledge Commons

| Tool | What it does |
|------|-------------|
| `syndicate` | Contribute verified lesson to global Knowledge Commons |
| `fedbrain_search` | Context-weighted global search |

### ⚙️ Infrastructure

| Tool | What it does |
|------|-------------|
| `list_instances` / `create_instance` / `delete_instance` | Manage Brain instances |
| `cache_get` / `cache_set` / `cache_delete` | Standard cache operations |
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

**What is incremental `brain_from_git`?**  
After the first run, only new commits since the last scan are processed. Repeated calls are instant.

**Can my whole team share the same Brain?**  
Yes. Use `team_learn` / `team_recall` or run `npx @cachly-dev/mcp-server@latest invite teammate@example.com`.

**What is a Memory Crystal?**  
A compressed snapshot of all lessons injected at every session start. The AI arrives pre-briefed even with a cold context window.

**What is `causal_trace` and why is it unique?**  
Given any error, `causal_trace` walks the Causal Knowledge Graph to find: root cause, intermediate causes, and the exact fix that worked — including the date and commands used. No other memory system builds or queries a causal graph.

**Is my code sent to cachly servers?**  
No code content is stored. cachly stores: lesson text, commit messages, session summaries, key-value context entries. All data on German servers, GDPR-compliant.

**What if I hit the context window limit mid-session?**  
Call `compact_recover`. It reconstructs full context from Memory Crystal + recent sessions + WIP registry — typically one tool call.

---

## Manual Setup

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
<summary><b>Cursor / Windsurf / VS Code / Copilot / Cline</b></summary>

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

<details>
<summary><b>Zed</b> (<code>.zed/settings.json</code>)</summary>

```json
{
  "context_servers": {
    "cachly": {
      "command": {
        "path": "npx",
        "args": ["-y", "@cachly-dev/mcp-server@latest"]
      }
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

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | — | API token (set by wizard automatically) |
| `CACHLY_BRAIN_INSTANCE_ID` | — | Default instance UUID (optional — auto-resolved) |
| `CACHLY_API_URL` | `https://api.cachly.dev` | Override for self-hosted |
| `CACHLY_NO_TELEMETRY` | unset | Set to `1` to disable anonymous usage pings |

---

## 🛠️ Ecosystem

| Package | What it does |
|---------|-------------|
| **[`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | ← you are here |
| **[`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw)** | Cut LLM costs 60–90% in JS/TS apps |

---

## Links

- 🌐 [cachly.dev](https://cachly.dev) — Dashboard & free signup
- 📖 [Docs](https://cachly.dev/docs/ai-memory) — Full documentation
- 💬 [GitHub Issues](https://github.com/cachly-dev/cachly-mcp/issues) — Bug reports & feature requests
- ⭐ [Star on GitHub](https://github.com/cachly-dev/cachly-mcp) — If cachly saves you time, a star means a lot!
