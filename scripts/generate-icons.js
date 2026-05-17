#!/usr/bin/env node
/**
 * Converts SVG icon assets to PNG for Expo.
 * Run: node scripts/generate-icons.js
 * Requires: npm install -g sharp-cli  OR  npx sharp-cli
 */
const { execSync } = require('child_process');
const path = require('path');

const frontend = path.join(__dirname, '..', 'apps', 'travel-chaos-organizer', 'frontend');

const conversions = [
  { input: 'assets/icon.svg', output: 'assets/icon.png', width: 1024, height: 1024 },
  { input: 'assets/adaptive-icon.svg', output: 'assets/adaptive-icon.png', width: 1024, height: 1024 },
  { input: 'assets/icon.svg', output: 'assets/splash.png', width: 1284, height: 2778 },
  { input: 'assets/icon.svg', output: 'assets/favicon.png', width: 32, height: 32 },
];

for (const { input, output, width, height } of conversions) {
  const src = path.join(frontend, input);
  const dst = path.join(frontend, output);
  try {
    execSync(`npx sharp-cli --input "${src}" --output "${dst}" resize ${width} ${height}`, { stdio: 'inherit' });
    console.log(`✓ ${output}`);
  } catch {
    console.error(`✗ ${output} — install sharp-cli: npm i -g sharp-cli`);
  }
}
