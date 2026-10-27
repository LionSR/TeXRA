// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

// Third-party imports
import { Effect, Schema, type Context } from 'effect';

// Local imports
import {
  presentFollowUpResult,
  ToolContext,
  type ToolContextShape,
  type ToolResult,
} from '@texra-ai/harness';
import {
  ChildRuns,
  requireRun,
  senderOf,
  type AgentTrace,
  type ProcessChildStrategy,
  type ToolCardHandle,
  executed,
  ToolError,
} from '@texra-ai/harness/plugins';
import {
  AgentConfigSchema,
  ensureError,
  toErrorMessage,
  previewLabel,
  type FollowUpContent,
  type RunId,
  type TokenUsageStats,
  type ToolUseLog,
} from '@texra-ai/harness/schemas';

import type {
  AgentCliSessionEntry,
  AgentCliSessionRegistry,
} from './agentCliSessionRegistry';
import type { SettingsStores } from '@texra-ai/harness';

/**
 * The tool cards one streamed agent-CLI turn opens, keyed by the id its SDK
 * assigns each tool call. Both drivers (claudeAgent.ts, codex.ts) open a card
 * when a tool call appears and update or close it as results arrive; on any
 * turn teardown — a normal end, a stream error, or an abort — every card still
 * open must be failed so no dead card keeps a "Running" spinner. This owns that
 * keyed lifecycle and the fail-if-open teardown, so the invariant lives in one
 * place rather than being re-counted in each driver's stream finalizer.
 */
export class StreamedToolCards {
  private readonly cards = new Map<string, ToolCardHandle>();

  constructor(private readonly logger: AgentTrace) {}

  /** Open a card for `id` with its first log. */
  open(id: string, log: ToolUseLog): void {
    this.cards.set(id, this.logger.openToolCard(log));
  }

  /** Update the card for `id` if one is open, else open one. */
  openOrUpdate(id: string, log: ToolUseLog): void {
    const card = this.cards.get(id);
    if (card) card.update(log);
    else this.open(id, log);
  }

  /** The card open for `id`, if any — for a caller that merges onto its last log. */
  get(id: string): ToolCardHandle | undefined {
    return this.cards.get(id);
  }

  /** Show `id`'s final log and drop its card; a no-op when none is open for `id`. */
  close(id: string, log: ToolUseLog): void {
    const card = this.cards.get(id);
    if (!card) return;
    card.update(log);
    this.cards.delete(id);
  }

  /** Fail every still-open card and clear. Call once when the turn tears down. */
  failOpen(): void {
    for (const card of this.cards.values()) card.failIfOpen();
    this.cards.clear();
  }
}

interface AgentCliResumeLabels {
  notActiveLabel: string;
  idParamName: string;
  summaryLabel: string;
  queuedLabel: string;
}

const notOwned = (
  id: string,
  labels: AgentCliResumeLabels,
): Effect.Effect<never, ToolError> =>
  Effect.fail(
    new ToolError(
      `${labels.notActiveLabel} '${id}' is owned by a different session; start a new session without ${labels.idParamName} to run in this context.`,
    ),
  );

const queueAgentCliFollowUp = Effect.fn('agentCliShared.queueAgentCliFollowUp')(
  function* (
    stored: AgentCliSessionEntry,
    params: {
      id: string;
      prompt: string;
      callerRunId: RunId | undefined;
      labels: AgentCliResumeLabels;
    },
  ): Effect.fn.Return<ToolResult, ToolError> {
    const { id, prompt, callerRunId, labels } = params;
    // A detached or re-parented child must not accept follow-ups from its
    // former orchestrator: the child's rows decide, in the job queuing it.
    const followUp = { text: prompt, from: senderOf(callerRunId) };
    const inbox = yield* (yield* ChildRuns).inbox(stored.runId);
    const result = yield* inbox.send(followUp, {
      fromParent: callerRunId !== undefined,
    });
    if (result.status === 'failed' && result.reason === 'not_parent')
      return yield* notOwned(id, labels);
    const shown = presentFollowUpResult(result);
    if (shown.severity === 'warning') {
      return yield* Effect.fail(
        new ToolError(
          `${labels.notActiveLabel} '${id}' did not accept the follow-up: ${shown.message}`,
        ),
      );
    }

    const preview = previewLabel(prompt);
    // A queued follow-up whose wake failed is still queued: it is delivered
    // when the agent is resumed, so the caller must not offer it again.
    const followUpLine =
      shown.severity === 'info'
        ? `Follow-up instruction queued for ${labels.queuedLabel} '${id}'. ${shown.message}`
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
    id: string | undefined;
    prompt: string;
    callerRunId: RunId | undefined;
    labels: AgentCliResumeLabels;
    launch: (
      releaseClaim?: () => void,
    ) => Effect.Effect<ToolResult, ToolError, R>;
  },
): Effect.fn.Return<ToolResult, ToolError, R | ToolContext> {
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
    return yield* queueAgentCliFollowUp(stored, {
      id,
      prompt: params.prompt,
      callerRunId: params.callerRunId,
      labels: params.labels,
    });
  }
});

