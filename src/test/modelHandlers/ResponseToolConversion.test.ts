// Standard library imports
import { strict as assert } from 'assert';

// Local imports - test
import {
  toGoogleTools,
  toOpenAIResponseTools,
} from '@agent/modelHandlers/toolConversion';
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
    assert.deepEqual((tools[0] as any).parameters, defs[0].parameters);
  });

  it('sets parameters to null when omitted', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'noop',
        description: 'no params',
      },
    ];

    const tools = toOpenAIResponseTools(defs);
    assert.equal((tools[0] as any).parameters, null);
  });

  it('returns native web search tool without exposing config', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          filters: {
            time_range: { start_time: '2024-01-01', end_time: '2024-02-01' },
            include_domains: ['example.com'],
          },
          search_context_size: 'high',
        },
      },
    ];

    const tools = toOpenAIResponseTools(defs, {
      supportsNativeWebSearch: true,
    });

    assert.equal(tools.length, 1);
    assert.equal(tools[0].type, 'web_search');
    assert.deepEqual(tools[0], { type: 'web_search' });
  });

  it('omits Google search overrides when emitting native tool', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search the web',
        parameters: {
          excludeDomains: ['example.com'],
          timeRange: { startTime: '2024-01-01', endTime: '2024-02-01' },
        },
      },
    ];

    const tools = toGoogleTools(defs, {
      supportsNativeWebSearch: true,
    });

    assert.equal(tools.length, 1);
    assert.deepEqual(tools[0].googleSearch, {});
  });
});
