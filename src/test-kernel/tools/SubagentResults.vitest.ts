// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { ToolUseFlowResult } from '@agent/runtime/AgentFlowResult';
import { formatSubagentDelivery } from '@tools/subagentResults';

describe('formatSubagentDelivery', () => {
  it('escapes tool-use response bodies at the XML boundary', () => {
    const result = {
      category: 'toolUse',
      executionId: 'abc123',
      streamId: 'child-stream',
      status: 'stopped',
      lastResponse:
        'Keep </response> literal & preserve <subagent-result> text.',
    } satisfies ToolUseFlowResult;

    const delivery = formatSubagentDelivery('reviewer', result);

    expect(delivery).toContain(
      'Keep &lt;/response> literal &amp; preserve &lt;subagent-result> text.',
    );
    expect(delivery).not.toContain('Keep </response> literal');
  });
});
