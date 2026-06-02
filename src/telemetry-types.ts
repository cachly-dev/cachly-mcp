/**
 * Canonical types for the cachly telemetry event stream.
 *
 * These types form the contract between:
 *   - cachly-mcp  (emitter)  →  POST /api/v1/telemetry/mcp
 *   - cachly API  (receiver) →  resolves api_key → {org_id, user_id}, queues enriched event
 *   - cachly-insights ingest (consumer) ← reads enriched events from the resolved queue
 *
 * The ingest worker MUST NOT see raw JWTs or api_keys.  Resolution happens
 * exclusively inside the cachly API trust boundary before events reach the queue.
 */

// ── Funnel event names ──────────────────────────────────────────────────────

export type FunnelEventName =
  // Auth lifecycle
  | 'device_flow_started'
  | 'device_flow_completed'
  | 'device_flow_failed'
  | 'auth_self_healed'
  | 'm2m_auth_completed'
  | 'm2m_auth_failed'
  | 'setup_started'
  | 'setup_auth_started'
  | 'setup_auth_completed'
  | 'setup_instance_ready'
  | 'setup_completed'
  | 'first_call_success'
  // Brain core
  | 'session_start'
  | 'session_end'
  | 'recall_best_solution'
  | 'learn_from_attempts'
  | 'smart_recall'
  | 'brain_from_git'
  | 'brain_predict'
  | 'brain_predict_failures'
  | 'brain_seed_starter'
  // Monetization
  | 'premium_gate_hit'
  // Open-ended for future extension
  | (string & Record<never, never>);

// ── Metrics blocks (structured, dashboard-queryable) ───────────────────────

export interface SessionStartMetrics {
  recalls_total?: number;
  born_at?: string;
  time_saved_mins?: number;
  starter_seeded?: boolean;
}

export interface SmartRecallMetrics {
  hit: boolean;
  topic?: string;
  latency_ms?: number;
  cross_author?: boolean;
}

export interface BrainFromGitMetrics {
  fixes: number;
  features: number;
  refactors: number;
  total: number;
}

export interface BrainSeedStarterMetrics {
  seeded_count: number;
  auto: boolean;
}

export type DashboardMetrics =
  | SessionStartMetrics
  | SmartRecallMetrics
  | BrainFromGitMetrics
  | BrainSeedStarterMetrics
  | Record<string, unknown>;

// ── Wire format (emitted by cachly-mcp) ───────────────────────────────────

/**
 * Raw event payload sent to /api/v1/telemetry/mcp.
 * Fields are stripped / resolved by the cachly API before the event reaches
 * the dashboard ingest queue — consumers will never see api_key or jwt.
 */
export interface TelemetryEventRaw {
  event: FunnelEventName;
  ts: string;                          // ISO-8601
  instance_id?: string;
  /** Long-lived API key or Keycloak access token. Server resolves → {org_id, user_id}. */
  api_key?: string;
  /** Anonymous JWT sub fingerprint — SHA-256 first 16 hex chars, no PII. */
  user_fingerprint?: string;
  /** Structured metrics block — typed per event, queryable without JSON path surgery. */
  metrics?: DashboardMetrics;
  [extra: string]: unknown;
}

// ── Resolved event format (written to ingest queue by cachly API) ──────────

/**
 * Identity-resolved event. This is what the cachly-insights ingest worker
 * consumes from the resolved queue (Redis Stream / Postgres notify channel).
 * The `api_key` field is absent — it never crosses the API trust boundary.
 */
export interface TelemetryEventResolved {
  event: FunnelEventName;
  ts: string;
  instance_id: string;
  org_id: string;
  user_id: string;
  metrics?: DashboardMetrics;
  [extra: string]: unknown;
}

// ── Internal API contract for the resolved-stream endpoint ─────────────────

/**
 * cachly API must expose this endpoint for the ingest worker:
 *
 *   GET /internal/telemetry/stream?since=<cursor>&limit=<n>
 *   Authorization: Bearer <SERVICE_ACCOUNT_TOKEN>
 *
 * Returns:
 *   { events: TelemetryEventResolved[]; next_cursor: string }
 *
 * Implementation notes for the cachly API team:
 *   1. Accept raw events at POST /api/v1/telemetry/mcp (existing, unchanged)
 *   2. Resolve api_key → {org_id, user_id} via Keycloak introspect or local DB lookup
 *   3. Strip api_key, write TelemetryEventResolved to a Redis Stream
 *      (key: cachly:telemetry:resolved, MAXLEN ~1M)
 *   4. Expose GET /internal/telemetry/stream as an XREAD wrapper with cursor pagination
 *   5. NEVER write api_key or jwt into the resolved stream
 */
export type InternalTelemetryStreamResponse = {
  events: TelemetryEventResolved[];
  next_cursor: string;
};
