import { describe, expect, it } from 'vitest';

import { ContextManagementDataSchema } from '@shared/schemas';

describe('ContextManagementDataSchema', () => {
  const base = {
    tokensBefore: 1000,
    contextWindow: 200_000,
    utilizationBefore: 5,
  };

  it('passes an already-populated tokens-freed entry through unchanged', () => {
    const result = ContextManagementDataSchema.parse({
      ...base,
      action: 'compaction',
      tokensAfter: 400,
      utilizationAfter: 2,
    });

    expect(result).toMatchObject({ tokensAfter: 400, utilizationAfter: 2 });
  });

  it('still requires originalMaxTokens/reducedMaxTokens for max_tokens_reduced', () => {
    expect(() =>
      ContextManagementDataSchema.parse({
        ...base,
        action: 'max_tokens_reduced',
      }),
    ).toThrow();
  });

  it('rejects retired entries missing their completion statistics', () => {
    expect(() =>
      ContextManagementDataSchema.parse({ ...base, action: 'clear_tool_uses' }),
    ).toThrow();
  });
});
