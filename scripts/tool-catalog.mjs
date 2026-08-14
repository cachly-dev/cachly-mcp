#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const toolsPath = resolve(here, '..', 'src', 'tools.ts');

/**
 * Setzt eine TS-Zeichenkette aus ihren Teilen zusammen.
 *
 * Die Beschreibungen in tools.ts sind ueber mehrere Zeilen mit `+` verkettet.
 * Hier interessiert nur der Text, nicht die Syntax — also alle einfach
 * gequoteten Literale einsammeln und aneinanderhaengen.
 */
function joinStringLiterals(chunk) {
  const parts = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = re.exec(chunk)) !== null) {
    parts.push(match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Liest die Pflichtfelder eines Werkzeugs aus seinem inputSchema.
 *
 * Ein Werkzeug kann mehrere `required:`-Listen haben, wenn ein Feld selbst ein
 * Objekt ist. Die oberste Liste ist die mit der geringsten Einrueckung — die
 * gilt fuer den Aufruf selbst.
 */
function extractRequiredArgs(block) {
  const re = /^([ \t]*)required:\s*\[([^\]]*)\]/gm;
  let best = null;
  let match;
  while ((match = re.exec(block)) !== null) {
    const indent = match[1].length;
    if (best === null || indent < best.indent) best = { indent, body: match[2] };
  }
  if (!best) return [];
  return [...best.body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

export function loadToolCatalog() {
  const source = readFileSync(toolsPath, 'utf8');

  // Abschnitts-Ueberschriften mit ihrer Position im Text merken, damit jedes
  // Werkzeug spaeter der Ueberschrift zugeordnet werden kann, die ueber ihm steht.
  const categoryMarks = [];
  {
    const re = /^[ \t]*\/\/[ \t]*─+[ \t]*(.+?)[ \t]*─+[ \t]*$/gm;
    let match;
    while ((match = re.exec(source)) !== null) {
      const label = match[1].trim();
      if (!label || label === 'Tools' || label.startsWith('Tool definitions')) continue;
      categoryMarks.push({ offset: match.index, category: label });
    }
  }
  const categoryAt = (offset) => {
    let category = 'Uncategorized';
    for (const mark of categoryMarks) {
      if (mark.offset > offset) break;
      category = mark.category;
    }
    return category;
  };

  // Werkzeug-Grenzen: jeder `name: '...'`-Treffer beginnt einen Block, der bis
  // zum naechsten Treffer reicht. Felder innerhalb von inputSchema heissen
  // `name: {` und werden davon nicht erfasst.
  const hits = [...source.matchAll(/\bname:\s*'([^']+)'/g)];
  const tools = hits.map((hit, i) => {
    const start = hit.index;
    const end = i + 1 < hits.length ? hits[i + 1].index : source.length;
    const block = source.slice(start, end);

    const descStart = block.indexOf('description:');
    const schemaStart = block.indexOf('inputSchema:');
    const descChunk =
      descStart === -1
        ? ''
        : block.slice(descStart + 'description:'.length, schemaStart === -1 ? undefined : schemaStart);

    return {
      name: hit[1],
      category: categoryAt(start),
      description: joinStringLiterals(descChunk),
      args: extractRequiredArgs(schemaStart === -1 ? '' : block.slice(schemaStart)),
    };
  });

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
