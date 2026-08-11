import { describe, expect, it } from 'vitest';

import { ResultMetaSchema } from '@agent/storage/resultMeta';
import { buildAgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import {
  buildSubagentFailureResultMeta,
  buildSubagentResultMeta,
} from '@tools/delegation/subagentResults';

const baseResult: AgentFlowResult = {
  category: 'toolUse',
  outcome: 'completed',
  executionId: 'abcdefabcdef' as ExecutionId,
  streamId: 'stream:tu' as StreamTabId,
};

describe('subagent result metadata', () => {
  it('builds a schema-valid manifest from the canonical final result', () => {
    const meta = buildSubagentResultMeta(
      'reviewer',
      buildAgentFinalResult({
        flowResult: {
          ...baseResult,
          response: 'All findings verified.',
          files: ['notes.md'],
        },
      }),
      99,
    );

    expect(ResultMetaSchema.parse(meta)).toEqual(meta);
  });

  it('failure manifest overwrites interim success and never claims success', () => {
    const interim: AgentFlowResult = {
      ...baseResult,
      response: 'looked fine before the crash',
    };
    const meta = buildSubagentFailureResultMeta(
      'reviewer',
      'toolUse',
      interim,
      50,
    );
    expect(meta.result.outcome).toBe('failed');
    // Cancelled runs keep their real outcome.
    const cancelled = buildSubagentFailureResultMeta(
      'reviewer',
      'toolUse',
      {
        ...interim,
        outcome: 'cancelled',
      },
      50,
    );
    expect(cancelled.result.outcome).toBe('cancelled');
  });
});
