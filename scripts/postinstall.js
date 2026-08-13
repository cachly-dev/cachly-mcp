#!/usr/bin/env node
// Shown once after: npm install @cachly-dev/mcp-server

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  violet: "\x1b[35m",
  green:  "\x1b[32m",
  cyan:   "\x1b[36m",
  dim:    "\x1b[2m",
  yellow: "\x1b[33m",
};

const line = `${c.dim}─────────────────────────────────────────────────────${c.reset}`;

console.log(`
${line}
  ${c.bold}${c.violet}🧠 cachly AI Brain${c.reset} ${c.dim}v${process.env.npm_package_version ?? ""}${c.reset}

  ${c.bold}One command sets everything up:${c.reset}

  ${c.cyan}npx @cachly-dev/mcp-server@latest autopilot${c.reset}

  Signs you in → detects your editors → writes all MCP configs
  automatically → adds Brain rules to CLAUDE.md.

  ${c.green}No credentials. No credit card. Free forever.${c.reset}
  ${c.dim}Other editors: https://cachly.dev/docs/mcp${c.reset}
${line}`);