interface AgentCliLaunchParams<TTurn> {
  /** The thread or session id this launch continues, if any. */
  resumeId?: string;
  agentName: string;
  /** The prompt the child launches with; it labels the run and its summary. */
  prompt: string;
  /** The model reference the child run is labeled with. */
  modelRef: string;
  registerFailedMessage: string;
  /**
   * Build the provider's loop strategy around the child stream the launch
   * guard created. See {@link buildAgentCliLaunch}.
   */
  buildLaunch: (ctx: {
    logger: AgentTrace;
    runId: RunId;
  }) => Effect.Effect<ProcessChildStrategy<TTurn>, Error>;
  /** Names the CLI in the result summary: `Launched <summaryLabel>: <previewLabel(prompt)>`. */
  summaryLabel: string;
  launchedLine: string;
  followUpLine: string;
}

/**
 * Launch an agent-CLI child of the calling run (fresh, or the paused one
 * `resumeId` continues) through the plugin's run door
 * (`ChildRuns.launchProcess`) and return the "launched" ToolResult. A
 * refused registration is the tool's error, worded by the provider.
 */
export const launchAgentCliSession = Effect.fn(
  'agentCliShared.launchAgentCliSession',
)(function* <TTurn>(
  params: AgentCliLaunchParams<TTurn>,
): Effect.fn.Return<ToolResult, ToolError> {
  // An external CLI drives this agent: the CLI is both the agent name and the
  // driving tool, and `identity.tool` is what gates native-only affordances
  // (resume/rerun) off for this cohort.
  const runId = yield* (yield* ChildRuns)
    .launchProcess({
      identity: {
        kind: 'agent',
        agent: params.agentName,
        tool: params.agentName,
      },
      // Synthetic run metadata: the CLI runs outside the normal run loop, so
      // the tool-use category and the model's reference are stated here
      // rather than inherited from the generic AgentConfig defaults.
      config: Schema.decodeUnknownSync(AgentConfigSchema)({
        agent: params.agentName,
        model: params.modelRef,
        instruction: params.prompt,
      }),
      description: params.prompt,
      resumeId: params.resumeId,
      buildLaunch: params.buildLaunch,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new ToolError(
            `${params.registerFailedMessage} ${toErrorMessage(error)}`,
            { cause: error },
          ),
      ),
    );
  return executed(
    [
      params.launchedLine,
      `Run ID: ${runId}`,
      `Run: ${runId}`,
      params.followUpLine,
    ].join('\n'),
    `Launched ${params.summaryLabel}: ${previewLabel(params.prompt)}`,
  );
});

/**
 * The command an agent-CLI call gets approved, built the one way both
 * providers build it: the child's effective mode — read from the call's own
 * settings, so the prompt names the mode the launch will use — and the prompt
 * it would be launched with. Each tool declares this as its loop-side guard,
 * so the run loop opens the prompt and neither tool body does.
 */
export const agentCliApprovalCommand = Effect.fn(
  'agentCliShared.agentCliApprovalCommand',
)(function* (
  agentName: string,
  prompt: string,
  mode: (stores: SettingsStores) => Effect.Effect<string, Error>,
): Effect.fn.Return<string, Error, ToolContext> {
  const { roots } = (yield* ToolContext).env;
  const resolved = yield* mode(roots);
  return `[${agentName} ${resolved}] ${prompt}`;
});

/** Run context resolved for an agent-CLI launch, handed to the provider's
 * `launch` callback by {@link dispatchAgentCliTool}. */
export interface AgentCliLaunchContext {
  parentWorkingDirectory: string | undefined;
  /** Release the disk-based fallback claim if the launch fails before promoting
   * it. Undefined for a fresh (non-resumed) launch. */
  releaseFallbackClaim: (() => void) | undefined;
  /** The session's registry the step served the tool (`store`). */
  registry: AgentCliSessionRegistry;
}

