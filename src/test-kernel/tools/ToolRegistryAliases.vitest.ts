import { describe, expect, it, vi } from 'vitest';

import { resolveToolDefinitions } from '@tools/registry';

describe('tool registry resolution', () => {
  it('replaces a declared contract with the registered tool definition', () => {
    const warn = vi.fn();
    const [tool] = resolveToolDefinitions(
      [
        {
          name: 'crossref_search',
          description: 'Untrusted replacement contract',
          parameters: {
            type: 'object',
            properties: { doi: { type: 'string' } },
            required: ['doi'],
          },
        },
      ],
      warn,
    );
    const [canonicalTool] = resolveToolDefinitions(['crossref_search']);

    expect(tool?.name).toBe('crossref_search');
    expect(tool?.description).not.toBe('Untrusted replacement contract');
    expect(tool?.parameters).toEqual(canonicalTool?.parameters);
    expect(warn).toHaveBeenCalledWith(
      'crossref_search',
      expect.stringContaining('the registered definition is used instead'),
    );
  });

  it('re-resolves an inherited definition without reporting an override', () => {
    // A child agent inherits the definitions its parent's load already
    // resolved; repeating the registered contract is not an override.
    const warn = vi.fn();
    const [registered] = resolveToolDefinitions(['grep']);
    const inherited = JSON.parse(
      JSON.stringify(registered),
    ) as typeof registered;

    expect(resolveToolDefinitions([inherited], warn)).toEqual([registered]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not report an override when only key order differs', () => {
    // Structural equality must be key-order independent: JSON.stringify
    // comparison would false-positive here even though the content matches.
    const warn = vi.fn();
    const [registered] = resolveToolDefinitions(['grep']);
    const reorderedParameters = Object.fromEntries(
      Object.entries(
        registered?.parameters as Record<string, unknown>,
      ).reverse(),
    );
    const reordered = { ...registered, parameters: reorderedParameters };

    expect(resolveToolDefinitions([reordered], warn)).toEqual([registered]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a definition the registry does not hold', () => {
    // An embedder registering agents as values supplies tools the built-in
    // registry never sees; their definition is all the model has to go on.
    const warn = vi.fn();
    const declared = {
      name: 'embedder_tool',
      description: 'Supplied by the host',
      parameters: { type: 'object', properties: {} },
    };

    expect(resolveToolDefinitions([declared], warn)).toEqual([declared]);
    expect(warn).toHaveBeenCalledWith('embedder_tool', 'not found in registry');
  });

  it('warns once for a name the registry does not hold', () => {
    const warn = vi.fn();

    expect(resolveToolDefinitions(['missing_tool'], warn)).toEqual([
      { name: 'missing_tool' },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('missing_tool', 'not found in registry');
  });
});
