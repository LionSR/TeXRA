// Standard library imports
import { strict as assert } from 'assert';

// Third-party imports
import { z } from 'zod';

// Local imports - test
import {
  toGoogleTools,
  toOpenAITools,
  toOpenAIResponseTools,
} from '@agent/modelHandlers/toolConversion';

// Type imports
import type { ToolDefinition } from '@model';
import type { Tool as GeminiTool } from '@google/genai';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { FunctionTool } from 'openai/resources/responses/responses';

type OpenAIFunctionTool = Extract<ChatCompletionTool, { type: 'function' }>;

describe('toOpenAITools', () => {
  it('leaves Chat Completions function tools non-strict', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'delegate_workflow',
        description: 'Delegate workflow',
        parameters: {
          type: 'object',
          properties: { instruction: { type: 'string' } },
          required: ['instruction'],
          additionalProperties: false,
        },
      },
    ];

    const tools = toOpenAITools(defs);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'function');
    assert.equal(tools[0].function.name, 'delegate_workflow');
    assert.equal(tools[0].function.strict, undefined);
  });

  it('normalizes object-union zod schemas for OpenAI function tools', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'inquiry',
        description: 'Ask or read',
        zodSchema: z.discriminatedUnion('command', [
          z.object({
            command: z.literal('ask'),
            question: z.string(),
          }),
          z.object({
            command: z.literal('read'),
            thread_id: z.string(),
          }),
        ]),
      },
    ];

    const tools = toOpenAITools(defs);
    const tool = tools[0] as OpenAIFunctionTool;
    const parameters = tool.function.parameters as Record<string, unknown>;
    assert.equal(parameters.type, 'object');
    assert.equal(parameters.oneOf, undefined);
    assert.equal(parameters.anyOf, undefined);
    assert.equal(parameters.allOf, undefined);

    const properties = parameters.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(properties.command.enum, ['ask', 'read']);
    assert.ok(properties.question);
    assert.ok(properties.thread_id);
    assert.deepEqual(parameters.required, ['command']);
  });
});

describe('toOpenAIResponseTools', () => {
  it('converts tool definitions to Response API format', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'echo',
        description: 'Echo value',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
      },
    ];

    const tools = toOpenAIResponseTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as FunctionTool;
    assert.equal(tool.type, 'function');
    assert.equal(tool.name, 'echo');
    assert.deepEqual(tool.parameters, defs[0].parameters);
  });

  it('uses an empty object schema when parameters are omitted', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'noop',
        description: 'no params',
      },
    ];

    const tools = toOpenAIResponseTools(defs);
    const tool = tools[0] as FunctionTool;
    assert.deepEqual(tool.parameters, {
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('converts web_search to native WebSearchTool when supportsNativeWebSearch is true', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    const tools = toOpenAIResponseTools(defs, {
      supportsNativeWebSearch: true,
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'web_search');
  });

  it('keeps web_search as function tool when supportsNativeWebSearch is false', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    const tools = toOpenAIResponseTools(defs, {
      supportsNativeWebSearch: false,
    });
    assert.equal(tools.length, 1);
    const tool = tools[0] as FunctionTool;
    assert.equal(tool.type, 'function');
    assert.equal(tool.name, 'web_search');
  });

  it('defaults supportsNativeWebSearch to false', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    // No options passed - should default to function tool
    const tools = toOpenAIResponseTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as FunctionTool;
    assert.equal(tool.type, 'function');
    assert.equal(tool.name, 'web_search');
  });

  it('filters out function tools when supportsFunctionCalling is false', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write a file',
      },
    ];

    // Deep research models don't support function calling
    const tools = toOpenAIResponseTools(defs, {
      supportsFunctionCalling: false,
    });
    // Both read_file and write_file should be filtered out
    assert.equal(tools.length, 0);
  });

  it('keeps native web_search when supportsFunctionCalling is false and supportsNativeWebSearch is true', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
      {
        name: 'read_file',
        description: 'Read a file',
      },
    ];

    // Deep research models support native web search but not function calling
    const tools = toOpenAIResponseTools(defs, {
      supportsFunctionCalling: false,
      supportsNativeWebSearch: true,
    });
    // Only web_search should remain as native tool
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'web_search');
  });

  it('defaults supportsFunctionCalling to true', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'custom_tool',
        description: 'A custom function tool',
      },
    ];

    // No options passed - function calling should be allowed by default
    const tools = toOpenAIResponseTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as FunctionTool;
    assert.equal(tool.type, 'function');
    assert.equal(tool.name, 'custom_tool');
  });
});

