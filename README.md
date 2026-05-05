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
  &nbsp;
  <img src="https://img.shields.io/badge/License-Apache--2.0-yellow" alt="License: Apache-2.0" />
</p>

---

## 🆕 What is a Cognitive Cache?

Every cache stores data. cachly stores **meaning** — and now reasons over it.

**Seven capabilities no other memory system has ever had:**

| Capability | What it does | Why it matters |
|-----------|-------------|----------------|
| **`memory_consolidate`** | Garbage collection for knowledge — detect contradictions, merge duplicates, prune stale | Like `git gc` for your AI brain |
| **`brain_diff`** | `git log` for your AI brain — what changed this week? | See your AI's learning velocity |
| **`causal_trace`** | Root cause analysis through memory — problem → chain → fix | **No other system can do this** |
| **`knowledge_decay`** | Confidence per lesson: `████░░░░ 40%` | Old knowledge rots. Now you know which. |
| **`autopilot`** | Generates CLAUDE.md that makes any AI self-managing, forever | Zero manual calls. One command. Done. |
| **`syndicate`** | Contribute verified lessons to the global AI Knowledge Commons | Anonymous (HMAC). Every AI learns. |
| **`syndicate_search`** | Search solutions discovered by every AI brain on the planet | Community trust scores: `████████░░ ×47` |

**The `causal_trace` moment:**
```
causal_trace(problem="auth breaks after restart")

→ Root: k8s:namespace-terminating
→ Via:  keycloak:jwks-race  
→ Fix:  PollUntilContextTimeout 3min  ← used this March 12, worked
```
*30 minutes of git blame + log archaeology. In one call.*

---

## The Problem

Every morning, you open your AI coding assistant. It doesn't remember yesterday.  
You explain your architecture. You explain the deployment process. You explain the bug you fixed last week.

**The average developer wastes 45 minutes/day re-establishing context.**

## The Fix — One Command

```bash
npx @cachly-dev/mcp-server@latest setup
```

The interactive wizard:
1. Signs you in (free, no credit card required)
2. Picks or creates your AI Brain instance
3. **Auto-detects** Cursor, Windsurf, VS Code, Claude Code, Continue.dev, Cline & Zed
4. Writes the correct MCP config for every detected editor
5. Creates `CLAUDE.md` with memory rules pre-filled

**Index your project** into the Brain for instant semantic search:
```bash
npx @cachly-dev/mcp-server@latest index .
```

---

## What it looks like

Every session starts with a briefing instead of a blank slate:

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
```

Your AI arrives pre-briefed. No repeating yourself.

---

## Cognitive Cache in Action

### Root Cause Analysis Through Memory

```
causal_trace(problem="auth fails after namespace restart")

🔍 Causal Trace — "auth fails after namespace restart"

Found 7 related memories (3 failures · 1 partial · 2 fixes)

❌ Root causes / similar failures:
  1. [12.03.2025] 🔴 k8s:namespace-terminating (relevance 9/10)
     ↳ Cannot create resources in Terminating namespace — must wait for full deletion
  2. [08.02.2025] 🟡 keycloak:jwks-cache-race (relevance 6/10)
     ↳ Concurrent JWKS map access panics under load — needs RWMutex

✅ What solved similar problems:
  • k8s:namespace-wait — PollUntilContextTimeout 3min loop until NotFound
  • auth:jwks-singleton — double-checked locking pattern, init once on startup

🧩 Likely causal chain:
  k8s:namespace-terminating
    ↓ led to keycloak:jwks-cache-race
    ↓ current symptom: auth fails after namespace restart

🎯 Recommended fix: apply k8s:namespace-wait solution
```

### Knowledge Syndication — The Global AI Brain

```
syndicate_search(query="k8s namespace stuck terminating")

🌐 Global Knowledge Commons — "k8s namespace stuck terminating"

Found 3 community solutions (ranked by trust):

  ████████░░ ×47  [VERIFIED] k8s:namespace-force-delete
    → kubectl get namespace <ns> -o json | jq '.spec.finalizers=[]' | kubectl replace --raw ...
    → Confirmed by 47 independent AI brains across 12 countries

  ██████░░░░ ×23  [VERIFIED] k8s:namespace-finalizer-patch
    → PATCH /api/v1/namespaces/<ns>/finalize with empty finalizers array
    → 23 confirmations, 0 contradictions

  ████░░░░░░ ×9   k8s:pvc-blocking-termination
    → PVCs with retain policy block namespace deletion
    → 9 confirmations
