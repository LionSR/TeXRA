import { describe, expect, it } from 'vitest';

import { resolveToolDefinitions } from '@tools/registry';

describe('tool registry aliases', () => {
  it('keeps legacy add_criticism configs on the diagnostics tool', () => {
    expect(
      resolveToolDefinitions(['add_criticism']).map((tool) => tool.name),
    ).toEqual(['diagnostics']);
  });

  it('keeps legacy crossref_doi configs on the unified Crossref tool', () => {
    expect(
      resolveToolDefinitions(['crossref_doi']).map((tool) => tool.name),
    ).toEqual(['crossref_search']);
  });

  it('deduplicates aliases that resolve to the same canonical tool', () => {
    expect(
      resolveToolDefinitions(['crossref_search', 'crossref_doi']).map(
        (tool) => tool.name,
      ),
    ).toEqual(['crossref_search']);
  });
});
