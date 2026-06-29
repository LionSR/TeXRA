import { registerExecution } from '@agent/storage';

import type { ValidatedExecutionRequest } from '@agent/core/state/executionRequests';
import type { ExecutionId } from '@shared/schemas';
import { generateExecutionId } from '@utils/core/executionId';
import { preferHelperModelForAssistive } from './assistiveModel';
import { executeAgent } from './executeAgent';
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { AgentFlowResult, WorkflowFlowResult } from './AgentFlowResult';
import type { AgentRunHandle } from './executionRegistry';
import type { SessionHandle } from './SessionHandle';

export interface RunAgentOptions {
  runtimeHost: AgentRuntimeHost;
  openWorkflowOutput?: (result: WorkflowFlowResult) => Promise<void>;
  enforceCategory?: boolean;
  registerExecution?: boolean;
  stopAfterCycle?: boolean;
  approvalPromptsUnavailable?: boolean;
  runtimeUnavailableTools?: readonly string[];
  /** Session owning this run's coordination state. Defaults to the process session. */
  session?: SessionHandle;
  /**
   * Fires once with the live per-run handle right after it is tracked (F-2):
   * `handle.result` settles with the terminal outcome, `handle.trace` is the
   * run's event channel, and the handle can interrupt via the session. The
   * returned promise is unchanged — this is additive, post-launch exposure.
   */
  onRun?: (handle: AgentRunHandle) => void | Promise<void>;
}

/**
 * START HERE — the high-level entry every host uses to run an agent.
 *
 * Validates-then-runs: assigns an executionId when the request omits one (a
 * fresh run), registers fresh runs in the execution store (resume reuses the
 * record; override via `registerExecution`), runs the agent, and — for a
 * workflow result — invokes `openWorkflowOutput` so the host can surface output.
 *
 * Use this unless you need per-chunk streaming/lifecycle callbacks or subagent
 * lineage; for those, drop to the lower-level engine `executeAgent` (exported
 * as `runAgentStream` from `@texra/core`), where the caller owns executionId
 * generation and `registerExecution`.
 */
export async function runAgent(
  request: ValidatedExecutionRequest,
  options: RunAgentOptions,
): Promise<AgentFlowResult> {
  const executionId =
    request.executionId ?? (generateExecutionId() as ExecutionId);
  const shouldRegister =
    options.registerExecution ?? request.executionId === undefined;

  // Root (user-initiated) launches route through here; orchestrator delegations
  // call executeAgent directly. So an assistive agent prefers the helper model
  // only when the user starts it, never when an orchestrator delegates to it.
  // Resolved before registerExecution so the stored record and the run agree.
  const config = await preferHelperModelForAssistive(request.config);

  if (shouldRegister) {
    await registerExecution(
      executionId,
      config,
      config.agent,
      undefined,
      config.agentCategory,
    );
  }

  const result = await executeAgent(config, executionId, {
    runtimeHost: options.runtimeHost,
    enforceCategory: options.enforceCategory,
    stopAfterCycle: options.stopAfterCycle,
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
    session: options.session,
    onRun: options.onRun,
  });
  if (result.category === 'workflow') {
    await options.openWorkflowOutput?.(result);
  }
  return result;
}
