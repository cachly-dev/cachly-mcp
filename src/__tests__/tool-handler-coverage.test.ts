/**
 * Guard: every tool declared in TOOLS must have a real handler.
 *
 * tools.ts is the advertised surface — the source of truth for what a
 * client sees. A name can live there without ever reaching working code if
 * no delegated handler and no explicit switch case claims it; the caller
 * then falls into the default branch. This test closes that gap by
 * cross-checking TOOLS against every exported *_TOOL_NAMES set plus the
 * names handled directly in the index.ts switch statement.
 *
 * Run: npx vitest run src/__tests__/tool-handler-coverage.test.ts
 */

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../tools.js';
import { ADVANCED_TOOL_NAMES } from '../handlers/advanced.js';
import { BRAIN_TOOL_NAMES } from '../handlers/brain.js';
import { CACHE_TOOL_NAMES } from '../handlers/cache.js';
import { CONTEXT_TOOL_NAMES } from '../handlers/context.js';
import { FEDBRAIN_TOOL_NAMES } from '../handlers/fedbrain.js';
import { INSTANCE_TOOL_NAMES } from '../handlers/instances.js';
import { ROADMAP_TOOL_NAMES } from '../handlers/roadmap.js';
import { SHARE_TOOL_NAMES } from '../handlers/share.js';
import { SYNDICATE_TOOL_NAMES } from '../handlers/syndicate.js';
import { TEAM_TOOL_NAMES } from '../handlers/team.js';
import { VIZ_TOOL_NAMES } from '../handlers/viz.js';

/**
 * Tool names resolved by an explicit `case` in the index.ts switch, outside
 * the eleven delegated *_TOOL_NAMES sets above.
 */
const SWITCH_CASE_TOOL_NAMES = new Set(['get_api_status']);

const HANDLED_TOOL_NAMES = new Set<string>([
  ...ADVANCED_TOOL_NAMES,
  ...BRAIN_TOOL_NAMES,
  ...CACHE_TOOL_NAMES,
  ...CONTEXT_TOOL_NAMES,
  ...FEDBRAIN_TOOL_NAMES,
  ...INSTANCE_TOOL_NAMES,
  ...ROADMAP_TOOL_NAMES,
  ...SHARE_TOOL_NAMES,
  ...SYNDICATE_TOOL_NAMES,
  ...TEAM_TOOL_NAMES,
  ...VIZ_TOOL_NAMES,
  ...SWITCH_CASE_TOOL_NAMES,
]);

describe('tool handler coverage', () => {
  it('every tool declared in TOOLS resolves to a real handler', () => {
    const uncovered = TOOLS
      .map((tool) => tool.name)
      .filter((toolName) => !HANDLED_TOOL_NAMES.has(toolName));
    expect(uncovered).toEqual([]);
  });
});
