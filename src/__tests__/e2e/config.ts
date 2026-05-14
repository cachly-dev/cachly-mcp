/**
 * E2E test configuration — read from environment variables.
 *
 * Required for full e2e run:
 *   E2E_API_URL       Base URL of the API server  (default: https://api.cachly.dev)
 *   E2E_JWT           Valid Keycloak JWT for a test user
 *   E2E_INSTANCE_ID   ID of a pre-provisioned (active) Brain instance
 *   E2E_API_KEY       Redis password for the test instance
 *   E2E_REDIS_HOST    Redis host for the test instance
 *   E2E_REDIS_PORT    Redis port                  (default: 6380)
 *   E2E_REDIS_TLS     "true" if TLS is required   (default: true)
 *
 * Optional:
 *   E2E_SKIP_SLOW     "true" to skip provisioning + device-flow tests
 */

export const cfg = {
  apiUrl:     process.env.E2E_API_URL     ?? 'https://api.cachly.dev',
  jwt:        process.env.E2E_JWT         ?? '',
  instanceId: process.env.E2E_INSTANCE_ID ?? '',
  apiKey:     process.env.E2E_API_KEY     ?? '',
  redisHost:  process.env.E2E_REDIS_HOST  ?? '',
  redisPort:  Number(process.env.E2E_REDIS_PORT ?? '6380'),
  redisTls:   (process.env.E2E_REDIS_TLS ?? 'true') !== 'false',
  skipSlow:   process.env.E2E_SKIP_SLOW   === 'true',
};

export function requireAuth() {
  if (!cfg.jwt)        throw new Error('E2E_JWT is required — run: export E2E_JWT=<your-token>');
  if (!cfg.instanceId) throw new Error('E2E_INSTANCE_ID is required');
}

export function requireRedis() {
  requireAuth();
  if (!cfg.apiKey)    throw new Error('E2E_API_KEY is required');
  if (!cfg.redisHost) throw new Error('E2E_REDIS_HOST is required');
}

export async function apiGet(path: string, jwt = cfg.jwt) {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

export async function apiPost(path: string, body: unknown, jwt = cfg.jwt) {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
