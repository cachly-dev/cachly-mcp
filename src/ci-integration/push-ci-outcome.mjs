#!/usr/bin/env node
/**
 * push-ci-outcome.mjs — standalone helper (no MCP dependency).
 *
 * Posts a CI outcome to the cachly Brain so it can self-calibrate
 * confidence on its knowledge-graph edges.
 *
 * Env vars (one of these required for auth):
 *   CACHLY_API_KEY               – cachly API key (cky_live_...), preferred: long-lived, rotatable
 *   CACHLY_JWT                   – Keycloak access token, fallback: short-lived, used if no API key is set
 *
 * Env vars (required):
 *   CACHLY_BRAIN_INSTANCE_ID    – Brain instance UUID
 *
 * Env vars (set by the workflow):
 *   JOB_NAME    – name of the CI job (used as topic)
 *   JOB_STATUS  – "success" | "failure" | "cancelled"
 *   PREV_STATUS – previous conclusion from workflow_run context (optional)
 *
 * Exit: always 0 — CI must not fail because of Brain push errors.
 */

const API_URL = process.env.CACHLY_API_URL ?? 'https://api.cachly.dev';
const API_KEY = process.env.CACHLY_API_KEY ?? '';
const JWT = process.env.CACHLY_JWT ?? '';
const AUTH_TOKEN = API_KEY || JWT;
const INSTANCE_ID = process.env.CACHLY_BRAIN_INSTANCE_ID ?? '';
const JOB_NAME = process.env.JOB_NAME ?? 'unknown';
const JOB_STATUS = (process.env.JOB_STATUS ?? 'unknown').toLowerCase();
const PREV_STATUS = (process.env.PREV_STATUS ?? '').toLowerCase();

if (!AUTH_TOKEN || !INSTANCE_ID) {
  console.warn('[cachly-ci] Missing CACHLY_API_KEY (or CACHLY_JWT fallback) or CACHLY_BRAIN_INSTANCE_ID — skipping Brain push.');
  process.exit(0);
}

const validStatuses = ['success', 'failure', 'cancelled'];
if (!validStatuses.includes(JOB_STATUS)) {
  console.warn(`[cachly-ci] Unknown JOB_STATUS="${JOB_STATUS}" — skipping.`);
  process.exit(0);
}

// Derive scan_topics: if previous run failed on this job, the Brain would
// have predicted it; send it so the backend can score the prediction.
const scanTopics = PREV_STATUS === 'failure' ? [JOB_NAME] : [];

const body = {
  job_status: JOB_STATUS,
  topics: [JOB_NAME],
  scan_topics: scanTopics,
  source: 'github_actions',
};

try {
  const url = `${API_URL}/api/v1/instances/${INSTANCE_ID}/ci-outcome`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (res.ok) {
    const data = await res.json();
    console.log(`[cachly-ci] Brain updated: ${data.updated ?? 0} confidence delta(s) for job="${JOB_NAME}" status="${JOB_STATUS}".`);
  } else {
    const text = await res.text().catch(() => '');
    console.warn(`[cachly-ci] Brain push returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
} catch (err) {
  // Network error, timeout, endpoint unavailable — log and exit cleanly.
  console.warn(`[cachly-ci] Brain push failed (non-fatal): ${err?.message ?? err}`);
}

process.exit(0);
