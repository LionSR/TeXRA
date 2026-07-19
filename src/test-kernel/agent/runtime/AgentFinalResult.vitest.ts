import { describe, expect, it } from 'vitest';

import {
  AgentFinalResultSchema,
  buildAgentFinalResult,
} from '@agent/runtime/AgentFinalResult';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ExecutionId, RunOutcome, StreamTabId } from '@shared/schemas';
import type { OutputFileSummary } from '@shared/schemas/output';

const OUTPUT: OutputFileSummary = {
  round: 1,
  relativePath: 'r1/paper.tex',
  absolutePath: '/runs/abc/r1/paper.tex',
  location: 'runStorage',
  originalPath: '/workspace/paper.tex',
  added: 4,
  removed: 2,
};

describe('AgentFinalResult', () => {
  it('normalizes every omitted workflow list and cost', () => {
    expect(
      AgentFinalResultSchema.parse({
        category: 'workflow',
        outcome: 'failed',
      }),
    ).toEqual({
      category: 'workflow',
      outcome: 'failed',
      outputs: [],
      compileFailures: [],
      diffs: [],
      cost: 0,
    });
  });

  it('normalizes an omitted tool-use response, file list, and cost', () => {
    expect(
      AgentFinalResultSchema.parse({
        category: 'toolUse',
        outcome: 'cancelled',
      }),
    ).toEqual({
      category: 'toolUse',
      outcome: 'cancelled',
      response: '',
      files: [],
      cost: 0,
    });
  });

  it('builds the workflow envelope after diffs exist and drops runtime fields', () => {
    const flowResult: AgentFlowResult = {
      category: 'workflow',
      outcome: 'completed',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:workflow' as StreamTabId,
      outputs: [OUTPUT],
      compileFailures: [],
      memoryMisses: [{ path: '/memories/missing.md', reason: 'not found' }],
      totalCostUsd: 1.25,
    };

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

  it('keeps tool-use files as path strings', () => {
    const flowResult: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'completed',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tool-use' as StreamTabId,
      lastResponse: 'Checked the argument.',
      touchedFiles: ['notes.md'],
      totalCostUsd: 0.2,
    };

    expect(buildAgentFinalResult({ flowResult })).toEqual({
      category: 'toolUse',
      outcome: 'completed',
      response: 'Checked the argument.',
      files: ['notes.md'],
      cost: 0.2,
    });
  });

  it('surfaces structured output on the workflow envelope', () => {
    const flowResult: AgentFlowResult = {
      category: 'workflow',
      outcome: 'completed',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:workflow' as StreamTabId,
      outputs: [],
      compileFailures: [],
    };

    expect(
      buildAgentFinalResult({ flowResult, structured: { title: 'Lemma 1' } }),
    ).toMatchObject({
      category: 'workflow',
      structured: { title: 'Lemma 1' },
    });
  });

  it('surfaces structured output on the tool-use envelope', () => {
    const flowResult: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'completed',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tool-use' as StreamTabId,
    };

    expect(
      buildAgentFinalResult({ flowResult, structured: [1, 2, 3] }),
    ).toMatchObject({
      category: 'toolUse',
      structured: [1, 2, 3],
    });
  });

  it('surfaces the flow result own structured value when the source omits it', () => {
    const flowResult: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'completed',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tool-use' as StreamTabId,
      structured: { title: 'Captured' },
    };

    // The caller passed no `structured`, so the flow result's own captured
    // value must surface without the caller re-threading it.
    expect(buildAgentFinalResult({ flowResult })).toMatchObject({
      category: 'toolUse',
      structured: { title: 'Captured' },
    });
  });

  it.each(['failed', 'cancelled'] as RunOutcome[])(
    'allows an error path to preserve the %s outcome',
    (outcome) => {
      expect(
        buildAgentFinalResult({ category: 'toolUse', outcome }),
      ).toMatchObject({ category: 'toolUse', outcome });
    },
  );

  it('rejects runtime-only fields at the final-result boundary', () => {
    expect(
      AgentFinalResultSchema.safeParse({
        category: 'toolUse',
        outcome: 'completed',
        executionId: 'abcdefabcdef',
      }).success,
    ).toBe(false);
  });

  it('rejects structured values that cannot be persisted as JSON', () => {
    expect(
      AgentFinalResultSchema.safeParse({
        category: 'toolUse',
        outcome: 'completed',
        structured: { count: 1n },
      }).success,
    ).toBe(false);
  });

  it('rejects WAITING and negative cumulative cost', () => {
    expect(
      AgentFinalResultSchema.safeParse({
        category: 'toolUse',
        outcome: 'waiting',
      }).success,
    ).toBe(false);
    expect(
      AgentFinalResultSchema.safeParse({
        category: 'toolUse',
        outcome: 'completed',
        cost: -0.01,
      }).success,
    ).toBe(false);
  });
});
