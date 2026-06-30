#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolCatalog } from './tool-catalog.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const capabilitiesPath = join(repoRoot, 'CACHLY_CAPABILITIES.json');
const outputPath = join(repoRoot, 'docs', 'generated', 'surface-parity.md');
const surfaceLabels = {
  mcp_server: 'MCP server',
  tool_spec_export: 'Tool-spec export',
  web_docs_marketing: 'Web docs / marketing',
  cachly_cli: 'Cachly CLI',
  vscode_extension: 'VS Code extension',
  openclaw_js: 'OpenClaw JS',
  python_agents: 'Python agents',
  intellij_extension: 'IntelliJ extension',
};

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function label(value) {
  return surfaceLabels[value] ?? value
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function codeList(values = []) {
  if (values.length === 0) return 'None';
  return values.map((value) => `\`${value}\``).join(', ');
}

function groupNameById(groups) {
  return new Map(groups.map((group) => [group.id, group.name]));
}

function groupList(groupIds = [], groupsById) {
  if (groupIds.length === 0) return 'None';
  return groupIds.map((id) => `${groupsById.get(id) ?? id} (\`${id}\`)`).join('<br>');
}

function surfaceDetail(surface) {
  const lines = [];

  if (surface.commands?.length) {
    lines.push(`Commands: ${codeList(surface.commands)}`);
  }
  if (surface.chat_commands?.length) {
    lines.push(`Chat commands: ${codeList(surface.chat_commands)}`);
  }
  if (surface.exports?.length) {
    lines.push(`Exports: ${codeList(surface.exports)}`);
  }
  if (surface.source_files?.length) {
    lines.push(`Sources: ${codeList(surface.source_files)}`);
  }

  return lines.length ? lines.join('<br>') : 'None';
}

export function renderCapabilityDocs(capabilities = readJson(capabilitiesPath), catalog = loadToolCatalog()) {
  const groups = capabilities.groups ?? [];
  const surfaces = capabilities.surfaces ?? {};
  const groupsById = groupNameById(groups);
  const lines = [
    '# Cachly Surface Parity',
    '',
    '<!-- Generated from CACHLY_CAPABILITIES.json via npm run capability-docs:write. -->',
    '',
    `Last updated: ${capabilities.last_updated}`,
    '',
    `MCP source of truth: \`${capabilities.source_of_truth}\``,
    '',
    `Current MCP catalog: ${catalog.total_tools} tools across ${Object.keys(catalog.categories).length} generated categories.`,
    '',
    'This document separates product capabilities from delivery surfaces. Not every SDK, editor plugin, or CLI command should expose all MCP tools; each surface below declares the subset it supports.',
    '',
    '## Capability Groups',
    '',
    '| Capability | ID | MCP tool examples | Description |',
    '|------------|----|-------------------|-------------|',
  ];

  for (const group of groups) {
    lines.push(`| ${group.name} | \`${group.id}\` | ${codeList(group.mcp_tools)} | ${group.description} |`);
  }

  lines.push(
    '',
    '## Surface Coverage',
    '',
    '| Surface | Kind | Coverage | Supported capabilities | Surface details |',
    '|---------|------|----------|------------------------|-----------------|',
  );

  for (const [surfaceId, surface] of Object.entries(surfaces)) {
    lines.push(
      `| ${label(surfaceId)} | \`${surface.kind}\` | \`${surface.coverage}\` | ${groupList(surface.supported_groups, groupsById)} | ${surfaceDetail(surface)} |`,
    );
  }

  lines.push('', '## Command Capability Maps', '');

  for (const [surfaceId, surface] of Object.entries(surfaces)) {
    const commandEntries = Object.entries(surface.command_capabilities ?? {});
    const chatEntries = Object.entries(surface.chat_command_capabilities ?? {});
    if (commandEntries.length === 0 && chatEntries.length === 0) continue;

    lines.push(`### ${label(surfaceId)}`, '');

    if (commandEntries.length > 0) {
      lines.push('| Command | Capability |', '|---------|------------|');
      for (const [command, capabilityId] of commandEntries) {
        lines.push(`| \`${command}\` | ${groupsById.get(capabilityId) ?? capabilityId} (\`${capabilityId}\`) |`);
      }
      lines.push('');
    }

    if (chatEntries.length > 0) {
      lines.push('| Chat command | Capability |', '|--------------|------------|');
      for (const [command, capabilityId] of chatEntries) {
        lines.push(`| \`${command}\` | ${groupsById.get(capabilityId) ?? capabilityId} (\`${capabilityId}\`) |`);
      }
      lines.push('');
    }
  }

  lines.push('## Next Machine-Readable Step', '', capabilities.next_machine_readable_step ?? 'None', '');

  return lines.join('\n');
}

function writeDocs(markdown) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, markdown, 'utf8');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'markdown';
  const markdown = renderCapabilityDocs();

  switch (command) {
    case 'markdown':
      console.log(markdown);
      break;
    case 'write':
      writeDocs(markdown);
      console.log(`Wrote ${outputPath}`);
      break;
    case 'check': {
      if (!existsSync(outputPath)) {
        console.error(`Missing generated capability docs: ${outputPath}`);
        process.exit(1);
      }
      const current = readFileSync(outputPath, 'utf8');
      if (current !== markdown) {
        console.error(`Generated capability docs are stale: ${outputPath}`);
        console.error('Run: npm run capability-docs:write');
        process.exit(1);
      }
      console.log(`Generated capability docs are current: ${outputPath}`);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
