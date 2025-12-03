// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import { toOpenAIResponseTools } from '@agent/modelHandlers/toolConversion';

// Type imports
import type { ToolDefinition } from '@model';
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

  it('converts web_search to native WebSearchTool', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
      },
    ];

    const tools = toOpenAIResponseTools(defs);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'web_search');
  });
});
