# 🧠 cachly AI Brain — MCP Server

> ### ChatGPT and Claude remember your conversations.
> ### cachly remembers your codebase.
>
> The bug you fixed. Why you chose Postgres. The deploy step that always breaks — and
> everything your teammates learned. **It stays when someone leaves the team, and it
> comes along when you switch assistants.**

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
  <img src="https://img.shields.io/badge/123_MCP_tools-violet" alt="123 MCP tools" />
  &nbsp;
  <img src="https://img.shields.io/badge/License-Apache--2.0-yellow" alt="License: Apache-2.0" />
</p>

<p align="center">
  <strong><a href="https://cachly.dev/sign-up">⚡ Get your free Brain → cachly.dev</a></strong><br/>
  <sub>Free forever · no credit card · 1-command setup · German servers · GDPR</sub>
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
- **It's provable** — **78.6 % Precision@1** on an external labelled corpus, with a CI gate
  that fails the build below 71.0 % ([see the benchmark](./BENCH.md)). A claim without a
  number is marketing; a number without a gate is a screenshot.
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

## Brain-first — Semantic Cache as Proof-Point

cachly is not a semantic cache with a brain bolt-on. The Brain is the product. The
Semantic Cache is the **proof-point** — it shows ROI in dollars from day one, with zero
trust required. It opens the door. The Brain is why teams never leave.

| | Wedge — Land | Moat — Retain |
|---|---|---|
| **Feature** | Semantic Cache | AI Brain (Lessons, Recall, Team-Sharing) |
| **Value** | Measurable cost savings from day one | Compounding team intelligence |
| **Metric** | Cache-hit rate, $/month saved | Lessons retained, WoW trend, recall quality |
| **Analogy** | Datadog APM (surfaces the problem) | Stripe (becomes critical infrastructure) |

**The org-level advantage:** Brain lessons and cache hits are shared across the whole
team — one person's fix becomes every agent's reflex. Anthropic Projects Memory is
per-user and model-locked. cachly is team-wide and model-neutral. That's the structural
moat no first-party tool can build.

---

## Setup — pick the shortest path for your editor

### Claude Code — two lines

```
/plugin marketplace add cachly-dev/cachly-mcp
/plugin install cachly-brain@cachly
```

Claude Code declares the MCP server for you; there is no JSON to write and no
path to set. Paste your brain ID once with `/plugin configure cachly-brain@cachly`
and you are done. (From v0.10.139 the server sets itself up on first use —
an anonymous 14-day trial brain, nothing to copy.)

Check it worked with `claude mcp list` — you should see
`plugin:cachly-brain:cachly … ✔ Connected`. Note that `claude plugin details`
reports `MCP servers (0)` even when the server is running; it does not count
them.

### VS Code — one click

