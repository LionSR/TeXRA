// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import {
  toGoogleTools,
  toOpenAIResponseTools,
} from '@agent/modelHandlers/toolConversion';

// Type imports
import type { ToolDefinition } from '@model';
import type { Tool as GeminiTool } from '@google/genai/dist/genai';
import type { FunctionTool } from 'openai/resources/responses/responses';

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

  it('sets parameters to null when omitted', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'noop',
        description: 'no params',
      },
    ];

    const tools = toOpenAIResponseTools(defs);
    const tool = tools[0] as FunctionTool;
    assert.equal(tool.parameters, null);
  });

  it('converts web_search to native WebSearchTool when supportsNativeWebSearch is true', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    const tools = toOpenAIResponseTools(defs, { supportsNativeWebSearch: true });
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

    const tools = toOpenAIResponseTools(defs, { supportsNativeWebSearch: false });
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
});

describe('toGoogleTools', () => {
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

  it('converts web_search to native googleSearch when supportsNativeWebSearch is true', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    const tools = toGoogleTools(defs, { supportsNativeWebSearch: true });
    assert.equal(tools.length, 1);
    const tool = tools[0] as GeminiTool;
    assert.ok(tool.googleSearch);
    assert.equal(tool.functionDeclarations, undefined);
  });

  it('keeps web_search as function declaration when supportsNativeWebSearch is false', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    const tools = toGoogleTools(defs, { supportsNativeWebSearch: false });
    assert.equal(tools.length, 1);
    const tool = tools[0] as GeminiTool;
    assert.ok(tool.functionDeclarations);
    assert.equal(tool.functionDeclarations?.length, 1);
    assert.equal(tool.functionDeclarations?.[0].name, 'web_search');
    assert.equal(tool.googleSearch, undefined);
  });

  it('skips native googleSearch when combined with other tools (Live API limitation)', () => {
    // Google's regular content generation API does NOT support combining
    // googleSearch with functionDeclarations. Only the Live API supports this.
    // When both are requested, we fall back to function declarations for all.
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

    const tools = toGoogleTools(defs, { supportsNativeWebSearch: true });
    // Should return function declarations for ALL tools (including web_search)
    // because native googleSearch cannot be combined with function calling
    assert.equal(tools.length, 1);
    const tool = tools[0] as GeminiTool;

    // Check that googleSearch is NOT present (would cause API error)
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

  it('defaults supportsNativeWebSearch to false', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    // No options passed - should default to function declaration
    const tools = toGoogleTools(defs);
    assert.equal(tools.length, 1);
    const tool = tools[0] as GeminiTool;
    assert.ok(tool.functionDeclarations);
    assert.equal(tool.functionDeclarations?.length, 1);
    assert.equal(tool.functionDeclarations?.[0].name, 'web_search');
    assert.equal(tool.googleSearch, undefined);
  });
});
