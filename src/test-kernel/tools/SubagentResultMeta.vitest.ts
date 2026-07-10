import { describe, expect, it } from 'vitest';

import { ResultMetaSchema } from '@agent/storage';
import { buildAgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { OutputFileSummary } from '@shared/schemas/output';
import {
  buildSubagentFailureResultMeta,
  buildSubagentResultMeta,
} from '@tools/subagentResults';

const OUTPUT: OutputFileSummary = {
  absolutePath: '/ws/executions/abc/r0/output.tex',
  relativePath: 'r0/output.tex',
  originalPath: '/ws/chapter1.tex',
  location: 'runStorage',
  round: 0,
  added: 12,
  removed: 3,
};

describe('buildSubagentResultMeta', () => {
  it('keeps legacy aliases out of the canonical write schema', () => {
    expect(
      ResultMetaSchema.safeParse({
        producer: 'subagent',
        agentName: 'reviewer',
        outcome: 'completed',
        success: true,
        wallTimeMs: 20,
        result: {
          category: 'toolUse',
          lastResponse: 'legacy response',
        },
      }).success,
    ).toBe(false);
  });

  it('builds a schema-valid manifest for workflow results with diffs', () => {
    const result: AgentFlowResult = {
      category: 'workflow',
      outcome: 'completed',
      outputs: [OUTPUT],
      compileFailures: [],
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:wf' as StreamTabId,
      totalCostUsd: 0.42,
    };
    const finalResult = buildAgentFinalResult({
      flowResult: result,
      diffs: [
        {
          path: OUTPUT.absolutePath,
          diffRelPath: 'diffs/r0_output.tex.diff',
          largeChange: false,
        },
      ],
    });
    const meta = buildSubagentResultMeta('merge', finalResult, 1234);

    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta.result).toBe(finalResult);
    expect(meta).toEqual({
      producer: 'subagent',
      agentName: 'merge',
      wallTimeMs: 1234,
      result: {
        category: 'workflow',
        outcome: 'completed',
        outputs: [OUTPUT],
        compileFailures: [],
        diffs: [
          {
            path: OUTPUT.absolutePath,
            diffRelPath: 'diffs/r0_output.tex.diff',
            largeChange: false,
          },
        ],
        cost: 0.42,
      },
    });
  });

  it('records diffsUnavailable in the manifest when diff generation failed', () => {
    const result: AgentFlowResult = {
      category: 'workflow',
      outcome: 'completed',
      outputs: [OUTPUT],
      compileFailures: [],
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:wf' as StreamTabId,
    };
    const finalResult = buildAgentFinalResult({
      flowResult: result,
      diffsUnavailable: 'latexdiff crashed',
    });
    const meta = buildSubagentResultMeta('merge', finalResult, 500);

    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta.result.category).toBe('workflow');
    expect(
      meta.result.category === 'workflow' ? meta.result.diffs : [],
    ).toEqual([]);
    expect(
      meta.result.category === 'workflow'
        ? meta.result.diffsUnavailable
        : undefined,
    ).toBe('latexdiff crashed');
  });

  it('builds a schema-valid manifest for tool-use results', () => {
    const result: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'completed',
      lastResponse: 'All findings verified.',
      touchedFiles: ['notes.md'],
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tu' as StreamTabId,
    };
    const meta = buildSubagentResultMeta(
      'reviewer',
      buildAgentFinalResult({ flowResult: result }),
      99,
    );

    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta).toEqual({
      producer: 'subagent',
      agentName: 'reviewer',
      wallTimeMs: 99,
      result: {
        category: 'toolUse',
        outcome: 'completed',
        response: 'All findings verified.',
        files: ['notes.md'],
        cost: 0,
      },
    });
  });

  it('failure manifest overwrites interim success and never claims success', () => {
    const interim: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'completed',
      lastResponse: 'looked fine before the crash',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tu' as StreamTabId,
    };
    const meta = buildSubagentFailureResultMeta(
      'reviewer',
      'toolUse',
      interim,
      50,
    );
    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta.result.outcome).toBe('failed');
    // Cancelled runs keep their real outcome.
    const cancelled = buildSubagentFailureResultMeta(
      'reviewer',
      'toolUse',
      { ...interim, outcome: 'cancelled' },
      50,
    );
    expect(cancelled.result.outcome).toBe('cancelled');
  });

  it('failure manifest without a flow result uses the known category', () => {
    const meta = buildSubagentFailureResultMeta(
      'merge',
      'workflow',
      undefined,
      10,
    );
    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta).toEqual({
      producer: 'subagent',
      agentName: 'merge',
      wallTimeMs: 10,
      result: {
        category: 'workflow',
        outcome: 'failed',
        outputs: [],
        compileFailures: [],
        diffs: [],
        cost: 0,
      },
    });
  });

  it('preserves a cancelled outcome in the envelope', () => {
    const result: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'cancelled',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tu' as StreamTabId,
    };
    const meta = buildSubagentResultMeta(
      'reviewer',
      buildAgentFinalResult({ flowResult: result }),
      5,
    );
    expect(meta.result.outcome).toBe('cancelled');
  });
});
