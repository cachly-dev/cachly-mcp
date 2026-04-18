# cachly MCP Server

> Manage your [cachly.dev](https://cachly.dev) cache instances directly from **GitHub Copilot, Claude, Cursor, Windsurf** and any other MCP-compatible AI assistant.

## 🚀 Zero-Touch Setup — One Command

Stop your AI from re-reading your entire codebase every time. One command enables **context memory** and configures all your editors automatically:

```bash
CACHLY_JWT=your-jwt npx @cachly-dev/mcp-server setup
```

The interactive wizard will:
1. Authenticate with your cachly account (or prompt for JWT)
2. Let you pick which cache instance to use as your AI Brain
3. **Auto-detect** Cursor, Windsurf, VS Code, Claude Code, and Continue.dev
4. Write the correct MCP config for every detected editor
5. Create/update `CLAUDE.md` (idempotent — safe to re-run)

**Result:** 60% fewer file reads, instant context across sessions, zero re-discovery.

### Non-interactive (CI / scripted setup)

```bash
CACHLY_JWT=your-jwt npx @cachly-dev/mcp-server init \
  --instance-id your-instance-id \
  --editor vscode
```

## What you can do

Once connected, just talk to your AI assistant:

```
"Create a free cachly instance called my-app-cache"
"List all my cache instances"
"Get the connection string for instance abc-123"
"Delete my test-cache instance"
```

## Available Tools

### 🧠 AI Brain — Session & Memory

| Tool | Description |
|---|---|
| **`session_start`** | Single call returning full briefing: last session, relevant lessons, open failures, brain health. Call at the start of every session. |
| **`session_end`** | Save session summary, files changed, duration. Call at the end of every session. |
| **`learn_from_attempts`** | Store structured lessons after any bug fix or deploy. Supports severity, file_paths, commands, tags. Deduplicates by topic. |
| **`recall_best_solution`** | Retrieve the best known solution for a topic (increments recall count). |
| **`remember_context`** | Cache any analysis or architecture finding for future sessions. |
| **`recall_context`** | Retrieve cached context by exact key (supports glob: `"file:*"`). |
| **`smart_recall`** | Semantic search across all cached context by meaning/keywords. |
| **`list_remembered`** | List all cached context entries. |
| **`forget_context`** | Delete stale context. |

### ⚙️ Instance Management

| Tool | Description |
|---|---|
| `list_instances` | List all your cache instances |
| `create_instance` | Create a new instance (free or paid tier) |
| `get_instance` | Get details for a specific instance |
| `get_connection_string` | Get the `redis://` connection URL |
| `delete_instance` | Permanently delete an instance |

### 🗄️ Cache Operations

| Tool | Description |
|---|---|
| `cache_get` / `cache_set` / `cache_delete` | Live cache operations |
| `cache_exists` / `cache_ttl` / `cache_keys` | Key inspection |
| `cache_stats` | Memory, hit rate, ops/sec |
| `cache_mget` / `cache_mset` | Bulk pipeline operations |
| `cache_lock_acquire` / `cache_lock_release` | Distributed locks (Redlock-lite) |
| `cache_stream_set` / `cache_stream_get` | LLM token streaming cache |

### 🔍 Semantic & AI

| Tool | Description |
|---|---|
| `semantic_search` | Vector similarity search (Speed/Business tier) |
| `detect_namespace` | Auto-classify prompt into semantic namespace |
| `cache_warmup` | Pre-warm semantic cache with known Q&A pairs |
| `index_project` | Index local source files for AI semantic search |
| `get_api_status` | Check API health + JWT auth info |

## Setup

### Recommended: Zero-Touch via npx

```bash
CACHLY_JWT=your-jwt npx @cachly-dev/mcp-server setup
```

No install, no build step. The wizard auto-detects your editors and writes all config files.

### Manual configuration

Get your JWT token at **[cachly.dev/settings](https://cachly.dev/settings)** → API Tokens.

#### Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "cachly": {
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server"],
      "env": { "CACHLY_JWT": "your-jwt-token-here" }
    }
  }
}
```

- **Claude Code:** add to `.claude/mcp.json` in your project
- **Claude Desktop (macOS):** `~/Library/Application Support/Claude/claude_desktop_config.json`

#### GitHub Copilot (VS Code)

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "cachly": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server"],
      "env": { "CACHLY_JWT": "your-jwt-token-here" }
    }
  }
}
```

Then: **Ctrl/Cmd+Shift+P → "MCP: List Servers"** → start `cachly`.

#### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cachly": {
      "command": "npx",
      "args": ["-y", "@cachly-dev/mcp-server"],
      "env": { "CACHLY_JWT": "your-jwt-token-here" }
    }
  }
}
```

#### Windsurf / Continue.dev

Same `stdio`/`mcpServers` format — add to their respective MCP config file.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CACHLY_JWT` | ✅ | – | Your Keycloak JWT from cachly.dev/settings |
| `CACHLY_API_URL` | ❌ | `https://api.cachly.dev` | Override for local dev |

