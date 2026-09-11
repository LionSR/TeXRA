// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

import { Cause, Data, Effect, Exit, Fiber } from 'effect';

import { registerRun } from '@agent/storage';
import { type AgentTrace } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import {
  startChildRunLoop,
  runWithOwnedRunLeaseLaunchGuard,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import type { CurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';
import {
  describeFollowUpFailure,
  FOLLOW_UP_WAKE_FAILED_MESSAGE,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import {
  runInSession,
  getRunContextRunId,
  getRunContextWorkingDirectory,
  type RunContext,
} from '@agent/runtime/RunContext';
import {
  RUN_OUTCOME,
  ToolError,
  type RunId,
  type TokenUsageStats,
  type ToolResult,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { requireLiveRun } from '@tools/contextHelpers';
import {
  type requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { executed } from '@tools/core/result';
import { generateRunId } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { previewLabel } from '@utils/text/stringUtils';

import {
  childRunDescription,
  createChildRun,
  type ChildRun,
} from './delegation/childRun';
import type {
  AgentCliSessionEntry,
  AgentCliSessionRegistry,
} from './agentCliSessionRegistry';

/** Session-keyed registry accessor (`codexThreadsFor`/`claudeAgentSessionsFor`);
 * dispatch and loop resolve it once against the ambient session. */
type AgentCliSessionStoreAccessor = (
  session: SessionHandle,
) => AgentCliSessionRegistry;

/**
 * A Promise collaborator of the dispatch/launch chain (bash approval,
 * follow-up submission, thread/session setup, the owned-lease launch guard)
 * rejected. `cause` is what it raised. The tools' `execute()` edges re-raise
 * the cause itself, so the tool runner surfaces the same error instance the
 * collaborator raised, exactly as the previous `await` chain did.
 */
class AgentCliCallFailed extends Data.TaggedError('AgentCliCallFailed')<{
  readonly cause: unknown;
}> {}

/**
 * The one wrap of the agent-CLI chain's Promise collaborators — the shared
 * dispatch/launch steps and each provider tool's own setup (SDK import,
 * binary lookup, config/env assembly).
 */
export const agentCliCall = <A>(
  call: () => Promise<A>,
): Effect.Effect<A, AgentCliCallFailed> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new AgentCliCallFailed({ cause }),
  });

/** The failures the agent-CLI dispatch/launch chain can raise. */
export type AgentCliToolFailure = ToolError | AgentCliCallFailed;

/**
 * Re-raise a collaborator's rejection as its own cause: pipe this at the
 * tool's `execute()` edge so `runPromise` rejects with the instance the
 * collaborator raised (see ExecutionsTool for the same edge shape).
 */
export const reraiseAgentCliCallFailure = <A, R>(
  effect: Effect.Effect<A, AgentCliToolFailure, R>,
): Effect.Effect<A, ToolError, R> =>
  effect.pipe(
    Effect.catchTag('AgentCliCallFailed', (error) => Effect.die(error.cause)),
  );

/**
 * Publish a turn's token usage to the progress UI for an agent-CLI child run.
 * Shared by the codex and claudeAgent session strategies.
 */
export function publishAgentCliStreamUsage(
  runId: RunId,
  usage: TokenUsageStats,
  logger: AgentTrace,
): void {
  logger.usage({ runId, usage }, { recordTranscript: false });
}

interface AgentCliResumeLabels {
  notActiveLabel: string;
  idParamName: string;
  summaryLabel: string;
  queuedLabel: string;
}

function requireCallerOwnership(
  id: string,
  callerRunId: RunId | undefined,
  handle: RunHandle | undefined,
  labels: AgentCliResumeLabels,
): Effect.Effect<void, ToolError> {
  if (!callerRunId || !handle || handle.isOwnedBy(callerRunId)) {
    return Effect.void;
  }
  return Effect.fail(
    new ToolError(
      `${labels.notActiveLabel} '${id}' is owned by a different session; start a new session without ${labels.idParamName} to run in this context.`,
    ),
  );
}

const queueAgentCliFollowUp = Effect.fn('agentCliShared.queueAgentCliFollowUp')(
  function* (
    registry: AgentCliSessionRegistry,
    stored: AgentCliSessionEntry,
    params: {
      session: SessionHandle;
      id: string;
      prompt: string;
      callerRunId: RunId | undefined;
      labels: AgentCliResumeLabels;
    },
  ): Effect.fn.Return<ToolResult, AgentCliToolFailure> {
    const { id, prompt, callerRunId, labels } = params;
    // Ownership is a live-handle fact: a detached or re-parented child must not
    // accept follow-ups from its former orchestrator. A missing handle falls
    // through to submitFollowUp's no-session outcome below.
    yield* requireCallerOwnership(
      id,
      callerRunId,
      registry.getHandle(stored),
      labels,
    );

    const result = yield* submitFollowUp(stored.childRunId, prompt, {
      session: params.session,
    });
    if (result.status === 'failed') {
      return yield* Effect.fail(
        new ToolError(
          `${labels.notActiveLabel} '${id}' did not accept the follow-up (${result.reason}): ${describeFollowUpFailure(result.reason)}`,
        ),
      );
    }

    const preview = previewLabel(prompt);
    // A queued follow-up whose wake failed is still queued: it is delivered
    // when the agent is resumed, so the caller must not offer it again.
    const wakeFailed = result.status === 'queued' && result.wake === 'failed';
    const followUpLine = wakeFailed
      ? `Follow-up instruction queued for ${labels.queuedLabel} '${id}', but the agent could not be resumed. ${FOLLOW_UP_WAKE_FAILED_MESSAGE}`
      : `Follow-up instruction queued for ${labels.queuedLabel} '${id}'. The agent will process it and deliver a new result automatically.`;
    return executed(
      [followUpLine, `Run ID: ${stored.runId}`].join('\n'),
      `Follow-up queued for ${labels.summaryLabel}: ${preview}`,
    );
  },
);

/**
 * Atomically choose between queueing onto an owned session id and launching a
 * disk-based fallback. A failed owner releases only its own claim; waiting
 * callers then compete for the released id, so one retries the fallback while
 * the others continue waiting. A successful launch transfers the claim to its
 * loop, which promotes it after the first successful turn or releases it during
 * cleanup so an acknowledged follow-up can never be stranded behind a failed
 * initial turn.
 */
const resumeOrLaunchAgentCliSession = Effect.fn(
  'agentCliShared.resumeOrLaunchAgentCliSession',
)(function* (
  store: AgentCliSessionRegistry,
  params: {
    session: SessionHandle;
    id: string | undefined;
    prompt: string;
    callerRunId: RunId | undefined;
    labels: AgentCliResumeLabels;
    launch: (
      releaseClaim?: () => void,
    ) => Effect.Effect<ToolResult, AgentCliToolFailure>;
  },
): Effect.fn.Return<ToolResult, AgentCliToolFailure> {
  const { id } = params;
  if (!id) return yield* params.launch();

  while (true) {
    const releaseClaim = store.claim(id);
    if (releaseClaim) {
      // Any failure cause — typed or defect — releases the claim before it
      // propagates, as the previous catch-release-rethrow did.
      return yield* Effect.suspend(() => params.launch(releaseClaim)).pipe(
        Effect.onError(() => Effect.sync(() => releaseClaim())),
      );
    }

    const stored = yield* store.waitForActive(id);
    if (!stored) continue;
    return yield* queueAgentCliFollowUp(store, stored, {
      session: params.session,
      id,
      prompt: params.prompt,
      callerRunId: params.callerRunId,
      labels: params.labels,
    });
  }
});

interface AgentCliLaunchParams {
  session: SessionHandle;
  /** The launching run: the child's parent edge. */
  parentRunId: RunId;
  agentName: string;
  description: string;
  config: AgentConfig;
  registerFailedMessage: string;
  startLoop: (ctx: {
    childRun: ChildRun;
    runId: RunId;
  }) => Effect.Effect<void, Error>;
  summary: string;
  launchedLine: string;
  followUpLine: string;
}

/**
 * Register a fresh agent-CLI run, create its child stream tab, start the
 * provider's turn loop, and return the "launched" ToolResult.
 */
export const launchAgentCliSession = Effect.fn(
  'agentCliShared.launchAgentCliSession',
)(function* (
  params: AgentCliLaunchParams,
): Effect.fn.Return<ToolResult, AgentCliToolFailure> {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const runId = generateRunId();
      // An external CLI drives this agent: the CLI is both the agent name and the
      // driving tool, and `identity.tool` is what gates native-only affordances
      // (resume/rerun) off for this cohort.
      const identity = {
        kind: 'agent',
        agent: params.agentName,
        tool: params.agentName,
      } as const;

      yield* registerRun(
        params.session,
        runId,
        params.config,
        params.agentName,
        {
          identity,
          userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
          parentRunId: params.parentRunId,
          description: childRunDescription(params.description),
        },
      ).pipe(
        Effect.mapError(
          (error) =>
            new ToolError(
              `${params.registerFailedMessage} ${toErrorMessage(error)}`,
              { cause: error },
            ),
        ),
      );
      // The launch guard owns the release-on-failure policy for every launch site
      // (bash background, the two detached child paths, and this one): a failed
      // launch must not leave a record that refuses a relaunch for the rest of the
      // process's life.
      const childRun = yield* runWithOwnedRunLeaseLaunchGuard(
        params.session,
        runId,
        Effect.gen(function* () {
          yield* restore(Effect.void);
          const stream = yield* createChildRun(
            params.session,
            runId,
            params.parentRunId,
            {
              run: identity,
              userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
              description: params.description,
              config: params.config,
            },
          );
          const started = yield* Effect.exit(
            Effect.suspend(() => params.startLoop({ childRun: stream, runId })),
          );
          if (Exit.isFailure(started)) {
            const startError = Cause.squash(started.cause);
            const finalized = yield* Effect.exit(
              stream.finalize({
                outcome: RUN_OUTCOME.FAILED,
                error: startError,
                persistence: { kind: 'finalize', flowRecord: 'delete' },
              }),
            );
            if (Exit.isFailure(finalized)) {
              return yield* Effect.fail(
                new AggregateError(
                  [startError, Cause.squash(finalized.cause)],
                  `Agent CLI run ${runId} failed and its child stream could not be finalized`,
                ),
              );
            }
            return yield* Effect.fail(ensureError(startError));
          }
          return stream;
        }),
      ).pipe(
        Effect.uninterruptible,
        Effect.mapError((cause) => new AgentCliCallFailed({ cause })),
      );

      return executed(
        [
          params.launchedLine,
          `Run ID: ${runId}`,
          `Stream tab: ${childRun.childRunId}`,
          params.followUpLine,
        ].join('\n'),
        params.summary,
      );
    }),
  );
});

