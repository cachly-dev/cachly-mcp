# 🧠 cachly AI Brain — MCP Server

> ### Your AI is brilliant for one session. Then it forgets you.
> Every morning you re-explain your architecture, your deploy process, the bug you
> already fixed last week. **cachly gives your AI — and your whole team — a permanent,
> shared brain that gets smarter with every commit.**

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
  <img src="https://img.shields.io/badge/105%20MCP%20tools-violet" alt="105 MCP tools" />
  &nbsp;
  <img src="https://img.shields.io/badge/License-Apache--2.0-yellow" alt="License: Apache-2.0" />
</p>

---

## The story you already live every day

You are a good engineer. You want to **ship**, not babysit a forgetful assistant.

But every session starts at zero. Your AI doesn't remember the race condition you
chased for three hours on Tuesday. It doesn't know your deploy gotchas. It can't tell
you that **Carol already solved this exact bug in March** — because Carol's knowledge
lives in Carol's head, and yours in yours.

So you re-explain. You re-research. Your team makes the same mistake in five different
branches. And when someone leaves, their hard-won knowledge walks out the door with them.

> **The villain isn't your AI. It's amnesia.** Context death between sessions, and
> knowledge silos between people. The average developer loses **~45 minutes a day**
> re-establishing context that should already exist.

You don't need a smarter model. **You need a memory that doesn't reset — and one that
your whole team shares.**

---

## Meet your guide

cachly is the brain layer that sits under whatever AI you already use. We've watched
hundreds of teams lose the same knowledge the same way, and we built the fix:

- **It learns automatically** — from every commit, every fix, every session. No extra calls.
- **It arrives pre-briefed** — your AI opens each session already knowing your stack.
- **It's shared** — one engineer's solved bug becomes the whole team's reflex.
- **It's provable** — quality-aware recall beats raw text search by **+22.2 % Precision@1**
  ([see the benchmark](./BENCH.md)). A claim without a number is marketing; this is the number.
- **It's neutral** — speaks [MCP](https://modelcontextprotocol.io), so it works with
  Claude, Cursor, Copilot, Windsurf, Cline, Zed. Switch models anytime — **your brain stays.**

We're not the hero of this story. **You are.** cachly is the thing that makes you the
engineer whose AI never forgets and whose team compounds knowledge instead of losing it.

---

## Taste it first — no account, no risk

```bash
npx @cachly-dev/mcp-server@latest demo
```

Run it in any project folder. It reads YOUR git history and shows what your AI *would*
know — your bugs fixed, your patterns, your past decisions. Nothing leaves your machine.

```
┌─────────────────────────────────────────────────────────────┐
│  Brain Preview — What your AI would know                    │
├─────────────────────────────────────────────────────────────┤
│  Commits: 847   Lessons: 634   Contributors: 7              │
│  Date range: 2024-01-12 → 2026-05-14                        │
├─────────────────────────────────────────────────────────────┤
│  Security fixes your AI would know:                         │
│  • fix(auth): JWT expiry check before signature validation  │
│  • security: sanitize webhook payload before JSON.parse     │
├─────────────────────────────────────────────────────────────┤
│  Bug fixes your AI would remember:                          │
│  • fix: Redis pub/sub race condition under high concurrency │
│  • fix: k8s readinessProbe threshold too low for cold start │
│  • fix: Stripe idempotency_key missing on retry path        │
├─────────────────────────────────────────────────────────────┤
│  With cachly, your AI arrives pre-briefed every session.    │
└─────────────────────────────────────────────────────────────┘
```

Like what you see? Make it permanent in the next step.

---

## The plan — three steps, then it's automatic

### 1. Run one command

```bash
npx @cachly-dev/mcp-server@latest setup
```

It signs you in (one browser click, no password, no credit card), detects every AI
editor you use, writes the MCP config, seeds your brain from git history, and installs
a git hook so it keeps learning.

### 2. Restart your editor

That's it. From now on your AI arrives pre-briefed — every session.

### 3. Just work

cachly learns in the background. You never have to "remember to save." Every fix,
every commit, every session feeds the brain automatically.

> **Already inside Claude / Cursor / Copilot?** Paste this to your AI and it configures everything itself:
> ```
> Set up cachly for this project. Run: npx @cachly-dev/mcp-server@latest setup
> It gives my AI persistent memory across sessions. Follow the browser login
> (one click, no credit card), then restart the editor.
> ```

**Our agreement with you:** Free forever tier. GDPR, EU servers. No model lock-in —
leave anytime and take your data. No code content is ever stored.

---

## What changes the moment you turn it on

| The moment | Without cachly | With cachly |
|-----------|----------------|-------------|
| Session start | *"What's your architecture again?"* | *"Ready. 23 lessons. Last session: deployed API."* |
| A known bug returns | Re-researches from scratch | *"You fixed this March 12 — here's the exact command."* |
| You open an unfamiliar file | Cold start | *"Carol fixed 3 bugs here. Related: `fix:stripe-retry`."* |
| A teammate leaves | Their knowledge leaves too | Their lessons stay, attributed, searchable |
| New hire, day one | Weeks to onboard | `setup` → full team context instantly |
| Pre-deploy | Hope nothing breaks | Brain predicts failure risks from past patterns |

