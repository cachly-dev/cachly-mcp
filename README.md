# cachly — The World's First Cognitive Cache

> **A cache that thinks.**  
> Not just managed Redis. The universal AI memory layer — persistent, self-managing, cross-model.  
> One command. Your AI never forgets again.

<p align="center">
  <a href="https://github.com/cachly-dev/cachly-mcp/stargazers">
    <img src="https://img.shields.io/github/stars/cachly-dev/cachly-mcp?style=social" alt="GitHub Stars" />
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
</p>

---

## What is a Cognitive Cache?

Every cache stores data. cachly stores **meaning**.

Five capabilities no other cache — or AI memory tool — has ever had:

| Capability | What it does |
|-----------|-------------|
| **`memory_consolidate`** | Distill the entire knowledge base: detect contradictions, merge duplicates, prune stale memories — like garbage collection for your AI's brain |
| **`brain_diff`** | Git-style diff for AI knowledge — shows exactly what was learned, forgotten, or updated across sessions |
| **`causal_trace`** | Root cause analysis through memory — given a problem, traces backwards through the knowledge graph to find what caused it |
| **`knowledge_decay`** | Temporal confidence scoring — every memory gets a freshness score that decays with time and rebounds with each recall |
| **`autopilot`** | Zero-config AI memory — generates a CLAUDE.md that makes any AI manage its own brain automatically, forever |

This is not a tool you use. This is infrastructure that makes AI genuinely intelligent over time.

---

## One command. Permanent memory. No copy-paste.

```bash
npx @cachly-dev/mcp-server@latest setup
```

Browser opens → sign in → Brain provisioned → every editor configured automatically.  
No dashboard visit. No API keys to copy. No instance IDs to manage.

---

## What it looks like

Every session starts with this instead of a blank slate:

```
🧠 Session Briefing

📅 Last session (2h ago): Fixed auth redirect loop in Next.js middleware
   Duration: 47 min · Files: middleware.ts, auth.config.ts, .env.local

📊 Brain: 23 lessons · 5 context entries · 38 recalls · ~9.5h saved

🎯 Relevant for "auth":
  ✅ next:middleware-auth — matcher must exclude /_next/static paths (negative lookahead)
  ✅ keycloak:refresh-token — use httpOnly cookie, not localStorage — Safari blocks third-party
  ❌ oauth:pkce — PKCE + CORS broken in Safari 16.3, still unresolved

🕐 Recent lessons:
  ✅ redis:pipeline-batching — pipeline() for N writes, 10× faster than sequential
  ✅ deploy:healthcheck — readinessProbe.failureThreshold must be ≥ 10 on cold starts
  ✅ typescript:strictNullChecks — enable in tsconfig, catches 30% of runtime errors at compile time
```

Your AI arrives pre-briefed. No repeating yourself. No re-explaining the architecture.

---

## The Cognitive Cache in Action

### Root Cause Analysis Through Memory

```
causal_trace(problem="auth fails after namespace restart")

🔍 Causal Trace — "auth fails after namespace restart"

Found 7 related memories (3 failures · 1 partial · 2 fixes)

❌ Root causes / similar failures:
  1. [12.03.2025] 🔴 `k8s:namespace-terminating` (relevance 9/10)
     ↳ Cannot create resources in Terminating namespace — must wait for full deletion
  2. [08.02.2025] 🟡 `keycloak:jwks-cache-race` (relevance 6/10)
     ↳ Concurrent JWKS map access panics under load — needs RWMutex

✅ What solved similar problems:
  • `k8s:namespace-wait` — PollUntilContextTimeout 3min loop until NotFound
  • `auth:jwks-singleton` — double-checked locking pattern, init once on startup

🧩 Likely causal chain:
  `k8s:namespace-terminating`
    ↓ led to `keycloak:jwks-cache-race`
    ↓ current symptom: auth fails after namespace restart

🎯 Recommended fix: apply `k8s:namespace-wait` solution
```

### Knowledge Decay — Trust What's Still True

```
knowledge_decay(threshold_days=30)

⏱️ Knowledge Decay Analysis

🧠 31 total memories · 24 healthy (avg 88% confidence) · 7 decaying

⚠️ 7 memories need re-verification:

  ██████████ 100% — `auth:jwt-refresh` (3d old · recalled 5×)
  ████████░░  80% 🟡 `k8s:resource-limits` (45d old · recalled 1×)
  █████░░░░░  52%    `deploy:docker-compose` (78d old · recalled 0×)
  ███░░░░░░░  31% 🔴 `stripe:webhook-secret` (112d old · recalled 0×)
  ██░░░░░░░░  22%    `react:concurrent-mode` (140d old · recalled 0×)

💡 Re-validate top decaying memories before critical tasks.
```

### Brain Diff — See What You've Learned

