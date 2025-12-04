// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import {
  toOpenAIResponseTools,
  toGoogleTools,
} from '@agent/modelHandlers/toolConversion';

// Type imports
import type { ToolDefinition } from '@model';

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
    assert.equal(tools[0].type, 'function');
    assert.equal(tools[0].name, 'echo');
    assert.deepEqual(tools[0].parameters, defs[0].parameters);
  });

  it('sets parameters to null when omitted', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'noop',
        description: 'no params',
      },
    ];

    const tools = toOpenAIResponseTools(defs);
    assert.equal(tools[0].parameters, null);
  });
});

describe('toGoogleTools', () => {
  it('converts regular tools to function declarations', () => {
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
    assert.ok(tools[0].functionDeclarations);
    assert.equal(tools[0].functionDeclarations?.length, 1);
    assert.equal(tools[0].functionDeclarations?.[0].name, 'read_file');
  });

  it('converts web_search to native googleSearch', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];

    const tools = toGoogleTools(defs);
    assert.equal(tools.length, 1);
    assert.ok(tools[0].googleSearch);
    assert.ok(!tools[0].functionDeclarations);
  });

  it('converts code_execution to native codeExecution', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'code_execution',
        description: 'Execute code',
        parameters: { type: 'object', properties: {} },
      },
    ];

    const tools = toGoogleTools(defs);
    assert.equal(tools.length, 1);
    assert.ok(tools[0].codeExecution);
    assert.ok(!tools[0].functionDeclarations);
  });

  it('separates native tools from function declarations', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'web_search',
        description: 'Search the web',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'code_execution',
        description: 'Execute code',
        parameters: { type: 'object', properties: {} },
      },
    ];

    const tools = toGoogleTools(defs);
    // Should produce 3 Tool objects: one with functionDeclarations, one with googleSearch, one with codeExecution
    assert.equal(tools.length, 3);

    const funcTool = tools.find((t) => t.functionDeclarations);
    const searchTool = tools.find((t) => t.googleSearch);
    const codeTool = tools.find((t) => t.codeExecution);

    assert.ok(funcTool);
    assert.equal(funcTool.functionDeclarations?.length, 1);
    assert.equal(funcTool.functionDeclarations?.[0].name, 'read_file');

    assert.ok(searchTool);
    assert.ok(codeTool);
  });

  it('returns empty array for empty input', () => {
    const tools = toGoogleTools([]);
    assert.deepEqual(tools, []);
  });
});