```

### Knowledge Decay — Trust What's Still True

```
knowledge_decay(threshold_days=30)

⏱️ Knowledge Decay Analysis

🧠 31 total memories · 24 healthy (avg 88% confidence) · 7 decaying

⚠️ 7 memories need re-verification:

  ██████████ 100% — auth:jwt-refresh (3d old · recalled 5×)
  ████████░░  80% 🟡 k8s:resource-limits (45d old · recalled 1×)
  █████░░░░░  52%    deploy:docker-compose (78d old · recalled 0×)
  ███░░░░░░░  31% 🔴 stripe:webhook-secret (112d old · recalled 0×)

💡 Re-validate top decaying memories before critical tasks.
```

---

## Before vs. After

| Situation | Without cachly | With cachly |
|-----------|----------------|-------------|
| Session start | "What's your architecture?" | Briefed in 2s — lessons, last session, open failures |
| Bug hits again | Re-researches from scratch (20–40 min) | "You fixed this on March 12, exact command: `kubectl rollout restart`" |
| "Why is X broken?" | Manual investigation | `causal_trace` traces root cause through memory in seconds |
| "Can I trust this lesson?" | No way to know | `knowledge_decay` shows confidence % per memory |
| Unknown bug | Google + Stack Overflow | `syndicate_search` — 47 AI brains already solved it |
| After holiday | Context completely dead | Full context restored, team lessons visible |
| New team member | Weeks to onboard | `session_start` gives full codebase context instantly |
| Model switch | Start over | Brain is model-agnostic — Claude, GPT-4, Gemini share one brain |

---

## Bootstrap from Git History

```bash
# As a CLI command
npx @cachly-dev/mcp-server@latest index .
```

Or call directly from any AI session via the `brain_from_git` MCP tool:

```
brain_from_git(instance_id="...", workspace_path="/home/you/project", days=180)
```

Either way, your git log is read and lessons are extracted automatically:

```
🧠 Brain bootstrapped from git history

📊 Scanned: 342 commits over last 180 days
✅ Success lessons: 28  ❌ Failure/revert lessons: 9
📁 Hotspot files tracked: 12
💾 Total stored: 31 new lessons

Top lessons extracted:
  ✅🟡 auth:jwt-refresh-token — Use httpOnly cookie, not localStorage
  ❌🔴 deploy:docker-compose-detach — Reverted: "blocks SSH terminal"
  ✅🟡 redis:connection-pool-timeout — connectTimeout:5000 prevents hangs