/**
 * The shared execute() dispatch skeleton for an agent-CLI tool. Wraps the
 * boilerplate-identical chain both providers (codex, claudeAgent) run: refuse
 * a call that has no run to launch under or cannot collect the result, choose
 * atomically between queueing onto an owned session and launching a disk-based
 * fallback, and resolve the run context a launch needs (parent
 * stream/run/working-directory). A missing in-memory entry denotes a
 * disk-based SDK fallback, so `launch` receives the `releaseFallbackClaim` it
 * must promote or release. Callers supply only their session store, resume id,
 * resume labels, and the provider-specific launch. The command each tool gets
 * approved is the loop-side guard each declares, not a step in here.
 *
 * The returned Effect is the tool's whole dispatch: the tool's `execute()`
 * runs it as is.
 */
export function dispatchAgentCliTool<R = never, S = never>(params: {
  toolCall: ToolContextShape;
  agentName: string;
  /** The plugin's session registry, served by the step that pinned it. */
  store: Context.Key<S, AgentCliSessionRegistry>;
  resumeId: string | undefined;
  /** Existing live session read by a fresh launch, such as a fork source. */
  sourceId?: string;
  prompt: string;
  labels: AgentCliResumeLabels;
  launch: (
    context: AgentCliLaunchContext,
  ) => Effect.Effect<ToolResult, ToolError, R>;
}): Effect.Effect<ToolResult, ToolError, R | S | ToolContext> {
  const { agentName, store, resumeId, sourceId, prompt, labels, launch } =
    params;
  return Effect.gen(function* () {
    // The run check is the one place either tool asks it: an agent-CLI child
    // is registered under its parent run and delivers every turn as a
    // follow-up to it, so a standalone host invocation has nowhere to put the
    // child.
    const { run } = yield* requireRun(agentName);
    // Every turn is delivered as a follow-up message. A run with
    // `stopAfterCycle` ends after the current cycle, so that follow-up would
    // land in a turn that never happens and the child's result is stranded.
    // Refuse rather than launch work nobody collects.
    if (run.toolPolicy.stopAfterCycle) {
      return yield* Effect.fail(
        new ToolError(
          `${agentName} is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Delegate with \`agent\`, which returns the child's result directly.`,
        ),
      );
    }
    const registry = yield* store;
    const callerRunId = run.runId;
    // A fork only reads its source session: a live source another run
    // owns is refused by its current edge, nothing written.
    const source = sourceId ? registry.lookup(sourceId) : undefined;
    const sourceParent =
      source && (yield* (yield* ChildRuns).parent(source.runId));
    if (sourceId && sourceParent != null && sourceParent !== callerRunId)
      return yield* notOwned(sourceId, labels);
    return yield* resumeOrLaunchAgentCliSession(registry, {
      id: resumeId,
      prompt,
      callerRunId,
      labels,
      launch: (releaseFallbackClaim) =>
        launch({
          parentWorkingDirectory: params.toolCall.env.workingDirectory,
          releaseFallbackClaim,
          registry,
        }),
    });
  });
}

// ============================================================================
// Shared session loop — one turn per enqueued prompt, delivers to parent
// ============================================================================

interface AgentCliLoopParams<TTurn> {
  logger: AgentTrace;
  runId: RunId;
  /** Stage label opened on the child trace (e.g. "Codex session"). */
  stageLabel: string;
  initialPrompt: string;
  /** Session/thread registry the loop tracks in-flight and successful turns in. */
  registry: AgentCliSessionRegistry;
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
    signal: AbortSignal,
  ) => Effect.Effect<TTurn, Error>;
  /**
   * Session/thread ids to register as active after a successful turn. Falsy
   * entries (not-yet-known ids) are skipped.
   */
  resolveSessionIds: (turn: TTurn) => readonly (string | null | undefined)[];
  /** The turn's own spend, logged and published on the child's trace as
   *  each turn returns. Null when the provider reported none. */
  getUsage: (turn: TTurn) => TokenUsageStats | null;
  formatDelivery: (
    turn: TTurn,
    wallTimeMs: number,
    lastPrompt: string,
  ) => string;
  formatError: (turn: TTurn | null, err: unknown, lastPrompt: string) => string;
  /** Omitted by providers (codex) that always throw on failure. */
  isTurnError?: (turn: TTurn) => boolean;
  turnErrorMessage?: (turn: TTurn) => string | undefined;
  /** The call continuing this session after a stop, and the id it resumed. */
  continueWith: readonly [tool: string, idParam: string, id?: string];
}

