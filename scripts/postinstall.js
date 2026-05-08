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

  ${c.bold}Add to Claude Code${c.reset} ${c.dim}(~/.claude/mcp.json or Settings → MCP):${c.reset}

  ${c.dim}{${c.reset}
    ${c.yellow}"mcpServers"${c.reset}: ${c.dim}{${c.reset}
      ${c.yellow}"cachly"${c.reset}: ${c.dim}{${c.reset}
        ${c.yellow}"command"${c.reset}: ${c.green}"npx"${c.reset},
        ${c.yellow}"args"${c.reset}: ${c.dim}[${c.reset}${c.green}"-y"${c.reset}, ${c.green}"@cachly-dev/mcp-server@latest"${c.reset}${c.dim}]${c.reset}
      ${c.dim}}${c.reset}
    ${c.dim}}${c.reset}
  ${c.dim}}${c.reset}

  Restart editor → call ${c.cyan}session_start${c.reset} → sign in with one click.
  ${c.green}No credentials. No credit card. Free forever.${c.reset}

  ${c.dim}Other editors: https://cachly.dev/docs/mcp${c.reset}
${line}`);
