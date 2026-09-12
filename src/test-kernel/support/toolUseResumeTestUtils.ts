import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { ToolUseResumeData } from '@agent/runtime/SessionResumeRetrieval';
import type { RunId } from '@shared/schemas';

/**
 * The identity a host resumes a tool-use run under: the config, the run id
 * and the conversation format its rows are in. The run's state is not part
 * of it — the loop folds that from the ledger.
 */
export function createToolUseResumeData(
  overrides: Partial<ToolUseResumeData> = {},
): ToolUseResumeData {
  return {
    type: 'toolUse',
    runId: '7e57ec000001' as RunId,
    agentConfig: AgentConfigSchema.parse({
      agent: 'test-agent',
      model: 'test-model',
      agentCategory: 'toolUse',
    }),
    modelCompatibilityKey: null,
    ...overrides,
  };
}
