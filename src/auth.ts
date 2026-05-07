import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export function jwtExpiryMs(token: string): number | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    ) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function checkJwt(jwt: string): void {
  if (!jwt) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      'CACHLY_JWT env var not set.\n\nGet your token at https://cachly.dev/setup-ai and add it to your MCP config:\n  CACHLY_JWT=<your-token>',
    );
  }
  const expMs = jwtExpiryMs(jwt);
  if (expMs !== null && expMs < Date.now()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `CACHLY_JWT expired at ${new Date(expMs).toISOString()}.\n\nGet a fresh token at https://cachly.dev/setup-ai and update CACHLY_JWT in your MCP config.`,
    );
  }
}

export function handleApiError(status: number, detail: string): never {
  if (status === 401) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Authentication failed (401): ${detail}\n\nYour CACHLY_JWT may be expired or invalid. Get a fresh token at https://cachly.dev/setup-ai`,
    );
  }
  if (status === 403) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Access denied (403): ${detail}\n\nCheck that your CACHLY_JWT belongs to an account with access to this resource.`,
    );
  }
  throw new McpError(ErrorCode.InternalError, `cachly API error ${status}: ${detail}`);
}
