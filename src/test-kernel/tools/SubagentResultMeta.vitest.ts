import { describe, expect, it } from 'vitest';

import { ResultMetaSchema } from '@agent/storage';
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
    const meta = buildSubagentResultMeta('merge', result, {
      wallTimeMs: 1234,
      diffInfos: new Map([
        [
          OUTPUT.absolutePath,
          { diffRelPath: 'diffs/r0_output.tex.diff', largeChange: false },
        ],
      ]),
    });

    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta).toMatchObject({
      producer: 'subagent',
      agentName: 'merge',
      outcome: 'completed',
      success: true,
      wallTimeMs: 1234,
      totalCostUsd: 0.42,
      result: {
        category: 'workflow',
        outputs: [OUTPUT],
        diffs: [
          {
            path: OUTPUT.absolutePath,
            diffRelPath: 'diffs/r0_output.tex.diff',
            largeChange: false,
          },
        ],
      },
    });
    expect(meta.result?.category).toBe('workflow');
    expect(
      meta.result?.category === 'workflow'
        ? meta.result.compileFailures
        : undefined,
    ).toBeUndefined();
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
    const meta = buildSubagentResultMeta('merge', result, {
      wallTimeMs: 500,
      diffsUnavailable: 'latexdiff crashed',
    });

    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta.result?.category).toBe('workflow');
    expect(
      meta.result?.category === 'workflow' ? meta.result.diffs : undefined,
    ).toBeUndefined();
    expect(
      meta.result?.category === 'workflow'
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
    const meta = buildSubagentResultMeta('reviewer', result, {
      wallTimeMs: 99,
    });

    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta).toMatchObject({
      producer: 'subagent',
      agentName: 'reviewer',
      success: true,
      result: {
        category: 'toolUse',
        lastResponse: 'All findings verified.',
        touchedFiles: ['notes.md'],
      },
    });
    expect(meta.result?.category).toBe('toolUse');
  });

  it('failure manifest overwrites interim success and never claims success', () => {
    const interim: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'completed',
      lastResponse: 'looked fine before the crash',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tu' as StreamTabId,
    };
    const meta = buildSubagentFailureResultMeta('reviewer', interim, 50);
    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta.success).toBe(false);
    expect(meta.outcome).toBe('failed');
    // Cancelled runs keep their real outcome.
    const cancelled = buildSubagentFailureResultMeta(
      'reviewer',
      { ...interim, outcome: 'cancelled' },
      50,
    );
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.success).toBe(false);
  });

  it('failure manifest without a flow result is minimal but valid', () => {
    const meta = buildSubagentFailureResultMeta('merge', undefined, 10);
    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
    expect(meta).toEqual({
      producer: 'subagent',
      agentName: 'merge',
      outcome: 'failed',
      success: false,
      wallTimeMs: 10,
    });
  });

  it('marks non-completed outcomes as unsuccessful', () => {
    const result: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'cancelled',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tu' as StreamTabId,
    };
    const meta = buildSubagentResultMeta('reviewer', result, {
      wallTimeMs: 5,
    });
    expect(meta.success).toBe(false);
    expect(meta.outcome).toBe('cancelled');
  });
});
