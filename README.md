# cachly — memory for coding agents (MCP server)

> **Solve it once. From then on, your AI knows.**
>
> Every fix, decision and dead end becomes a lesson. Your AI finds it again when the same
> problem comes back, in the next session, in another editor, or on a teammate's machine.

[![npm version](https://img.shields.io/npm/v/@cachly-dev/mcp-server?color=violet&logo=npm)](https://www.npmjs.com/package/@cachly-dev/mcp-server)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-yellow)](./LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.cachly--dev%2Fmcp--server-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=cachly)
[![Hosted in the EU](https://img.shields.io/badge/hosted_in-the_EU-003399)](https://cachly.dev/docs/eu-hosted-mcp-memory-server)

**Works with** Claude Code · Cursor · GitHub Copilot · Windsurf · Cline · Continue.dev · Zed ·
Codex CLI · Gemini CLI · JetBrains IDEs

[Quick start](#quick-start) · [What it looks like](#what-it-looks-like) ·
[Pricing](#pricing) · [FAQ](#faq) · [Reference](#reference) · [cachly.dev](https://cachly.dev)

## Quick start

**Claude Code** — two lines, and the next session has a Brain (the store of your lessons):

```
/plugin marketplace add cachly-dev/cachly-mcp
/plugin install cachly-brain@cachly
```

cachly creates a test Brain on EU servers when the session starts. It comes with 14 days
of the Solo plan and then continues on Free with the same key. Check it with
`claude mcp list`: you should see `plugin:cachly-brain:cachly … ✔ Connected`.

**Cursor, Windsurf, VS Code, Cline, Continue.dev, Zed, Codex CLI, Gemini CLI** — one command:

```bash
npx @cachly-dev/mcp-server@latest autopilot
```

`autopilot` finds your editors, writes the MCP config and the rule file for each, adds a
git hook that learns from your commits, and fills your Brain from your git history. You
sign in once in the browser with a device code. Restart your editor afterwards.

**Already inside Claude, Cursor or Copilot?** Paste this to your AI:

```
Set up cachly for this project. Run: npx @cachly-dev/mcp-server@latest autopilot
Follow the browser sign-in, then restart the editor.
```

**In the IDE:** the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=cachly-dev.cachly-brain)
creates your Brain on first start. The [JetBrains plugin](https://plugins.jetbrains.com/plugin/32059-cachly-brain)
brings it to IntelliJ IDEA, PyCharm, GoLand, WebStorm and Rider
([guide](https://cachly.dev/docs/jetbrains)).

**Keep your test Brain** with `npx @cachly-dev/mcp-server@latest claim`. You sign in once,
and the Brain moves into your account with all its lessons.

<details>
<summary><b>Claude Code in detail:</b> the three hooks, auto-update, and the test Brain</summary>

The plugin adds three Claude Code hooks:

| Hook | What it does |
|------|--------------|
| `SessionStart` | Gives your AI a short briefing: the 5 most-reused lessons (on a new Brain: starter tips) |
| `UserPromptSubmit` | Puts the lessons that match your prompt next to it |
| `Stop` | Saves a lesson when the AI's last message clearly reports a fix. It skips messages that say something failed or is unclear. It saves quietly. |

Turn on auto-update once: `/plugin` → **Marketplaces** → **cachly** → **Enable auto-update**.
Claude Code leaves it off for marketplaces outside Anthropic's own. The MCP server updates
itself on every start; the hooks come with the plugin and update with it. If an update is
waiting, the first `session_start` of a session says so in one line.

The test Brain is created by the plugin hook at session start, or by the first tool call
if the hook did not run. `claude mcp list` is the reliable check: `claude plugin details`
shows `MCP servers (0)` even while the server runs.

`claim` revokes every test key and stores a new key where your editor and hooks look for
it. The Brain restarts once, which takes about 20 seconds. The Free plan holds one Brain:
if you already have one, `claim` stops with a message and leaves both Brains as they are.

`autopilot` writes these rule files, so each editor's AI checks its memory before a task:
`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/cachly.mdc`, `.github/copilot-instructions.md`,
`.windsurfrules`, `.clinerules`, and `GEMINI.md`, `.junie/guidelines.md` and
`.continue/rules/cachly.md` where you use Gemini CLI, Junie or Continue. Claude Code and
Gemini CLI also follow the server's own instructions; Cline, Continue and Zed rely on the
rule file. You can also add the server by hand (see [Manual Setup](#manual-setup)).
</details>

## What it looks like

Monday, your AI fixes a bug and keeps what worked (output shortened):

```
learn_from_attempts(topic="billing:invoice-rounding", outcome="success",
  what_worked="ROUND HALF-EVEN IN invoice_total(): Math.round drifted by one cent on .5 values",
  file_paths=["src/billing/invoice.ts"])

✅ Lesson stored: billing:invoice-rounding
```

Three weeks later, a new session, a different person, the same symptom:

```
smart_recall(query="invoice total is one cent off")

💡 billing:invoice-rounding · 👤 anna
   ROUND HALF-EVEN IN invoice_total(): Math.round drifted by one cent on .5 values
   ▸ src/billing/invoice.ts
```

Your AI starts from the fix. With the hooks, this happens before you type: the matching
lessons are placed next to your prompt.

**Some fixes come back.** After a time/date or a dependency fix, `learn_from_attempts` adds
a relapse watch with counted numbers from 289 open-source projects. For example: 148 of
791 time/date fixes (19 %) were followed within 90 days by another time/date problem in
the same files, 4.4× as often as a random issue in the same project. Each hint links a
real pair of issues as an example.

## Why developers and teams use it

- **Your AI keeps what it learned.** Lessons outlive the session, the editor and the
  model. One Brain serves Claude Code, Cursor, Copilot, Codex and the others at the same
  time.
- **Your team learns each thing once.** `invite teammate@example.com` shares your Brain.
  Every lesson carries the name of whoever learned it, and a reviewer can confirm it so
  it ranks higher.
- **A light footprint in the context window.** Your editor lists 27 tool entries, about
  8,000 tokens per request. All 124 MCP tools stay one call away through
  `cachly_tool`.
- **Your data stays in the EU and stays yours.** Storage in Germany, embeddings computed
  in the EU, and `export` writes every lesson to Markdown and JSONL whenever you like.
  The server is open source under Apache-2.0.

## How it works

1. A fix, a decision or a dead end is stored as a lesson: topic, what worked, what failed,
   severity, file paths, commands and author.
2. At the start of a session, your AI receives a briefing with the last session, open
   failures and recent lessons.
3. When you ask for something, `smart_recall` looks up the lessons that match. It combines
   keyword search (BM25), meaning-based search and the causal graph, in 11 languages.
4. When an error appears, `causal_trace` walks from the symptom to the cause and to the fix
   that worked.
5. Before a deploy, `brain_predict` lists failure patterns from past incidents.
6. A git hook and the [CI templates](#ci-integration) add lessons from commits and from
   red-to-green runs.
7. Lessons are shared in the team. Each one carries the name of whoever learned it.

**See it on your own project first:** `npx @cachly-dev/mcp-server@latest demo` reads your
git history and prints the fixes, patterns and decisions your AI would know. It runs
entirely on your machine.

**Our agreement with you.** You can leave and take your data:
`npx @cachly-dev/mcp-server@latest export` writes every lesson to `lessons.md` (to read)
and `lessons.jsonl` (to reuse). Code excerpts are stored only when you call
`index_project` yourself, and then only on your own EU instance. Read
[what leaves your machine](https://cachly.dev/docs/eu-hosted-mcp-memory-server) before you
decide.

## Pricing

| Plan | Price | People | Storage |
|------|-------|--------|---------|
| **Free** | €0 | 1 | 25 MB, one Brain, 500 recalls a month |
| **Solo** | €19/month | 1 | 200 MB |
| **Team** | €49/month | up to 5 | 900 MB |
| **Business** | €199/month | up to 20, with SSO | 7 GB |

Start on Free with a sign-in, without a credit card. Organisations are free; you pay per
Brain plan. Yearly billing and the current limits are on
[cachly.dev/pricing](https://cachly.dev/pricing).

## Guides

| Guide | What you find there |
|-------|---------------------|
| [Claude Code hooks: which event to use when](https://cachly.dev/docs/claude-code-hooks) | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop` and more, sorted by when they fire. What each one can block, add and change. |
| [A UserPromptSubmit hook for Claude Code](https://cachly.dev/docs/claude-code-hooks/userpromptsubmit) | The stdin JSON, `additionalContext`, a working Node script and five traps to avoid. |
| The same hooks in [VS Code and Copilot CLI](https://cachly.dev/docs/claude-code-hooks#vscode), [Codex CLI](https://cachly.dev/docs/claude-code-hooks#codex) and [Gemini CLI](https://cachly.dev/docs/claude-code-hooks#gemini) | Which event takes context in each editor, and the exact file `setup` writes there. |
| Comparisons: [Supermemory](https://cachly.dev/docs/cachly-vs-supermemory), [Zep](https://cachly.dev/docs/cachly-vs-zep), [claude-mem](https://cachly.dev/docs/cachly-vs-claude-mem), [Basic Memory](https://cachly.dev/docs/cachly-vs-basic-memory), [mem0](https://cachly.dev/docs/cachly-vs-mem0), [Letta](https://cachly.dev/docs/cachly-vs-letta) | Side by side, each row with its source and a visible date, including when the other product fits better. |
| [EU-hosted MCP server: what leaves your machine](https://cachly.dev/docs/eu-hosted-mcp-memory-server) | Where data lands: storage in Germany, embeddings in the EU, the network edge, and a checklist. |
| [Lessons learned for coding agents](https://cachly.dev/docs/coding-agent-lessons-learned) | How to write a lesson your agent finds again: symptom, decisive fact first, what failed, files, a check. With examples and a `LESSONS.md`. |
| [JetBrains plugin guide](https://cachly.dev/docs/jetbrains) | What the plugin does, and how Claude Code, Junie and JetBrains AI Assistant use the Brain. |
| [Repo X-ray](https://cachly.dev/roentgen) | Enter a public GitHub repo. In a few seconds you see how many problems its team has solved, and which ones more than once. |

## FAQ

**How is this different from a `CLAUDE.md` or a memory folder?**
A rule file is read in full in every session, so it grows and costs tokens each time.
cachly keeps lessons outside the prompt and places only the matching ones next to it, ranked
by outcome and review. The [comparisons](#guides) show where a plain file or another product
fits better.

**Does my AI need to call `session_start` by hand?**
No. A session starts on the first tool call and ends when the editor closes.

**Can my whole team share one Brain?**
Yes. Use `team_learn` and `team_recall`, and invite people with
`npx @cachly-dev/mcp-server@latest invite teammate@example.com`. They get an email and accept it
with the link or with `join <token>`. Members can read and learn; deleting the Brain, rotating
its password and billing stay with the owner.

**Is my code sent to cachly servers?**
Only if you call `index_project` yourself. It stores a short excerpt (up to
`summary_chars`, 1200 characters by default) per indexed file, on your own EU instance.
Every other tool stores lesson text, commit messages, session summaries and key-value
context, but no source code. Storage is in Germany and embeddings are computed in the EU.
API traffic passes through Cloudflare, a US company. The
[EU guide](https://cachly.dev/docs/eu-hosted-mcp-memory-server) lists every data flow.

**What is `causal_trace`?**
Given an error, it walks the causal knowledge graph to find the root cause, the
intermediate causes and the fix that worked, with its date and commands.

**What if I hit the context-window limit mid-session?**
Call `compact_recover`. It rebuilds your context from the Crystal, the recent
sessions and the registry of work in progress. Usually one tool call is enough.

**How do I write lessons my agent finds again?**
Lead with the decisive fact. The
[lessons guide](https://cachly.dev/docs/coding-agent-lessons-learned) shows how, with
examples.

## Reference

Everything below is for looking things up. The long tables open with a click.

### MCP Tools (124 total, 27 listed by default)

Your editor sees 27 entries by default: the daily tools (26 of them) and one dispatcher,
`cachly_tool`. This is on purpose. The full list of 124 costs about 28,000 tokens in every
request. The 27 listed entries cost about 8,000. All other tools (98 of them) run through
the dispatcher:

```
cachly_tool(tool: "team_roster")                  run any of them by name
cachly_tool(tool: "team_roster", describe: true)  get its schema first
```

Every tool stays reachable. The server dispatches by name, so `team_roster` called directly
still works. Set `CACHLY_ALLE_WERKZEUGE=1` to list all 124. Set `CACHLY_PROFILE=lean` to
list 8 plus `cachly_tool`, or `CACHLY_PROFILE=recall` to list the 3 read-only tools.
<details>
<summary><b>All tools by area</b></summary>

#### Session and lessons (most used)

| Tool | What it does |
|------|-------------|
| **`session_start`** | Full briefing: last session, open failures, recent lessons, Brain health |
| **`session_end`** | Save what you built; extract lessons from the summary and the git log |
| **`learn_from_attempts`** | Store a structured lesson after any fix, deploy or discovery (with `author`, `visibility`) |
| **`recall_best_solution`** | The known fix for a topic, with its success and failure history |
| **`smart_recall`** | Hybrid BM25 + semantic + causal-graph search, 11 languages, quality-reranked |
| **`remember_context`** | Keep architecture findings, decisions and file summaries |
| **`compact_recover`** | Recover your context after you hit the context-window limit |

#### Team Brain and org knowledge graph

| Tool | What it does |
|------|-------------|
| `team_learn` / `team_recall` | Share lessons across the team with author attribution |
| `team_confirm` | A reviewer confirms a lesson (senior or peer); confirmed lessons rank higher in recall |
| `team_assign_role` / `team_roster` / `team_whoami` | Roles (admin, reviewer, contributor, viewer), enforced once an admin is set |
| `team_audit` | Admin-only governance trail: every role change and lesson confirmation |
| **`brain_who_knows`** | Find your team's experts on a topic, ranked from authorship |
| **`brain_file_map`** | Experts and lessons per file, before you touch it |
| **`team_expertise_map`** | The team's skills matrix in one table |
| **`brain_collab_pairs`** | Who works with whom, with bus-factor alerts |
| **`brain_portability`** | Config snippets for 7 MCP clients, so the same Brain serves any model |
| **`skill_gaps`** | Knowledge blind spots: unresolved failures, missing attribution |
| **`brain_coverage`** | A 0–100 health score for the knowledge of your codebase |
| `madc_deliberate` | Specialist AI agents vote to resolve contradictory lessons |
| `memory_crystalize` | Distill all lessons into a Crystal for instant team context |
| `team_crystallize` | A Team Crystal: fixes that 2 or more teammates reached independently |

#### Causal intelligence

| Tool | What it does |
|------|-------------|
| **`causal_trace`** | Root-cause analysis through the causal knowledge graph |
| **`brain_predict`** / `brain_predict_failures` | Predict likely failures before they happen |
| **`brain_from_git`** | Fill people, files and lessons from git history, incrementally |
| **`brain_from_ci`** | Bulk-ingest CI outcomes: red→green becomes a fix lesson with a causal `fixes` edge, green→red a `causes` edge |
| `memory_consolidate` | Detect contradictions, merge duplicates, expire stale lessons |
| `ckg_inspect` | Inspect the causal graph around a concept |

Example:

```
causal_trace(problem="auth breaks after restart")

→ Root: k8s:namespace-terminating
→ Via:  keycloak:jwks-race
→ Fix:  PollUntilContextTimeout 3min
```

#### Shareable and public Brains

| Tool | What it does |
|------|-------------|
| **`brain_seed_starter`** | Seed 16 universal lessons so your first `smart_recall` finds something; runs on a fresh repo |
| **`brain_share`** | Publish a Brain snapshot as a link (public or unlisted). For your own data, run `npx @cachly-dev/mcp-server export` |
| **`brain_import`** | Import a shared Brain into yours: `topic_prefix`, `min_confidence`, `dry_run` |
| `brain_share_list` / `brain_unshare` | List your shares; revoke one so the link goes dead |
| **`brain_discover`** | Search the Brain marketplace for ready-made knowledge bases |

#### Knowledge Commons, infrastructure and roadmap

| Tool | What it does |
|------|-------------|
| `syndicate` / `fedbrain_search` | Contribute to, and search, the global Knowledge Commons |
| `brain_marketplace` / `brain_install` | Browse and install curated Domain Brains (Kubernetes, Auth, databases) |
| `cache_get` / `cache_set` / `semantic_search` / `index_project` | Cache and semantic operations. Pass `org_id` on `cache_get` / `cache_set` to share the cache org-wide |
| `cache_stats` / `cache_org_stats` | Hits and requests served from the cache, per instance or across your org |
| `list_instances` / `create_instance` / `delete_instance` | Manage Brain instances |
| `roadmap_add` / `roadmap_next` | A project roadmap stored in the Brain |

Run `health` to see what is wired up in your editor. The full catalog is generated from
[`src/tools.ts`](./src/tools.ts).
</details>

### CLI commands

```bash
npx @cachly-dev/mcp-server@latest autopilot # One command: signs in, configures every editor, fills the Brain from git
```

Every command below runs as `npx @cachly-dev/mcp-server@latest <command>`. Key and Brain
instance come from the environment or from `~/.cachly/credentials.json`, the file `autopilot` writes.

<details>
<summary><b>All CLI commands</b></summary>

| Every day | |
|---|---|
| `status` | Lessons, recalls and team at a glance |
| `ambient-stats` | Tokens injected vs saved — the honest net, even when negative |
| `doctor` | Diagnose a broken or missing install, with the fix for each step |
| `health` | Check key, API, editor configs and git hook |
| `digest` | What your Brain learned this week, shareable |

| Set up | |
|---|---|
| `demo` | Preview your Brain from git history (no account needed) |
| `setup` (alias `autosetup`) | Interactive variant: pick editors yourself |
| `init --editor <id>` | Write the config for one editor, with flags |
| `claim` | Move a test Brain into your account, lessons included |
| `upgrade` | Check for updates |
| `uninstall` | Take cachly out of this project again. Shows your numbers first, then the plan; `--dry-run` only lists, `--global` adds the home folder |

| Your data | |
|---|---|
| `export` | Write every lesson to `lessons.md` and `lessons.jsonl` |
| `index [dir]` | Index a project's code into the Brain (CI-friendly) |
| `learn-git [repo]` | Learn lessons from recent git commits |

| Team & sharing | |
|---|---|
| `invite <email>` | Share your Brain with a teammate. They get an email; members can read and learn |
| `join <token>` | Accept an invitation (the command is in the email) and connect that Brain |
| `join --brain <id>` | Connect a Brain you already have access to (for example after accepting on the web) |
| `refer` | Show your personal referral link for new users |
| `share` | Generate a shareable stats card |
| `publish` | Publish your Brain as an importable link (`--public`) |
| `badge` | Get a live README badge for your Brain |

| More | |
|---|---|
| `bench` | Run the recall benchmark (no sign-in needed) |
| `tool-specs` / `openapi` | Tool definitions for other agent frameworks (OpenAI, Anthropic, LangChain, OpenAPI) |

The method behind `bench` is described in [BENCH.md](./BENCH.md).

> **Tip: learn from every merged PR.** Run `learn-git` in CI with the
> [cachly-brain-setup GitHub Action](https://github.com/cachly-dev/cachly-action) and
> `mode: learn`. Each merged PR then teaches your Brain.
</details>

### CI integration

Every CI run is a lesson. A red→green transition is a proven fix, and a green→red one is a
known cause. Ready-to-paste templates live in [`src/ci-integration/`](./src/ci-integration/):

- **GitHub Actions:** use [cachly-dev/cachly-action](https://github.com/cachly-dev/cachly-action).
  It needs the secrets `CACHLY_API_KEY` and `CACHLY_BRAIN_INSTANCE_ID`.
- **GitLab CI:** pull in the
  [GitLab template](https://github.com/cachly-dev/cachly-action/blob/main/templates/cachly.gitlab-ci.yml)
  with `include: remote:`. It adds hidden jobs for `learn`, `scan`, `confirm` and `hygiene`;
  extend the ones you want.
- **Anything else:** [`push-ci-outcome.mjs`](./src/ci-integration/push-ci-outcome.mjs) is a
  standalone Node.js helper with no dependencies. It always exits 0, so your CI never
  fails because of a Brain push.

Already have months of CI history? The `brain_from_ci` tool ingests past outcomes in one
call, the way `brain_from_git` ingests commits.

### Editor support matrix

`npx @cachly-dev/mcp-server@latest autopilot` detects and configures the editors below.
Manual snippets are in [Manual Setup](#manual-setup).

<details>
<summary><b>Editors, config files and sign-in paths</b></summary>

| Editor / client | Auto-setup | Config file written | Global config | Notes |
|---|---|---|---|---|
| **Claude Code** | yes | `.mcp.json` | with the plugin | Without a key: test Brain at session start (plugin) or on the first tool call; browser sign-in only as fallback |
| **Cursor** | yes, detected via `.cursor/` | `.cursor/mcp.json`, hooks in `.cursor/hooks.json` | no | Project-level; restart Cursor after setup. Lessons arrive with the first tool call of a turn |
| **Windsurf** | yes, detected via `.windsurf/` | `.windsurf/mcp.json` | no | Project-level; restart Windsurf after setup |
| **VS Code + Copilot** | yes, detected via `.vscode/` | `.vscode/mcp.json`, hooks in `.github/hooks/cachly-ambient.json` | no | Needs the VS Code MCP support or Copilot chat. Briefing at session start, lessons before each prompt |
| **Codex CLI** | yes, detected via `~/.codex` | `.codex/config.toml` (`[mcp_servers.cachly]`), hooks in `.codex/hooks.json` | no | Codex loads both once you trust the folder; confirm the hook once in `/hooks` |
| **Gemini CLI** | yes, detected via `~/.gemini` | `mcpServers.cachly` and `hooks` in `.gemini/settings.json` | no | Gemini loads both once you trust the folder. Lessons are appended to the prompt (`BeforeAgent`) |
| **Cline** | yes, detected via VS Code | `.vscode/mcp.json` | no | Shares the config with Copilot; restart VS Code |
| **Continue.dev** | yes, detected via `.continue/` | `.continue/config.json` | no | Uses the `modelContextProtocolServers` key |
| **Zed** | yes, detected via `.zed/` | `.zed/settings.json` | no | Uses the `context_servers` key |
| **Windsurf (global)** | `autosetup --editor windsurf` | `~/.windsurf/mcp.json` | yes | Pass `--editor` to target the global config |
| **Any other MCP client** | `autosetup --editor claude` | `.mcp.json` | no | Standard `mcpServers` stdio format |

**Which sign-in path each case uses:**

| Scenario | Path |
|---|---|
| `autosetup` or `autopilot` from a terminal (TTY) | OAuth device flow: one click in the browser, the API key is saved automatically |
| `autosetup` from a VS Code task or CI (no TTY) | Detects the non-interactive run, opens the browser with a step-by-step guide, prints the `CACHLY_JWT=... autosetup` command |
| First tool call without any key | Test Brain: an anonymous Brain on EU servers. The key is saved to `~/.cachly/credentials.json`, and the call goes through. If that fails (offline, rate limit), the inline device flow starts with a URL and a code |
| First tool call with `CACHLY_BRAIN_INSTANCE_ID` set but no key | Inline device flow. You already have a Brain, so no second account is created |
| `CACHLY_JWT=cky_live_xxx npx ... autosetup` | Skips the sign-in step and uses the key you pass |

</details>

### Manual Setup

<details>
<summary><b>Claude Code</b> (<code>.mcp.json</code> in the project)</summary>

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

For all your projects at once, use the plugin above, or
`claude mcp add -s user cachly -- npx -y @cachly-dev/mcp-server@latest`
(Claude Code stores that in `~/.claude.json`).

Without a key, the first tool call creates a test Brain on EU servers. No sign-up.
Run `npx @cachly-dev/mcp-server@latest autopilot` to use your own account instead.
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

### Self-hosting and bring-your-own embeddings

Embeddings turn text into vectors for the meaning-based search. By default, cachly
computes them on its own servers in the EU as soon as you are signed in. Your text goes
to a third-party provider only when you name that provider yourself:

<details>
<summary><b>Embedding providers and your own backend</b></summary>

| Provider | Env vars | Model |
|---|---|---|
| cachly (default, EU servers) | none beyond your key | managed |
| Ollama (local) | `OLLAMA_BASE_URL`, detected automatically | `nomic-embed-text` |
| OpenAI | `CACHLY_EMBED_PROVIDER=openai` and `OPENAI_API_KEY` | `text-embedding-3-small` |
| Google Gemini | `CACHLY_EMBED_PROVIDER=gemini` and `GEMINI_API_KEY` | `text-embedding-004` |
| Mistral | `CACHLY_EMBED_PROVIDER=mistral` and `MISTRAL_API_KEY` | `mistral-embed` |
| Cohere | `CACHLY_EMBED_PROVIDER=cohere` and `COHERE_API_KEY` | `embed-english-v3.0` |

Run `npx @cachly-dev/mcp-server@latest health` to see which provider is active.

**Point at your own backend.** Every install can talk to a private backend instead of
`api.cachly.dev`:

```bash
# One command: run the setup against your self-hosted backend
npx @cachly-dev/mcp-server@latest autopilot --api-url https://cachly.mycorp.internal

# Or without prompts
npx @cachly-dev/mcp-server@latest autosetup \
  --instance-id <uuid> --api-key <cky_live_...> \
  --api-url https://cachly.mycorp.internal
```

`autosetup` writes `CACHLY_API_URL` into the editor config only when it differs from the
default cloud. Default installs stay clean, and self-hosted installs keep talking to your
backend on every editor start.
</details>

### Environment Variables

<details>
<summary><b>All environment variables</b></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHLY_JWT` | none | API key. The setup wizard sets it for you |
| `CACHLY_BRAIN_INSTANCE_ID` | none | Default Brain UUID. Optional, it is resolved automatically |
| `CACHLY_API_URL` | `https://api.cachly.dev` | Override for a self-hosted backend |
| `CACHLY_EMBED_PROVIDER` | automatic | Name an embedding provider yourself (see above) |
| `CACHLY_ALLE_WERKZEUGE` | unset | Set to `1` to list all 124 tools instead of 27 |
| `CACHLY_PROFILE` | unset | `lean` lists 8 tools plus `cachly_tool`, `recall` lists the 3 read-only tools |
| `CACHLY_UPDATE_CHECK` | on | Set to `false` to stop the version check. npm is asked at most once a day, with a 2-second limit |
| `CACHLY_NO_TELEMETRY` | unset | Set to `1` to disable usage pings. They include your API token and up to 80 characters of `smart_recall` queries |
| `CACHLY_LERNEN` | on | Learning from use in the prompt hook. For 5 % of prompts the matching lessons are computed but not shown (control group), up to 10 % try a stricter or shorter setting. At the end of each turn the hook reports which setting ran and whether the agent named a shown lesson; topics are sent hashed, prompts never. Set to `0` (or `CACHLY_NO_TELEMETRY=1`) to turn it off |
| `CACHLY_KONTROLLE_ANTEIL` | `5%` | Share of prompts in the control group. `0` turns the control group off, at most `50%` |
| `CACHLY_ERKUNDUNG` | `10%` | Share of prompts that may try another setting. `0` keeps the leading setting, at most `10%` |

</details>

## Links

| Where | What you find there |
|-------|---------------------|
| [cachly.dev](https://cachly.dev) | Sign-up, dashboard and the product page |
| [cachly.dev/pricing](https://cachly.dev/pricing) | Plans, yearly billing and current limits |
| [MCP docs](https://cachly.dev/docs/mcp) · [AI memory docs](https://cachly.dev/docs/ai-memory) | Setup, tools and concepts |
| [Release notes](./CHANGELOG.md) | What changed in each version |
| [github.com/cachly-dev/cachly-mcp](https://github.com/cachly-dev/cachly-mcp) | Source code of this server |
| [GitHub Issues](https://github.com/cachly-dev/cachly-mcp/issues) | Bugs and feature requests |
| [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=cachly) | The official entry, `io.github.cachly-dev/mcp-server` |
| [Cachly Brain for VS Code](https://marketplace.visualstudio.com/items?itemName=cachly-dev.cachly-brain) | Status bar, lessons view and ambient learning in the editor |
| [Cachly Brain for JetBrains](https://plugins.jetbrains.com/plugin/32059-cachly-brain) | The same Brain in IntelliJ IDEA, PyCharm, GoLand, WebStorm and Rider ([source](https://github.com/cachly-dev/cachly-intellij)) |
| [cachly-dev/cachly-action](https://github.com/cachly-dev/cachly-action) | GitHub Action: setup, PR risk scan, learning from merged PRs, weekly hygiene |
| [`@cachly-dev/openclaw`](https://www.npmjs.com/package/@cachly-dev/openclaw) | Semantic caching for LLM calls in JS/TS apps |

The VS Code extension shows the same Brain in the editor:

![The Lessons view inside the Cachly Brain VS Code extension, listing six stored lessons](https://cachly.dev/screenshots/vscode/shot3-lesson-card.png)

---

**Solve it once. From then on, your AI knows.**

```bash
npx @cachly-dev/mcp-server@latest autopilot
```
