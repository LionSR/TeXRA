import { Effect, SubscriptionRef } from 'effect';

import { registerRun } from '@agent/storage';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ProcessServices } from '@platform/processRuntime';
import { Secrets } from '@platform/secrets';
import {
  APPROVAL_BYPASS_KINDS,
  NO_APPROVAL_GRANTS,
} from '@shared/approvalBypassKind';
import { inheritedGrants, stricterPolicy } from '@shared/approvalBypassKind';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { type RunId, USER_FOLLOW_UP_SUPPORT } from '@shared/schemas';
import { generateRunId } from '@utils/core';
import { humanGrant } from './runApprovalQueue';
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
      | 'tools'
      | 'ownApiKeyFallback'
      | 'onRun'
      | 'onRunResolved'
      | 'onTraceEvent'
      | 'publishWorkflowOutput'
    >,
    RunTerminalOwner {
  readonly session: SessionHandle;
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
  /**
   * The chat's previous root: this run starts with the human grants that
   * run held, so a conversation keeps the grants its earlier rounds made.
   */
  continues?: RunId;
  /** An Auto-approve launch: the run starts with every bypass granted, in
   *  its `run.start`, so no approval opens ahead of the grant. */
  approveDelegatedWork?: boolean;
  /**
   * The policy the launch asked for (a CLI flag, `--no-input`). Stricter
   * than the session's, it becomes the run's launch limit on its
   * `run.start`, narrowing the run and its descendants only; a more
   * permissive one is ignored, since a launch never widens the project's.
   */
  approvalPolicy?: TexraApprovalPolicy;
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
    continues,
    approveDelegatedWork,
    approvalPolicy,
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
        suppressErrorNotification,
      });
      const userFollowUpSupport =
        definition.config.script == null &&
        executeAgentOptions.stopAfterCycle !== true
          ? USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE
          : USER_FOLLOW_UP_SUPPORT.UNSUPPORTED;
      const launchGrants = approveDelegatedWork
        ? humanGrant(APPROVAL_BYPASS_KINDS, true)(NO_APPROVAL_GRANTS)
        : NO_APPROVAL_GRANTS;
      const grants =
        continues !== undefined && continues !== runId
          ? inheritedGrants(
              SubscriptionRef.getUnsafe(runSession.view.ref),
              continues,
            )
          : launchGrants;
      // Only a strictly stricter request narrows; the limit then holds
      // even if the project's policy is widened later.
      const project =
        approvalPolicy === undefined
          ? undefined
          : runSession.approvals.policy();
      const limit =
        approvalPolicy === undefined ||
        project === undefined ||
        stricterPolicy(approvalPolicy, project) === project
          ? undefined
          : stricterPolicy(approvalPolicy, grants.limit ?? approvalPolicy);
      yield* registerRun(runSession, runId, definition.config, {
        identity: { kind: 'agent', agent: definition.config.agent },
        userFollowUpSupport,
        grants: limit === undefined ? grants : { ...grants, limit },
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
