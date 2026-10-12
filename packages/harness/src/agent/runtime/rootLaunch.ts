import { Effect, Fiber, SubscriptionRef } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { SessionOwner } from '@platform/processRuntime';
import { Secrets } from '@platform/secrets';
import {
  APPROVAL_BYPASS_KINDS,
  inheritedGrants,
  NO_APPROVAL_GRANTS,
  type ApprovalPolicyLimit,
} from '@shared/approvalBypassKind';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { type RunId, USER_FOLLOW_UP_SUPPORT } from '@shared/schemas';
import { generateRunId } from '@utils/core';
import { humanGrant } from './runApprovalQueue';
import { prepareAgentDefinition } from './AgentLaunchContext';
import { runWithLaunchGuard, type RunTerminalOwner } from './runLaunchGuard';
import { executeAgent, type ExecuteAgentOptions } from './executeAgent';
import { applyHelperModelPreference } from './helperModelName';
import { registryOf } from './runRegistry';
import { presentRunFailure } from './terminalResultToast';
import type { SessionHandle } from './SessionHandle';
import type { RunEndResult } from './RunEndResult';

/**
 * Options for a root launch (`Runs.launch({ request, options })`). Fields
 * shared with the lower-level `executeAgent` are picked from
 * `ExecuteAgentOptions` (and forwarded as-is) so the two option types can't
 * drift apart silently; see that interface for their docs.
 */
export interface RootLaunchOptions
  extends
    Pick<
      ExecuteAgentOptions,
      | 'stopAfterCycle'
      | 'tools'
      | 'ownApiKeyFallback'
      | 'onRun'
      | 'onAdmitted'
      | 'publishWorkflowOutput'
    >,
    RunTerminalOwner {
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
   * The policy the launch asked for explicitly (a CLI flag, its env
   * variable, `--no-input`, a chat's `/approval`). Unless it is
   * Auto-approve, it is the run's launch limit on its `run.start`: the run
   * and its descendants run under the stricter of it and the project's
   * policy, for good. A launch never widens the project's policy.
   */
  approvalPolicy?: TexraApprovalPolicy;
}

/** A fresh launch; a persisted run resumes through `resumeRun`. */
export interface RootLaunchRequest {
  readonly config: AgentConfig;
  /** The id to register the run under; one is minted when omitted. */
  readonly runId?: RunId;
}

/**
 * START HERE — a root launch, what `Runs.launch({ request, options })` runs
 * (its session's `programs.root`): the composition root's `SessionOwner`
 * must still hold the session; the run id is minted when the request names
 * none; the run is admitted at the session's door and awaited, the caller's
 * interruption stopping it. A run that fails before it opens has no row to
 * present it: its launch does, once, unless the caller presents it.
 *
 * Use `Runs.launch` unless you need per-chunk streaming/lifecycle callbacks
 * or subagent lineage; for those, drop to the lower-level `executeAgent`,
 * where the caller owns runId generation and the registration.
 */
export const rootRun = Effect.fn('rootRun')(
  function* (
    request: RootLaunchRequest,
    options: RootLaunchOptions & { readonly session: SessionHandle },
  ): Effect.fn.Return<RunEndResult, Error, SessionOwner> {
    const { session } = options;
    if (!(yield* (yield* SessionOwner).holds(session)))
      return yield* Effect.fail(
        new Error('This session is closed; open it again to launch a run.'),
      );
    const runId = request.runId ?? generateRunId();
    const fiber = yield* registryOf(session.runs).start(
      runId,
      admittedRun(runId, request, options),
      (run) => run,
    );
    return yield* Fiber.join(fiber).pipe(
      Effect.onInterrupt(() => Fiber.interrupt(fiber)),
    );
  },
  (launch, _request, options) =>
    launch.pipe(
      Effect.tapError((error) =>
        options.suppressErrorNotification === true
          ? Effect.void
          : presentRunFailure(options.session.interactions, error),
      ),
    ),
);

/**
 * The run a root launch admits, on the launched fiber: it resolves the model
 * and runs the run under the launch terminal ({@link runWithLaunchGuard}),
 * which awaits the host's `beforeRunEnd` before the run's claim goes. The
 * run is born with its opening, so a launch that fails before it leaves no
 * run: its failure is the launch's.
 */
const admittedRun = Effect.fn('admittedRun')(function* (
  runId: RunId,
  request: RootLaunchRequest,
  options: RootLaunchOptions & { readonly session: SessionHandle },
) {
  const {
    beforeRunEnd,
    preferHelperModel,
    suppressErrorNotification,
    continues,
    approveDelegatedWork,
    approvalPolicy,
    ...executeAgentOptions
  } = options;
  const runSession = options.session;
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
  // A chat round takes the human grants of the round it continues, never
  // its launch limit: the round asks with the chat's policy now, which also
  // bounds what it inherits. An Auto-approve launch grants every bypass;
  // any other explicit policy drops the bypasses a round inherits, so a
  // chat that left Auto-approve is asked again.
  const continuing = continues !== undefined && continues !== runId;
  const inherited = continuing
    ? inheritedGrants(SubscriptionRef.getUnsafe(runSession.view.ref), continues)
    : NO_APPROVAL_GRANTS;
  const capped = continuing && approvalPolicy !== undefined;
  const { limit: _previous, ...grants } =
    approveDelegatedWork || capped
      ? humanGrant(
          APPROVAL_BYPASS_KINDS,
          approveDelegatedWork === true,
        )(inherited)
      : inherited;
  // A policy the launch asked for, Auto-approve aside, is the run's
  // limit whatever the project's is now, so widening the project's
  // policy later never widens this run.
  const limit: ApprovalPolicyLimit | undefined =
    approvalPolicy === 'yolo' ? undefined : approvalPolicy;
  return yield* runWithLaunchGuard(
    runSession,
    runId,
    executeAgent(definition, runId, {
      ...executeAgentOptions,
      registration: {
        identity: { kind: 'agent', agent: definition.config.agent },
        userFollowUpSupport,
        grants: limit === undefined ? grants : { ...grants, limit },
      },
    }),
    { beforeRunEnd },
  );
});
