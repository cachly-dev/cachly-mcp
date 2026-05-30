# Plan — External Team-Knowledge-Reuse Dashboard (`cachly-insights`)

> **Status:** Planning · target: a **separate repo** (`cachly-dev/cachly-insights`)
> **Owner:** TBD · **Last updated:** 2026-05-30 · **Author of plan:** generated alongside cachly-mcp v0.10.80
>
> This document is the build spec for the server-side analytics dashboard that
> surfaces the **three decisive metrics** (STRATEGY.md §6 / PROGRESS.md §3) across
> all Brains — the last open item that is *not* shippable inside the MCP package
> itself, because it needs aggregation, persistence, and a UI.

---

## 0. Why this is a separate repo

The MCP server (`cachly-mcp`) is a stateless CLI/stdio binary published to npm. It
**emits** telemetry and **writes** per-Brain stats, but it must stay small, have no
web framework, no database of its own, and no dashboard. The dashboard:

- aggregates across **many** Brains / orgs (cross-cutting, not per-instance);
- needs a **time-series store** and a **web UI** (heavy deps, wrong for an npm CLI);
- has its own deploy cadence, secrets, and access control (internal + customer-facing);
- is read-mostly and must never sit in the agent hot path.

So it lives in `cachly-dev/cachly-insights` and consumes data the MCP server and the
cachly API already produce.

---

## 1. Goals & non-goals

### Goals
1. **Prove the three metrics over real users**, not just synthetic benches:
   - **Time-to-first-recall** — wall-clock `born_at → first_recall_at` distribution.
   - **Recall-lift** — already proven in-repo (`npm run bench`); dashboard shows the
     *adoption* of recall (how often recall actually fires) rather than re-deriving IR metrics.
   - **Team-knowledge-reuse** — % of recalls using a teammate's lesson; distinct reuse pairs.
2. **Onboarding funnel** — setup_started → auth → first_call_success → first recall, with
   drop-off at each step (this is what caught the 0% activation regression earlier).
3. **Per-org Team-Knowledge-Reuse view** — a customer-facing page an org admin can open
   to see "lesson written by Alice, reused 7× by 4 teammates → ~3.5h saved".
4. **Internal health** — starter-seed rate, brain_from_git yield, device-flow failures by reason.

### Non-goals
- No PII beyond what the user already attributes (handles like "alice"; never emails in the UI).
- Not a replacement for product analytics (PostHog/GA) — this is *Brain-value* analytics.
- No write path back into Brains. Read-only over telemetry + stats snapshots.

---

## 2. Data sources (what already exists in cachly-mcp)

### 2a. Funnel telemetry — `POST ${API_URL}/api/v1/telemetry/mcp`

Fire-and-forget JSON, 3s timeout, opt-out via `CACHLY_NO_TELEMETRY=1`. Body shape
(`sendFunnelEvent` in `src/index.ts`):

```jsonc
{
  "event": "first_call_success",      // see event list below
  "version": "0.10.80",                // CURRENT_VERSION
  "editor": "cursor",                  // detectEditor(): cursor|windsurf|copilot|claude|unknown
  "jwt": "<token>",                    // present only when authenticated (server resolves → org/user)
  "instance_id": "uuid",               // when known
  "tool": "smart_recall",              // for tool-scoped events
  "reason": "timeout",                 // for device_flow_failed
  "auto": true,                        // for brain_seed_starter (auto vs manual)
  "fixes": 12, "features": 3, "refactors": 1, "total": 16  // for brain_from_git
}
```

**Event catalogue** (grep `sendFunnelEvent(` in `src/index.ts`):

| Stage | Events |
|---|---|
| Setup | `setup_started`, `setup_auth_started`, `setup_auth_completed` |
| Device flow | `device_flow_started`, `device_flow_completed`, `device_flow_failed{reason}`, `auth_self_healed{reason}` |
| Activation | `first_call_no_jwt`, `first_call_success{tool}` |
| Usage | `session_start`, `session_end`, `smart_recall`, `recall_best_solution`, `learn_from_attempts` |
| Bootstrapping | `brain_from_git{fixes,features,refactors,total}`, `brain_seed_starter{auto}`, `brain_predict`, `brain_predict_failures` |
| Provisioning errors | `auto_provision_failed{status}`, `instance_not_reachable{status}`, `redis_connect_failed{error}` |