/**
 * Run the shared agent-CLI execute() prelude: refuse a run that cannot collect
 * the result, request bash approval for the labelled command, fire the
 * post-approval in-progress hook, then dispatch to the resume/launch branch
 * with the active run context.
 *
 * Both agent-CLI tools deliver every turn as a follow-up message. A run with
 * `stopAfterCycle` ends after the current cycle, so that follow-up would land
 * in a turn that never happens and the child's result is stranded. Fail before
 * prompting for approval rather than launching work nobody collects.
 */
const withAgentCliApproval = Effect.fn('agentCliShared.withAgentCliApproval')(
  function* (
    toolName: string,
    approvalLabel: string,
    contexts: CurrentToolContexts | undefined,
    requestApproval: typeof requestBashApproval,
    run: (
      runContext: RunContext | undefined,
    ) => Effect.Effect<ToolResult, AgentCliToolFailure>,
  ): Effect.fn.Return<ToolResult, AgentCliToolFailure> {
    if (contexts?.runContext?.stopAfterCycle) {
      return yield* Effect.fail(
        new ToolError(
          `${toolName} is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Delegate with delegate_agent, which returns the child's result directly.`,
        ),
      );
    }

    const approval = yield* agentCliCall(() =>
      requestApproval({ command: approvalLabel }),
    );
    if (approval.action !== 'approve') {
      return buildBashApprovalRejectedResult(approvalLabel, approval);
    }

    contexts?.callContext?.hooks?.onRunReady?.();
    return yield* run(contexts?.runContext);
  },
);

