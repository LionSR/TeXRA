import { describe, expect, it, vi } from 'vitest';

import { resolveToolDefinitions } from '@tools/registry';

describe('tool registry aliases', () => {
  it('keeps legacy crossref_doi configs on the unified Crossref tool', () => {
    // Remove with the dated Crossref alias row in #6981 (2026-08-19).
    const [tool] = resolveToolDefinitions(['crossref_doi']);
    const [canonicalTool] = resolveToolDefinitions(['crossref_search']);

    expect(tool?.name).toBe('crossref_search');
    expect(tool?.parameters).toEqual(canonicalTool?.parameters);
  });

  it('replaces a declared contract with the registered tool definition', () => {
    // Remove with the dated Crossref alias row in #6981 (2026-08-19).
    const warn = vi.fn();
    const [tool] = resolveToolDefinitions(
      [
        {
          name: 'crossref_doi',
          description: 'Retired DOI-only contract',
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
    expect(tool?.description).not.toBe('Retired DOI-only contract');
    expect(tool?.parameters).toEqual(canonicalTool?.parameters);
    expect(warn).toHaveBeenCalledWith(
      'crossref_doi',
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

  it('deduplicates aliases that resolve to the same canonical tool', () => {
    // Remove with the dated Crossref alias row in #6981 (2026-08-19).
    expect(
      resolveToolDefinitions(['crossref_search', 'crossref_doi']).map(
        (tool) => tool.name,
      ),
    ).toEqual(['crossref_search']);
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
