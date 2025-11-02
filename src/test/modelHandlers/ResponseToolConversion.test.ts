// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import { toOpenAIResponseTools } from '@agent/modelHandlers/toolConversion';
import type { ToolDefinition } from '@model';

describe('toOpenAIResponseTools', () => {
  it('converts tool definitions to Response API format', () => {
    const echoSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    } satisfies ToolDefinition['inputSchema'];

    const defs: ToolDefinition[] = [
      {
        name: 'echo',
        description: 'Echo value',
        inputSchema: echoSchema,
      },
    ];

    const tools = toOpenAIResponseTools(defs);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'function');
    assert.equal(tools[0].name, 'echo');
    assert.deepEqual(tools[0].parameters, defs[0].inputSchema);
  });

  it('sets parameters to null when omitted', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'noop',
        description: 'no params',
      } as ToolDefinition,
    ];

    const tools = toOpenAIResponseTools(defs);
    assert.equal(tools[0].parameters, null);
  });
});