## Example Session

```
User: Create a free cache instance for my OpenAI project

Copilot: I'll create a free cachly instance for you.
[calls create_instance(name="openai-cache", tier="free")]

✅ Instance **openai-cache** (FREE) created and provisioning started!
   ID: `a1b2c3d4-...`
   Status: provisioning

Use `get_connection_string` to get your Redis URL in ~30 seconds.

User: Get the connection string

Copilot: [calls get_connection_string(instance_id="a1b2c3d4-...")]

Connection string for openai-cache:
  redis://:password@my-node.cachly.dev:30101

Environment variable:
  REDIS_URL="redis://:password@my-node.cachly.dev:30101"
```

## Local Development

```bash
# Run against local API
CACHLY_JWT=your-token CACHLY_API_URL=http://localhost:3001 npm run dev
```

---

## Real-World Use Cases

### 🧠 Stop Re-Reading Your Codebase — "Thinking Cache"

**The Problem:** Every time you ask Copilot about your codebase, it runs "Ich verschaffe mir einen Überblick über die Codebasis" and re-reads hundreds of files.

**The Solution:** Cache your AI's "thinking" results:

```
You: "Analyze the authentication architecture"
AI:  [reads 47 files, takes 30 seconds]
     The auth uses Keycloak with JWT tokens. The flow is:
     1. User hits /sign-in → NextAuth redirect
     2. Keycloak validates credentials
     3. JWT returned, stored in session
     
     [calls remember_context("auth_architecture", "The auth uses Keycloak...")]
     🧠 Context saved for future sessions.

--- Next day, new session ---

You: "How does auth work?"
AI:  [calls smart_recall("auth")]
     🧠 Found cached context:
     The auth uses Keycloak with JWT tokens...
     
     (No file reading needed — instant answer!)
```

The `setup` wizard (see top of this README) writes the session instructions automatically into your `CLAUDE.md` / `.github/copilot-instructions.md` — **no manual editing needed.** Just run `npx @cachly-dev/mcp-server setup` once and your AI assistant calls `session_start` at the start of every session automatically.

### 1. AI-Assisted Development — "Which caches am I using?"

You're building a microservice that uses multiple cachly instances. Ask your AI assistant directly:

```
You: "List all my cachly instances and their status"
AI:  Using cachly_list_instances...
     
     You have 3 instances:
     1. prod-api (Pro, running) — redis://:***@prod.cachly.dev:30101
     2. staging (Dev, running) — redis://:***@staging.cachly.dev:30102  
     3. ml-pipeline (Speed, running) — redis://:***@ml.cachly.dev:30103
     
     Total MRR: €72/month
```

### 2. Cache Debugging — "Why is my hit rate dropping?"

Your semantic cache hit rate dropped overnight. Debug it without leaving your editor:

```
You: "Check the analytics for my prod-api instance"
AI:  Using cachly_semantic_stats...
     
     ⚠️ Hit rate dropped 23% in the last 24h (82% → 63%)
     
     Anomaly detected: near-miss spike (+140%)
     → 47 queries are hitting similarity 0.80-0.84 (just below your 0.85 threshold)
     
     Recommendation: Lower threshold to 0.82 to capture these near-misses.
     
You: "Do it"
AI:  Using cachly_set_threshold... ✅ Threshold set to 0.82 for namespace cachly:sem
```

### 3. Deployment Cache Warmup — "Pre-fill the cache for the new release"

After deploying a new version, warm the semantic cache with common queries:

```
You: "Warm up the staging cache with our top 50 support questions"
AI:  Using cachly_batch_index with your FAQ embeddings...
     
     ✅ Indexed 50 entries in 340ms (batch pipeline)
     Namespace: cachly:sem:qa
     
     Your cache is ready — first users will get instant responses.
```

### 4. Cost Monitoring — "How much am I saving?"

Track your LLM cost savings directly in your IDE:

```
You: "How much has cachly saved me this month?"
AI:  Using cachly_semantic_stats...
     
     📊 This month's savings:
     - Total cache hits: 12,847
     - Estimated savings: $384.21 (vs. direct LLM calls)
     - Efficiency score: 84/100 (Grade: A)
     - Best namespace: cachly:sem:qa (94% hit rate)
```

### 5. CI Pipeline Integration — "Check cache health before deploy"

Add cache health checks to your deployment workflow:

```
You: "Check if any cache anomalies would block a deploy"
AI:  Using cachly_analytics_anomalies...
     
     ✅ No critical anomalies detected.
     1 info-level notice: stale cache in namespace "translations" 
     (12 near-misses/24h, 0 new entries)
     
     Recommendation: Run warmup after deploy for translations namespace.
     Deploy is safe to proceed.
```

---

## License

MIT © [cachly.dev](https://cachly.dev)

