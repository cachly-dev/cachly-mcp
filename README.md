# cachly — Give Your AI a Permanent Brain

> **Claude forgets everything when the session ends.**  
> cachly doesn't. Every fix, every lesson, every architecture decision — loaded in 2 seconds at the start of every session. Forever.

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
Just: **"session_start" → full context → work.**

---

## Before vs. After

| Situation | Without cachly | With cachly |
|-----------|----------------|-------------|
| Session start | "What's your architecture?" | Briefed in 2s — lessons, last session, open failures |
| Bug hits again | Re-researches from scratch (20–40 min) | "You fixed this on March 12, exact command: `kubectl rollout restart`" |
| After holiday | Context completely dead | Full context restored, team lessons visible |
| New team member | Weeks to onboard | `session_start` gives full codebase context instantly |
| Repeated patterns | Pays tokens for each re-discovery | Recalled in 1 round-trip, ~1,200 tokens saved per hit |

---

## Setup Wizard — What Happens

```
🧠  cachly AI Brain — Interactive Setup
────────────────────────────────────────

Step 1: Sign in to cachly (free — no credit card required)
   Code: XKCD-9281
   URL:  https://auth.cachly.dev/activate?user_code=XKCD-9281
   ✓  Browser opened — confirm the code above to continue...
   ................. ✓ Authorized!
⏳ Generating your API key... ✓

⏳ Fetching your instances... found 1

✓  Instance: My Brain (a1b2c3d4…)

Step 3: Detected editors: Claude Code, Cursor, GitHub Copilot
   Configure for which? [all / claude/cursor/copilot] (Enter = all):

✅ Written: .mcp.json
✅ Written: .cursor/mcp.json
✅ Written: CLAUDE.md

🧠  Done! Restart your editor — the `cachly` MCP tools will appear.
    Your AI now has persistent memory across every session.
```

---

## Tools (most important ones)

### Session & Memory

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session, open failures, relevant lessons, brain stats |
| **`session_end`** | Save what you built, auto-extract lessons from summary + git log |
| **`learn_from_attempts`** | Store lessons after any fix, deploy, or discovery |
| **`recall_best_solution`** | Best known fix for a topic — with full success/failure history |
| **`smart_recall`** | Full-text search across all brain data (BM25+) |
| **`remember_context`** / **`recall_context`** | Save/restore architecture findings, file summaries, ADRs |
| **`forget_lesson`** | Remove a stale or wrong lesson |
| **`list_lessons`** | Overview of all stored topics with severity, age, recall count |

### Team Brain

| Tool | What it does |
|------|-------------|
| **`team_learn`** / **`team_recall`** | Share lessons across the whole team on a shared instance |
| **`memory_crystalize`** | Distill all lessons into a Crystal snapshot — injected at every `session_start` |
| **`brain_doctor`** | Health check: IQ boost %, lesson quality, open failures |
| **`invite_member`** | Invite a dev to your org by email |

### Cache & Infrastructure

| Tool | What it does |
|------|-------------|
| `cache_get` / `cache_set` / `cache_delete` | Standard Redis operations |
| `cache_mget` / `cache_mset` | Bulk pipeline (single round-trip) |
| `semantic_search` | Find cached entries by meaning (vector search, EU-hosted) |
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

## Manual setup (if you prefer)

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
<summary>CLAUDE.md brain rules</summary>

```markdown
## AI Brain (cachly)
- ALWAYS call `session_start` at the beginning of every session — no exceptions
- After every fix, deploy, or discovery: call `learn_from_attempts`
- Before working on a known topic: call `recall_best_solution("<topic>")`
- At session end: call `session_end` with a one-line summary
```
</details>

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | — | **Required.** API key or JWT from the setup wizard |
| `CACHLY_BRAIN_INSTANCE_ID` | — | Default instance UUID — set once, works in all tools |
| `CACHLY_API_URL` | `https://api.cachly.dev` | Override for self-hosted |
| `CACHLY_NO_TELEMETRY` | unset | Set to `1` to opt out of anonymous usage pings |

---

## Ecosystem

| Package | What it does |
|---------|-------------|
| **[`@cachly-dev/mcp-server`](https://www.npmjs.com/package/@cachly-dev/mcp-server)** | ← you are here — AI Brain MCP for Claude Code, Cursor, Copilot, Windsurf |
| **[`cachly-brain` (VS Code)](https://marketplace.visualstudio.com/items?itemName=cachly.cachly-brain)** | VS Code extension — status bar, CodeLens lessons, one-click setup |
| **[`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw)** | JS/TS SDK — cut LLM costs 60–90% with semantic cache in your own app |
| **[`@cachly-dev/sdk`](https://www.npmjs.com/package/@cachly-dev/sdk)** | Node.js SDK — managed Redis, semantic cache & AI memory in your app |

---

## Links

- 🌐 [cachly.dev](https://cachly.dev) — Dashboard & free signup
- 📖 [Docs](https://cachly.dev/docs/ai-memory) — Full documentation
- 💬 [Issues](https://github.com/cachly-dev/cachly-mcp/issues) — Bug reports & feature requests
- ⭐ [Star on GitHub](https://github.com/cachly-dev/cachly-mcp) — If cachly saves you time, a star means a lot