/** Run context resolved for an agent-CLI launch, handed to the provider's
 * `launch` callback by {@link dispatchAgentCliTool}. */
interface AgentCliLaunchContext {
  parentRunId: RunId;
  parentWorkingDirectory: string | undefined;
  /** Release the disk-based fallback claim if the launch fails before promoting
   * it. Undefined for a fresh (non-resumed) launch. */
  releaseFallbackClaim: (() => void) | undefined;
}

/**
 * The shared execute() dispatch skeleton for an agent-CLI tool. Wraps the
 * boilerplate-identical chain both providers (codex, claudeAgent) run: request
 * approval for the labelled command, choose atomically between queueing onto an
 * owned session and launching a disk-based fallback, and resolve the run context
 * a launch needs (parent stream/run/working-directory). A missing
 * in-memory entry denotes a disk-based SDK fallback, so `launch` receives the
 * `releaseFallbackClaim` it must promote or release. Callers supply only their
 * approval label, session store, resume id, resume labels, and the
 * provider-specific launch.
 *
 * The returned Effect is the tool's whole dispatch: the tool's `execute()`
 * runs it at its own edge with {@link reraiseAgentCliCallFailure} piped in.
 */
export function dispatchAgentCliTool(params: {
  session: SessionHandle;
  contexts: CurrentToolContexts | undefined;
  /** Bound at the tool entry so approval retains the parent run's policy. */
  requestApproval: typeof requestBashApproval;
  agentName: string;
  approvalLabel: string;
  store: AgentCliSessionStoreAccessor;
  resumeId: string | undefined;
  /** Existing live session read by a fresh launch, such as a fork source. */
  sourceId?: string;
  prompt: string;
  labels: AgentCliResumeLabels;
  launch: (
    context: AgentCliLaunchContext,
  ) => Effect.Effect<ToolResult, AgentCliToolFailure>;
}): Effect.Effect<ToolResult, AgentCliToolFailure> {
  const {
    agentName,
    approvalLabel,
    store,
    resumeId,
    sourceId,
    prompt,
    labels,
    launch,
  } = params;
  return withAgentCliApproval(
    agentName,
    approvalLabel,
    params.contexts,
    params.requestApproval,
    (runContext) =>
      Effect.gen(function* () {
        const registry = store(params.session);
        const callerRunId = getRunContextRunId(runContext);
        if (sourceId) {
          yield* requireCallerOwnership(
            sourceId,
            callerRunId,
            registry.getHandle(registry.lookup(sourceId)),
            labels,
          );
        }
        return yield* resumeOrLaunchAgentCliSession(registry, {
          session: params.session,
          id: resumeId,
          prompt,
          callerRunId,
          labels,
          launch: (releaseFallbackClaim) => {
            // A missing in-memory entry denotes a disk-based SDK fallback.
            // requireLiveRun throws its ToolError synchronously; as a defect
            // it still reaches the tool runner as the same instance and the
            // claim-release in resumeOrLaunchAgentCliSession still fires
            // (onError observes every cause).
            const { runId } = requireLiveRun(agentName, runContext);
            return launch({
              parentRunId: runId,
              parentWorkingDirectory: getRunContextWorkingDirectory(runContext),
              releaseFallbackClaim,
            });
          },
        });
      }),
  );
}