Install the **[cachly Brain](https://marketplace.visualstudio.com/items?itemName=cachly-dev.cachly-brain)**
extension. It signs you in silently and creates your brain — no account form.

### JetBrains — one click

Install **[Cachly Brain](https://plugins.jetbrains.com/plugin/32059-cachly-brain)**
from the JetBrains Marketplace (IntelliJ, PyCharm, GoLand, WebStorm, Rider).
Status bar, brain health and the lessons view live in the IDE; the source is
at [cachly-dev/cachly-intellij](https://github.com/cachly-dev/cachly-intellij).
The `npx … autopilot` path below also configures JetBrains AI Assistant.

### MCP Registry — for any client that reads it

The server is listed in the official **[MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=cachly)**
as `io.github.cachly-dev/mcp-server`, every release, same day. Clients that
browse the registry (Claude Desktop, Goose, VS Code's MCP gallery and others)
find it there by name; the entry points at this npm package.

### Anything else — one command

```bash
npx @cachly-dev/mcp-server@latest autopilot
```

Autopilot does everything in a single command: it auto-detects every AI editor you use,
writes the MCP config, signs you in via browser device-flow (one click, no password, no
credit card), and bootstraps your brain from git history. Restart your editor and your AI
arrives pre-briefed — every session, automatically.

> **Already inside Claude / Cursor / Copilot?** Paste this to your AI and it configures everything itself:
> ```
> Set up cachly for this project. Run: npx @cachly-dev/mcp-server@latest autopilot
> It gives my AI persistent memory across sessions. Follow the browser login
> (one click, no credit card), then restart the editor.
> ```

**Our agreement with you:** Free forever tier. GDPR, EU servers. No model lock-in —
leave anytime and take your data: `npx @cachly-dev/mcp-server@latest export` writes
every lesson to `lessons.md` (to read) and `lessons.jsonl` (to reuse). Code excerpts
are stored only if you call `index_project` yourself — and only on your own EU
instance.

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
| **Provable recall quality** | ✅ 78.6 % Precision@1, CI gate at 71.0 % ([benchmark](./BENCH.md)) | ❌ no public metric |
| **Governance** (review, attribution, audit) | ✅ `team_confirm`, roles, audit trail | ❌ |
| **Self-hosting / BYOK / VPC** | ✅ data stays in your infra | ❌ Anthropic-hosted |
| Survives a **model switch** | ✅ your brain is yours | ❌ memory is gone or fragmented |
| Zero-setup for one solo user | ⚠️ ~1 command | ✅ built in |

**The honest takeaway:** if you're a solo dev who only ever uses Claude, the built-in
memory is great — use it. If you work on a **team**, switch tools, care about **proof**,
or need **governance and data residency**, that's a gap Anthropic structurally can't
close without breaking its own lock-in. **That gap is where cachly wins.**

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
| **`brain_collab_pairs`** | Person↔Person Collaboration Graph — *"Frag X und Y, die haben das zusammen gelöst."* Bus-factor alerts included. |
| **`brain_portability`** | W9 Model-Neutrality — config for 7 clients (Claude, Cursor, Copilot, Windsurf, Cline, Zed, Continue). *"Same Brain, any model."* |
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
npx @cachly-dev/mcp-server@latest autopilot # One command — signs in, configures every editor, bootstraps from git
npx @cachly-dev/mcp-server@latest demo      # Preview your Brain (no account needed)
npx @cachly-dev/mcp-server@latest bench     # Recall quality vs flat-file memory (no auth required)
npx @cachly-dev/mcp-server@latest autosetup # Interactive variant — pick editors yourself
npx @cachly-dev/mcp-server@latest health    # Check token, API, editors, git hook
npx @cachly-dev/mcp-server@latest digest    # Weekly Brain summary — shareable
npx @cachly-dev/mcp-server@latest share     # Generate a shareable stats card + tweet
npx @cachly-dev/mcp-server@latest publish   # Publish your Brain as an importable link (--public)
npx @cachly-dev/mcp-server@latest badge     # Get a live README badge for your Brain
npx @cachly-dev/mcp-server@latest invite    # Invite a teammate to share your Brain
npx @cachly-dev/mcp-server@latest index .   # Index a project's code into the Brain (CI-friendly)
npx @cachly-dev/mcp-server@latest learn-git # Auto-learn lessons from recent git commits
```

> **Tip — auto-learn on every merged PR:** run `learn-git` in CI via the
> [cachly-brain-setup GitHub Action](https://github.com/cachly-dev/cachly-action)
> with `mode: learn`. Each merged PR teaches your Brain automatically.

---

## CI integration — your pipeline teaches the Brain

Every CI run is a lesson: a red→green transition is a proven fix, a green→red one is a
known cause. Ready-to-paste templates live in
[`src/ci-integration/`](./src/ci-integration/):

- **GitHub Actions** — copy [`brain-from-ci-action.yml`](../github-action/templates/brain-from-ci-action.yml)
  into `.github/workflows/`. It triggers on `workflow_run` (completed) and pushes the
  outcome to your Brain. Requires `CACHLY_API_KEY` + `CACHLY_BRAIN_INSTANCE_ID` secrets
  (`CACHLY_JWT` still works as a fallback).
- **GitLab CI** — copy [`brain-from-ci-gitlab.yml`](./src/ci-integration/brain-from-ci-gitlab.yml)
  into your pipeline: two `.post` jobs (`on_success` / `on_failure`) with `allow_failure: true`.
  Want more than outcome pushes? The full GitLab template
  [`cachly.gitlab-ci.yml`](https://github.com/cachly-dev/cachly-action/blob/main/templates/cachly.gitlab-ci.yml)
  adds hidden jobs for `learn` / `scan` / `confirm` — pull it in with
  `include: remote:` (it is an includable template, not a CI/CD Catalog component).
- **Anything else** — [`push-ci-outcome.mjs`](./src/ci-integration/push-ci-outcome.mjs) is a
  standalone Node.js helper with zero dependencies. It always exits 0 — your CI never
  fails because of a Brain push.

Already have months of CI history? Backfill it in one call with the **`brain_from_ci`**
MCP tool — bulk-ingests past outcomes the same way `brain_from_git` ingests commits.

---

## MCP Tools (123 total, 27 in the default catalogue)

**Your editor sees 27 of them, not 123 — on purpose.** The full list cost
~27,750 tokens in *every* request, which is 14 % of a 200k window gone before
you type anything. The tools you use daily are listed individually; the other
96 sit behind one dispatcher:

```
cachly_tool(tool: "team_roster")                  run any of them by name
cachly_tool(tool: "team_roster", describe: true)  get its schema first
```

Nothing is unreachable: the server dispatches by name and never consults the
catalogue, so `team_roster` called directly still works. Set
`CACHLY_ALLE_WERKZEUGE=1` to get all 123 listed again.

The full tool catalog is generated from `sdk/mcp/src/tools.ts`. Cross-surface
coverage is tracked in [`../../docs/generated/surface-parity.md`](../../docs/generated/surface-parity.md),
and pinned OpenAPI/OpenAI/Anthropic/LangChain projections live in
[`../../docs/generated/tool-specs/`](../../docs/generated/tool-specs/).

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
| `team_confirm` | A reviewer confirms a lesson (🛡️ senior / ✔️ peer) → ranks higher in recall · reviewer-gated |
| `team_assign_role` / `team_roster` / `team_whoami` | Roles (👑 admin · 🛡️ reviewer · ✏️ contributor · 👁️ viewer) — enforced once an admin is set |
| `team_audit` | Immutable, admin-only governance trail: every role change & lesson confirmation |
| **`brain_who_knows`** | Find your team's experts on any topic — ranked 🥇🥈🥉 |
| **`brain_file_map`** | Experts + lessons per file, before you touch it |
| **`team_expertise_map`** | Full team skills matrix in one table |
| **`brain_collab_pairs`** | Person↔Person Collaboration Graph — who collaborates with whom, bus-factor alerts |
| **`brain_portability`** | Config snippets for 7 MCP clients — proves model-neutrality, same Brain everywhere |
| **`skill_gaps`** | Knowledge blind spots: unresolved failures, missing attribution |
| **`brain_coverage`** | 0–100 knowledge-health score for your codebase |
| `madc_deliberate` | Specialist AI agents vote to resolve contradictory lessons |
| `memory_crystalize` | Distill all lessons into a Crystal for instant team context |
| `team_crystallize` | Team Crystal — fixes that 2+ teammates independently converged on (the cross-person, causal layer) |

### 🧬 Causal Intelligence

| Tool | What it does |
|------|-------------|
| **`causal_trace`** | Root-cause analysis through the Causal Knowledge Graph |
| **`brain_predict`** / `brain_predict_failures` | Predict likely failures before they happen |
| **`brain_from_git`** | Bootstrap people + files + lessons from git history — incremental |
| **`brain_from_ci`** | Bulk-ingest CI outcomes: red→green becomes a fix lesson + causal `fixes` edge, green→red a `causes` edge — `brain_from_git` for CI logs |
| `memory_consolidate` | Detect contradictions, merge duplicates, expire stale lessons |
| `ckg_inspect` | Inspect the causal graph around any concept |

### 🌐 Shareable & Public Brains

| Tool | What it does |
|------|-------------|
| **`brain_seed_starter`** | Seed 16 universal lessons so your **first** `smart_recall` hits — auto-runs on a fresh repo |
| **`brain_share`** | Publish a Brain snapshot as a shareable link (public or unlisted) — a link to show off, not your data. For that, run `npx @cachly-dev/mcp-server export` |
| **`brain_import`** | Import any shared Brain into yours — `topic_prefix`, `min_confidence`, `dry_run` |
| `brain_share_list` / `brain_unshare` | List your shares · revoke a share (link goes dead) |
| **`brain_discover`** | Search the Brain marketplace for ready-made knowledge bases |

### 🌍 Knowledge Commons · ⚙️ Infrastructure · 📋 Roadmap

| Tool | What it does |
|------|-------------|
| `syndicate` / `fedbrain_search` | Contribute to / search the global Knowledge Commons |
| `brain_marketplace` / `brain_install` | Browse + install curated Domain Brains (Kubernetes, Auth, DB…) into your Brain |
| `cache_get` / `cache_set` / `semantic_search` / `index_project` | Cache + semantic ops — pass `org_id` on `cache_get`/`cache_set` to share the cache org-wide (writes mirror to `org:{org_id}:sem`, reads fall back to it on miss) |
| `cache_stats` / `cache_org_stats` | Tokenmaxxing ROI: hits, estimated USD saved + monthly projection — per instance or aggregated across your whole org. Zero hits yet? You get a day-1 ROI projection instead. |
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
Only if you call `index_project` yourself: it stores a short excerpt (up to
`summary_chars`, default 1200 characters) per indexed file, on your own EU
instance. Every other tool stores lesson text, commit messages, session
summaries, and key-value context — no source code. All data on EU servers,
GDPR-compliant.

**What is `causal_trace` and why is it unique?**
Given any error, it walks the Causal Knowledge Graph to find root cause, intermediate
causes, and the exact fix that worked — including date and commands. No other memory
system builds or queries a causal graph.

**What if I hit the context-window limit mid-session?**
Call `compact_recover`. It reconstructs full context from Memory Crystal + recent
sessions + WIP registry — typically one tool call.

---

## Editor support matrix

`npx @cachly-dev/mcp-server@latest autopilot` auto-detects and configures all of the
following. Manual snippets are in the **Manual Setup** section below.

| Editor / Client | Auto-setup | Config file written | Global config | Notes |
|---|---|---|---|---|
| **Claude Code** | ✅ | `~/.claude/mcp.json` + `.mcp.json` | ✅ global always | Runtime device-flow sign-in on first tool call |
| **Cursor** | ✅ detected via `.cursor/` | `.cursor/mcp.json` | — | Project-level; restart Cursor after setup |
| **Windsurf** | ✅ detected via `.windsurf/` | `.windsurf/mcp.json` | — | Project-level; restart Windsurf after setup |
| **VS Code + Copilot** | ✅ detected via `.vscode/` | `.vscode/mcp.json` | — | Requires VS Code MCP extension or Copilot chat |
| **Cline** | ✅ detected via VS Code | `.vscode/mcp.json` | — | Shares config with Copilot; restart VS Code |
| **Continue.dev** | ✅ detected via `.continue/` | `.continue/config.json` | — | Uses `modelContextProtocolServers` key |
| **Zed** | ✅ detected via `.zed/` | `.zed/settings.json` | — | Uses `context_servers` key |
| **Windsurf (global)** | `autosetup --editor windsurf` | `~/.windsurf/mcp.json` | ✅ | Pass `--editor` to target global config |
| **Any other MCP client** | `autosetup --editor claude` | `.mcp.json` | — | Standard `mcpServers` stdio format |

**Which sign-in path each editor uses:**

| Scenario | Path |
|---|---|
| `autosetup` from a real terminal (TTY) | OAuth device-flow → browser click → API key saved automatically |
| `autosetup` from VSCode task / CI (non-TTY) | Auto-detects non-interactive, opens browser with step-by-step guide, prints `CACHLY_JWT=... autosetup` instruction |
| First tool call from Claude Code (no JWT yet) | Inline device-flow: MCP returns URL + code, browser opens automatically, next call proceeds |
| `CACHLY_JWT=cky_live_xxx npx ... autosetup` | Skips auth step entirely, uses provided key |

> **Tip — fastest per-project setup from inside Claude Code:**
> ```
> Set up cachly for this project: npx @cachly-dev/mcp-server@latest autopilot
> ```
> Claude runs it and restarts automatically.

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

## Self-hosting & BYOK

cachly is **bring-your-own-key and self-host friendly out of the box** — no
enterprise contract required to keep data in your own infra.

**Bring your own embedding key (BYOK).** Semantic search runs on the embedding
provider *you* choose. Set one env var and cachly auto-detects it; no key needed if
you prefer cachly's server-side embeddings (uses your JWT):

| Provider | Env var | Model |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `text-embedding-3-small` |
| Google Gemini | `GEMINI_API_KEY` | `text-embedding-004` |
| Mistral | `MISTRAL_API_KEY` | `mistral-embed` |
| Cohere | `COHERE_API_KEY` | `embed-english-v3.0` |
| Ollama (local, free) | `OLLAMA_BASE_URL` | `nomic-embed-text` |
| cachly (server-side) | *(none — uses JWT)* | managed |

Force a specific one with `CACHLY_EMBED_PROVIDER=openai`. Run
`npx @cachly-dev/mcp-server@latest health` to confirm which provider is active.

**Point at your own backend (self-hosting).** Every cachly install can talk to a
private backend instead of `api.cachly.dev`:

```bash
# One-shot: wire up the wizard against your self-hosted backend
npx @cachly-dev/mcp-server@latest autopilot --api-url https://cachly.mycorp.internal

# Or non-interactively
npx @cachly-dev/mcp-server@latest autosetup \
  --instance-id <uuid> --api-key <cky_live_...> \
  --api-url https://cachly.mycorp.internal
```

`autosetup` bakes `CACHLY_API_URL` into the editor config **only** when it differs
from the default cloud — so default installs stay clean, and self-hosted installs
keep talking to your backend on every editor launch. All data stays in your infra.

---

## Pricing

| Tier | RAM | Price | Best for |
|------|-----|-------|----------|
| **Free** | 25 MB | **€0/mo forever** | Dev & side projects |
| **Dev** | 200 MB | €19/mo | Individual developers |
| **Pro** | 900 MB | €49/mo | Teams |
| **Speed** | 900 MB + Dragonfly | €79/mo | AI-heavy workloads |
| **Business** | 7 GB | €199/mo | Scale-ups |

✅ All plans: **EU servers · GDPR-compliant · No credit card for Free**

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | — | API token (set by wizard automatically) |
| `CACHLY_BRAIN_INSTANCE_ID` | — | Default instance UUID (optional — auto-resolved) |
| `CACHLY_API_URL` | `https://api.cachly.dev` | Override for self-hosted |
| `CACHLY_NO_TELEMETRY` | unset | Set to `1` to disable usage pings (these include your API token and up to 80 characters of `smart_recall` queries) |

---

## 🧠 Brain v3 — what's new

| Feature | Tool | What it does |
|---|---|---|
| Autonomous hygiene | `brain_hygiene` | Sweeps stale lessons, flags provisional, archives orphans |
| PR risk scan | `cachly-action` `scan` / `predict` modes | Matches PR title, body and changed files against Brain lessons via the `/scan` API — posts a PR comment with risk score before CI runs |
| Multi-agent arbitration | `brain_conflicts` · `brain_resolve_conflict` | Detects + resolves conflicting lessons across agents |
| Plans dashboard | `brain_plan` | Persistent plans in the UI with step tracking and brain-viz overlay |
| Privacy federation | `brain_contribute_signal` · `brain_import_meta` | Share patterns without sharing data — k-anonymous global commons |

---

## 🛠️ Ecosystem & Docs

**One brain, wherever you work.** Start with the MCP server, or drop the same memory
straight into your editor — your lessons follow you across all of them.

| Package | What it does |
|---------|-------------|
| **[`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | ← you are here · works with Claude, Cursor, Copilot, Windsurf, Cline, Zed |
| **[Cachly Brain for VS Code](https://marketplace.visualstudio.com/items?itemName=cachly-dev.cachly-brain)** | One-click memory in the editor — status bar, lessons view, ambient learning. No terminal needed. |
| **[Cachly Brain for JetBrains](https://plugins.jetbrains.com/plugin/32059-cachly-brain)** | Same brain for IntelliJ / PyCharm / GoLand / WebStorm / Rider — status bar, brain health, lessons view. |
| **[`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw)** | Cut LLM costs with semantic caching in JS/TS apps |
| **[cachly-dev/cachly-action](https://github.com/cachly-dev/cachly-action)** | GitHub Action: auto-setup, PR risk scan, auto-learn from merged PRs, weekly hygiene |

Prefer a visual view over the terminal? The VS Code companion extension shows the
same Brain, live, in the editor:

![The Lessons view inside the Cachly Brain VS Code extension, listing six stored lessons](https://cachly.dev/screenshots/vscode/shot3-lesson-card.png)

*The Lessons view in the VS Code companion extension — the same lessons this server stores, browsable without leaving the editor.*

- 🌐 [cachly.dev](https://cachly.dev) — Dashboard & free signup
- 📖 [Docs](https://cachly.dev/docs/ai-memory) — Full documentation
- 🗺️ [Public Roadmap](https://cachly.dev/roadmap) — what's coming next
- 💬 [GitHub Issues](https://github.com/cachly-dev/cachly-mcp/issues) — Bugs & feature requests

---

> **Stop re-explaining yourself to your own tools.** Give your AI — and your team — a
> brain that remembers, learns, and gets sharper with every commit.
>
> ```bash
> npx @cachly-dev/mcp-server@latest autopilot
> ```
