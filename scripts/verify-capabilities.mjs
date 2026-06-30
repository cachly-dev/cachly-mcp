#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCapabilityDocs } from './capability-docs.mjs';
import { loadToolCatalog } from './tool-catalog.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const capabilitiesPath = join(repoRoot, 'CACHLY_CAPABILITIES.json');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const catalog = loadToolCatalog();
const toolNames = new Set(catalog.tools.map((tool) => tool.name));
const capabilities = readJson(capabilitiesPath);
const generatedDocsPath = join(repoRoot, 'docs', 'generated', 'surface-parity.md');
const failures = [];

function fail(message) {
  failures.push(message);
}

if (capabilities.source_of_truth !== 'sdk/mcp/src/tools.ts') {
  fail('source_of_truth must stay sdk/mcp/src/tools.ts');
}
if (capabilities.mcp?.total_tools !== catalog.total_tools) {
  fail(`mcp.total_tools=${capabilities.mcp?.total_tools} does not match catalog ${catalog.total_tools}`);
}

const groups = capabilities.groups ?? [];
const groupIds = new Set();
for (const group of groups) {
  if (!group.id || !group.name) fail('every group needs id and name');
  if (groupIds.has(group.id)) fail(`duplicate group id: ${group.id}`);
  groupIds.add(group.id);
  for (const tool of group.mcp_tools ?? []) {
    if (!toolNames.has(tool)) fail(`group ${group.id} references unknown MCP tool: ${tool}`);
  }
}

const surfaces = capabilities.surfaces ?? {};
for (const [surfaceId, surface] of Object.entries(surfaces)) {
  if (!surface.kind || !surface.coverage) fail(`${surfaceId}: kind and coverage are required`);
  for (const groupId of surface.supported_groups ?? []) {
    if (!groupIds.has(groupId)) fail(`${surfaceId}: unknown supported group ${groupId}`);
  }
  for (const [command, capabilityId] of Object.entries(surface.command_capabilities ?? {})) {
    if (!groupIds.has(capabilityId)) fail(`${surfaceId}: ${command} has unknown capability ${capabilityId}`);
  }
  for (const [command, capabilityId] of Object.entries(surface.chat_command_capabilities ?? {})) {
    if (!groupIds.has(capabilityId)) fail(`${surfaceId}: chat command ${command} has unknown capability ${capabilityId}`);
  }
}

const vscodePkg = readJson(join(repoRoot, 'sdk/vscode/package.json'));
const vscodeCommands = new Set((vscodePkg.contributes?.commands ?? []).map((cmd) => cmd.command));
const vscodeCapabilityCommands = vscodePkg.cachlyCapabilities?.commands ?? {};
for (const command of surfaces.vscode_extension?.commands ?? []) {
  if (!vscodeCommands.has(command)) fail(`vscode_extension: command not registered in package.json: ${command}`);
  if (!vscodeCapabilityCommands[command]) fail(`vscode_extension: command missing cachlyCapabilities mapping: ${command}`);
  if (vscodeCapabilityCommands[command] !== surfaces.vscode_extension?.command_capabilities?.[command]) {
    fail(`vscode_extension: command capability mismatch for ${command}`);
  }
}
for (const command of Object.keys(vscodeCapabilityCommands)) {
  if (!vscodeCommands.has(command)) fail(`vscode_extension: cachlyCapabilities maps unknown command: ${command}`);
  if (!groupIds.has(vscodeCapabilityCommands[command])) fail(`vscode_extension: ${command} has unknown capability ${vscodeCapabilityCommands[command]}`);
}
const vscodeChatCommands = new Set((vscodePkg.contributes?.chatParticipants?.[0]?.commands ?? []).map((cmd) => cmd.name));
const vscodeCapabilityChatCommands = vscodePkg.cachlyCapabilities?.chatCommands ?? {};
for (const command of surfaces.vscode_extension?.chat_commands ?? []) {
  if (!vscodeChatCommands.has(command)) fail(`vscode_extension: chat command not registered in package.json: ${command}`);
  if (!vscodeCapabilityChatCommands[command]) fail(`vscode_extension: chat command missing cachlyCapabilities mapping: ${command}`);
  if (vscodeCapabilityChatCommands[command] !== surfaces.vscode_extension?.chat_command_capabilities?.[command]) {
    fail(`vscode_extension: chat command capability mismatch for ${command}`);
  }
}
for (const command of Object.keys(vscodeCapabilityChatCommands)) {
  if (!vscodeChatCommands.has(command)) fail(`vscode_extension: cachlyCapabilities maps unknown chat command: ${command}`);
  if (!groupIds.has(vscodeCapabilityChatCommands[command])) fail(`vscode_extension: chat command ${command} has unknown capability ${vscodeCapabilityChatCommands[command]}`);
}

