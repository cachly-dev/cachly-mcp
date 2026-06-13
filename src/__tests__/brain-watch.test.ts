import { describe, it, expect } from 'vitest';
import { buildBrainWatchHook, BRAIN_WATCH_HOOK_VERSION } from '../brain-watch-hook.js';

describe('buildBrainWatchHook', () => {
  it('contains the BRAIN_WATCH_HOOK_VERSION marker', () => {
    const hook = buildBrainWatchHook('inst-abc');
    expect(hook).toContain(`cachly brain_watch — Auto-Learn ${BRAIN_WATCH_HOOK_VERSION}`);
  });

  it('ends with exit 0', () => {
    const hook = buildBrainWatchHook('inst-abc');
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('embeds the instance_id in the API URL', () => {
    const hook = buildBrainWatchHook('my-instance-id');
    expect(hook).toContain('my-instance-id');
    expect(hook).toContain('https://api.cachly.dev/api/v1/instances/my-instance-id/learn');
  });

  it('embeds the apiKey as CACHLY_JWT when provided', () => {
    const hook = buildBrainWatchHook('inst-abc', 'cky_live_test123');
    expect(hook).toContain('CACHLY_JWT="cky_live_test123"');
  });
});
