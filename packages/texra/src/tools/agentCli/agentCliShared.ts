// Shared helpers for the agent-CLI tool modules (codex.ts, claudeAgent.ts).
// Host-agnostic, VS Code-free.

// Third-party imports
import { Clock, Effect, Exit, Schema, Scope, type Context } from 'effect';

// Local imports
import { ToolContext } from '@texra-ai/harness/plugins';
import {
  ChildRuns,
  noLaterTurn,
  type AgentTrace,
  type ChildRunDelivery,
  type PluginToolServices,
  type ProcessTurn,
  type ToolCardHandle,
  executed,
  ToolError,
  type ToolResult,
} from '@texra-ai/harness/plugins';
import {
  AgentConfigSchema,
  toErrorMessage,
  previewLabel,
  type RunId,
  type TokenUsageStats,
  type ToolUseLog,
} from '@texra-ai/harness/schemas';

import type { ClaimThread } from './agentCliSessionStores';

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

  private readonly logger: AgentTrace;
  constructor(logger: AgentTrace) {
    this.logger = logger;
  }

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

interface AgentCliLaunchParams {
  agentName: string;
  /** The prompt the child launches with; it labels the run and its summary. */
  prompt: string;
  /** The model reference the child run is labeled with. */
  modelRef: string;
  registerFailedMessage: string;
  /** Build the provider's turn around the trace of the run the launch
   *  registered. See {@link buildAgentCliTurn}. */
  turn: (ctx: { logger: AgentTrace; runId: RunId }) => ProcessTurn;
  /** Names the CLI in the result summary: `Launched <summaryLabel>: <previewLabel(prompt)>`. */
  summaryLabel: string;
  launchedLine: string;
  followUpLine: string;
}

/**
 * Launch an agent-CLI child of the calling run through the plugin's run
 * door (`ChildRuns.launchProcess`) and return the "launched" ToolResult. A
 * refused registration is the tool's error, worded by the provider.
 */
export const launchAgentCliSession = Effect.fn(
  'agentCliShared.launchAgentCliSession',
)(function* (
  params: AgentCliLaunchParams,
): Effect.fn.Return<ToolResult, ToolError, PluginToolServices> {
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
      turn: params.turn,
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
 * The shared execute() dispatch of an agent-CLI tool, run as the tool's
 * whole `execute()`: refuse a call that has no run to launch under or
 * cannot collect the result, claim the thread the call continues, and
 * launch the provider's turn, which holds the claim for its life. The command each tool gets
 * approved is the loop-side guard each declares, not a step in here.
 */
export function dispatchAgentCliTool<R = never, S = never>(params: {
  agentName: string;
  /** The plugin's thread claims, served by the step that pinned it. */
  store: Context.Key<S, ClaimThread>;
  /** The thread or session the call continues, if any. */
  resumeId: string | undefined;
  /** What a thread is called in a refusal ("Codex thread"). */
  threadLabel: string;
  /** The provider's launch. It reads the tool call from context, as this
   *  dispatch does; `claim` is the claim on the thread the call continues,
   *  which its turn closes as it ends (undefined for a fresh launch). */
  launch: (
    claim: Scope.Closeable | undefined,
  ) => Effect.Effect<ToolResult, ToolError, R>;
}): Effect.Effect<ToolResult, ToolError, R | S | ToolContext> {
  const { agentName, store, resumeId, threadLabel, launch } = params;
  return Effect.gen(function* () {
    const { run } = (yield* ToolContext).env;
    // The turn is delivered as a follow-up message. A one-shot run has no
    // later turn to take it: refuse rather than launch work nobody collects.
    if (noLaterTurn(run)) {
      return yield* Effect.fail(
        new ToolError(
          `${agentName} is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Delegate with \`agent\`, which returns the child's result directly.`,
        ),
      );
    }
    if (resumeId === undefined) return yield* launch(undefined);
    const claimThread = yield* store;
    // The claim is taken with interruption masked, so it is never left
    // standing with no one to close it; only the launch is interruptible. A
    // launch that fails before its turn started closes the claim; the turn
    // closes it as it ends.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claim = yield* claimThread(resumeId);
        if (claim === undefined)
          return yield* Effect.fail(
            new ToolError(
              `${threadLabel} '${resumeId}' is still processing a turn. Wait for its result (a follow-up message) before sending it another instruction.`,
            ),
          );
        return yield* restore(Effect.suspend(() => launch(claim))).pipe(
          Effect.onError((cause) => Scope.close(claim, Exit.failCause(cause))),
        );
      }),
    );
  });
}

// ============================================================================
// Shared turn: one provider turn, delivered to the parent by the run's end
// ============================================================================

interface AgentCliTurnParams<TTurn> {
  logger: AgentTrace;
  /** The claim on the thread this turn continues, closed as it ends. */
  claim: Scope.Closeable | undefined;
  /** The provider's turn: its own foreign edge (the provider SDK's
   *  streamed turn), wrapped once. A stop interrupts it: each provider
   *  hands its SDK a signal that interruption aborts
   *  (`Effect.abortSignal`). */
  runProviderTurn: Effect.Effect<TTurn, Error>;
  /** The turn's own spend, logged and published on the child's trace as
   *  the turn returns. Null when the provider reported none. */
  getUsage: (turn: TTurn) => TokenUsageStats | null;
  /** The delivery of a turn the provider returned. */
  delivery: (turn: TTurn, wallTime: string) => ChildRunDelivery;
  /** The delivery of a failed turn: one the provider reported failed, or
   *  (no turn) one that threw. */
  errorDelivery: (turn: TTurn | null, err: unknown) => ChildRunDelivery;
  /** Omitted by providers (codex) that always throw on failure. */
  isTurnError?: (turn: TTurn) => boolean;
  turnErrorMessage?: (turn: TTurn) => string;
}

/**
 * The agent-CLI child's one turn ({@link ProcessTurn}), common to every
 * provider (codex, claudeAgent): the provider's turn with its wall time,
 * its usage on the child's trace, its delivery or error report, and the
 * thread's claim closed as the turn ends. Callers supply only their
 * provider-specific turn and its deliveries.
 */
export function buildAgentCliTurn<TTurn>(
  params: AgentCliTurnParams<TTurn>,
): ProcessTurn {
  const {
    logger,
    claim,
    runProviderTurn,
    getUsage,
    delivery,
    errorDelivery,
    isTurnError,
    turnErrorMessage,
  } = params;
  const run = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const turn = yield* runProviderTurn;
    const wallTimeMs = (yield* Clock.currentTimeMillis) - startedAt;
    const wallTime = `${(wallTimeMs / 1000).toFixed(1)}s`;
    // Every turn the provider returns, an error turn included, reports its
    // spend: the child has no model rows, so its `usage` rows are its one
    // record of spend.
    const usage = getUsage(turn);
    if (usage) {
      logger.info('Tokens', {
        data: { input: usage.inputTokens, output: usage.outputTokens },
      });
      logger.emit({ type: 'usage', usage });
    }
    logger.info(`Turn completed in ${wallTime}`);
    if (isTurnError?.(turn) === true) {
      const failure =
        turnErrorMessage?.(turn) ??
        'The provider reported a failed turn without throwing.';
      logger.error(failure);
      return { report: errorDelivery(turn, null), failure };
    }
    return { report: delivery(turn, wallTime) };
  }).pipe(
    Effect.onExit((exit) =>
      claim === undefined ? Effect.void : Scope.close(claim, exit),
    ),
  );
  return {
    run,
    reportError: (error) => errorDelivery(null, error),
  };
}
