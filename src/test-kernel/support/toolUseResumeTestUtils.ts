import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import type { ResumeTurnIdentity } from '@agent/runtime/executeAgent';
import type { RunId } from '@shared/schemas';

/**
 * The identity a host resumes a tool-use run under: the config and the run
 * id. The run's state and route are not part of it — the loop folds them
 * from the run history.
 */
export function createToolUseResumeData(
  overrides: Partial<ResumeTurnIdentity> = {},
): ResumeTurnIdentity {
  return {
    runId: '7e57ec000001' as RunId,
    agentConfig: AgentConfigSchema.parse({
      agent: 'test-agent',
      model: 'test-model',
    }),
    ...overrides,
  };
}
