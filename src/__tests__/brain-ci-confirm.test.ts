/**
 * brain_confirm_ci — v4 Move 1: closed-loop CI self-calibration.
 *
 * Verifies:
 * - confirmed failure increases confidence
 * - false positive decreases confidence
 * - cancelled job returns early without changes
 * - missing topics throws
 * - graceful fallback when API unreachable
 * - no change when topic not in scan_topics
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

describe('brain_confirm_ci', () => {
  it('rejects invalid job_status', async () => {
    await expect(callTool('brain_confirm_ci', { job_status: 'unknown', topics: ['auth:jwt'] }, mockFetch({})))
      .rejects.toThrow(/job_status must be/);
  });

  it('rejects missing topics', async () => {
    await expect(callTool('brain_confirm_ci', { job_status: 'success', topics: [] }, mockFetch({})))
      .rejects.toThrow(/topics is required/);
  });

  it('returns early for cancelled without calling API', async () => {
    let called = false;
    const fetch = (async () => { called = true; return {}; }) as unknown as Parameters<typeof handleSyndicateTool>[3];
    const result = await callTool('brain_confirm_ci', { job_status: 'cancelled', topics: ['auth:jwt'] }, fetch);
    expect(result).toContain('cancelled');
    expect(called).toBe(false);
  });

  it('shows updated count when API returns deltas', async () => {
    const fetch = mockFetch({
      updated: 2,
      job_status: 'failure',
      confidence_deltas: [
        { topic: 'auth:jwt', old: 0.70, new: 0.85, delta: 0.15, reason: 'confirmed_failure' },
        { topic: 'deploy:k8s', old: 0.65, new: 0.80, delta: 0.15, reason: 'confirmed_failure' },
      ],
    });
    const result = await callTool('brain_confirm_ci', {
      job_status: 'failure',
      topics: ['auth:jwt', 'deploy:k8s'],
      scan_topics: ['auth:jwt', 'deploy:k8s'],
    }, fetch);
    expect(result).toContain('2 lessons');
    expect(result).toContain('auth:jwt');
    expect(result).toContain('confirmed_failure');
  });

  it('shows no changes message when updated=0', async () => {
    const fetch = mockFetch({ updated: 0, confidence_deltas: [], job_status: 'success' });
    const result = await callTool('brain_confirm_ci', {
      job_status: 'success',
      topics: ['auth:jwt'],
      scan_topics: [],
    }, fetch);
    expect(result).toContain('No confidence changes');
  });

  it('shows false_positive in table for success + scan_topics match', async () => {
    const fetch = mockFetch({
      updated: 1,
      job_status: 'success',
      confidence_deltas: [
        { topic: 'auth:jwt', old: 0.75, new: 0.65, delta: -0.10, reason: 'false_positive' },
      ],
    });
    const result = await callTool('brain_confirm_ci', {
      job_status: 'success',
      topics: ['auth:jwt'],
      scan_topics: ['auth:jwt'],
    }, fetch);
    expect(result).toContain('false_positive');
    expect(result).toContain('-10%');
  });

  it('falls back gracefully when API is unreachable', async () => {
    const result = await callTool('brain_confirm_ci', {
      job_status: 'failure',
      topics: ['auth:jwt'],
    }, failFetch());
    expect(result).toContain('Could not reach Brain API');
  });
});