describe('toGoogleTools', () => {
  // NOTE: Native googleSearch is disabled because Google's regular content
  // generation API does NOT support combining googleSearch with functionDeclarations.
  // This is a Live API only feature. All tools are converted to function declarations.

  it('returns empty array for empty input', () => {
    const tools = toGoogleTools([]);
    assert.deepEqual(tools, []);
  });

  it('converts function declarations to single tool object', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ];

    const tools = toGoogleTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as GeminiTool;
    assert.ok(tool.functionDeclarations);
    assert.equal(tool.functionDeclarations?.length, 1);
    assert.equal(tool.functionDeclarations?.[0].name, 'read_file');
    assert.equal(tool.googleSearch, undefined);
  });

  it('converts web_search to function declaration (native googleSearch disabled)', () => {
    // Native googleSearch is disabled because it cannot be combined with
    // function calling in Google's regular API (Live API only feature)
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    const tools = toGoogleTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as GeminiTool;
    // Should be function declaration, NOT native googleSearch
    assert.ok(tool.functionDeclarations);
    assert.equal(tool.functionDeclarations?.length, 1);
    assert.equal(tool.functionDeclarations?.[0].name, 'web_search');
    assert.equal(tool.googleSearch, undefined);
  });

  it('converts all tools to function declarations', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    ];

    const tools = toGoogleTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as GeminiTool;

    // Check that googleSearch is NOT present
    assert.equal(tool.googleSearch, undefined);

    // Check that all tools are converted to function declarations
    assert.ok(
      tool.functionDeclarations,
      'Expected functionDeclarations to be present',
    );
    assert.equal(tool.functionDeclarations?.length, 3);
    assert.equal(tool.functionDeclarations?.[0].name, 'web_search');
    assert.equal(tool.functionDeclarations?.[1].name, 'read_file');
    assert.equal(tool.functionDeclarations?.[2].name, 'write_file');
  });

  it('flattens top-level discriminated unions into a single object schema', () => {
    // Gemini rejects function parameter schemas whose root is oneOf/anyOf/allOf
    // (HTTP 400: schema must have type 'object' and not contain 'oneOf'/'anyOf'/'allOf').
    // Discriminated unions like the inquiry tool must flatten to a single object.
    const defs: ToolDefinition[] = [
      {
        name: 'inquiry',
        description: 'Ask, read, or list inquiry threads',
        zodSchema: z.discriminatedUnion('command', [
          z.object({
            command: z.literal('ask'),
            question: z.string(),
            thread_id: z.string().nullish(),
          }),
          z.object({
            command: z.literal('read'),
            thread_id: z.string(),
          }),
          z.object({
            command: z.literal('list'),
            status: z.enum(['open', 'answered']).default('open'),
          }),
        ]),
      },
    ];

    const tools = toGoogleTools(defs);
    const tool = tools[0] as GeminiTool;
    const params = tool.functionDeclarations?.[0]
      .parametersJsonSchema as Record<string, unknown>;

    assert.equal(params.type, 'object');
    assert.equal(params.oneOf, undefined);
    assert.equal(params.anyOf, undefined);
    assert.equal(params.allOf, undefined);

    const properties = params.properties as Record<
      string,
      Record<string, unknown>
    >;
    // Discriminator collapses literal branches into an enum.
    assert.deepEqual(properties.command.enum, ['ask', 'read', 'list']);
    assert.equal(properties.command.type, 'string');
    // Branch-specific props are merged in.
    assert.ok(properties.question);
    assert.ok(properties.thread_id);
    assert.ok(properties.status);
    // Only command is required by every branch.
    assert.deepEqual(params.required, ['command']);
  });
});
