#!/usr/bin/env node
// Shown once after: npm install @cachly-dev/mcp-server

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  violet: "\x1b[35m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
};

const line = `${c.dim}─────────────────────────────────────────────────────${c.reset}`;

console.log(`
${line}
  ${c.bold}${c.violet}🧠 Cachly Brain MCP Server${c.reset} ${c.dim}v${process.env.npm_package_version ?? ""}${c.reset}

  ${c.bold}Give your AI assistant persistent memory in 30 seconds:${c.reset}

  ${c.cyan}1.${c.reset} Get a free Brain instance at ${c.bold}cachly.dev/setup-ai${c.reset}
  ${c.cyan}2.${c.reset} Add to Claude Code / Cursor / Copilot / Windsurf:
     ${c.dim}npx @cachly-dev/mcp-server@latest init${c.reset}

  ${c.green}✅ Free tier · GDPR · German servers · No credit card${c.reset}

  ${c.dim}──────────────────────────────────────────────────────${c.reset}
  ${c.yellow}📦 Related packages:${c.reset}
  ${c.cyan}@cachly-dev/openclaw${c.reset}   Cut LLM costs 60–90% in JS/TS apps
                         ${c.dim}npm install @cachly-dev/openclaw${c.reset}
  ${c.cyan}cachly${c.reset}                 CLI to manage your Brain instances
                         ${c.dim}npm install -g cachly${c.reset}

${line}`);

