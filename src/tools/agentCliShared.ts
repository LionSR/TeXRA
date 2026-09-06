// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

import { Data, Effect } from 'effect';

import { registerExecution } from '@agent/storage';
import { type AgentTrace } from '@agent/trace';
import { runWithOwnedExecutionLeaseLaunchGuard } from '@agent/storage/executionLease';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import {
  currentSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import type { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { getStreamTabId } from '@agent/runtime/streamTab';
import {
  startChildRunLoop,
  type ChildRunPorts,
  type ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import { getCurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';
import {
  describeFollowUpFailure,
  FOLLOW_UP_WAKE_FAILED_MESSAGE,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import type { FollowUpQueueBatchItem } from '@agent/followUp/FollowUpQueue';
import {
  getRunContextExecutionId,
  getRunContextStreamId,
  getRunContextWorkingDirectory,
  type RunContext,
} from '@agent/runtime/RunContext';
import {
  RUN_OUTCOME,
  ToolError,
  type ExecutionId,
  type StreamTabId,
  type TokenUsageStats,
  type ToolResult,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { requireRunStream } from '@tools/contextHelpers';
import {
  requestBashApproval,
  buildBashApprovalRejectedResult,
} from '@tools/approval/bashApproval';
import { executed } from '@tools/core/result';
import { generateExecutionId } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { truncateWithEllipsis } from '@utils/text/stringUtils';

import {
  childStreamDescription,
  createChildStream,
  type ChildStream,
} from './delegation/childStream';
import {
  AgentCliSessionRegistry,
  type AgentCliSessionEntry,
  type AgentCliSessions,
} from './agentCliSessionRegistry';

/** Session-keyed registry accessor (`codexThreadsFor`/`claudeAgentSessionsFor`);
 * dispatch and loop resolve it once against the ambient session. */
export type AgentCliSessionStoreAccessor = (
  session: SessionHandle,
) => AgentCliSessions;

/**
 * A call this module makes into a still-Promise collaborator — the approval
 * prompt, the follow-up submission, the provider's own launch — rejected.
 * Each site re-raises `cause` once it has done its own cleanup, so the tool
 * surfaces the error the collaborator raised and not a wrapper.
 */
class AgentCliCallFailed extends Data.TaggedError('AgentCliCallFailed')<{
  readonly cause: unknown;
}> {}

const agentCliCall = <A>(
  call: () => Promise<A>,
): Effect.Effect<A, AgentCliCallFailed> =>
  Effect.tryPromise({
    try: call,
    catch: (cause) => new AgentCliCallFailed({ cause }),
  });

/**
 * Publish a turn's token usage to the progress UI for an agent-CLI child stream.
 * Shared by the codex and claudeAgent session strategies.
 */
export function publishAgentCliStreamUsage(
  childStreamId: StreamTabId,
  executionId: ExecutionId,
  usage: TokenUsageStats,
  logger: AgentTrace,
): void {
  logger.usage(
    {
      streamId: childStreamId,
      storageKey: executionId,
      usage,
    },
    { recordTranscript: false },
  );
}

interface AgentCliResumeLabels {
  notActiveLabel: string;
  idParamName: string;
  summaryLabel: string;
  queuedLabel: string;
}

function requireCallerOwnership(
  id: string,
  callerStreamId: StreamTabId | undefined,
  handle: AgentExecutionHandle | undefined,
  labels: AgentCliResumeLabels,
): Effect.Effect<void, ToolError> {
  if (!callerStreamId || !handle || handle.isOwnedBy(callerStreamId)) {
    return Effect.void;
  }
  return Effect.fail(
    new ToolError(
      `${labels.notActiveLabel} '${id}' is owned by a different session; start a new session without ${labels.idParamName} to run in this context.`,
    ),
  );
}

const queueAgentCliFollowUp = Effect.fn('agentCli.queueFollowUp')(function* (
  stored: AgentCliSessionEntry,
  params: {
    id: string;
    prompt: string;
    callerStreamId: StreamTabId | undefined;
    labels: AgentCliResumeLabels;
  },
) {
  const registry = yield* AgentCliSessionRegistry;
  const { id, prompt, callerStreamId, labels } = params;
  // Ownership is a live-handle fact: a detached or re-parented child must not
  // accept follow-ups from its former orchestrator. A missing handle falls
  // through to submitFollowUp's no-session outcome below.
  yield* requireCallerOwnership(
    id,
    callerStreamId,
    registry.getHandle(stored),
    labels,
  );

  const result = yield* agentCliCall(() =>
    submitFollowUp(stored.childStreamId, prompt, {
      session: currentSession(),
    }),
  );
  if (result.status === 'failed') {
    return yield* Effect.fail(
      new ToolError(
        `${labels.notActiveLabel} '${id}' did not accept the follow-up (${result.reason}): ${describeFollowUpFailure(result.reason)}`,
      ),
    );
  }

  const preview = truncateWithEllipsis(prompt, 60);
  // A queued follow-up whose wake failed is still queued: it is delivered
  // when the agent is resumed, so the caller must not offer it again.
  const wakeFailed = result.status === 'queued' && result.wake === 'failed';
  const followUpLine = wakeFailed
    ? `Follow-up instruction queued for ${labels.queuedLabel} '${id}', but the agent could not be resumed. ${FOLLOW_UP_WAKE_FAILED_MESSAGE}`
    : `Follow-up instruction queued for ${labels.queuedLabel} '${id}'. The agent will process it and deliver a new result automatically.`;
  return executed(
    [followUpLine, `Execution ID: ${stored.executionId}`].join('\n'),
    `Follow-up queued for ${labels.summaryLabel}: ${preview}`,
  );
});

/**
 * Atomically choose between queueing onto an owned session id and launching a
 * disk-based fallback. A failed owner releases only its own claim; waiting
 * callers then compete for the released id, so one retries the fallback while
 * the others continue waiting. A successful launch transfers the claim to its
 * loop, which promotes it after the first successful turn or releases it during
 * cleanup so an acknowledged follow-up can never be stranded behind a failed
 * initial turn.
 */
const resumeOrLaunchAgentCliSession = Effect.fn('agentCli.resumeOrLaunch')(
  function* (params: {
    id: string | undefined;
    prompt: string;
    callerStreamId: StreamTabId | undefined;
    labels: AgentCliResumeLabels;
    launch: (releaseClaim?: () => void) => Promise<ToolResult>;
  }) {
    const store = yield* AgentCliSessionRegistry;
    const { id } = params;
    if (!id) return yield* agentCliCall(() => params.launch());

    while (true) {
      const releaseClaim = store.claim(id);
      if (releaseClaim) {
        return yield* agentCliCall(() => params.launch(releaseClaim)).pipe(
          Effect.catchTag('AgentCliCallFailed', (failure) => {
            releaseClaim();
            return Effect.die(failure.cause);
          }),
        );
      }

      const stored = yield* store.waitForActive(id);
      if (!stored) continue;
      return yield* queueAgentCliFollowUp(stored, {
        id,
        prompt: params.prompt,
        callerStreamId: params.callerStreamId,
        labels: params.labels,
      });
    }
  },
);

interface AgentCliLaunchParams {
  parentStreamId: StreamTabId;
  parentExecutionId: ExecutionId | undefined;
  agentName: string;
  streamPrefix: string;
  description: string;
  config: AgentConfig;
  registerFailedMessage: string;
  startLoop: (ctx: {
    childStream: ChildStream;
    executionId: ExecutionId;
  }) => void | Promise<void>;
  summary: string;
  launchedLine: string;
  followUpLine: string;
}

/**
 * Register a fresh agent-CLI execution, create its child stream tab, start the
 * provider's turn loop, and return the "launched" ToolResult.
 */
export async function launchAgentCliSession(
  params: AgentCliLaunchParams,
): Promise<ToolResult> {
  const executionId = generateExecutionId();
  const childStreamId = getStreamTabId(params.streamPrefix, { executionId });
  // An external CLI drives this agent: the CLI is both the agent name and the
  // driving tool, and `identity.tool` is what gates native-only affordances
  // (resume/rerun) off for this cohort.
  const identity = {
    kind: 'agent',
    agent: params.agentName,
    tool: params.agentName,
  } as const;

  try {
    await registerExecution(executionId, params.config, params.agentName, {
      streamId: childStreamId,
      identity,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
      parentExecutionId: params.parentExecutionId,
      description: childStreamDescription(params.description),
    });
  } catch (error) {
    // Keep the cause: registration aggregates real store-write failures
    // (unwritable storage root, torn record) that the per-provider prefix
    // alone cannot diagnose.
    throw new ToolError(
      `${params.registerFailedMessage} ${toErrorMessage(error)}`,
      { cause: error },
    );
  }
  // The launch guard owns the release-on-failure policy for every launch site
  // (bash background, the two detached child paths, and this one): a failed
  // launch must not leave a record that refuses a relaunch for the rest of the
  // process's life.
  const childStream = await runWithOwnedExecutionLeaseLaunchGuard(
    executionId,
    async () => {
      const stream = createChildStream(executionId, params.parentStreamId, {
        streamPrefix: params.streamPrefix,
        run: identity,
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
        description: params.description,
        config: params.config,
      });
      try {
        await params.startLoop({ childStream: stream, executionId });
      } catch (error) {
        try {
          await stream.finalize({
            outcome: RUN_OUTCOME.FAILED,
            error,
            persistence: { kind: 'finalize', flowRecord: 'delete' },
          });
        } catch (finalizeError) {
          throw new AggregateError(
            [error, finalizeError],
            `Agent CLI execution ${executionId} failed and its child stream could not be finalized`,
          );
        }
        throw error;
      }
      return stream;
    },
  );

  return executed(
    [
      params.launchedLine,
      `Execution ID: ${executionId}`,
      `Stream tab: ${childStream.childStreamId}`,
      params.followUpLine,
    ].join('\n'),
    params.summary,
  );
}

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
const withAgentCliApproval = Effect.fn('agentCli.withApproval')(function* <
  E,
  R,
>(
  toolName: string,
  approvalLabel: string,
  run: (runContext: RunContext | undefined) => Effect.Effect<ToolResult, E, R>,
) {
  const contexts = getCurrentToolContexts();
  if (contexts?.runContext?.stopAfterCycle) {
    return yield* Effect.fail(
      new ToolError(
        `${toolName} is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Delegate with delegate_agent, which returns the child's result directly.`,
      ),
    );
  }

  const approval = yield* agentCliCall(() =>
    requestBashApproval({ command: approvalLabel }),
  );
  if (approval.action !== 'approve') {
    return buildBashApprovalRejectedResult(approvalLabel, approval);
  }

  contexts?.callContext?.hooks?.onExecutionReady?.();
  return yield* run(contexts?.runContext);
});

/** Run context resolved for an agent-CLI launch, handed to the provider's
 * `launch` callback by {@link dispatchAgentCliTool}. */
interface AgentCliLaunchContext {
  parentStreamId: StreamTabId;
  parentExecutionId: ExecutionId | undefined;
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
 * a launch needs (parent stream/execution/working-directory). A missing
 * in-memory entry denotes a disk-based SDK fallback, so `launch` receives the
 * `releaseFallbackClaim` it must promote or release. Callers supply only their
 * approval label, session store, resume id, resume labels, and the
 * provider-specific launch.
 */
export function dispatchAgentCliTool(params: {
  agentName: string;
  approvalLabel: string;
  store: AgentCliSessionStoreAccessor;
  resumeId: string | undefined;
  /** Existing live session read by a fresh launch, such as a fork source. */
  sourceId?: string;
  prompt: string;
  labels: AgentCliResumeLabels;
  launch: (context: AgentCliLaunchContext) => Promise<ToolResult>;
}): Effect.Effect<ToolResult, ToolError> {
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
  return withAgentCliApproval(agentName, approvalLabel, (runContext) =>
    Effect.gen(function* () {
      const registry = yield* AgentCliSessionRegistry;
      const callerStreamId = getRunContextStreamId(runContext);
      if (sourceId) {
        yield* requireCallerOwnership(
          sourceId,
          callerStreamId,
          registry.getHandle(registry.lookup(sourceId)),
          labels,
        );
      }
      return yield* resumeOrLaunchAgentCliSession({
        id: resumeId,
        prompt,
        callerStreamId,
        labels,
        launch: (releaseFallbackClaim) => {
          // A missing in-memory entry denotes a disk-based SDK fallback.
          const { streamId } = requireRunStream(agentName, runContext);
          return launch({
            parentStreamId: streamId,
            parentExecutionId: getRunContextExecutionId(runContext),
            parentWorkingDirectory: getRunContextWorkingDirectory(runContext),
            releaseFallbackClaim,
          });
        },
      });
      // The registry is the ambient session's, resolved once here — after the
      // approval gate, as the previous `store(currentSession())` call site
      // was; every program below reads it from context.
    }).pipe(
      Effect.provide(AgentCliSessionRegistry.layer(store(currentSession()))),
    ),
  ).pipe(
    // A collaborator that rejected has already done its own cleanup; the
    // tool surfaces the error it raised, as the previous `await` chain did.
    Effect.catchTag('AgentCliCallFailed', (failure) =>
      Effect.die(failure.cause),
    ),
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
  childStream: ChildStream;
  parentStreamId: StreamTabId;
  executionId: ExecutionId;
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
  /** Provider-specific single-turn execution, given the joined follow-up prompt. */
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
 * only their provider-specific turn execution, usage/delivery formatting, and
 * registry entry construction.
 */
export function startAgentCliLoop<TTurn>(
  params: AgentCliLoopParams<TTurn>,
): void {
  const {
    childStream,
    parentStreamId,
    executionId,
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
  const { childStreamId, logger } = childStream;
  // Resolved once against the ambient session — the same session
  // `startChildRunLoop` captures for its strategy callbacks below.
  const registry = store(currentSession());

  // The one entry this loop registers and tracks: the child run's identity
  // and follow-up address. Live handles are resolved by the registry itself.
  const target: AgentCliSessionEntry = { childStreamId, executionId };

  // Fresh and resumed session/thread ids are registered after the first
  // successful turn is persisted, immediately before its result reaches the
  // parent.
  const registerSessionId = (id: string): void => {
    if (registry.lookup(id)) return;
    registry.register(id, target);
  };

  // The joined prompt text for whichever turn is currently in flight —
  // captured here (rather than threaded through the loop contract) since
  // `formatDelivery`/`formatError` run strictly after the turn that set it.
  let lastPrompt = initialPrompt;
  const runTurn = (
    followUps: readonly FollowUpQueueBatchItem[],
    ports: ChildRunPorts,
    signal: AbortSignal,
  ): Promise<TTurn> => {
    lastPrompt = followUps.map((f) => f.text).join('\n\n');
    return runProviderTurn(lastPrompt, ports, signal);
  };

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
        publishAgentCliStreamUsage(childStreamId, executionId, usage, logger);
      }
    },
    formatDelivery: (turn, wallTimeMs) =>
      formatDelivery(turn, wallTimeMs, lastPrompt),
    formatError: (turn, err) => formatError(turn, err, lastPrompt),
    releaseSessionOwnership: () => {
      releaseFallbackClaim?.();
      registry.releaseByExecutionId(executionId);
    },
  };

  const completion = startChildRunLoop({
    childStream,
    childStreamId,
    parentStreamId,
    executionId,
    agentName,
    strategy,
  });
  void completion.catch((error: unknown) => {
    logger.error(loopFailedMessage, { data: error });
  });
}
