import { describe, expect, it } from 'vitest';

import { ResultMetaSchema } from '@agent/storage/resultMeta';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { RunEnd, RunId } from '@shared/schemas';
import {
  buildSubagentFailureResultMeta,
  buildSubagentResultMeta,
} from '@tools/delegation/subagentResults';

const baseResult: AgentFlowResult = {
  outcome: 'completed',
  runId: 'abcdefabcdef' as RunId,
  output: { category: 'toolUse', response: '', files: [] },
};

describe('subagent result metadata', () => {
  it('failure manifest overwrites interim success and never claims success', () => {
    const interim: AgentFlowResult = {
      ...baseResult,
      output: {
        category: 'toolUse',
        response: 'looked fine before the crash',
        files: [],
      },
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