> ⚠️ The cachly API is the **only** component that maps `jwt → org_id/user_id`. The
> dashboard must consume an **already-resolved** stream from the API, never raw JWTs.

### 2b. Per-Brain stats — Valkey/Dragonfly keys (written by `cachly-mcp`)

Set in `src/handlers/brain.ts` (and `share.ts` for the seed). All `EX` 365d where noted:

| Key | Type | Meaning | Written by |
|---|---|---|---|
| `cachly:stats:born_at:{instance}` | string (ISO, NX) | first lesson stored | learn_from_attempts, brain_seed_starter |
| `cachly:stats:first_recall_at:{instance}` | string (ISO, NX) | first proven recall | smart_recall/recall path |
| `cachly:stats:recalls_total:{instance}` | int | total proven recalls | recall path |
| `cachly:stats:cross_author_recalls:{instance}` | int | recalls of a teammate's lesson | recall path |
| `cachly:stats:reuse_pairs:{instance}` | set | `"{requester}<-{author}"` distinct pairs | recall path |
| `cachly:stats:time_saved_mins:{instance}` | float | cumulative minutes saved | recall path |
| `cachly:brain:starter_seeded:{instance}` | string (ISO) | seed marker (idempotency) | brain_seed_starter |

`brain_metrics(instance_id)` already reads all of these for a single Brain. The
dashboard generalises this to **all** instances + time series.

---

## 3. Architecture

```
┌───────────────┐   funnel events (HTTPS POST)    ┌────────────────────┐
│  cachly-mcp   │ ───────────────────────────────▶│  cachly API        │
│  (npm CLI)    │                                  │  (existing)        │
│               │   writes cachly:stats:* ───────▶│  Valkey/Dragonfly  │
└───────────────┘                                  └─────────┬──────────┘
                                                             │ jwt→org/user resolved here
                                              ┌──────────────▼───────────────┐
                                              │  Ingestion worker (NEW)       │
                                              │  - subscribes to telemetry    │
                                              │  - nightly stats snapshot scan│
                                              │  - writes time-series rows    │
                                              └──────────────┬───────────────┘
                                                             ▼
                                              ┌──────────────────────────────┐
                                              │  TimescaleDB / ClickHouse     │
                                              │  (events + daily snapshots)   │
                                              └──────────────┬───────────────┘
                                                             ▼
                                  ┌──────────────────────────┴───────────────────┐
                                  │  cachly-insights API (read-only, NEW)         │
                                  │  REST/GraphQL: /funnel /ttfr /reuse/:org ...  │
                                  └──────────────────────────┬───────────────────┘
                                                             ▼
                                  ┌──────────────────────────────────────────────┐
                                  │  Web UI (Next.js)                             │
                                  │  - internal dashboards (auth: staff SSO)      │
                                  │  - per-org customer page (auth: org admin)    │
                                  └──────────────────────────────────────────────┘
```

**Key decision:** the cachly API stays the single trust boundary for identity. The
ingestion worker reads *resolved* events (org_id, user_handle) — the dashboard repo
never sees a JWT. Either (a) the API forwards events to a queue with identity attached,
or (b) the API exposes an internal authenticated `/internal/telemetry/stream`.

---

## 4. Data model (TimescaleDB flavour)

```sql
-- Raw resolved funnel events (hypertable, partitioned by time)
CREATE TABLE funnel_events (
  ts           TIMESTAMPTZ NOT NULL,
  event        TEXT NOT NULL,
  org_id       TEXT,           -- resolved by API; null for anonymous (no-jwt)
  user_handle  TEXT,           -- resolved; null when anonymous
  instance_id  TEXT,
  version      TEXT,
  editor       TEXT,
  tool         TEXT,
  reason       TEXT,           -- device_flow_failed reason, etc.
  meta         JSONB           -- {auto, fixes, features, refactors, total, status...}
);
SELECT create_hypertable('funnel_events', 'ts');

-- Daily per-Brain snapshot of cachly:stats:* (one scan/night)
CREATE TABLE brain_stats_daily (
  day                   DATE NOT NULL,
  instance_id           TEXT NOT NULL,
  org_id                TEXT,
  born_at               TIMESTAMPTZ,
  first_recall_at       TIMESTAMPTZ,
  ttfr_seconds          BIGINT,        -- derived: first_recall_at - born_at
  recalls_total         BIGINT,
  cross_author_recalls  BIGINT,
  reuse_pairs           INT,           -- cardinality of the set
  time_saved_mins       DOUBLE PRECISION,
  starter_seeded        BOOLEAN,
  PRIMARY KEY (day, instance_id)
);

-- Org dimension (mirrored/synced from cachly API, read-only)
CREATE TABLE orgs (org_id TEXT PRIMARY KEY, name TEXT, plan TEXT, created_at TIMESTAMPTZ);
```

