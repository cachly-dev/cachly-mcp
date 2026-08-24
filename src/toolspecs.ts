/**
 * Agent-framework tool-spec exporter.
 *
 * cachly exposes 123 MCP tools. MCP-native clients (Claude Code, Cursor,
 * Windsurf, Copilot) speak MCP directly. But the wider agent ecosystem —
 * OpenAI Assistants / function calling, the Anthropic Messages API, LangChain,
 * CrewAI, AutoGen — each want the SAME tool definitions in their own dialect.
 *
 * Rather than hand-maintain four copies, we derive every dialect from the single
 * TOOLS source of truth. Zero new runtime dependencies: these are just shape
 * transforms over the JSON-Schema input schemas the tools already declare.
 *
 * CLI:  npx @cachly-dev/mcp-server tool-specs --format=openapi|openai|anthropic|langchain
 */

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
};

export type SpecFormat = 'openapi' | 'openai' | 'anthropic' | 'langchain';

const SERVER_TITLE = 'cachly AI Brain — MCP tools';

/** OpenAI function-calling / Assistants tool array. */
export function toOpenAITools(tools: ReadonlyArray<ToolDef>): unknown[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

/** Anthropic Messages API tool array (input_schema, not parameters). */
export function toAnthropicTools(tools: ReadonlyArray<ToolDef>): unknown[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}

/**
 * LangChain / CrewAI StructuredTool descriptors. LangChain consumes a name +
 * description + JSON-schema args; this shape is accepted by
 * `convertToOpenAITool`-style helpers and by CrewAI's tool adapters.
 */
export function toLangChainTools(tools: ReadonlyArray<ToolDef>): unknown[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    schema: t.inputSchema ?? { type: 'object', properties: {} },
  }));
}

/**
 * OpenAPI 3.1 document. Each MCP tool becomes a POST operation under
 * /mcp/tools/{name}, with the tool's input schema as the request body. This lets
 * any OpenAPI-driven agent (OpenAI Assistants "from OpenAPI", Postman, codegen)
 * wrap cachly automatically. The operation maps 1:1 onto an MCP tools/call.
 */
export function toOpenAPI(tools: ReadonlyArray<ToolDef>, version: string, serverUrl = 'https://api.cachly.dev'): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const t of tools) {
    paths[`/mcp/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.description.split('. ')[0],
        description: t.description,
        requestBody: {
          required: (t.inputSchema?.required?.length ?? 0) > 0,
          content: {
            'application/json': {
              schema: t.inputSchema ?? { type: 'object', properties: {} },
            },
          },
        },
        responses: {
          '200': {
            description: 'Tool result (MCP content blocks).',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    content: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { type: { type: 'string' }, text: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: SERVER_TITLE,
      version,
      description:
        'OpenAPI projection of the cachly MCP tool surface. Each path maps 1:1 onto an MCP ' +
        'tools/call. Authenticate with a bearer token (CACHLY_JWT, a cky_ API key, or an ' +
        'OAuth2 client_credentials access token).',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}

/** Render the requested format as a pretty-printed JSON string. */
export function renderToolSpecs(tools: ReadonlyArray<ToolDef>, format: SpecFormat, version: string): string {
  switch (format) {
    case 'openapi':   return JSON.stringify(toOpenAPI(tools, version), null, 2);
    case 'openai':    return JSON.stringify({ tools: toOpenAITools(tools) }, null, 2);
    case 'anthropic': return JSON.stringify({ tools: toAnthropicTools(tools) }, null, 2);
    case 'langchain': return JSON.stringify({ tools: toLangChainTools(tools) }, null, 2);
  }
}
