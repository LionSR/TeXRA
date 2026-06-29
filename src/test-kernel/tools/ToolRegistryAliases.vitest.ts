import { describe, expect, it } from 'vitest';

import { resolveToolDefinitions } from '@tools/registry';

describe('tool registry aliases', () => {
  it('keeps legacy add_criticism configs on the diagnostics tool', () => {
    expect(
      resolveToolDefinitions(['add_criticism']).map((tool) => tool.name),
    ).toEqual(['diagnostics']);
  });
});
