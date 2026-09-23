// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

// Third-party imports
import { Data, Effect } from 'effect';

// Local imports
import { registerRun } from '@agent/storage';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunHandle } from '@agent/runtime/RunHandle';
import { Runs, type RunRegistry } from '@agent/runtime/runRegistry';
import type {
  ChildRunPorts,
  ChildRunStrategy,
} from '@agent/runtime/childRunLoop';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import {
  describeFollowUpFailure,
  FOLLOW_UP_WAKE_FAILED_MESSAGE,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { AgentResume, type StateStore } from '@platform/interfaces';
import {
  emptyUsageStats,
  sumUsageStats,
  ToolError,
  type FollowUpContent,
  type RunId,
  type TokenUsageStats,
  type ToolResult,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { executed } from '@tools/core/result';
import { requireToolRun, type ToolRun } from '@tools/core/toolRun';
import { generateRunId } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { previewLabel } from '@utils/text/stringUtils';

import {
  childRunDescription,
  createChildRun,
  type ChildRun,
} from './delegation/childRun';
import {
  startDetachedChildRunLoop,
  type DetachedChildRunLaunch,
} from './delegation/detachedChildRun';
import type {
  AgentCliSessionEntry,
  AgentCliSessionRegistry,
} from './agentCliSessionRegistry';

/** Registry accessor keyed by the session's runs
 * (`codexThreadsFor`/`claudeAgentSessionsFor`); dispatch and loop resolve it
 * once against the `Runs` they take from context. */
type AgentCliSessionStoreAccessor = (
  runs: RunRegistry,
) => AgentCliSessionRegistry;

/**
 * A collaborator of the dispatch/launch chain (bash approval, follow-up
 * submission, thread/session setup, the owned-run launch guard) failed.
 * `cause` is what it raised. The tools' `execute()` edges re-raise the cause
 * itself, so the tool runner surfaces the same error instance the
 * collaborator raised, exactly as the previous `await` chain did.
 */
class AgentCliCallFailed extends Data.TaggedError('AgentCliCallFailed')<{
  readonly cause: unknown;
}> {}

/**
 * The one re-tagging of the agent-CLI chain's collaborators onto this
 * chain's error channel — the shared dispatch/launch steps and each provider
 * tool's own setup (SDK import, binary lookup, thread creation).
 */
export const agentCliCall = <A, E>(
  call: Effect.Effect<A, E>,
): Effect.Effect<A, AgentCliCallFailed> =>
  Effect.mapError(call, (cause) => new AgentCliCallFailed({ cause }));

/** The failures the agent-CLI dispatch/launch chain can raise. */
export type AgentCliToolFailure = ToolError | AgentCliCallFailed;

/**
 * Re-raise a collaborator's rejection as its own cause: pipe this at the
 * tool's native `execute()` edge so BaseTool normalizes the original error
 * without hiding the collaborator's diagnostics.
 */
export const reraiseAgentCliCallFailure = <A, R>(
  effect: Effect.Effect<A, AgentCliToolFailure, R>,
): Effect.Effect<A, ToolError, R> =>
  effect.pipe(
    Effect.catchTag('AgentCliCallFailed', (error) => Effect.die(error.cause)),
  );

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
  ): Effect.fn.Return<ToolResult, AgentCliToolFailure, AgentResume> {
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

    const result = yield* submitFollowUp(stored.runId, prompt, {
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
)(function* <R>(
  store: AgentCliSessionRegistry,
  params: {
    session: SessionHandle;
    id: string | undefined;
    prompt: string;
    callerRunId: RunId | undefined;
    labels: AgentCliResumeLabels;
    launch: (
      releaseClaim?: () => void,
    ) => Effect.Effect<ToolResult, AgentCliToolFailure, R>;
  },
): Effect.fn.Return<
  ToolResult,
  AgentCliToolFailure,
  R | ToolCall | AgentResume
> {
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

interface AgentCliLaunchParams<TTurn> {
  session: SessionHandle;
  /** The launching run: the child's parent edge. */
  parentRunId: RunId;
  agentName: string;
  description: string;
  config: AgentConfig;
  registerFailedMessage: string;
  /**
   * Build the provider's loop strategy (and its late-failure trace) around the
   * child stream the launch guard created. See {@link buildAgentCliLaunch}.
   */
  buildLaunch: (ctx: {
    childRun: ChildRun;
    runId: RunId;
  }) => Effect.Effect<DetachedChildRunLaunch<TTurn>, Error, Runs>;
  summary: string;
  launchedLine: string;
  followUpLine: string;
}

/**
 * Register a fresh agent-CLI run, then run the shared detached-child launch
 * choreography over it: create the child stream tab inside the owned-run
 * launch guard, hand the provider's strategy to the child run loop, and return
 * the "launched" ToolResult.
 *
 * `registerRun` stays here rather than moving to `registerChildRun`: an
 * agent-CLI run stamps `identity.tool`, TERMINAL_BACKED follow-up support and
 * a run description that the native registration does not.
 *
 * Failure channel: a setup failure propagates as the choreography raised it.
 * A typed failure is re-tagged onto this chain's `AgentCliCallFailed`; a
 * cause carrying an interrupt re-raises as an interrupt into the calling tool
 * fiber rather than being squashed into a failure. Under today's topology the
 * only reachable interrupt is the `restore` checkpoint below, before the child
 * stream exists (everything after it is uninterruptible), so this states the
 * primitive's semantics rather than a second live arm.
 */
export const launchAgentCliSession = Effect.fn(
  'agentCliShared.launchAgentCliSession',
)(function* <TTurn>(
  params: AgentCliLaunchParams<TTurn>,
): Effect.fn.Return<ToolResult, AgentCliToolFailure, Runs | AgentResume> {
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

      const { childRunId } = yield* startDetachedChildRunLoop({
        session: params.session,
        runId,
        parentRunId: params.parentRunId,
        agentName: params.agentName,
        // An agent-CLI child is an external process on the user's own
        // subscription, outside both the cost contract and the child-run
        // concurrency budget, exactly as a background shell is
        // (`.agents/docs/implemented/architecture/2026-08-15-child-run-concurrency-budget.md`).
        budgeted: false,
        createChildRun: () =>
          // Deliberate interruption checkpoint, not dead code: everything from
          // here to the started loop is uninterruptible, so without this the
          // pending interrupt would only be observed after the loop has been
          // launched. `ChildRunProgressEvents.vitest.ts` pins the behavior — a
          // cancel arriving while the record is committed but the detached work
          // has not started must leave the run CANCELLED with no loop behind it.
          restore(Effect.void).pipe(
            Effect.andThen(
              createChildRun(params.session, runId, params.parentRunId, {
                run: identity,
                userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.TERMINAL_BACKED,
                description: params.description,
                config: params.config,
              }),
            ),
          ),
        buildLaunch: (childRun) => params.buildLaunch({ childRun, runId }),
      }).pipe(Effect.mapError((cause) => new AgentCliCallFailed({ cause })));

      return executed(
        [
          params.launchedLine,
          `Run ID: ${runId}`,
          `Run: ${childRunId}`,
          params.followUpLine,
        ].join('\n'),
        params.summary,
      );
    }),
  );
});

/**
 * Run the shared agent-CLI execute() prelude: refuse a call that has no run to
 * launch under or cannot collect the result, then dispatch to the
 * resume/launch branch with the active run.
 *
 * The run check is the one place either tool asks it: an agent-CLI child is
 * registered under its parent run and delivers every turn as a follow-up to
 * it, so a standalone host invocation has nowhere to put the child. Failing
 * here hands the whole chain a `NonNullable` run instead of re-asking at each
 * step.
 *
 * Both agent-CLI tools deliver every turn as a follow-up message. A run with
 * `stopAfterCycle` ends after the current cycle, so that follow-up would land
 * in a turn that never happens and the child's result is stranded. Refuse
 * rather than launch work nobody collects.
 */
const withAgentCliRun = Effect.fn('agentCliShared.withAgentCliRun')(function* <
  R,
>(
  toolName: string,
  toolCall: ToolCallShape,
  run: (run: ToolRun) => Effect.Effect<ToolResult, AgentCliToolFailure, R>,
): Effect.fn.Return<ToolResult, AgentCliToolFailure, R | ToolCall> {
  const activeRun = yield* requireToolRun(toolName, toolCall);
  if (activeRun.toolPolicy.stopAfterCycle) {
    return yield* Effect.fail(
      new ToolError(
        `${toolName} is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Delegate with delegate_agent, which returns the child's result directly.`,
      ),
    );
  }

  return yield* run(activeRun);
});

/**
 * The command an agent-CLI call gets approved, built the one way both
 * providers build it: the child's effective mode — read from the call's own
 * settings, so the prompt names the mode the launch will use — and the prompt
 * it would be launched with. Each tool declares this as its loop-side guard,
 * so the run loop opens the prompt and neither tool body does.
 */
export const agentCliApprovalCommand = (
  agentName: string,
  prompt: string,
  mode: (workspaceState: StateStore) => Effect.Effect<string, Error>,
): Effect.Effect<string, Error, ToolCall> =>
  Effect.gen(function* () {
    const { roots } = yield* ToolCall;
    const resolved = yield* mode(roots.workspaceState);
    return `[${agentName} ${resolved}] ${prompt}`;
  });

/** Run context resolved for an agent-CLI launch, handed to the provider's
 * `launch` callback by {@link dispatchAgentCliTool}. */
interface AgentCliLaunchContext {
  /** The launching run's session: the child's registration and delivery target. */
  session: SessionHandle;
  parentRunId: RunId;
  parentWorkingDirectory: string | undefined;
  /** Release the disk-based fallback claim if the launch fails before promoting
   * it. Undefined for a fresh (non-resumed) launch. */
  releaseFallbackClaim: (() => void) | undefined;
}

/**
 * The shared execute() dispatch skeleton for an agent-CLI tool. Wraps the
 * boilerplate-identical chain both providers (codex, claudeAgent) run: choose
 * atomically between queueing onto an owned session and launching a disk-based
 * fallback, and resolve the run context a launch needs (parent
 * stream/run/working-directory). A missing in-memory entry denotes a
 * disk-based SDK fallback, so `launch` receives the `releaseFallbackClaim` it
 * must promote or release. Callers supply only their session store, resume id,
 * resume labels, and the provider-specific launch. The command each tool gets
 * approved is the loop-side guard each declares, not a step in here.
 *
 * The returned Effect is the tool's whole dispatch: the tool's `execute()`
 * runs it at its own edge with {@link reraiseAgentCliCallFailure} piped in.
 */
export function dispatchAgentCliTool<R = never>(params: {
  toolCall: ToolCallShape;
  agentName: string;
  store: AgentCliSessionStoreAccessor;
  resumeId: string | undefined;
  /** Existing live session read by a fresh launch, such as a fork source. */
  sourceId?: string;
  prompt: string;
  labels: AgentCliResumeLabels;
  launch: (
    context: AgentCliLaunchContext,
  ) => Effect.Effect<ToolResult, AgentCliToolFailure, R>;
}): Effect.Effect<
  ToolResult,
  AgentCliToolFailure,
  R | ToolCall | Runs | AgentResume
> {
  const { agentName, store, resumeId, sourceId, prompt, labels, launch } =
    params;
  return withAgentCliRun(agentName, params.toolCall, (run) =>
    Effect.gen(function* () {
      const registry = store(yield* Runs);
      const callerRunId = run.runId;
      if (sourceId) {
        yield* requireCallerOwnership(
          sourceId,
          callerRunId,
          registry.getHandle(registry.lookup(sourceId)),
          labels,
        );
      }
      return yield* resumeOrLaunchAgentCliSession(registry, {
        session: run.session,
        id: resumeId,
        prompt,
        callerRunId,
        labels,
        launch: (releaseFallbackClaim) =>
          launch({
            session: run.session,
            parentRunId: run.runId,
            parentWorkingDirectory: params.toolCall.workingDirectory,
            releaseFallbackClaim,
          }),
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
  childRun: ChildRun;
  runId: RunId;
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
  /** Provider-specific single-turn run, given the joined follow-up prompt. The
   * implementer wraps its own foreign edge (the provider SDK's streamed turn)
   * once, so the loop composes the turn instead of lifting it. `signal` is the
   * child run's interrupt controller, which each provider hands to its SDK. */
  runProviderTurn: (
    prompt: string,
    ports: ChildRunPorts,
    signal: AbortSignal,
  ) => Effect.Effect<TTurn, Error>;
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
  turnErrorMessage?: (turn: TTurn) => string | undefined;
  /** Logged if the loop fails after launch. */
  loopFailedMessage: string;
}

/**
 * Build the shared agent-CLI child-run launch. `startChildRunLoop` (reached
 * through {@link launchAgentCliSession}'s detached-launch choreography)
 * processes prompts from the child's follow-up queue one at a time and
 * delivers each turn's result to the parent's follow-up queue; this supplies
 * the `ChildRunStrategy` scaffolding common to every agent-CLI provider
 * (codex, claudeAgent): a dedup'd session/thread registration closure, the
 * `lastPrompt` capture feeding `formatDelivery`/`formatError`, and the
 * boilerplate-identical strategy fields (`isTerminal`, `getUsage`,
 * `onLoopStart`, `onTurnSuccess`, `publishUsage`, `releaseSessionOwnership`).
 * Callers supply only their provider-specific turn run, usage/delivery
 * formatting, and registry entry construction.
 */
export function buildAgentCliLaunch<TTurn>(
  params: AgentCliLoopParams<TTurn>,
): Effect.Effect<DetachedChildRunLaunch<TTurn>, never, Runs> {
  return Effect.gen(function* () {
    const {
      childRun,
      runId,
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
      turnErrorMessage,
      loopFailedMessage,
    } = params;
    const { logger } = childRun;
    const registry = store(yield* Runs);

    // The one entry this loop registers and tracks: the child run's identity
    // and follow-up address. Live handles are resolved by the registry itself.
    const target: AgentCliSessionEntry = { runId };

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
    /** The child run's spend across every turn this loop has run. */
    let cumulativeUsage: TokenUsageStats = emptyUsageStats();
    const runTurn = (
      followUps: readonly FollowUpContent[],
      ports: ChildRunPorts,
      signal: AbortSignal,
    ): Effect.Effect<TTurn, Error> =>
      Effect.suspend(() => {
        lastPrompt = followUps.map((f) => f.text).join('\n\n');
        return runProviderTurn(lastPrompt, ports, signal);
      });

    const strategy: ChildRunStrategy<TTurn> = {
      stageLabel,
      launch: (ports, signal) =>
        runTurn([{ text: initialPrompt, origin: 'user' }], ports, signal),
      runTurn,
      isTerminal: () => false,
      getUsage,
      isTurnError,
      turnErrorMessage,
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
        if (!usage) return;
        // Each provider reports only the turn it just ran, so the loop holds
        // the child run's running total and publishes that. Not a transcript
        // event: the session's `usage` row is a latest-only listing key.
        cumulativeUsage = sumUsageStats([cumulativeUsage, usage]);
        logger.usage(
          { runId, usage: cumulativeUsage },
          { recordTranscript: false },
        );
      },
      formatDelivery: (turn, wallTimeMs) =>
        Effect.try({
          try: () => formatDelivery(turn, wallTimeMs, lastPrompt),
          catch: ensureError,
        }),
      formatError: (turn, err) => formatError(turn, err, lastPrompt),
      releaseSessionOwnership: () => {
        releaseFallbackClaim?.();
        registry.releaseByRunId(runId);
      },
    };

    return {
      strategy,
      // Nobody awaits an agent-CLI child: own a late loop failure here as a
      // trace diagnostic, since the loop already owns its one user-facing
      // result delivery.
      onLoopFailed: (error: unknown): void => {
        logger.error(loopFailedMessage, { data: error });
      },
    };
  });
}
