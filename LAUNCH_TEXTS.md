# Launch Texts — cachly AI Brain

---

## Product Hunt

### Tagline (60 chars max)
Persistent memory + causal AI for Claude, Cursor & Copilot

### Description (260 chars)
Your AI forgets everything between sessions. cachly fixes that permanently. One command sets it up: detects your editors, writes all configs, bootstraps lessons from your git history. Free forever. No credentials required.

### Full Description

**The problem:** Every morning you re-explain your architecture to your AI. Every bug gets re-researched. Every fix gets re-discovered. The average developer wastes 45 minutes/day on this.

**The fix:** `npx @cachly-dev/mcp-server@latest setup`

One command. It signs you in (one browser click), detects every editor you have (Claude Code, Cursor, Windsurf, VS Code, Copilot, Cline, Zed), writes the correct config for each, bootstraps your Brain from your git history, and installs a git hook that learns from every future commit automatically.

**What your AI gets:**
- A briefing at every session start: last session, open failures, relevant past fixes
- Causal root cause analysis: `causal_trace("auth breaks after restart")` → Root cause → Chain → Exact fix from 3 months ago with the command that worked
- Failure prediction before it happens: `brain_predict` reads your history before every deploy
- A running "time saved" counter — so you can see the ROI

**What makes it different from mem0, MemGPT, etc.:**
The `causal_trace` tool. No other memory system builds a Causal Knowledge Graph. Most systems store facts. cachly stores WHY things broke and HOW they were fixed — with the full chain of cause and effect. 30 minutes of git blame in one call.

**Free forever:** 25 MB, German servers, GDPR-compliant, no credit card.

### First Comment (post immediately after launch)
Hey PH! 👋

I built cachly after watching my AI re-research the same deployment bug for the third time in a month. It had no memory. I did.

The thing I'm most proud of: `causal_trace`. You describe a problem in plain English, and it walks your Brain's Causal Knowledge Graph to find: the root cause, the intermediate failure chain, and the exact fix that worked last time — including the date and the command. Nothing else does this.

5000+ developers are already using the npm package. Would love your feedback on what's missing.

**Commands to try after setup:**
- `causal_trace(problem="[your last bug]")` — see if it already knows the answer
- `brain_predict(context="about to deploy")` — what will go wrong?
- `brain_doctor` — Brain health check

---

## Hacker News — Show HN

**Title:**
Show HN: cachly – causal memory for AI coding assistants (MCP server, free)

**Text:**
I built cachly after noticing that my AI re-researched the same bug three times in a month. The context window empties, the memory vanishes.

cachly is an MCP server that gives Claude Code, Cursor, Copilot, and Windsurf persistent memory with one command:

  npx @cachly-dev/mcp-server@latest setup

It detects your editors, writes all the MCP configs, bootstraps from your git history, and installs a git hook that learns from every future commit. No credentials needed in any config file — OAuth Device Flow handles auth inline on the first tool call.

The part I think is technically interesting: `causal_trace`. Instead of just storing facts like most memory systems, cachly builds a Causal Knowledge Graph — typed edges: `fixes`, `requires`, `co-occurs`, `causes`, `contradicts`. When you describe a problem, it walks the graph to reconstruct the failure chain and surface the exact fix.

  causal_trace(problem="auth breaks after restart")
  → Root: k8s:namespace-terminating
  → Via:  keycloak:jwks-race
  → Fix:  PollUntilContextTimeout 3min ← worked March 12

Sessions start and end automatically (no manual session_start/session_end). Everything runs in the background.

Free tier: 25 MB, German servers, GDPR. Apache-2.0.

GitHub: https://github.com/cachly-dev/cachly-mcp
npm: https://www.npmjs.com/package/@cachly-dev/mcp-server

Happy to answer questions about the architecture.

---

## Reddit — r/ClaudeAI

**Title:**
I built persistent memory for Claude Code — no credentials, no config, one command

**Text:**
After the 10th time explaining my project architecture to Claude, I built cachly.

**What it does:**
Run `npx @cachly-dev/mcp-server@latest setup` once. It:
1. Signs you in with one browser click (no credentials in config)
2. Detects Claude Code, Cursor, Windsurf, VS Code, Cline — writes all configs automatically
3. Bootstraps your Brain from your git history right away
4. Installs a git hook so every future commit feeds the brain automatically

From that point, your AI arrives pre-briefed every session. No `session_start` needed — it's automatic.

**The feature I'm most excited about:**
`causal_trace("auth breaks after restart")` — it doesn't just search for similar lessons, it walks a Causal Knowledge Graph to reconstruct the failure chain and return the exact fix you used before, with commands and file paths.

**Free forever** — 25 MB, German servers, GDPR, no credit card.

GitHub: https://github.com/cachly-dev/cachly-mcp

Would love feedback from this community — what memory features would you most want?

---

## Reddit — r/LocalLLaMA

**Title:**
MCP server that learns from your git history automatically — causal memory for AI coding

**Text:**
Built this for the problem of AI context loss between sessions. Technical highlights:

- **Causal Knowledge Graph (CKG):** Typed edges (fixes, requires, co-occurs, causes, contradicts). `causal_trace` walks the graph instead of just doing text similarity.
- **Continuous Learning Stream:** git post-commit hook + GitHub Actions step. Every commit → lessons extracted automatically. Zero `session_end` calls needed.
- **brain_predict:** Before deploys, reads your CKG for patterns that match past failures and returns probability-weighted warnings.
- **Memory Crystals:** Compresses 30-50 sessions into a dense snapshot injected at every session start.
- **11-language BM25+ search:** EN, DE, FR, ES, IT, PT, ZH, JA, KO, AR, HE — cross-lingual retrieval (e.g. `smart_recall("deploy")` finds デプロイ, 部署, 배포).

Works with any MCP host: Claude Code, Cursor, Windsurf, VS Code, Cline, Zed, Continue.dev.

Free tier: 25 MB. Apache-2.0. German servers.

GitHub: https://github.com/cachly-dev/cachly-mcp

---

## Twitter/X Thread

**Tweet 1:**
Your AI forgets everything between sessions.
I built the fix.

`npx @cachly-dev/mcp-server@latest setup`

One command → persistent AI memory across Claude, Cursor, Copilot, Windsurf.
Free forever. 🧵

**Tweet 2:**
The part that took the longest to build: `causal_trace`

You type: "auth breaks after restart"

It returns:
→ Root: k8s:namespace-terminating
→ Via: keycloak:jwks-race
→ Fix: PollUntilContextTimeout 3min ← you used this March 12, it worked

30 minutes of git blame. One call.

**Tweet 3:**
How setup works:
1. Run the command
2. Browser opens → one click sign-in (no password)
3. It detects every editor you have
4. Writes MCP config for each automatically
5. Bootstraps Brain from your git history
6. Installs git hook for automatic future learning

Restart editor. Done.

**Tweet 4:**
What your AI sees every morning:

🧠 Session Briefing
⏱️ Brain saved you ~4h 30m total
✅ api:auth — Bearer in header, not cookie
✅ docker:build — ARG changes bust cache
⚠️ k8s:deploy — namespace terminating race condition

🤝 Your team has 3 new lessons since yesterday

**Tweet 5:**
Free tier: 25 MB, German servers, GDPR-compliant, no credit card.
Open source: Apache-2.0

GitHub: github.com/cachly-dev/cachly-mcp
npm: @cachly-dev/mcp-server

If this saves you time, a ⭐ means a lot.