// ============================================================================
// Shared session loop — one turn per enqueued prompt, delivers to parent
// ============================================================================

/** Minimal token-usage shape the loop's turn summary needs. Structurally
 * compatible with `ChildRunStrategy`'s own (unexported) turn-usage type. */
interface AgentCliTurnUsage {
  input_tokens?: number;
  output_tokens?: number;
}

interface AgentCliLoopParams<TTurn> {
  session: SessionHandle;
  childRun: ChildRun;
  parentRunId: RunId;
  runId: RunId;
  /** Passed through to `startChildRunLoop` (registry lookups, log labels). */
  agentName: string;
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  stageLabel: string;
  initialPrompt: string;
  /** Session/thread registry the loop tracks in-flight and successful turns in. */
  store: AgentCliSessionStoreAccessor;
  /**
   * The disk-based fallback session/thread id claimed synchronously before the
   * loop starts, if any. Release it if the loop exits before promoting it.
   */
  releaseFallbackClaim: (() => void) | undefined;
  /** Provider-specific single-turn run, given the joined follow-up prompt. */
  runProviderTurn: (
    prompt: string,
    ports: ChildRunPorts,
    signal: AbortSignal,
  ) => Promise<TTurn>;
  /**
   * Session/thread ids to register as active after a successful turn. Falsy
   * entries (not-yet-known ids) are skipped.
   */
  resolveSessionIds: (turn: TTurn) => readonly (string | null | undefined)[];
  /** Token usage for the turn summary (null when none). */
  getUsage: (turn: TTurn) => AgentCliTurnUsage | null;
  /** Usage-stats payload to publish to the UI, or undefined to skip publishing. */
  buildUsageStats: (turn: TTurn) => TokenUsageStats | undefined;
  formatDelivery: (
    turn: TTurn,
    wallTimeMs: number,
    lastPrompt: string,
  ) => string;
  formatError: (turn: TTurn | null, err: unknown, lastPrompt: string) => string;
  /** Omitted by providers (codex) that always throw on failure. */
  isTurnError?: (turn: TTurn) => boolean;
  onTurnError?: (turn: TTurn, logger: AgentTrace) => void;
  /** Logged if the loop's completion promise rejects after launch. */
  loopFailedMessage: string;
}

