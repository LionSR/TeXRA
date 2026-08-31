import { describe, expect, it } from 'vitest';

import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import { selectAutoOpenFinalOutput } from '@agent/runtime/selectAutoOpenFinalOutput';
import {
  RUN_OUTCOME,
  type ExecutionId,
  type OutputFileSummary,
  type StreamTabId,
} from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';

const OUTPUT = {
  round: 0,
  relativePath: 'result.pdf',
  absolutePath: '/tmp/result.pdf',
  location: 'runStorage',
  originalPath: null,
  added: null,
  removed: null,
} satisfies OutputFileSummary;

function workflowResult(
  outcome: WorkflowFlowResult['outcome'],
): WorkflowFlowResult {
  return {
    category: 'workflow',
    outcome,
    executionId: 'auto-open-output' as ExecutionId,
    streamId: 'workflow@gpt54#auto-open-output' as StreamTabId,
    outputs: [OUTPUT],
    compileFailures: [],
  };
}

describe('selectAutoOpenFinalOutput', () => {
  setupPlatform({
    config: { 'texra.agentOutputs.autoOpenFinal': true },
  });

  it.each([RUN_OUTCOME.CANCELLED, RUN_OUTCOME.FAILED])(
    'does not select partial output from a %s workflow',
    (outcome) => {
      expect(
        selectAutoOpenFinalOutput(workflowResult(outcome)),
      ).toBeUndefined();
    },
  );
});