```
brain_diff(since_sessions=5)

📊 Brain Diff — knowledge delta over last 5 sessions

🧠 Total: 31 lessons · +12 new · 19 pre-existing

📅 Sessions covered:
  • 04.05.2026 (23m) — Fixed auth redirect loop + pushed to main
  • 03.05.2026 (61m) — K8s provisioner: namespace termination wait
  • 02.05.2026 (34m) — Token refresh + JWKS race condition

➕ 12 new lessons learned:
  ✅ 🔴 `auth:token-refresh` — Store refresh token in JWT callback, refresh at <60s TTL
  ✅ 🟡 `k8s:namespace-terminating` — Wait 3min via PollUntilContextTimeout before recreate
  ✅ 🟡 `api:status-codes` — Always 201 for paid tier; checkout_url in body is the signal
  ❌    `stripe:402-redirect` — 402 blocks fetch(), use 201 + JSON body for checkout flow
  …and 8 more

📚 19 lessons unchanged (stable knowledge base)
```

### Autopilot — Zero-Config Forever Memory

```
autopilot(instance_id="...", project_dir="/home/you/myproject", write=true)

🤖 cachly Autopilot — zero-config AI memory for myproject

Brain: 31 lessons stored · Instance: `a1b2c3d4…`

✅ Written to:
   • /home/you/myproject/CLAUDE.md
   • /home/you/myproject/.github/copilot-instructions.md

🎯 Autopilot is live. This AI — and any other AI on this project —
   will now manage memory automatically.
```

From that point on: no manual `session_start`, no manual `learn_from_attempts`, no manual `session_end`. The AI does it all, every time, forever.

---

## Before vs. After

| Situation | Without cachly | With cachly |
|-----------|----------------|-------------|
| Session start | "What's your architecture?" | Briefed in 2s — lessons, last session, open failures |
| Bug hits again | Re-researches from scratch (20–40 min) | "You fixed this on March 12, exact command: `kubectl rollout restart`" |
| "Why is X broken?" | Manual investigation from scratch | `causal_trace` traces root cause through memory in seconds |
| "Can I trust this lesson?" | No way to know | `knowledge_decay` shows confidence % per memory |
| After holiday | Context completely dead | Full context restored, team lessons visible |
| New team member | Weeks to onboard | `session_start` gives full codebase context instantly |
| Model switch | Start over with new AI | Brain is model-agnostic — Claude, GPT-4, Gemini, all share one brain |
| Context limit | Lose everything | `compact_recover` restores checkpoint + lessons in one call |

---

## Bootstrap from Git History

```bash
npx @cachly-dev/mcp-server@latest learn
```

**One command. 2 years of team knowledge. 30 seconds.**

`brain_from_git` reads your git log and extracts lessons automatically:

```
🧠 Brain bootstrapped from git history

📊 Scanned: 342 commits over last 180 days
✅ Success lessons: 28  ❌ Failure/revert lessons: 9
📁 Hotspot files tracked: 12
💾 Total stored: 31 new lessons

Top lessons extracted:
  ✅🟡 `auth:jwt-refresh-token` — Use httpOnly cookie, not localStorage — Safari blocks third-party
  ❌🔴 `deploy:docker-compose-detach` — Reverted: "docker compose up without -d blocks SSH terminal"
  ✅🟡 `redis:connection-pool-timeout` — connectTimeout:5000 + retryStrategy:null prevents hangs
  ❌🔴 `auth:pkce-safari-16` — PKCE flow broken Safari 16.3, still unresolved
```

---

## Full Tool Reference

### Cognitive Cache (v0.6 — new)

| Tool | What it does |
|------|-------------|
| **`memory_consolidate`** | Distill knowledge base: detect contradictions, merge duplicates, prune stale. Knowledge health score 0–100. |
| **`brain_diff`** | Git-style diff for AI knowledge — what was learned, updated, or went stale since N sessions |
| **`causal_trace`** | Root cause analysis: given a problem, traces backwards through memory to find cause + recommended fix |
| **`knowledge_decay`** | Temporal confidence per memory — decay by age, recover by recall frequency |
| **`autopilot`** | Generates and optionally writes CLAUDE.md that makes any AI fully self-managing |

### Session & Memory

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session, open TODOs, checkpoint, lessons, brain stats |
| **`session_end`** | Save session + auto-refresh CLAUDE.md with top lessons inline |
| **`session_ping`** | Cross-provider checkpoint — switch Claude↔Copilot↔Cursor seamlessly |
| **`compact_recover`** | One call after context compaction — restores checkpoint + TODOs + critical lessons |
| **`brain_from_git`** | Bootstrap brain from git history — no manual lesson writing required |
| **`learn_from_attempts`** | Store lessons after any fix, deploy, or discovery |
| **`recall_best_solution`** | Best known fix for a topic — with full success/failure history |
| **`smart_recall`** | Full-text search across all brain data (BM25+) |
| **`todo_add`** / **`todo_done`** | Persistent TODOs — survive sessions, compaction, provider switches |
| **`refresh_claude_md`** | Embed top lessons inline in CLAUDE.md — ambient brain without tool calls |
| **`remember_context`** / **`recall_context`** | Save/restore architecture findings, file summaries, ADRs |
| **`auto_learn_session`** | Batch-store multiple observations at session end |
| **`sync_file_changes`** | Track file change history, surface related lessons per file |

### Team Brain

