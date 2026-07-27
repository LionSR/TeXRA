import { describe, expect, it } from 'vitest';

import { resolveToolDefinitions } from '@tools/registry';

describe('tool registry aliases', () => {
  it('keeps legacy add_criticism configs on the diagnostics tool', async () => {
    expect(
      (await resolveToolDefinitions(['add_criticism'])).map((tool) => tool.name),
    ).toEqual(['diagnostics']);
  });

  it('keeps legacy crossref_doi configs on the unified Crossref tool', async () => {
    // Remove with the dated Crossref alias row in #6981 (2026-08-19).
    const [tool] = await resolveToolDefinitions(['crossref_doi']);
    const [canonicalTool] = await resolveToolDefinitions(['crossref_search']);

    expect(tool?.name).toBe('crossref_search');
    expect(tool?.parameters).toEqual(canonicalTool?.parameters);
  });

  it('replaces legacy object-form schemas with the canonical tool contract', async () => {
    // Remove with the dated Crossref alias row in #6981 (2026-08-19).
    const [tool] = await resolveToolDefinitions([
      {
        name: 'crossref_doi',
        description: 'Retired DOI-only contract',
        parameters: {
          type: 'object',
          properties: { doi: { type: 'string' } },
          required: ['doi'],
        },
      },
    ]);
    const [canonicalTool] = await resolveToolDefinitions(['crossref_search']);

    expect(tool?.name).toBe('crossref_search');
    expect(tool?.description).not.toBe('Retired DOI-only contract');
    expect(tool?.parameters).toEqual(canonicalTool?.parameters);
  });

  it('deduplicates aliases that resolve to the same canonical tool', async () => {
    // Remove with the dated Crossref alias row in #6981 (2026-08-19).
    expect(
      (await resolveToolDefinitions(['crossref_search', 'crossref_doi'])).map(
        (tool) => tool.name,
      ),
    ).toEqual(['crossref_search']);
  });
});