This is the transformation: from the engineer who **re-explains everything every
morning** → to the team whose **collective brain never forgets and gets sharper with
every commit.**

---

## cachly vs. Claude's built-in memory

Anthropic now ships memory for Claude — and it's genuinely good for **one developer,
using only Claude, alone.** That's not the game we're playing. Here's the honest map:

| | **cachly** | **Claude built-in memory** |
|--|------------|----------------------------|
| Works across **teams** | ✅ one engineer's fix → everyone's reflex | ❌ per-user / per-agent only |
| Works across **models & tools** | ✅ MCP — Claude, Cursor, Copilot, Windsurf, Zed… | ❌ Claude + Anthropic API only |
| **Structured** knowledge | ✅ topic · outcome · severity · causal graph | ⚠️ flat text files, read linearly |
| **Causal root-cause** (`causal_trace`) | ✅ problem → chain → proven fix | ❌ |
| **Provable recall quality** | ✅ +22.2 % Precision@1 vs. BM25 ([benchmark](./BENCH.md)) | ❌ no public metric |
| **Governance** (review, attribution, audit) | ✅ `team_confirm`, roles, audit trail | ❌ |
| **Self-hosting / BYOK / VPC** | ✅ data stays in your infra | ❌ Anthropic-hosted |
| Survives a **model switch** | ✅ your brain is yours | ❌ memory is gone or fragmented |
| Zero-setup for one solo user | ⚠️ ~1 command | ✅ built in |

**The honest takeaway:** if you're a solo dev who only ever uses Claude, the built-in
memory is great — use it. If you work on a **team**, switch tools, care about **proof**,
or need **governance and data residency**, that's a gap Anthropic structurally can't
close without breaking its own lock-in. **That gap is where cachly wins.**
*(Full strategic analysis: [STRATEGY.md](./STRATEGY.md).)*

---

## vs. other memory tools

| | cachly | mem0 | MemGPT / Letta | Plain CLAUDE.md |
|--|--------|------|----------------|-----------------|
| Persistent memory | ✅ | ✅ | ✅ | Manual |
| MCP server (no code changes) | ✅ | ✅ | ❌ | ✅ |
| Causal root cause analysis | ✅ | ❌ | ❌ | ❌ |
| Fully automatic (no explicit calls) | ✅ | ❌ | ❌ | ❌ |
| Team knowledge graph + attribution | ✅ | Paid | ❌ | ❌ |
| Provable recall lift (published) | ✅ | ❌ | ❌ | ❌ |
| Git-ambient learning | ✅ | ❌ | ❌ | ❌ |
| GDPR / EU servers | ✅ | ❌ | ❌ | ✅ |
| Free tier forever | ✅ | Limited | ❌ | ✅ |

---

## The standout moves

| Capability | What it does |
|---------|-------------|
| **`causal_trace`** | Root-cause analysis *through memory*: problem → causal chain → the fix that worked, with date and commands. **No other system builds and queries a causal graph.** |
| **`brain_who_knows`** | *"Who on my team knows about Kubernetes deploys?"* → ranked experts 🥇🥈🥉, built automatically from authorship. |
| **`brain_file_map`** | Before you touch a file: who's worked on it and which lessons reference it. |
| **`team_expertise_map`** | The whole team's skills matrix in one table — onboarding and bus-factor insurance. |
| **`brain_from_git`** | Reads your entire git history and populates the team knowledge graph (people + files + lessons) — zero setup, retroactively. |
| **`brain_coverage` / `skill_gaps`** | A 0–100 health score for your knowledge + a ranked list of blind spots to fix. |
| **`brain_predict`** | Predicts likely failures *before* they happen, from past incident patterns. |
| **Ambient Git** | A git hook auto-extracts lessons from every commit. Zero extra calls. |

**`causal_trace` in action:**
```
causal_trace(problem="auth breaks after restart")

→ Root: k8s:namespace-terminating
→ Via:  keycloak:jwks-race
→ Fix:  PollUntilContextTimeout 3min  ← used this March 12, worked
```
*30 minutes of git blame in one call.*

---

## What runs automatically after setup