/**
 * Run the shared agent-CLI session loop. `startChildRunLoop` processes prompts
 * from the child's follow-up queue one at a time and delivers each turn's
 * result to the parent's follow-up queue; this wraps that with the scaffolding
 * common to every agent-CLI provider (codex, claudeAgent): a dedup'd
 * session/thread registration closure, the `lastPrompt` capture feeding
 * `formatDelivery`/`formatError`, and the boilerplate-identical
 * `ChildRunStrategy` fields (`isTerminal`, `getUsage`, `onLoopStart`,
 * `onTurnSuccess`, `publishUsage`, `releaseSessionOwnership`). Callers supply
 * only their provider-specific turn run, usage/delivery formatting, and
 * registry entry construction.
 */
export function startAgentCliLoop<TTurn>(
  params: AgentCliLoopParams<TTurn>,
): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    const {
      childRun,
      parentRunId,
      runId,
      agentName,
      stageLabel,
      initialPrompt,
      store,
      releaseFallbackClaim,
      runProviderTurn,
      resolveSessionIds,
      getUsage,
      buildUsageStats,
      formatDelivery,
      formatError,
      isTurnError,
      onTurnError,
      loopFailedMessage,
    } = params;
    const { childRunId, logger } = childRun;
    const registry = store(params.session);

    // The one entry this loop registers and tracks: the child run's identity
    // and follow-up address. Live handles are resolved by the registry itself.
    const target: AgentCliSessionEntry = { childRunId, runId };

    // Fresh and resumed session/thread ids are registered after the first
    // successful turn is persisted, immediately before its result reaches the
    // parent.
    const registerSessionId = (id: string): void => {
      if (registry.lookup(id)) return;
      registry.register(id, target);
    };

    // The joined prompt text for whichever turn is currently in flight;
    // captured here (rather than threaded through the loop contract) since
    // `formatDelivery`/`formatError` run strictly after the turn that set it.
    let lastPrompt = initialPrompt;
    const runTurn = (
      followUps: readonly FollowUpQueueBatchItem[],
      ports: ChildRunPorts,
      signal: AbortSignal,
    ): Effect.Effect<TTurn, Error> =>
      Effect.tryPromise({
        try: () => {
          lastPrompt = followUps.map((f) => f.text).join('\n\n');
          return runInSession(params.session, () =>
            runProviderTurn(lastPrompt, ports, signal),
          );
        },
        catch: ensureError,
      });

    const strategy: ChildRunStrategy<TTurn> = {
      stageLabel,
      launch: (ports, signal) =>
        runTurn([{ text: initialPrompt, origin: 'user' }], ports, signal),
      runTurn,
      isTerminal: () => false,
      getUsage,
      isTurnError,
      onTurnError,
      onLoopStart: () => {
        registry.trackInFlight(target);
      },
      onTurnSuccess: (turn) => {
        for (const id of resolveSessionIds(turn)) {
          if (id) registerSessionId(id);
        }
      },
      publishUsage: (turn) => {
        const usage = buildUsageStats(turn);
        if (usage) {
          publishAgentCliStreamUsage(runId, usage, logger);
        }
      },
      formatDelivery: (turn, wallTimeMs) =>
        formatDelivery(turn, wallTimeMs, lastPrompt),
      formatError: (turn, err) => formatError(turn, err, lastPrompt),
      releaseSessionOwnership: () => {
        releaseFallbackClaim?.();
        registry.releaseByRunId(runId);
      },
    };

    const completion = yield* startChildRunLoop({
      session: params.session,
      childRun,
      parentRunId,
      runId,
      agentName,
      strategy,
    });
    yield* Effect.forkDetach(
      Fiber.join(completion).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            logger.error(loopFailedMessage, { data: Cause.squash(cause) });
          }),
        ),
      ),
    );
  }).pipe(Effect.uninterruptible);
}
