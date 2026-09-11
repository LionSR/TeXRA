import { describe, expect, it } from 'vitest';

import {
  AgentFinalResultSchema,
  buildAgentFinalResult,
} from '@agent/runtime/AgentFinalResult';
import type {
  ToolUseFlowResult,
  WorkflowFlowResult,
} from '@agent/runtime/AgentFlowResult';
import type { RunId, RunOutcome, OutputFileSummary } from '@shared/schemas';

const OUTPUT: OutputFileSummary = {
  round: 1,
  relativePath: 'r1/paper.tex',
  absolutePath: '/runs/abc/r1/paper.tex',
  location: 'runStorage',
  originalPath: '/workspace/paper.tex',
  added: 4,
  removed: 2,
};

const RUN_ID = 'abcdefabcdef' as RunId;

function workflowFlowResult(
  overrides: Partial<WorkflowFlowResult> = {},
): WorkflowFlowResult {
  return {
    category: 'workflow',
    outcome: 'completed',
    runId: RUN_ID,
    outputs: [],
    compileFailures: [],
    ...overrides,
  };
}

function toolUseFlowResult(
  overrides: Partial<ToolUseFlowResult> = {},
): ToolUseFlowResult {
  return {
    category: 'toolUse',
    outcome: 'completed',
    runId: RUN_ID,
    ...overrides,
  };
}

function expectInvalidFinalResult(input: unknown): void {
  expect(AgentFinalResultSchema.safeParse(input).success).toBe(false);
}

describe('AgentFinalResult', () => {
  it.each([
    {
      name: 'normalizes every omitted workflow list and cost',
      input: { category: 'workflow', outcome: 'failed' },
      normalized: {
        category: 'workflow',
        outcome: 'failed',
        outputs: [],
        compileFailures: [],
        diffs: [],
        cost: 0,
      },
    },
    {
      name: 'normalizes an omitted tool-use response, file list, and cost',
      input: { category: 'toolUse', outcome: 'cancelled' },
      normalized: {
        category: 'toolUse',
        outcome: 'cancelled',
        response: '',
        files: [],
        cost: 0,
      },
    },
  ])('$name', ({ input, normalized }) => {
    expect(AgentFinalResultSchema.parse(input)).toEqual(normalized);
  });

  it('builds the workflow envelope after diffs exist and drops runtime fields', () => {
    const flowResult = workflowFlowResult({
      outputs: [OUTPUT],
      memoryMisses: [{ path: '/memories/missing.md', reason: 'not found' }],
      totalCostUsd: 1.25,
    });

    expect(
      buildAgentFinalResult({
        flowResult,
        diffs: [
          {
            path: OUTPUT.absolutePath,
            diffRelPath: 'diffs/paper.diff',
            largeChange: false,
          },
        ],
      }),
    ).toEqual({
      category: 'workflow',
      outcome: 'completed',
      outputs: [OUTPUT],
      compileFailures: [],
      diffs: [
        {
          path: OUTPUT.absolutePath,
          diffRelPath: 'diffs/paper.diff',
          largeChange: false,
        },
      ],
      cost: 1.25,
    });
  });

  it.each([
    {
      category: 'workflow',
      flowResult: workflowFlowResult(),
      structured: { title: 'Lemma 1' },
    },
    {
      category: 'toolUse',
      flowResult: toolUseFlowResult(),
      structured: [1, 2, 3],
    },
  ])(
    'surfaces structured output on the $category envelope',
    ({ category, flowResult, structured }) => {
      expect(buildAgentFinalResult({ flowResult, structured })).toMatchObject({
        category,
        structured,
      });
    },
  );

  it('surfaces the flow result own structured value when the source omits it', () => {
    const flowResult = toolUseFlowResult({
      structured: { title: 'Captured' },
    });

    // The caller passed no `structured`, so the flow result's own captured
    // value must surface without the caller re-threading it.
    expect(buildAgentFinalResult({ flowResult })).toMatchObject({
      category: 'toolUse',
      structured: { title: 'Captured' },
    });
  });

  it('rejects runtime-only fields at the final-result boundary', () => {
    expectInvalidFinalResult({
      category: 'toolUse',
      outcome: 'completed',
      runId: 'abcdefabcdef',
    });
  });

  it('rejects structured values that cannot be persisted as JSON', () => {
    expectInvalidFinalResult({
      category: 'toolUse',
      outcome: 'completed',
      structured: { count: 1n },
    });
  });

  it('rejects WAITING and negative cumulative cost', () => {
    expectInvalidFinalResult({
      category: 'toolUse',
      outcome: 'waiting',
    });
    expectInvalidFinalResult({
      category: 'toolUse',
      outcome: 'completed',
      cost: -0.01,
    });
  });
});
