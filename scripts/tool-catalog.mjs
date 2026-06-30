#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const toolsPath = resolve(here, '..', 'src', 'tools.ts');

export function loadToolCatalog() {
  const source = readFileSync(toolsPath, 'utf8');
  const tools = [];
  let category = 'Uncategorized';

  for (const line of source.split(/\r?\n/)) {
    const categoryMatch = line.match(/^\s*\/\/\s*─+\s*(.+?)\s*─+\s*$/);
    if (categoryMatch) {
      const next = categoryMatch[1].trim();
      if (next && next !== 'Tools' && !next.startsWith('Tool definitions')) {
        category = next;
      }
      continue;
    }

    const nameMatch = line.match(/\bname:\s*'([^']+)'/);
    if (nameMatch) {
      tools.push({ name: nameMatch[1], category });
    }
  }

  const names = tools.map((tool) => tool.name);
  const duplicateNames = names.filter((name, i) => names.indexOf(name) !== i);
  if (duplicateNames.length > 0) {
    throw new Error(`Duplicate MCP tool names: ${[...new Set(duplicateNames)].join(', ')}`);
  }

  const categories = tools.reduce((acc, tool) => {
    acc[tool.category] ??= [];
    acc[tool.category].push(tool.name);
    return acc;
  }, {});

  return {
    generated_from: 'sdk/mcp/src/tools.ts',
    total_tools: tools.length,
    categories,
    tools,
  };
}

export function renderMarkdown(catalog = loadToolCatalog()) {
  const lines = [
    '# Cachly MCP Tool Catalog',
    '',
    '<!-- Generated from sdk/mcp/src/tools.ts via npm run tool-catalog:markdown. -->',
    '',
    `Total tools: ${catalog.total_tools}`,
    '',
  ];

  for (const [category, names] of Object.entries(catalog.categories)) {
    lines.push(`## ${category}`, '');
    for (const name of names) lines.push(`- \`${name}\``);
    lines.push('');
  }

  return lines.join('\n');
}

function printSummary(catalog) {
  console.log(`total_tools=${catalog.total_tools}`);
  for (const [category, names] of Object.entries(catalog.categories)) {
    console.log(`${category}: ${names.length}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'summary';
  const catalog = loadToolCatalog();

  switch (command) {
    case 'count':
      console.log(String(catalog.total_tools));
      break;
    case 'json':
      console.log(JSON.stringify(catalog, null, 2));
      break;
    case 'markdown':
      console.log(renderMarkdown(catalog));
      break;
    case 'summary':
      printSummary(catalog);
      break;
    case 'root':
      console.log(repoRoot);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
