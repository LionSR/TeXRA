// Third-party imports
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Local imports - core
import { MapToolRegistry, type ITool } from '@agent/core/tools/ToolTypes';

// Local imports - tools
import {
  buildTerminalTool,
  buildTerminalToolRegistry,
  isStrictNativeCompatible,
  resolveStructuredOutput,
} from '@tools/structuredOutput';

// The synthetic terminal tool's name is a file-local const in
// structuredOutput.ts; assert against the literal here.
const SUBMIT_OUTPUT_TOOL_NAME = 'submit_output';

describe('resolveStructuredOutput', () => {
  it('round-trips a JSON Schema object through z.fromJSONSchema', () => {
    const jsonSchema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['title', 'count'],
      additionalProperties: false,
    };

    const spec = resolveStructuredOutput(jsonSchema, 'result');

    expect(spec.name).toBe('result');
    expect(spec.jsonSchema).toBe(jsonSchema);
    expect(spec.validate({ title: 'Lemma', count: 2 }).success).toBe(true);
    expect(spec.validate({ title: 'Lemma' }).success).toBe(false);
  });

  it('derives an equivalent JSON Schema from a Zod schema', () => {
    const zodSchema = z.strictObject({
      title: z.string(),
      count: z.number(),
    });

    const spec = resolveStructuredOutput(zodSchema, 'result');

    expect(spec.zodSchema).toBe(zodSchema);
    expect(spec.jsonSchema).toMatchObject({
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'number' },
      },
    });
    expect(spec.validate({ title: 'Lemma', count: 2 }).success).toBe(true);
    expect(spec.validate({ title: 'Lemma', count: 'two' }).success).toBe(false);
  });
});

describe('isStrictNativeCompatible', () => {
  it('accepts a plain all-required additionalProperties:false object', () => {
    const spec = resolveStructuredOutput({
      type: 'object',
      properties: {
        title: { type: 'string' },
        done: { type: 'boolean' },
      },
      required: ['title', 'done'],
      additionalProperties: false,
    });

    expect(isStrictNativeCompatible(spec)).toBe(true);
  });

  it('rejects numeric constraint keywords from .int().min()', () => {
    const spec = resolveStructuredOutput(
      z.strictObject({ count: z.int().min(1) }),
    );

    expect(isStrictNativeCompatible(spec)).toBe(false);
  });

  it('rejects an optional (not required) property', () => {
    const spec = resolveStructuredOutput(
      z.strictObject({ title: z.string(), note: z.string().nullish() }),
    );

    expect(isStrictNativeCompatible(spec)).toBe(false);
  });

  it('rejects a string pattern constraint', () => {
    const spec = resolveStructuredOutput({
      type: 'object',
      properties: { id: { type: 'string', pattern: '^[a-z]+$' } },
      required: ['id'],
      additionalProperties: false,
    });

    expect(isStrictNativeCompatible(spec)).toBe(false);
  });

  it('rejects an object that allows extra properties', () => {
    const spec = resolveStructuredOutput({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });

    expect(isStrictNativeCompatible(spec)).toBe(false);
  });

  it('rejects a bare object node with no additionalProperties: false', () => {
    const spec = resolveStructuredOutput({ type: 'object' });

    expect(isStrictNativeCompatible(spec)).toBe(false);
  });

  it('rejects an unconstrained (empty) schema', () => {
    const spec = resolveStructuredOutput({});

    expect(isStrictNativeCompatible(spec)).toBe(false);
  });
});

describe('buildTerminalTool', () => {
  const spec = resolveStructuredOutput(
    z.strictObject({ title: z.string(), count: z.number() }),
  );

  it('captures already-validated input and returns a success result', async () => {
    const capture = vi.fn<(value: unknown) => void>();
    const tool = buildTerminalTool(spec, capture);

    expect(tool.definition.name).toBe(SUBMIT_OUTPUT_TOOL_NAME);

    const result = await tool.call({ title: 'Lemma', count: 2 });

    expect(result.status).toBe('executed');
    expect(capture).toHaveBeenCalledWith({ title: 'Lemma', count: 2 });
  });

  it('rejects invalid input via its own schema before execute (repair path)', async () => {
    const capture = vi.fn<(value: unknown) => void>();
    const tool = buildTerminalTool(spec, capture);

    const result = await tool.call({ title: 'Lemma', count: 'two' });

    expect(result.status).toBe('error');
    expect(capture).not.toHaveBeenCalled();
  });

  it('rejects a non-object root schema so provider tool inputs stay valid', () => {
    const arraySpec = resolveStructuredOutput(z.array(z.string()));

    expect(() => buildTerminalTool(arraySpec, vi.fn())).toThrow(
      /object at the root/,
    );
  });

  it('binds capture per instance so concurrent runs never share a sink', async () => {
    const captureA = vi.fn<(value: unknown) => void>();
    const captureB = vi.fn<(value: unknown) => void>();
    const toolA = buildTerminalTool(spec, captureA);
    const toolB = buildTerminalTool(spec, captureB);

    await toolA.call({ title: 'A', count: 1 });

    expect(captureA).toHaveBeenCalledTimes(1);
    expect(captureB).not.toHaveBeenCalled();
  });
});

describe('buildTerminalToolRegistry', () => {
  const spec = resolveStructuredOutput(z.strictObject({ title: z.string() }));
  const realTool = {
    definition: { name: 'read_file', description: 'read', parameters: {} },
  } as ITool;
  const base = new MapToolRegistry({ read_file: realTool });

  it('overrides submit_output while delegating every other lookup', () => {
    const terminalTool = buildTerminalTool(spec, vi.fn());
    const overlay = buildTerminalToolRegistry(base, terminalTool);

    expect(overlay.get(SUBMIT_OUTPUT_TOOL_NAME)).toBe(terminalTool);
    expect(overlay.has(SUBMIT_OUTPUT_TOOL_NAME)).toBe(true);
    expect(overlay.get('read_file')).toBe(realTool);
    expect(overlay.has('read_file')).toBe(true);
    expect(overlay.get('missing')).toBeUndefined();
    expect(overlay.has('missing')).toBe(false);
  });

  it('never mutates the base registry', () => {
    const terminalTool = buildTerminalTool(spec, vi.fn());
    buildTerminalToolRegistry(base, terminalTool);

    // The shared default registry must never gain the synthetic tool.
    expect(base.get(SUBMIT_OUTPUT_TOOL_NAME)).toBeUndefined();
    expect(base.has(SUBMIT_OUTPUT_TOOL_NAME)).toBe(false);
  });
});
