// Third-party imports
import { describe, expect } from 'vitest';
import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

// Local imports - tools
import {
  buildTerminalTool,
  normalizeStructuredOutputSchema,
} from '@tools/structuredOutput';

describe('normalizeStructuredOutputSchema', () => {
  it('rejects regex-bearing sandbox schemas before host compilation', () => {
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: { value: { type: 'string', pattern: '(a+)+$' } },
      }),
    ).toThrow(/cannot use pattern/);
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: {
          tuple: {
            type: 'array',
            items: [{ type: 'string', pattern: '(a+)+$' }],
          },
        },
      }),
    ).toThrow(/cannot use pattern/);
  });

  it('rejects format, $ref, and prototype-polluting property keys', () => {
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: { at: { type: 'string', format: 'email' } },
      }),
    ).toThrow(/cannot use format/);
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: { child: { $ref: '#/$defs/x' } },
      }),
    ).toThrow(/cannot use \$ref/);
    // Real sandbox schemas arrive via JSON.parse, which creates an own
    // "__proto__" key (an object literal would set the prototype instead).
    const polluting = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
    ) as Record<string, unknown>;
    expect(() => normalizeStructuredOutputSchema(polluting)).toThrow(
      /cannot declare a "__proto__" property/,
    );
  });
});

describe('buildTerminalTool', () => {
  const schema = Schema.Struct({ title: Schema.String, count: Schema.Number });

  it.effect('accepts only one structured result per run', () =>
    Effect.gen(function* () {
      const tool = buildTerminalTool(schema);

      // The settled result carries the value: the run's structured output.
      expect(yield* tool.call({ title: 'First', count: 1 })).toMatchObject({
        status: 'executed',
        value: { title: 'First', count: 1 },
      });
      expect(yield* tool.call({ title: 'Second', count: 2 })).toMatchObject({
        status: 'error',
      });
    }),
  );
});
