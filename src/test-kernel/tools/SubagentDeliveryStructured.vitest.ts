// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { buildSubagentResult } from '@tools/delegation/subagentResults';

// A tool-use flow result carrying a value captured by the submit_output
// terminal tool must surface as `.structured` on the built AgentFinalResult,
// so a workflow-script agent({ schema }) call receives it unchanged.
function toolUseFlowResult(
  structured: unknown,
): Extract<AgentFlowResult, { category: 'toolUse' }> {
  return {
    category: 'toolUse',
    outcome: 'completed',
    executionId: 'exec-structured' as ExecutionId,
    streamId: 'stream-structured' as StreamTabId,
    response: 'done',
    structured,
  };
}

describe('buildSubagentResult structured pass-through', () => {
  it('carries a captured structured value onto the final result', async () => {
    const built = await buildSubagentResult(
      'exec-structured' as ExecutionId,
      'assistant',
      toolUseFlowResult({ title: 'Lemma', count: 2 }),
      { startedAt: Date.now() },
    );

    expect(built.result.category).toBe('toolUse');
    expect(built.result.structured).toEqual({ title: 'Lemma', count: 2 });
  });

  it('omits structured when the run captured nothing', async () => {
    const built = await buildSubagentResult(
      'exec-structured' as ExecutionId,
      'assistant',
      toolUseFlowResult(undefined),
      { startedAt: Date.now() },
    );

    expect(built.result.structured).toBeUndefined();
  });
});
