import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  EDITOR_FILES,
  buildServerEnv,
  buildMcpConfig,
  mergeMcpConfig,
  buildClaudeMdBlock,
  CLAUDE_MD_MARKER_START,
  CLAUDE_MD_MARKER_END,
} from '../index.js';
import { writeInstructions } from '../index';
import { credentialsPath } from '../credentials.js';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Regression tests for the one-step `setup` / `autopilot` config writer.
 *
 * These functions decide what lands in the user's editor config files — the
 * single most important correctness surface for activation. A bug here means a
 * user runs setup, sees "Brain is ready", and their editor silently never loads
 * the MCP server (or — worse — their other MCP servers get clobbered).
 *
 * Pure / fs-injected functions only: no real network, Redis, or disk required.
 */

const KEY = 'cky_live_testkey123';
const IID = '11111111-2222-3333-4444-555555555555';

// mergeMcpConfig takes an injected fsOps so we can simulate any on-disk config
// without touching the real filesystem.
function fsOpsFrom(files: Record<string, string>) {
  return {
    existsSync: (p: string) => p in files,
    readFile: (p: string) => Promise.resolve(files[p] ?? ''),
  };
}

describe('EDITOR_FILES', () => {
  it('maps every supported editor to its canonical config path', () => {
    expect(EDITOR_FILES.claude).toBe('.mcp.json');
    expect(EDITOR_FILES.cursor).toBe('.cursor/mcp.json');
    expect(EDITOR_FILES.windsurf).toBe('.windsurf/mcp.json');
    expect(EDITOR_FILES.copilot).toBe('.vscode/mcp.json');
    expect(EDITOR_FILES.continue).toBe('.continue/config.json');
    expect(EDITOR_FILES.cline).toBe('.vscode/mcp.json');
    expect(EDITOR_FILES.zed).toBe('.zed/settings.json');
  });

  it('covers all editors the setup wizard can detect', () => {
    // If setup detects an editor not in this map it falls back to .mcp.json,
    // which would land in the wrong place. Keep this list in sync with detection.
    for (const e of ['claude', 'cursor', 'windsurf', 'copilot', 'continue', 'cline', 'zed']) {
      expect(EDITOR_FILES[e], `missing mapping for ${e}`).toBeTruthy();
    }
  });
});

