import { describe, expect, it } from 'vitest';

import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { buildSubagentFailureResultMeta } from '@tools/subagentResults';

describe('buildSubagentFailureResultMeta', () => {
  it('failure manifest overwrites interim success and never claims success', () => {
    const interim: AgentFlowResult = {
      category: 'toolUse',
      outcome: 'completed',
      response: 'looked fine before the crash',
      executionId: 'abcdefabcdef' as ExecutionId,
      streamId: 'stream:tu' as StreamTabId,
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
      { ...interim, outcome: 'cancelled' },
      50,
    );
    expect(cancelled.result.outcome).toBe('cancelled');
  });
});