const intellijPluginXml = read('sdk/intellij/src/main/resources/META-INF/plugin.xml');
const intellijCapabilities = readJson(join(repoRoot, 'sdk/intellij/src/main/resources/cachly-capabilities.json'));
const intellijActionMatches = [...intellijPluginXml.matchAll(/<action\s+id="([^"]+)"[\s\S]*?class="([^"]+)"/g)];
const intellijActions = new Map(intellijActionMatches.map((match) => [match[1], match[2]]));
const intellijCapabilityCommands = intellijCapabilities.commands ?? {};
if (intellijCapabilities.plugin_id !== 'dev.cachly.brain') {
  fail(`intellij_extension: unexpected plugin_id ${intellijCapabilities.plugin_id}`);
}
for (const command of surfaces.intellij_extension?.commands ?? []) {
  if (!intellijActions.has(command)) fail(`intellij_extension: action not registered in plugin.xml: ${command}`);
  if (!intellijCapabilityCommands[command]) fail(`intellij_extension: action missing cachly-capabilities mapping: ${command}`);
  if (intellijCapabilityCommands[command] !== surfaces.intellij_extension?.command_capabilities?.[command]) {
    fail(`intellij_extension: action capability mismatch for ${command}`);
  }
}
for (const [command, capabilityId] of Object.entries(intellijCapabilityCommands)) {
  if (!intellijActions.has(command)) fail(`intellij_extension: cachly-capabilities maps unknown action: ${command}`);
  if (!groupIds.has(capabilityId)) fail(`intellij_extension: ${command} has unknown capability ${capabilityId}`);
}

const cliCommandFiles = [
  'sdk/cli/src/commands/brain.ts',
  'sdk/cli/src/commands/cache.ts',
  'sdk/cli/src/commands/instances.ts',
  'sdk/cli/src/commands/auth.ts',
  'sdk/cli/src/commands/init.ts',
  'sdk/cli/src/commands/benchmark.ts',
  'sdk/cli/src/commands/cost-estimate.ts',
  'sdk/cli/src/commands/migrate.ts',
  'sdk/cli/src/commands/tail.ts',
];
const cliSource = read('sdk/cli/src/index.ts') + '\n' + cliCommandFiles.map(read).join('\n');
for (const command of surfaces.cachly_cli?.commands ?? []) {
  const pattern = new RegExp(`\\bnew\\s+Command\\('${escapeRegExp(command)}'\\)|\\.command\\('${escapeRegExp(command)}(?:\\s|')`);
  if (!pattern.test(cliSource)) fail(`cachly_cli: command not found in CLI source: ${command}`);
  const expectedCapability = surfaces.cachly_cli?.command_capabilities?.[command];
  if (!expectedCapability) fail(`cachly_cli: command missing command_capabilities mapping: ${command}`);
  const annotatedPattern = new RegExp(`withCapability\\(\\s*(?:new\\s+Command\\('${escapeRegExp(command)}'\\)|[a-zA-Z]+\\.command\\('${escapeRegExp(command)}(?:\\s|'))[\\s\\S]*?,\\s*'${escapeRegExp(expectedCapability)}'`);
  if (expectedCapability && !annotatedPattern.test(cliSource)) {
    fail(`cachly_cli: command ${command} is not annotated with ${expectedCapability}`);
  }
}
for (const [command, capabilityId] of Object.entries(surfaces.cachly_cli?.command_capabilities ?? {})) {
  if (!groupIds.has(capabilityId)) fail(`cachly_cli: ${command} has unknown capability ${capabilityId}`);
}
for (const file of cliCommandFiles) {
  const lines = read(file).split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if ((line.includes('new Command(') || line.includes('.command(')) && !line.includes('withCapability(')) {
      fail(`${file}:${index + 1}: CLI command declaration missing withCapability(...)`);
    }
    if (line.includes('withCapability(')) {
      const match = line.match(/,\s*'([^']+)'\s*\)/);
      if (match && !groupIds.has(match[1])) fail(`${file}:${index + 1}: unknown CLI capability ${match[1]}`);
    }
  });
}

const openclawSource = read('sdk/openclaw/src/index.ts') + '\n' + read('sdk/openclaw/src/brain.ts');
for (const exported of surfaces.openclaw_js?.exports ?? []) {
  const pattern = new RegExp(`\\b${exported}\\b`);
  if (!pattern.test(openclawSource)) fail(`openclaw_js: export not found in source: ${exported}`);
}

const pythonSources = [
  'sdk/agents/cachly_agents/__init__.py',
  'sdk/agents/cachly_agents/brain.py',
  'sdk/agents/cachly_agents/memory.py',
  'sdk/agents/cachly_agents/semantic.py',
  'sdk/agents/cachly_agents/langchain.py',
  'sdk/agents/cachly_agents/autogen.py',
  'sdk/agents/cachly_agents/crewai.py',
].map(read).join('\n');
for (const exported of surfaces.python_agents?.exports ?? []) {
  const pattern = new RegExp(`\\b${exported}\\b`);
  if (!pattern.test(pythonSources)) fail(`python_agents: symbol not found in source: ${exported}`);
}

if (!existsSync(generatedDocsPath)) {
  fail(`generated capability docs missing: ${generatedDocsPath}`);
} else {
  const expectedDocs = renderCapabilityDocs(capabilities, catalog);
  const currentDocs = readFileSync(generatedDocsPath, 'utf8');
  if (currentDocs !== expectedDocs) {
    fail('generated capability docs are stale; run sdk/mcp npm run capability-docs:write');
  }
}

if (failures.length > 0) {
  console.error('Capability verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Capability verification passed (${groups.length} groups, ${Object.keys(surfaces).length} surfaces, ${catalog.total_tools} MCP tools).`);
