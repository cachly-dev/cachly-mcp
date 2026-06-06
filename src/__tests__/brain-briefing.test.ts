/**
 * brain_briefing — v4 Move 2: proactive briefing.
 *
 * Verifies:
 * - rejects invalid event_type
 * - rejects empty context
 * - shows "no risk" message when no warnings returned
 * - renders ranked warning table with risk level
 * - graceful fallback when API unreachable
 */

import { describe, it, expect } from 'vitest';
import { handleSyndicateTool } from '../handlers/syndicate.js';

const INSTANCE = 'test-instance';

function makeConn() {
  return (async (_id: string) => ({})) as unknown as Parameters<typeof handleSyndicateTool>[2];
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  apiFetch: Parameters<typeof handleSyndicateTool>[3],
) {
  return handleSyndicateTool(name, { instance_id: INSTANCE, ...args }, makeConn(), apiFetch);
}

function mockFetch(response: unknown) {
  return (async () => response) as unknown as Parameters<typeof handleSyndicateTool>[3];
}

function failFetch() {
  return (async () => { throw new Error('API down'); }) as unknown as Parameters<typeof handleSyndicateTool>[3];
}

describe('brain_briefing', () => {
  it('rejects invalid event_type', async () => {
    await expect(callTool('brain_briefing', { event_type: 'on_save', context: 'auth.ts' }, mockFetch({})))
      .rejects.toThrow(/event_type must be/);
  });

  it('rejects empty context', async () => {
    await expect(callTool('brain_briefing', { event_type: 'file_open', context: '   ' }, mockFetch({})))
      .rejects.toThrow(/context is required/);
  });

  it('shows no-risk message when no warnings match', async () => {
    const fetch = mockFetch({ event_type: 'file_open', risk_level: 'low', warnings: [], matched_lessons: 3 });
    const result = await callTool('brain_briefing', { event_type: 'file_open', context: 'src/auth/login.ts' }, fetch);
    expect(result).toContain('no known risk patterns matched');
    expect(result).toContain('3 related lessons');
  });

  it('renders ranked warning table with risk level', async () => {
    const fetch = mockFetch({
      event_type: 'pr_open',
      risk_level: 'high',
      matched_lessons: 4,
      warnings: [
        { topic: 'auth:jwt', confidence: 0.85, severity: 'critical', message: 'JWT refresh race condition', fix: 'Lock token refresh with a mutex' },
        { topic: 'deploy:k8s', confidence: 0.62, severity: 'major', message: 'Readiness probe too aggressive', fix: 'Increase failureThreshold to 10' },
      ],
    });
    const result = await callTool('brain_briefing', { event_type: 'pr_open', context: 'Refactor auth + deploy pipeline' }, fetch);
    expect(result).toContain('risk: HIGH');
    expect(result).toContain('auth:jwt');
    expect(result).toContain('85%');
    expect(result).toContain('Lock token refresh with a mutex');
  });

  it('passes threshold through to the API when provided', async () => {
    let capturedBody: string | undefined;
    const fetch = (async (_path: string, opts?: RequestInit) => {
      capturedBody = opts?.body as string;
      return { event_type: 'deploy', risk_level: 'low', warnings: [], matched_lessons: 0 };
    }) as unknown as Parameters<typeof handleSyndicateTool>[3];

    await callTool('brain_briefing', { event_type: 'deploy', context: 'Deploy v2.4 to production', threshold: 0.8 }, fetch);
    expect(capturedBody).toBeDefined();
    expect(JSON.parse(capturedBody as string)).toMatchObject({ event_type: 'deploy', threshold: 0.8 });
  });

  it('falls back gracefully when API is unreachable', async () => {
    const result = await callTool('brain_briefing', { event_type: 'file_open', context: 'src/db/migrate.go' }, failFetch());
    expect(result).toContain('Could not reach Brain API');
  });
});