/**
 * Build the shared agent-CLI child-run launch. `startChildRunLoop` (reached
 * through {@link launchAgentCliSession}'s detached-launch choreography)
 * processes prompts from the child's follow-up queue one at a time and
 * delivers each turn's result to the parent's follow-up queue; this supplies
 * the `ProcessChildStrategy` scaffolding common to every agent-CLI provider
 * (codex, claudeAgent): a dedup'd session/thread registration closure, the
 * `lastPrompt` capture feeding `formatDelivery`/`formatError`, and the
 * boilerplate-identical strategy fields (`onTurnSuccess`,
 * `releaseSessionOwnership`), and each turn's usage on the child's trace.
 * Callers supply only their provider-specific turn run, usage/delivery
 * formatting, and registry entry construction.
 */
export function buildAgentCliLaunch<TTurn>(
  params: AgentCliLoopParams<TTurn>,
): Effect.Effect<ProcessChildStrategy<TTurn>> {
  return Effect.gen(function* () {
    const {
      logger,
      runId,
      stageLabel,
      initialPrompt,
      registry,
      releaseFallbackClaim,
      runProviderTurn,
      resolveSessionIds,
      getUsage,
      formatDelivery,
      formatError,
      isTurnError,
      turnErrorMessage,
    } = params;
    // Released with the child's aliases (`releaseSessionOwnership`).
    yield* registry.holdWhileLive(runId);

    // The one entry this loop registers and tracks: the child run's identity
    // and follow-up address. Live handles are resolved by the registry itself.
    const target: AgentCliSessionEntry = { runId };

    // Session/thread ids are registered after the first successful turn is
    // persisted, just before its result reaches the parent.
    const [continueTool, continueParam, resumedId] = params.continueWith;
    let continueId = resumedId;
    const registerSessionId = (id: string): void => {
      continueId = id;
      if (registry.lookup(id)) return;
      registry.register(id, target);
    };

    // The joined prompt text for whichever turn is currently in flight;
    // captured here (rather than threaded through the loop contract) since
    // `formatDelivery`/`formatError` run strictly after the turn that set it.
    let lastPrompt = initialPrompt;
    // Every turn the provider returns, an error turn included, reports its
    // spend: the child has no run history, so its `usage` rows are its one
    // record of spend, one per turn, which is what each provider reports.
    const providerTurn = (
      prompt: string,
      signal: AbortSignal,
    ): Effect.Effect<TTurn, Error> =>
      runProviderTurn(prompt, signal).pipe(
        Effect.tap((turn) =>
          Effect.sync(() => {
            const usage = getUsage(turn);
            if (!usage) return;
            logger.info('Tokens', {
              data: { input: usage.inputTokens, output: usage.outputTokens },
            });
            logger.emit({ type: 'usage', usage });
          }),
        ),
      );
    const runTurn = (
      followUps: readonly FollowUpContent[],
      signal: AbortSignal,
    ): Effect.Effect<TTurn, Error> =>
      Effect.suspend(() => {
        lastPrompt = followUps.map((f) => f.text).join('\n\n');
        return providerTurn(lastPrompt, signal);
      });

    return {
      stageLabel,
      launch: (signal) => providerTurn(initialPrompt, signal),
      runTurn,
      isTurnError,
      turnErrorMessage,
      onTurnSuccess: (turn) => {
        for (const id of resolveSessionIds(turn)) {
          if (id) registerSessionId(id);
        }
      },
      formatDelivery: (turn, wallTimeMs) =>
        Effect.try({
          try: () => formatDelivery(turn, wallTimeMs, lastPrompt),
          catch: ensureError,
        }),
      formatError: (turn, err) => formatError(turn, err, lastPrompt),
      pauseNotice: () =>
        continueId === undefined
          ? undefined
          : {
              text: `The ${stageLabel} is paused. Nothing continues it on its own; to continue it, call ${continueTool} with ${continueParam} '${continueId}'.`,
              resumeId: continueId,
            },
      releaseSessionOwnership: () => {
        releaseFallbackClaim?.();
        registry.releaseByRunId(runId);
      },
    };
  });
}
