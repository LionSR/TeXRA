// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Local imports - core
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';

// Local imports - tools
import {
  buildOverlayToolRegistry,
  buildTerminalTool,
  normalizeStructuredOutputSchema,
} from '@tools/structuredOutput';

// The synthetic terminal tool's name is a file-local const in
// structuredOutput.ts; assert against the literal here.
const SUBMIT_OUTPUT_TOOL_NAME = 'submit_output';

function makeCapture() {
  return vi.fn<(value: unknown) => void>();
}

describe('normalizeStructuredOutputSchema', () => {
  it('normalizes a JSON Schema object through the pinned Zod API', async () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['title', 'count'],
      additionalProperties: false,
    };

    const normalized = normalizeStructuredOutputSchema(jsonSchema);
    const capture = makeCapture();
    const tool = buildTerminalTool(jsonSchema, capture);

    expect(normalized.jsonSchema).toMatchObject(jsonSchema);
    await expect(
      tool.call({ title: 'Lemma', count: 2 }),
    ).resolves.toMatchObject({ status: 'executed' });
    await expect(tool.call({ title: 'Lemma' })).resolves.toMatchObject({
      status: 'error',
    });
  });

  it('derives an equivalent object schema from a Zod schema', () => {
    const zodSchema = z.strictObject({
      title: z.string(),
      count: z.number(),
    });

    const normalized = normalizeStructuredOutputSchema(zodSchema);

    expect(normalized.zodSchema).toBe(zodSchema);
    expect(normalized.jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'number' },
      },
    });
  });

  it('rejects non-object and unconstrained roots at normalization time', () => {
    expect(() => normalizeStructuredOutputSchema({})).toThrow(/object.*root/);
    expect(() => normalizeStructuredOutputSchema(z.array(z.string()))).toThrow(
      /object.*root/,
    );
  });

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

  it('allows output fields whose names match JSON Schema keywords', () => {
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          patternProperties: { type: 'string' },
        },
      }),
    ).not.toThrow();
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

  it('rejects sandbox schemas past the depth and node caps', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 15; i += 1) {
      deep = { type: 'object', properties: { next: deep } };
    }
    expect(() => normalizeStructuredOutputSchema(deep)).toThrow(
      /nested deeper than/,
    );

    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 1100; i += 1) wide[`f${i}`] = { type: 'string' };
    expect(() =>
      normalizeStructuredOutputSchema({ type: 'object', properties: wide }),
    ).toThrow(/exceeds the .* limit/);
  });

  it('rejects scalar-heavy schemas past the serialized-size cap', () => {
    // A giant enum is only a couple of object nodes but a huge payload; the
    // size cap catches what the node/depth caps cannot.
    const choice = { enum: Array.from({ length: 200_000 }, (_, i) => `v${i}`) };
    expect(() =>
      normalizeStructuredOutputSchema({
        type: 'object',
        properties: { choice },
      }),
    ).toThrow(/byte size limit/);
  });
});

describe('buildTerminalTool', () => {
  const schema = z.strictObject({ title: z.string(), count: z.number() });

  it('captures already-validated input and returns a success result', async () => {
    const capture = makeCapture();
    const tool = buildTerminalTool(schema, capture);

    expect(tool.definition.name).toBe(SUBMIT_OUTPUT_TOOL_NAME);

    const result = await tool.call({ title: 'Lemma', count: 2 });

    expect(result).toMatchObject({ status: 'executed', endTurn: true });
    expect(capture).toHaveBeenCalledWith({ title: 'Lemma', count: 2 });
  });

  it('rejects invalid input via its own schema before execute (repair path)', async () => {
    const capture = makeCapture();
    const tool = buildTerminalTool(schema, capture);

    const result = await tool.call({ title: 'Lemma', count: 'two' });

    expect(result.status).toBe('error');
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects a non-object root schema so provider tool inputs stay valid', () => {
    expect(() => buildTerminalTool(z.array(z.string()), vi.fn())).toThrow(
      /object at the root/,
    );
  });

  it('supports async Zod validation through the canonical tool boundary', async () => {
    const capture = makeCapture();
    const tool = buildTerminalTool(
      z.strictObject({
        title: z.string().refine(async (value) => value === 'accepted'),
      }),
      capture,
    );

    await expect(tool.call({ title: 'rejected' })).resolves.toMatchObject({
      status: 'error',
    });
    await expect(tool.call({ title: 'accepted' })).resolves.toMatchObject({
      status: 'executed',
    });
  });

  it('rejects transformed values that cannot cross the JSON boundary', async () => {
    const capture = makeCapture();
    const tool = buildTerminalTool(
      z.strictObject({ value: z.string().transform(() => 1n) }),
      capture,
    );

    await expect(tool.call({ value: 'one' })).resolves.toMatchObject({
      status: 'error',
    });
    expect(capture).not.toHaveBeenCalled();
  });

  it('accepts only one structured result per run', async () => {
    const capture = makeCapture();
    const tool = buildTerminalTool(schema, capture);

    await expect(
      tool.call({ title: 'First', count: 1 }),
    ).resolves.toMatchObject({ status: 'executed' });
    await expect(
      tool.call({ title: 'Second', count: 2 }),
    ).resolves.toMatchObject({ status: 'error' });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('binds capture per instance so concurrent runs never share a sink', async () => {
    const captureA = makeCapture();
    const captureB = makeCapture();
    const toolA = buildTerminalTool(schema, captureA);
    const toolB = buildTerminalTool(schema, captureB);

    await toolA.call({ title: 'A', count: 1 });

    expect(captureA).toHaveBeenCalledTimes(1);
    expect(captureB).not.toHaveBeenCalled();
  });
});

describe('buildOverlayToolRegistry', () => {
  const schema = z.strictObject({ title: z.string() });

  function stubTool(name: string): ITool {
    return {
      definition: { name, description: name, parameters: {} },
    } as ITool;
  }

  const realTool = {
    definition: { name: 'read_file', description: 'read', parameters: {} },
  } as ITool;
  const base = new MapToolRegistry({ read_file: realTool });

  it('resolves every run-scoped tool while delegating other lookups', () => {
    const first = stubTool('first');
    const second = stubTool('second');
    const terminalTool = buildTerminalTool(schema, vi.fn());
    const overlay = buildOverlayToolRegistry(base, [
      first,
      second,
      terminalTool,
    ]);

    expect(overlay.get('first')).toBe(first);
    expect(overlay.get('second')).toBe(second);
    expect(overlay.get(SUBMIT_OUTPUT_TOOL_NAME)).toBe(terminalTool);
    expect(overlay.get('read_file')).toBe(realTool);
    expect(overlay.get('missing')).toBeUndefined();
    expect(overlay.has('missing')).toBe(false);
  });

  it('isolates concurrent overlays without mutating the shared base', () => {
    const first = stubTool('first');
    const second = stubTool('second');
    const firstRun = buildOverlayToolRegistry(base, [first]);
    const secondRun = buildOverlayToolRegistry(base, [second]);

    expect(firstRun.get('first')).toBe(first);
    expect(firstRun.get('second')).toBeUndefined();
    expect(secondRun.get('second')).toBe(second);
    expect(secondRun.get('first')).toBeUndefined();
    expect(base.get('first')).toBeUndefined();
    expect(base.get('second')).toBeUndefined();
  });

  it('lets the last run-scoped tool win a name collision', () => {
    const first = stubTool('read_file');
    const second = stubTool('read_file');
    const overlay = buildOverlayToolRegistry(base, [first, second]);

    expect(overlay.get('read_file')).toBe(second);
  });
});