| Tool | What it does |
|------|-------------|
| **`team_learn`** / **`team_recall`** | Share lessons across the whole team on a shared instance |
| **`invite_link`** | Generate `npx ... join <token>` — teammate connects in one command |
| **`global_learn`** / **`global_recall`** | Cross-project global knowledge base |
| **`publish_lesson`** / **`import_public_brain`** | Share knowledge with the community |
| **`brain_stats`** | Dashboard: lessons, recalls, time saved, top topics, team authors |
| **`export_brain`** | Full Markdown export — share, archive, or import |
| **`brain_doctor`** | Health check: lesson quality, open failures, recommendations |

### Cache & Infrastructure

| Tool | What it does |
|------|-------------|
| `cache_get` / `cache_set` / `cache_delete` | Standard Redis/Valkey operations |
| `cache_mget` / `cache_mset` | Bulk pipeline (single round-trip) |
| `cache_stats` | Memory, hit rate, ops/sec, keyspace info |
| `semantic_search` | Find cached entries by meaning (vector search, EU-hosted) |
| `cache_warmup` | Pre-warm cache from file or URL list |
| `cache_lock_acquire` / `cache_lock_release` | Distributed locking |
| `cache_stream_set` / `cache_stream_get` | Cache streaming LLM responses in chunks |
| `get_connection_string` | Get the `redis://` URL for your own app |

---

## Pricing

| Tier | RAM | Price | Best for |
|------|-----|-------|----------|
| **Free** | 25 MB | **€0/mo forever** | Side projects & solo devs |
| **Dev** | 200 MB | €19/mo | Individual developers |
| **Pro** | 900 MB | €49/mo | Teams (shared brain) |
| **Speed** | 900 MB + Dragonfly + Semantic | €79/mo | AI-heavy workloads |
| **Business** | 7 GB | €199/mo | Scale-ups |

✅ All plans: **German servers · GDPR-compliant · 99.9% SLA · no credit card for Free**

---

## Manual Setup

<details>
<summary>Claude Code (<code>~/.claude/mcp.json</code> or <code>.mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "cachly": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server@latest"],
      "env": {
        "CACHLY_JWT": "your-api-key",
        "CACHLY_BRAIN_INSTANCE_ID": "your-instance-id"
      }
    }
  }
}
```
</details>

<details>
<summary>Cursor / Windsurf (<code>.cursor/mcp.json</code> or <code>.mcp.json</code>)</summary>

```json
{
  "servers": {
    "cachly": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server@latest"],
      "env": {
        "CACHLY_JWT": "your-api-key",
        "CACHLY_BRAIN_INSTANCE_ID": "your-instance-id"
      }
    }
  }
}
```
</details>

<details>
<summary>Autopilot CLAUDE.md (generated by <code>autopilot</code> tool)</summary>

```markdown
# My Project — cachly AI Brain (Autopilot)

> Brain instance: `your-instance-id` · 31 lessons stored

## Memory Protocol — follow these rules automatically, every session

### SESSION START (before any work)
mcp__cachly__compact_recover({"instance_id":"..."})
mcp__cachly__smart_recall({"instance_id":"...","query":"<describe your task>"})

### WHEN SOMETHING WORKS
mcp__cachly__learn_from_attempts({"instance_id":"...","topic":"<topic>","outcome":"success","what_worked":"<solution>","severity":"major"})

### ROOT CAUSE ANALYSIS
mcp__cachly__causal_trace({"instance_id":"...","problem":"<symptom>"})

### SESSION END (always)
mcp__cachly__session_end({"instance_id":"...","summary":"<one sentence>","files_changed":["..."]})
```
</details>

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | — | **Required.** API key or JWT from the setup wizard |
| `CACHLY_BRAIN_INSTANCE_ID` | — | Default instance UUID — set once, works in all tools |
| `CACHLY_API_URL` | `https://api.cachly.dev` | Override for self-hosted |
| `CACHLY_EMBED_PROVIDER` | auto-detect | `openai` \| `gemini` \| `mistral` \| `cohere` \| `ollama` \| `cachly` |
| `CACHLY_NO_TELEMETRY` | unset | Set to `1` to opt out of anonymous usage pings |

---

## Ecosystem

| Package | What it does |
|---------|-------------|
| **[`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | ← you are here — Cognitive Cache MCP for Claude, Cursor, Copilot, Windsurf |
| **[`cachly-brain` (VS Code)](https://marketplace.visualstudio.com/items?itemName=cachly.cachly-brain)** | VS Code extension — status bar, CodeLens lessons, one-click setup |
| **[`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw)** | JS/TS SDK — cut LLM costs 60–90% with semantic cache in your own app |
| **[`@cachly-dev/sdk`](https://www.npmjs.com/package/@cachly-dev/sdk)** | Node.js SDK — managed Redis, semantic cache & AI memory in your app |

---

## Links

- 🌐 [cachly.dev](https://cachly.dev) — Dashboard & free signup
- 📖 [Docs](https://cachly.dev/docs/ai-memory) — Full documentation
- 💬 [Issues](https://github.com/cachly-dev/cachly-mcp/issues) — Bug reports & feature requests
