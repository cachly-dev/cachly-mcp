#!/usr/bin/env node
// Shown once after: npm install @cachly-dev/mcp-server

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  violet: "\x1b[35m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

const line = `${c.dim}─────────────────────────────────────────────────────${c.reset}`;

console.log(`
${line}
  ${c.bold}${c.violet}🧠 cachly AI Brain${c.reset} ${c.dim}v${process.env.npm_package_version ?? ""}${c.reset}

  ${c.bold}Give your AI persistent memory — 30 seconds:${c.reset}

  ${c.cyan}npx @cachly-dev/mcp-server@latest setup${c.reset}

  Signs you in · detects your editors · writes the config.
  ${c.green}Free tier · GDPR · German servers · No credit card${c.reset}

${line}`);
