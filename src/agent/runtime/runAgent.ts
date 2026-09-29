import { Effect } from 'effect';

import { registerRun } from '@agent/storage';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ProcessServices } from '@platform/processRuntime';
import { Secrets } from '@platform/secrets';
import {
  AgentCategory,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { generateRunId } from '@utils/core';
import { prepareAgentDefinition } from './AgentLaunchContext';
import { runWithLaunchGuard, type RunTerminalOwner } from './runLaunchGuard';
import { applyHelperModelPreference } from './helperModelPreference';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import type { SessionHandle } from './SessionHandle';
import type { RunEndResult } from './RunEndResult';

/**
 * Options for `runAgent`. Fields shared with the lower-level `executeAgent`
 * are picked from `ExecuteAgentOptions` (and forwarded as-is) so the two
 * option types can't drift apart silently; see that interface for their docs.
 */
export interface RunAgentOptions
  extends
    Pick<
      ExecuteAgentOptions,
      | 'stopAfterCycle'
      | 'onApprovalPolicyDenial'
      | 'tools'
      | 'ownApiKeyFallback'
      | 'onRun'
      | 'onRunResolved'
      | 'onTraceEvent'
      | 'publishWorkflowOutput'
    >,
    RunTerminalOwner {
  readonly session: SessionHandle;
  /** Reject an explicitly supplied category that differs from the resolved definition. */
  readonly enforceCategory?: boolean;
  /**
   * The caller owns presentation for failures before registration; after
   * that the run's `result` event presents.
   */
  suppressErrorNotification?: boolean;
  /**
   * Opt-in set by the "fix LaTeX" VS Code actions (Fix-Compilation command, the
   * progress-view compile fixer): run the launched agent on the configured
   * helper model instead of the selected one. Off for a direct main-view launch,
   * the CLI, and orchestrator delegations, which all keep the chosen model.
   */
  preferHelperModel?: boolean;
}

/** A fresh launch; a persisted run resumes through `resumeRun`. */
export interface RunAgentRequest {
  readonly config: AgentConfig;
  /** The id to register the run under; one is minted when omitted. */
  readonly runId?: RunId;
}

/**
 * START HERE — the high-level entry every host uses to run an agent.
 *
 * Assigns a runId when the request omits one, then launches the run through
 * the session's one door (`Runs.launch`), awaited: a stop by run id
 * (`RunRegistry.interrupt`) or the caller's interruption reaches the run
 * wherever it has got to. On the launched fiber it resolves the model,
 * registers the run and runs it under the launch terminal
 * ({@link runWithLaunchGuard}), which holds the run's claim for the run's
 * whole life and, on every exit, ends what the lifecycle did not, awaits the
 * host's `beforeRunEnd` and commits the run's ending before the claim goes.
 * Presenting the result is the caller's, once this returns.
 *
 * Use this unless you need per-chunk streaming/lifecycle callbacks or subagent
 * lineage; for those, drop to the lower-level engine `executeAgent`, where the
 * caller owns runId generation and `registerRun`.
 */
export const runAgent = Effect.fn('runAgent')(function* (
  request: RunAgentRequest,
  options: RunAgentOptions,
): Effect.fn.Return<RunEndResult, Error, ProcessServices> {
  const {
    beforeRunEnd,
    onRunClaimed,
    preferHelperModel,
    suppressErrorNotification,
    ...executeAgentOptions
  } = options;
  const runSession = options.session;
  const runId = request.runId ?? generateRunId();
  return yield* runSession.runs.launchRun(
    runId,
    Effect.gen(function* () {
      // Resolve the selected model before registering the run. The helper
      // model swap reads the enabled-model list, the routing switches and the
      // provider keys, so it takes this session's setting slots and the
      // process secret store.
      const config = preferHelperModel
        ? yield* applyHelperModelPreference(request.config, {
            ...runSession.roots,
            secrets: yield* Secrets,
          })
        : request.config;
      const definition = yield* prepareAgentDefinition({
        config,
        session: runSession,
        enforceCategory: options.enforceCategory,
        suppressErrorNotification,
      });
      const userFollowUpSupport =
        definition.config.agentCategory === AgentCategory.ToolUse &&
        executeAgentOptions.stopAfterCycle !== true
          ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
          : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
      yield* registerRun(runSession, runId, definition.config, {
        identity: { kind: 'agent', agent: definition.config.agent },
        userFollowUpSupport,
      });
      return yield* runWithLaunchGuard(
        runSession,
        runId,
        executeAgent(definition, runId, executeAgentOptions),
        { beforeRunEnd, onRunClaimed },
      );
    }),
  );
});