Continuous aggregates (Timescale) for the heavy rollups: daily funnel counts,
TTFR percentiles per cohort, reuse % per org.

---

## 5. Dashboard views (the actual screens)

### V1 — Activation Funnel (internal)
Step bars with drop-off %:
`setup_started → setup_auth_completed → device_flow_completed → first_call_success → first recall`.
Sliceable by `version`, `editor`. **This is the regression alarm** — the earlier
"setup_started:2, device_flow_completed:0" incident would have been one red bar here.
Alert: fire if `device_flow_completed / setup_auth_started < 0.5` over 24h.

### V2 — Time-to-first-recall (internal + per-org)
- Distribution histogram of `ttfr_seconds` (buckets: <2min 🟢, <1h 🟡, >1h 🔴).
- p50 / p90 trend line over weeks; goal line at **120s**.
- **Cohort split: seeded vs non-seeded** (join `brain_seed_starter` event /
  `starter_seeded` flag). This is where we prove the v0.10.80 starter corpus moved
  the real-user metric — the live counterpart to `npm run bench:onboarding`.

### V3 — Team-Knowledge-Reuse (customer-facing, per org)
The flagship "value only a shared brain delivers" page an org admin opens:
- Headline: **"{cross_author_recalls} cross-author recalls · {reuse_pairs} reuse relationships · ~{time_saved} saved"**.
- Reuse graph: nodes = handles, edges = "B reused A's lesson" (from `reuse_pairs`).
- Leaderboard: whose lessons get reused most (the "knowledge multiplier" people).
- Trend: reuse % over time vs the 30% target.
- Export to PNG/PDF for the customer's own internal reporting (sales/retention asset).

### V4 — Brain Health & Bootstrapping (internal)
- `brain_from_git` yield distribution (total lessons per bootstrap; 0-yield rate →
  these are the repos the starter corpus now catches).
- Starter-seed rate + auto vs manual.
- `device_flow_failed` by `reason`; `redis_connect_failed`, `auto_provision_failed` by status.

### V5 — Marketplace (once `brain_discover` has live data)
- Top shared Brains by import count; share→import conversion. (Depends on the
  `/api/v1/brains/share` + `/discover` endpoints going live — see cachly-mcp v0.10.79.)

---

## 6. Tech stack (recommended)

| Layer | Choice | Why |
|---|---|---|
| Store | **TimescaleDB** (or ClickHouse if event volume explodes) | time-series + SQL + continuous aggregates; EU-hostable |
| Ingestion | small **Node/TS worker** | shares types with cachly-mcp; subscribes to API stream + nightly snapshot cron |
| API | **Next.js route handlers** (or Fastify) | read-only REST; colocate with UI |
| UI | **Next.js + Tremor/Recharts** | fast dashboards, server components, SSO-friendly |
| Auth | staff **SSO** (internal) + **org-admin** scoped tokens from cachly API (customer pages) |
| Deploy | same Hetzner/EU footprint as cachly (GDPR, "EU servers" promise) | data residency |
| IaC | reuse existing k8s/helm patterns from the main infra repo |

Keep `@cachly-dev/insights-types` as a tiny shared package (event names, stats key
names) imported by **both** cachly-mcp and cachly-insights, so the contract can't drift.

---

## 7. Privacy / GDPR (non-negotiable, ties to the brand promise)

- **No raw JWTs** ever leave the cachly API. Identity is resolved server-side.
- **Opt-out respected**: `CACHLY_NO_TELEMETRY=1` already suppresses emission at source.
- Handles (`author="alice"`) are user-chosen labels, not PII — but the per-org page is
  gated to that org's admins only; no cross-org handle exposure.
- **Aggregate-only retention**: keep raw `funnel_events` 90d, then roll up to dailies
  and drop raw. Dailies carry no message content — only counters + timestamps.
