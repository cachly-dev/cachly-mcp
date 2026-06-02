/**
 * Unit tests for the agent-framework tool-spec exporter.
 *
 * Verifies that every dialect (OpenAPI 3.1, OpenAI, Anthropic, LangChain) is
 * derived faithfully from the real TOOLS source of truth — so the wider agent
 * ecosystem can wrap cachly without hand-written glue.
 *
 * Run: npx vitest run src/__tests__/toolspecs.test.ts
 */

import { describe, it, expect } from 'vitest';
import { TOOLS } from '../tools.js';
import {
  toOpenAITools, toAnthropicTools, toLangChainTools, toOpenAPI, renderToolSpecs,
  type ToolDef,
} from '../toolspecs.js';

const tools = TOOLS as unknown as ReadonlyArray<ToolDef>;

describe('tool-spec exporter', () => {
  it('covers every MCP tool in each dialect', () => {
    expect(toOpenAITools(tools)).toHaveLength(tools.length);
    expect(toAnthropicTools(tools)).toHaveLength(tools.length);
    expect(toLangChainTools(tools)).toHaveLength(tools.length);
    expect(tools.length).toBeGreaterThanOrEqual(120);
  });

  it('OpenAI format uses {type:function, function:{name,description,parameters}}', () => {
    const t = toOpenAITools(tools)[0] as { type: string; function: { name: string; description: string; parameters: unknown } };
    expect(t.type).toBe('function');
    expect(t.function.name).toBe(tools[0].name);
    expect(t.function.description).toBe(tools[0].description);
    expect(t.function.parameters).toEqual(tools[0].inputSchema);
  });

  it('Anthropic format uses input_schema (not parameters)', () => {
    const t = toAnthropicTools(tools)[0] as Record<string, unknown>;
    expect(t.name).toBe(tools[0].name);
    expect(t).toHaveProperty('input_schema');
    expect(t).not.toHaveProperty('parameters');
  });

  it('LangChain format exposes name/description/schema', () => {
    const t = toLangChainTools(tools)[0] as Record<string, unknown>;
    expect(t.name).toBe(tools[0].name);
    expect(t).toHaveProperty('schema');
  });

  it('OpenAPI is a valid 3.1 doc with one POST path per tool', () => {
    const doc = toOpenAPI(tools, '9.9.9') as { openapi: string; paths: Record<string, { post: unknown }>; security: unknown[] };
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toHaveLength(tools.length);
    for (const t of tools) {
      const path = doc.paths[`/mcp/tools/${t.name}`] as { post: { operationId: string } };
      expect(path).toBeTruthy();
      expect(path.post.operationId).toBe(t.name);
    }
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it('OpenAPI requestBody.required reflects whether the tool has required params', () => {
    const withReq = tools.find(t => (t.inputSchema?.required?.length ?? 0) > 0)!;
    const noReq = tools.find(t => (t.inputSchema?.required?.length ?? 0) === 0)!;
    const doc = toOpenAPI(tools, '1.0.0') as { paths: Record<string, { post: { requestBody: { required: boolean } } }> };
    expect(doc.paths[`/mcp/tools/${withReq.name}`].post.requestBody.required).toBe(true);
    expect(doc.paths[`/mcp/tools/${noReq.name}`].post.requestBody.required).toBe(false);
  });

  it('renderToolSpecs emits parseable JSON for every format', () => {
    for (const fmt of ['openapi', 'openai', 'anthropic', 'langchain'] as const) {
      const out = renderToolSpecs(tools, fmt, '0.0.1');
      expect(() => JSON.parse(out)).not.toThrow();
    }
  });

  it('embeds the version into the OpenAPI info block', () => {
    const doc = JSON.parse(renderToolSpecs(tools, 'openapi', '7.7.7')) as { info: { version: string } };
    expect(doc.info.version).toBe('7.7.7');
  });
});
