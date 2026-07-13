import { describe, it, expect } from 'vitest';
import { detectEditor } from '../editor.js';

describe('detectEditor', () => {
  it('detects Claude Code via either signal', () => {
    expect(detectEditor({ CLAUDE_CODE_ENTRYPOINT: 'cli' })).toBe('claude');
    expect(detectEditor({ CLAUDECODE: '1' })).toBe('claude');
  });

  it('detects VS Code forks before the generic vscode fallback', () => {
    // Cursor/Windsurf also set TERM_PROGRAM=vscode — the fork-specific signal wins.
    expect(detectEditor({ CURSOR_TRACE_ID: 'x', TERM_PROGRAM: 'vscode' })).toBe('cursor');
    expect(detectEditor({ WINDSURF_SESSION_ID: 'x', TERM_PROGRAM: 'vscode' })).toBe('windsurf');
    expect(detectEditor({ TERM_PROGRAM: 'cursor' })).toBe('cursor');
    expect(detectEditor({ TERM_PROGRAM: 'windsurf' })).toBe('windsurf');
  });

  it('detects Copilot agent', () => {
    expect(detectEditor({ GITHUB_COPILOT_WORKSPACE: '/w' })).toBe('copilot');
    expect(detectEditor({ COPILOT_AGENT_ID: 'abc' })).toBe('copilot');
  });

  it('detects Zed', () => {
    expect(detectEditor({ TERM_PROGRAM: 'zed' })).toBe('zed');
    expect(detectEditor({ ZED_TERM: 'true' })).toBe('zed');
  });

  it('detects JetBrains IDEs', () => {
    expect(detectEditor({ TERMINAL_EMULATOR: 'JetBrains-JediTerm' })).toBe('jetbrains');
    expect(detectEditor({ __INTELLIJ_COMMAND_HISTFILE__: '/h' })).toBe('jetbrains');
    expect(detectEditor({ IDEA_INITIAL_DIRECTORY: '/p' })).toBe('jetbrains');
  });

  it('detects VS Code — integrated terminal AND native MCP stdio child (the 345-unknown gap)', () => {
    expect(detectEditor({ TERM_PROGRAM: 'vscode' })).toBe('vscode');
    // Native MCP child has no terminal, but the IPC handshake vars are present.
    expect(detectEditor({ VSCODE_PID: '123' })).toBe('vscode');
    expect(detectEditor({ VSCODE_IPC_HOOK_CLI: '/tmp/sock' })).toBe('vscode');
    expect(detectEditor({ VSCODE_GIT_IPC_HANDLE: '/tmp/git' })).toBe('vscode');
    // macOS launch bundle id.
    expect(detectEditor({ __CFBundleIdentifier: 'com.microsoft.VSCode' })).toBe('vscode');
    expect(detectEditor({ __CFBundleIdentifier: 'com.microsoft.VSCodeInsiders' })).toBe('vscode');
  });

  it('falls back to unknown only when nothing matches', () => {
    expect(detectEditor({})).toBe('unknown');
    expect(detectEditor({ TERM_PROGRAM: 'iTerm.app' })).toBe('unknown');
    expect(detectEditor({ HOME: '/home/x', PATH: '/usr/bin' })).toBe('unknown');
  });

  it('treats empty-string env vars as absent (no false positives)', () => {
    expect(detectEditor({ CLAUDE_CODE_ENTRYPOINT: '', VSCODE_PID: '' })).toBe('unknown');
    expect(detectEditor({ CLAUDECODE: '0' })).toBe('unknown');
  });

  it('priority: Claude Code wins even when launched from within a VS Code terminal', () => {
    expect(detectEditor({ CLAUDE_CODE_ENTRYPOINT: 'cli', TERM_PROGRAM: 'vscode' })).toBe('claude');
  });
});
