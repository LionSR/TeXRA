import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  emptyRunEndOutput,
  RunEndSchema,
} from '@shared/schemas';

function expectInvalidRunEnd(input: unknown): void {
  expect(RunEndSchema.safeParse(input).success).toBe(false);
}

describe('RunEnd', () => {
  it.each([
    {
      name: 'normalizes every omitted workflow list',
      category: AgentCategory.Workflow,
      normalized: {
        category: 'workflow',
        outputs: [],
        compileFailures: [],
        diffs: [],
      },
    },
    {
      name: 'normalizes an omitted tool-use response and file list',
      category: AgentCategory.ToolUse,
      normalized: { category: 'toolUse', response: '', files: [] },
    },
  ])('$name', ({ category, normalized }) => {
    expect(emptyRunEndOutput(category)).toEqual(normalized);
  });

  it.each([
    { category: AgentCategory.Workflow, structured: { title: 'Lemma 1' } },
    { category: AgentCategory.ToolUse, structured: [1, 2, 3] },
  ])(
    'surfaces structured output on the $category terminal row',
    ({ category, structured }) => {
      expect(
        RunEndSchema.parse({
          outcome: 'completed',
          output: { ...emptyRunEndOutput(category), structured },
        }).output,
      ).toMatchObject({ structured });
    },
  );

  it('rejects runtime-only fields at the terminal-row boundary', () => {
    expectInvalidRunEnd({
      outcome: 'completed',
      output: emptyRunEndOutput(AgentCategory.ToolUse),
      runId: 'abcdefabcdef',
    });
  });

  it('rejects structured values that cannot be persisted as JSON', () => {
    expectInvalidRunEnd({
      outcome: 'completed',
      output: {
        ...emptyRunEndOutput(AgentCategory.ToolUse),
        structured: { count: 1n },
      },
    });
  });

  it('rejects WAITING and a negative cumulative cost', () => {
    expectInvalidRunEnd({
      outcome: 'waiting',
      output: emptyRunEndOutput(AgentCategory.ToolUse),
    });
    expectInvalidRunEnd({
      outcome: 'completed',
      output: emptyRunEndOutput(AgentCategory.ToolUse),
      usage: { totalCost: -0.01 },
    });
  });
});