- Lesson *content* (`what_worked`, etc.) is **never** ingested into the dashboard.
- Data residency: EU region only, matching the cachly "German servers" promise.
- DPA / processing record entry before go-live; this feeds the SOC-2/ISO track.

---

## 8. Repo bootstrap — concrete setup steps

```
cachly-insights/
  packages/
    types/            # @cachly-dev/insights-types — shared event + stats-key contract
  apps/
    ingest/           # worker: API stream subscriber + nightly Valkey snapshot cron
    web/              # Next.js dashboard (API routes + UI)
  db/
    migrations/       # TimescaleDB schema (§4) + continuous aggregates
  deploy/             # helm chart, mirrors main infra conventions
  README.md
  .env.example        # INSIGHTS_DB_URL, CACHLY_API_INTERNAL_URL, CACHLY_API_INTERNAL_TOKEN, REGION=eu
```

**Step-by-step:**
1. `cachly-dev/cachly-insights` repo; copy lint/tsconfig/CI from cachly-mcp for consistency.
2. Extract the event catalogue (§2a) + stats keys (§2b) into `packages/types`. Add a
   matching import in cachly-mcp so the contract is enforced both ways (follow-up PR there).
3. Stand up TimescaleDB (EU); apply `db/migrations` (§4 schema + continuous aggregates).
4. **API change (in the cachly API repo, prerequisite):** add an internal authenticated
   `/internal/telemetry/stream` (resolved events) **or** push resolved events to a queue.
   Without this the dashboard cannot get org/user identity safely.
5. `apps/ingest`: (a) subscribe to the resolved stream → insert `funnel_events`;
   (b) nightly cron → `SCAN cachly:stats:*` → upsert `brain_stats_daily` (compute `ttfr_seconds`).
6. `apps/web`: build V1 (funnel) first — it's the regression alarm and needs only events.
   Then V2 (TTFR, with seeded cohort split), then V3 (per-org reuse, the customer asset).
7. Wire alerts (§5 V1) into the existing Telegram/Prometheus path.
8. Gate the per-org page behind org-admin tokens issued by the cachly API.

---

## 9. Milestones

| Phase | Deliverable | Depends on |
|---|---|---|
| **M0** | Repo skeleton + shared `types` package + DB schema | — |
| **M1** | Ingestion worker (events + nightly snapshot) writing to Timescale | API internal stream/queue |
| **M2** | **V1 Activation Funnel** + drop-off alert | M1 |
| **M3** | **V2 Time-to-first-recall** with seeded-vs-cold cohort split | M1 (snapshots) |
| **M4** | **V3 per-org Team-Knowledge-Reuse** page (customer-facing) | M1 + org-admin auth |
| **M5** | V4 health + V5 marketplace (when share/discover endpoints live) | M1; cachly-mcp shares API |

**Critical path / external blocker:** M1 depends on the **cachly API** exposing
resolved telemetry (identity-attached). That work is *not* in cachly-mcp and is the
first cross-repo task to schedule.

---

## 10. Open decisions (need a human call)

1. **Timescale vs ClickHouse** — Timescale unless we expect >50M events/day.
2. **Push vs pull for events** — does the cachly API push to a queue (Kafka/NATS/Redis
   Streams) or expose an internal pull endpoint the ingest worker polls? (Affects M1.)
3. **Per-org page surface** — embed inside the existing cachly web app, or standalone
   subdomain `insights.cachly.dev`? (Auth + branding implications.)
4. **Anonymous (no-jwt) events** — keep for funnel top-of-line, or drop entirely for
   privacy simplicity? Currently `first_call_no_jwt` is emitted without identity.
5. **Retention window** — 90d raw proposed; legal/DPA to confirm.

---

## 11. How this closes the PROGRESS.md item

PROGRESS.md §3 lists Team-Knowledge-Reuse as *"getrackt + inline + in `brain_metrics`;
externes Dashboard 🔲"*. This plan specifies that dashboard end-to-end: the data already
flows (events + `cachly:stats:*`), `brain_metrics` already proves the per-Brain view, and
`npm run bench:onboarding` already proves the time-to-first-recall mechanism offline.
The only remaining work is **aggregation + UI in a separate repo**, plus the one
**cachly API prerequisite** (resolved telemetry stream). Everything the dashboard needs
from the MCP side is shipped as of v0.10.80.
