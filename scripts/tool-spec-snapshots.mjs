#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const outputDir = join(repoRoot, 'docs', 'generated', 'tool-specs');
const formats = ['openapi', 'openai', 'anthropic', 'langchain'];

function outputPath(format) {
  return join(outputDir, `cachly.${format}.json`);
}

function render(format) {
  const raw = execFileSync(
    process.execPath,
    ['--import', 'tsx', 'src/index.ts', 'tool-specs', `--format=${format}`],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    },
  );

  return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
}

function writeSnapshots() {
  mkdirSync(outputDir, { recursive: true });
  for (const format of formats) {
    const target = outputPath(format);
    writeFileSync(target, render(format), 'utf8');
    console.log(`Wrote ${target}`);
  }
}

function checkSnapshots() {
  const failures = [];
  for (const format of formats) {
    const target = outputPath(format);
    if (!existsSync(target)) {
      failures.push(`Missing ${target}`);
      continue;
    }

    const expected = render(format);
    const current = readFileSync(target, 'utf8');
    if (current !== expected) {
      failures.push(`Stale ${target}`);
    }
  }

  if (failures.length > 0) {
    console.error('Tool-spec snapshots are not current:');
    for (const failure of failures) console.error(`- ${failure}`);
    console.error('Run: npm run tool-spec-snapshots:write');
    process.exit(1);
  }

  console.log(`Tool-spec snapshots are current: ${outputDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const command = process.argv[2] ?? 'check';

  switch (command) {
    case 'write':
      writeSnapshots();
      break;
    case 'check':
      checkSnapshots();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}