| Trigger | What the Brain does — no prompting |
|---------|----------------------------------|
| First tool call | Session starts; project indexed in background |
| Before every task | Recalls relevant past lessons |
| During debugging | Traces root causes through causal memory |
| Before deploys | Predicts failure risks from past patterns |
| After every fix | Stores the lesson with commands + file paths + author |
| Every git commit | Hook extracts a lesson from the commit |
| Editor closes | Session summary saved for next time |

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
npx @cachly-dev/mcp-server@latest learn-git # Auto-learn lessons from recent git commits
```

> **Tip — auto-learn on every merged PR:** run `learn-git` in CI via the
> [cachly-brain-setup GitHub Action](https://github.com/cachly-dev/cachly/tree/main/sdk/github-action)
> with `mode: learn`. Each merged PR teaches your Brain automatically.

---

## MCP Tools (100 total)

### 🧠 Session & Memory (most used)

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session, open failures, recent lessons, brain health |
| **`session_end`** | Save what you built; auto-extract lessons from summary + git log |
| **`learn_from_attempts`** | Store structured lessons after any fix, deploy, or discovery (with `author`, `visibility`) |
| **`recall_best_solution`** | Best known solution for a topic — with success/failure history |
| **`smart_recall`** | Hybrid BM25 + semantic + causal-graph search — 11 languages, quality-reranked |
| **`remember_context`** | Cache architecture findings, decisions, file summaries |
| **`compact_recover`** | Full context recovery after hitting the context-window limit |

### 👥 Team Brain & Org Knowledge Graph

| Tool | What it does |
|------|-------------|
| `team_learn` / `team_recall` | Share lessons across the team with author attribution |
| `team_confirm` | A reviewer confirms a lesson (🛡️ senior / ✔️ peer) → ranks higher in recall |
| **`brain_who_knows`** | Find your team's experts on any topic — ranked 🥇🥈🥉 |
| **`brain_file_map`** | Experts + lessons per file, before you touch it |
| **`team_expertise_map`** | Full team skills matrix in one table |
| **`skill_gaps`** | Knowledge blind spots: unresolved failures, missing attribution |
| **`brain_coverage`** | 0–100 knowledge-health score for your codebase |
| `madc_deliberate` | Specialist AI agents vote to resolve contradictory lessons |
| `memory_crystalize` | Distill all lessons into a Crystal for instant team context |

### 🧬 Causal Intelligence

| Tool | What it does |
|------|-------------|
| **`causal_trace`** | Root-cause analysis through the Causal Knowledge Graph |
| **`brain_predict`** / `brain_predict_failures` | Predict likely failures before they happen |
| **`brain_from_git`** | Bootstrap people + files + lessons from git history — incremental |
| `memory_consolidate` | Detect contradictions, merge duplicates, expire stale lessons |
| `ckg_inspect` | Inspect the causal graph around any concept |

### 🌍 Knowledge Commons · ⚙️ Infrastructure · 📋 Roadmap

| Tool | What it does |
|------|-------------|
| `syndicate` / `fedbrain_search` | Contribute to / search the global Knowledge Commons |
| `cache_get` / `cache_set` / `semantic_search` / `index_project` | Cache + semantic ops |
| `list_instances` / `create_instance` / `delete_instance` | Manage Brain instances |
| `roadmap_add` / `roadmap_next` | Persistent project roadmap stored in the Brain |

*…and ~70 more. Run `health` to see what's wired up in your editor.*

---

## FAQ

**Does my AI need to call `session_start` manually?**
No. Sessions start and end automatically on the first tool call and when the editor closes.

**How is this different from Claude's built-in memory?**
Claude's memory is per-user, Claude-only, flat-file, and unbenchmarked. cachly is
team-shared, model-neutral (any MCP client), structured + causal, governed, and has a
[published recall benchmark](./BENCH.md). See the comparison table above.

**Can my whole team share one Brain?**
Yes — that's the point. `team_learn` / `team_recall`, or
`npx @cachly-dev/mcp-server@latest invite teammate@example.com`.

**Is my code sent to cachly servers?**
No code content is stored. cachly stores lesson text, commit messages, session
summaries, and key-value context. All data on EU servers, GDPR-compliant.

**What is `causal_trace` and why is it unique?**
Given any error, it walks the Causal Knowledge Graph to find root cause, intermediate
causes, and the exact fix that worked — including date and commands. No other memory
system builds or queries a causal graph.

**What if I hit the context-window limit mid-session?**
Call `compact_recover`. It reconstructs full context from Memory Crystal + recent
sessions + WIP registry — typically one tool call.

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

✅ All plans: **EU servers · GDPR-compliant · 99.9% SLA · No credit card for Free**

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | — | API token (set by wizard automatically) |
| `CACHLY_BRAIN_INSTANCE_ID` | — | Default instance UUID (optional — auto-resolved) |
| `CACHLY_API_URL` | `https://api.cachly.dev` | Override for self-hosted |
| `CACHLY_NO_TELEMETRY` | unset | Set to `1` to disable anonymous usage pings |

---

## 🛠️ Ecosystem & Docs

| Package | What it does |
|---------|-------------|
| **[`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | ← you are here |
| **[`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw)** | Cut LLM costs 60–90% in JS/TS apps |

- 🌐 [cachly.dev](https://cachly.dev) — Dashboard & free signup
- 📖 [Docs](https://cachly.dev/docs/ai-memory) — Full documentation
- 📊 [BENCH.md](./BENCH.md) — The recall-quality proof
- 🧭 [STRATEGY.md](./STRATEGY.md) · [VISION_10X.md](./VISION_10X.md) · [PROGRESS.md](./PROGRESS.md)
- 💬 [GitHub Issues](https://github.com/cachly-dev/cachly-mcp/issues) — Bugs & feature requests

---

> **Stop re-explaining yourself to your own tools.** Give your AI — and your team — a
> brain that remembers, learns, and gets sharper with every commit.
>
> ```bash
> npx @cachly-dev/mcp-server@latest setup
> ```