describe('buildServerEnv', () => {
  it('GROW-033: omits the JWT by default — always writes the instance id', () => {
    const env = buildServerEnv(KEY, IID);
    expect(env.CACHLY_JWT).toBeUndefined();
    expect(env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });

  it('GROW-033: includes the JWT only when explicitly opted in (the global ~/.claude/mcp.json write)', () => {
    const env = buildServerEnv(KEY, IID, { includeApiKey: true });
    expect(env.CACHLY_JWT).toBe(KEY);
    expect(env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });

  it('omits CACHLY_API_URL for the default cloud backend (clean configs)', () => {
    // API_URL defaults to https://api.cachly.dev in a fresh process — the env
    // should not bake in a redundant URL.
    const env = buildServerEnv(KEY, IID);
    expect(env.CACHLY_API_URL).toBeUndefined();
  });
});

describe('buildMcpConfig', () => {
  it('produces standard mcpServers shape for Claude/Cursor/etc.', () => {
    const cfg = JSON.parse(buildMcpConfig(KEY, IID, 'claude'));
    expect(cfg.mcpServers.cachly.command).toBe('npx');
    expect(cfg.mcpServers.cachly.args).toEqual(['-y', '@cachly-dev/mcp-server@latest']);
    expect(cfg.mcpServers.cachly.env.CACHLY_JWT).toBeUndefined();
    expect(cfg.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });

  it('produces Continue.dev experimental shape', () => {
    const cfg = JSON.parse(buildMcpConfig(KEY, IID, 'continue'));
    const servers = cfg.experimental.modelContextProtocolServers;
    expect(Array.isArray(servers)).toBe(true);
    expect(servers[0].transport.type).toBe('stdio');
    expect(servers[0].env.CACHLY_JWT).toBeUndefined();
    expect(servers[0].env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });

  it('produces Zed context_servers shape', () => {
    const cfg = JSON.parse(buildMcpConfig(KEY, IID, 'zed'));
    expect(cfg.context_servers.cachly.command.path).toBe('npx');
    expect(cfg.context_servers.cachly.command.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });

  it('always emits valid JSON', () => {
    for (const e of ['claude', 'cursor', 'windsurf', 'copilot', 'continue', 'cline', 'zed']) {
      expect(() => JSON.parse(buildMcpConfig(KEY, IID, e)), `invalid JSON for ${e}`).not.toThrow();
    }
  });
});

describe('mergeMcpConfig', () => {
  const path = '/proj/.mcp.json';

  it('creates a fresh config when none exists — without the JWT (GROW-033)', async () => {
    const out = await mergeMcpConfig(path, KEY, IID, 'claude', fsOpsFrom({}));
    const cfg = JSON.parse(out);
    expect(cfg.mcpServers.cachly.env.CACHLY_JWT).toBeUndefined();
    expect(cfg.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });

  it('preserves OTHER MCP servers when adding cachly (the critical guarantee)', async () => {
    const existing = JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        github: { command: 'docker', args: ['run', 'ghcr.io/github/github-mcp-server'] },
      },
    });
    const out = await mergeMcpConfig(path, KEY, IID, 'claude', fsOpsFrom({ [path]: existing }));
    const cfg = JSON.parse(out);
    // cachly added…
    expect(cfg.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
    // …and the user's existing servers untouched.
    expect(cfg.mcpServers.filesystem).toBeTruthy();
    expect(cfg.mcpServers.github.command).toBe('docker');
  });

  it('replaces a stale cachly entry instead of duplicating it', async () => {
    const existing = JSON.stringify({
      mcpServers: { cachly: { command: 'npx', args: ['old'], env: { CACHLY_BRAIN_INSTANCE_ID: 'old_iid' } } },
    });
    const out = await mergeMcpConfig(path, KEY, IID, 'claude', fsOpsFrom({ [path]: existing }));
    const cfg = JSON.parse(out);
    expect(cfg.mcpServers.cachly.env.CACHLY_JWT).toBeUndefined();
    expect(cfg.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
    expect(Object.keys(cfg.mcpServers)).toEqual(['cachly']);
  });

  // GROW-033 BESTANDSSCHUTZ: a project file written before GROW-033 may still
  // carry the key in plaintext. Merging it must not just drop that key — it
  // has to land in the home credentials store first (resolveApiKey reads
  // that store), so nobody loses access when the project file goes secret-free.
  it('migrates a legacy plaintext key from an existing cachly entry to the home store, and drops it from the file', async () => {
    const heim = mkdtempSync(join(tmpdir(), 'cachly-setup-config-heim-'));
    try {
      const existing = JSON.stringify({
        mcpServers: { cachly: { command: 'npx', args: ['old'], env: { CACHLY_JWT: 'old_key', CACHLY_BRAIN_INSTANCE_ID: 'old_iid' } } },
      });
      const out = await mergeMcpConfig(path, KEY, IID, 'claude', fsOpsFrom({ [path]: existing }), { home: heim });
      const cfg = JSON.parse(out);
      expect(cfg.mcpServers.cachly.env.CACHLY_JWT).toBeUndefined();
      expect(JSON.stringify(cfg)).not.toContain('old_key');
      expect(readFileSync(credentialsPath({ home: heim }), 'utf-8')).toContain('old_key');
    } finally {
      rmSync(heim, { recursive: true, force: true });
    }
  });

  it('preserves unrelated top-level keys (e.g. editor settings)', async () => {
    const existing = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
    const out = await mergeMcpConfig(path, KEY, IID, 'cursor', fsOpsFrom({ [path]: existing }));
    const cfg = JSON.parse(out);
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.other).toBeTruthy();
  });

  it('falls back to a clean config when existing JSON is corrupt', async () => {
    const out = await mergeMcpConfig(path, KEY, IID, 'claude', fsOpsFrom({ [path]: '{ not valid json ::: ' }));
    // Must still yield a usable cachly config rather than throwing.
    const cfg = JSON.parse(out);
    expect(cfg.mcpServers.cachly.env.CACHLY_JWT).toBeUndefined();
    expect(cfg.mcpServers.cachly.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });

  it('merges Continue.dev configs without dropping other MCP servers', async () => {
    const existing = JSON.stringify({
      models: [{ title: 'gpt' }],
      experimental: {
        modelContextProtocolServers: [
          { transport: { type: 'stdio', command: 'other' }, env: { SOMETHING: '1' } },
        ],
      },
    });
    const out = await mergeMcpConfig('/proj/.continue/config.json', KEY, IID, 'continue', fsOpsFrom({ '/proj/.continue/config.json': existing }));
    const cfg = JSON.parse(out);
    expect(cfg.models).toEqual([{ title: 'gpt' }]); // unrelated config preserved
    const servers = cfg.experimental.modelContextProtocolServers;
    // the non-cachly server stays, cachly is appended, and nobody carries a JWT (GROW-033)
    expect(servers.some((s: { env?: Record<string, string> }) => s.env?.SOMETHING === '1')).toBe(true);
    expect(servers.some((s: { env?: Record<string, string> }) => s.env?.CACHLY_BRAIN_INSTANCE_ID === IID)).toBe(true);
    expect(servers.every((s: { env?: Record<string, string> }) => !s.env?.CACHLY_JWT)).toBe(true);
  });

  it('replaces an existing cachly entry in Continue.dev (no duplicates), and migrates its legacy key (GROW-033)', async () => {
    const heim = mkdtempSync(join(tmpdir(), 'cachly-setup-config-heim-'));
    try {
      const existing = JSON.stringify({
        experimental: {
          modelContextProtocolServers: [
            { transport: { type: 'stdio', command: 'npx' }, env: { CACHLY_JWT: 'old', CACHLY_BRAIN_INSTANCE_ID: 'old' } },
          ],
        },
      });
      const out = await mergeMcpConfig('/p/config.json', KEY, IID, 'continue', fsOpsFrom({ '/p/config.json': existing }), { home: heim });
      const servers = JSON.parse(out).experimental.modelContextProtocolServers;
      const cachlyServers = servers.filter((s: { env?: Record<string, string> }) => s.env?.CACHLY_BRAIN_INSTANCE_ID === IID);
      expect(cachlyServers).toHaveLength(1);
      expect(cachlyServers[0].env.CACHLY_JWT).toBeUndefined();
      expect(readFileSync(credentialsPath({ home: heim }), 'utf-8')).toContain('old');
    } finally {
      rmSync(heim, { recursive: true, force: true });
    }
  });

  it('merges Zed context_servers without touching other settings', async () => {
    const existing = JSON.stringify({ theme: 'One Dark', context_servers: { someOther: { command: { path: 'x' } } } });
    const out = await mergeMcpConfig('/p/.zed/settings.json', KEY, IID, 'zed', fsOpsFrom({ '/p/.zed/settings.json': existing }));
    const cfg = JSON.parse(out);
    expect(cfg.theme).toBe('One Dark');
    expect(cfg.context_servers.someOther).toBeTruthy();
    expect(cfg.context_servers.cachly.command.env.CACHLY_JWT).toBeUndefined();
    expect(cfg.context_servers.cachly.command.env.CACHLY_BRAIN_INSTANCE_ID).toBe(IID);
  });

  it('always emits valid JSON for every editor with a pre-existing config', async () => {
    const existing = JSON.stringify({ mcpServers: { a: { command: 'a' } } });
    for (const e of ['claude', 'cursor', 'windsurf', 'copilot', 'cline']) {
      const out = await mergeMcpConfig(path, KEY, IID, e, fsOpsFrom({ [path]: existing }));
      expect(() => JSON.parse(out), `invalid JSON for ${e}`).not.toThrow();
    }
  });
});

describe('buildClaudeMdBlock', () => {
  it('embeds the instance id and is wrapped in idempotency markers', () => {
    const block = buildClaudeMdBlock(IID);
    expect(block).toContain(IID);
    expect(block).toContain(CLAUDE_MD_MARKER_START);
    expect(block).toContain(CLAUDE_MD_MARKER_END);
  });

  it('documents the mandatory session lifecycle tools', () => {
    const block = buildClaudeMdBlock(IID);
    for (const tool of ['session_start', 'smart_recall', 'learn_from_attempts', 'session_end', 'causal_trace', 'brain_predict']) {
      expect(block, `CLAUDE.md should instruct the AI to use ${tool}`).toContain(tool);
    }
  });

  it('is stable across calls with the same instance (idempotent replacement)', () => {
    expect(buildClaudeMdBlock(IID)).toBe(buildClaudeMdBlock(IID));
  });
});

describe('writeInstructions', () => {
  const tmp = resolve(__dirname, '../../../tmp-test-instructions');
  const files = [
    'CLAUDE.md',
    'AGENTS.md',
    '.github/copilot-instructions.md',
  ];
  const instanceId = 'test-instance-123';

  beforeAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('writes the brain protocol block to all instruction files', async () => {
    const result = await writeInstructions(tmp, instanceId);
    for (const file of files) {
      const path = resolve(tmp, file);
      expect(existsSync(path)).toBe(true);
      const content = readFileSync(path, 'utf-8');
      expect(content).toContain('Cachly AI Brain');
      expect(content).toContain(instanceId);
      expect(result[path]).toMatch(/written|appended|updated/);
    }
  });
});
