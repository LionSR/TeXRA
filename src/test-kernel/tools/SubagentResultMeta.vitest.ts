import { describe, expect, it } from 'vitest';

import { ResultMetaSchema } from '@agent/storage';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { OutputFileSummary } from '@shared/schemas/output';
import { buildSubagentResultMeta } from '@tools/subagentResults';

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
      agentName: 'merge',
      category: 'workflow',
      outcome: 'completed',
      success: true,
      wallTimeMs: 1234,
      totalCostUsd: 0.42,
      outputs: [OUTPUT],
      diffs: [
        {
          path: OUTPUT.absolutePath,
          diffRelPath: 'diffs/r0_output.tex.diff',
          largeChange: false,
        },
      ],
    });
    expect(meta.compileFailures).toBeUndefined();
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
      agentName: 'reviewer',
      category: 'toolUse',
      success: true,
      lastResponse: 'All findings verified.',
      touchedFiles: ['notes.md'],
    });
    expect(meta.outputs).toBeUndefined();
    expect(meta.diffs).toBeUndefined();
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