```

---

## 67 MCP Tools

### 🧠 Cognitive Cache

| Tool | What it does |
|------|-------------|
| **`memory_consolidate`** | Distill knowledge base: contradictions, duplicates, pruned stale. Health score 0–100. |
| **`brain_diff`** | Git-style diff — what was learned, updated, or went stale since N sessions |
| **`causal_trace`** | Root cause analysis: given a problem, traces backwards through memory to find cause + fix |
| **`knowledge_decay`** | Temporal confidence per memory — decay by age, recover by recall frequency |
| **`autopilot`** | Generates and optionally writes CLAUDE.md that makes any AI fully self-managing |

### 🌐 Knowledge Syndication

| Tool | What it does |
|------|-------------|
| **`syndicate`** | Contribute a verified lesson to the global Knowledge Commons (anonymous, HMAC-hashed) |
| **`syndicate_search`** | Search solutions from every AI brain on the planet — ranked by `confirm_count` |
| **`syndicate_stats`** | Your contribution stats to the global commons |
| **`syndicate_trending`** | Most-confirmed lessons in the community this week |

### 🔁 Context Recovery

| Tool | What it does |
|------|-------------|
| **`compact_recover`** | **Call first after any context limit hit.** Returns last checkpoint, pending tasks, and top lessons — instantly. No full scan. |
| **`brain_from_git`** | Bootstrap brain from git history: `brain_from_git(workspace_path=".", days=180)` → stores months of team knowledge in one call. |

### 🧩 Session & Memory

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session, open failures, recent lessons, brain stats |
| **`session_end`** | Save session + auto-extract lessons from ambient git log |
| **`session_ping`** | Cross-provider checkpoint — switch Claude↔Copilot↔Cursor seamlessly |
| **`session_handoff`** | Hand off remaining tasks to next window with full context |
| **`auto_learn_session`** | Batch-store multiple observations at session end |
| **`learn_from_attempts`** | Store lessons after any fix, deploy, or discovery |
| **`recall_best_solution`** | Best known fix for a topic — with full success/failure history |
| **`recall_at`** | Recall a lesson at a specific point in time |
| **`smart_recall`** | BM25+ full-text search across all brain data — 11 languages |
| **`remember_context`** / **`recall_context`** | Cache/retrieve architecture findings, file summaries, ADRs |
| **`list_remembered`** / **`forget_context`** | List/remove cached context entries |
| **`sync_file_changes`** | Track file change history, surface related lessons per file |
| **`setup_ai_memory`** | Interactive wizard to configure AI memory |

### 🗺️ Roadmap

| Tool | What it does |
|------|-------------|
| **`roadmap_add`** | Add a feature/task to the persistent project roadmap |
| **`roadmap_update`** | Mark progress, change status, update priority |
| **`roadmap_list`** | View all roadmap items — shown at every `session_start` |
| **`roadmap_next`** | Pick the highest-priority open item to work on next |

### 👥 Team Brain

| Tool | What it does |
|------|-------------|
| **`team_learn`** / **`team_recall`** | Share lessons across the whole team on a shared instance |
| **`team_synthesize`** | Consolidate multiple lessons into one authoritative version |
| **`memory_crystalize`** | Distill all lessons into a Crystal snapshot for instant team context |
| **`brain_doctor`** | Health check: lesson quality, IQ boost %, open failures, recommendations |
| **`global_learn`** / **`global_recall`** | Cross-project universal lessons |
| **`publish_lesson`** / **`import_public_brain`** | Share/import community knowledge |
| **`trace_dependency`** | Find all lessons affected by a dependency change |
| **`list_orgs`** / **`create_org`** | Manage team organizations |
| **`invite_member`** / **`get_org_plan`** | Invite a developer to your org by email |

### 🔍 Multilingual Brain — Search in Any Language

`smart_recall` understands **11 languages natively** — no configuration required.

| Script | Languages | Tokenization |
|--------|-----------|-------------|
| Latin | EN, DE, FR, ES, IT, PT | Whitespace + stopwords |
| CJK | Chinese, Japanese, Korean | Character bigrams |
| RTL | Arabic, Hebrew | Word tokenization + Arabic light stemming |

**Romanization matching** — store in Japanese, search in romaji:
```
smart_recall("depuroi") → finds デプロイ docs
smart_recall("kontena") → finds コンテナ docs
```

**Cross-language retrieval** — 130+ tech term synonyms EN↔JA↔ZH↔KO↔AR↔HE:
```
smart_recall("deploy") → finds デプロイ, 部署, 배포, نشر, פריסה
```

### ⚙️ Instance Management

| Tool | What it does |
|------|-------------|
| `list_instances` / `create_instance` | List or spin up cache instances |
| `get_instance` / `delete_instance` | Get details or remove an instance |
| `get_connection_string` | Get the `redis://` URL for your own app |

### 🗄️ Cache Operations

| Tool | What it does |
|------|-------------|
| `cache_get` / `cache_set` / `cache_delete` | Standard cache operations |
| `cache_exists` / `cache_ttl` / `cache_keys` | Key inspection |
| `cache_mget` / `cache_mset` | Bulk pipeline (single round-trip) |
| `cache_stats` | Memory, hit rate, ops/sec, keyspace info |
| `cache_lock_acquire` / `cache_lock_release` | Distributed Redlock-lite |
| `cache_stream_set` / `cache_stream_get` | Cache streaming LLM responses in chunks |
| `cache_warmup` / `index_project` | Pre-warm cache or index a project directory |

### 🔭 Semantic Search

| Tool | What it does |
|------|-------------|
| `semantic_search` | Find cached entries by meaning (pgvector HNSW, EU-hosted) |
| `detect_namespace` | Auto-classify prompt into code/qa/summary/translation/creative |

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
<summary>Cursor / Windsurf / VS Code (<code>.cursor/mcp.json</code> or <code>.mcp.json</code>)</summary>

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
## AI Brain Rules (cachly Autopilot)
- If context was compacted: call compact_recover FIRST before anything else
- Call session_start BEFORE reading any files or making changes
- Call learn_from_attempts AFTER every fix, deploy, or discovery
- Call causal_trace BEFORE long debugging sessions
- Call syndicate_search BEFORE investigating any unknown error
- Call session_end when closing the window
```
</details>

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

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | — | **Required.** API key from [cachly.dev](https://cachly.dev) |
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
- ⭐ [Star on GitHub](https://github.com/cachly-dev/cachly-mcp) — If cachly saves you time, a star means a lot!
