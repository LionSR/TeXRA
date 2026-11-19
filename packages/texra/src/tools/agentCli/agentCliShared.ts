// What the agent-CLI tools (codex.ts, claudeAgent.ts) share: the tool's
// whole call over a provider record, and the tool cards a streamed turn
// opens. Host-agnostic, VS Code-free.

// Third-party imports
import { Clock, Effect, Exit, Schema, Scope, type Context } from 'effect';

// Local imports
import {
  ChildRuns,
  noLaterTurn,
  type AgentTrace,
  type ChildRunDelivery,
  type PluginToolServices,
  type ProcessTurn,
  type ToolCardHandle,
  executed,
  ToolContext,
  ToolError,
  type ToolResult,
} from '@texra-ai/harness/plugins';
import {
  AgentConfigSchema,
  ensureError,
  toErrorMessage,
  previewLabel,
  type RunId,
  type TokenUsageStats,
  type ToolUseLog,
} from '@texra-ai/harness/schemas';

import type { ClaimThread } from './agentCliSessionStores';

/**
 * The tool cards one streamed agent-CLI turn opens, keyed by the id its SDK
 * assigns each tool call. Both drivers open a card when a tool call appears
 * and update or close it as results arrive. The set is acquired in the
 * turn's scope ({@link StreamedToolCards.make}), whose close fails every
 * card still open, so no dead card keeps a "Running" spinner whichever way
 * the turn ends.
 */
export class StreamedToolCards {
  private readonly cards = new Map<string, ToolCardHandle>();

  private readonly logger: AgentTrace;
  private constructor(logger: AgentTrace) {
    this.logger = logger;
  }

  /** A card set whose open cards fail when the enclosing scope closes. */
  static make(
    logger: AgentTrace,
  ): Effect.Effect<StreamedToolCards, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => new StreamedToolCards(logger)),
      (cards) =>
        Effect.sync(() => {
          for (const card of cards.cards.values()) card.failIfOpen();
          cards.cards.clear();
        }),
    );
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
}

/** One provider turn as the provider's SDK reported it. */
export interface AgentCliTurn {
  readonly response: string;
  /** The turn's own spend; null when the provider reported none. */
  readonly usage: TokenUsageStats | null;
  /** The delivery's attributes: the id a later call continues with. */
  readonly attributes: ChildRunDelivery['attributes'];
  /** Body lines the delivery carries, failed or not (Claude's cost). */
  readonly lines?: readonly string[];
  /** Set when the provider reported the turn failed without throwing. */
  readonly failure?: string;
}

/** A failure that is not the tool's own (a throw from a provider's SDK, a
 *  harness service's error) as the tool's failure, under the message it
 *  carried. */
export const asToolError = (cause: unknown): ToolError =>
  new ToolError(ensureError(cause).message, { cause });

/** A launch the provider prepared from the call's input. */
interface AgentCliLaunch {
  /** The model reference the child run is labeled with. */
  readonly modelRef: string;
  /** The receipt's first line: what launched, and how. */
  readonly launchedLine: string;
  /** The turn, on the trace of the run the launch registered. A stop
   *  interrupts it: the provider hands its SDK a signal that interruption
   *  aborts. */
  readonly turn: (logger: AgentTrace) => Effect.Effect<AgentCliTurn, ToolError>;
}

/** What a provider supplies to be an agent-CLI tool. */
interface AgentCliProvider<I, S, R> {
  /** The agent and its driving tool's name. */
  readonly name: string;
  /** The delivery's envelope family. */
  readonly family: string;
  /** What the receipt and a failed registration call it ("Codex"). */
  readonly label: string;
  /** What one of its threads is called ("Codex thread"). */
  readonly threadLabel: string;
  /** The input field a later call continues a thread with. */
  readonly idField: string;
  /** The plugin's thread claims, served by the step that pinned it. */
  readonly store: Context.Key<S, ClaimThread>;
  /** The thread the call continues, if any. */
  resumeId(input: I): string | undefined;
  prepare(input: I): Effect.Effect<AgentCliLaunch, ToolError, R>;
}

/**
 * An agent-CLI tool's whole `execute()`: refuse a call whose run has no later
 * turn to collect the result, claim the thread the call continues for the
 * turn's life, and launch the provider's turn as a child run that delivers
 * its result as a follow-up. The command each tool gets approved is the
 * loop-side guard each declares, not a step in here.
 */
export function agentCliTool<I extends { readonly prompt: string }, S, R>(
  provider: AgentCliProvider<I, S, R>,
): (
  input: I,
) => Effect.Effect<ToolResult, ToolError, R | S | PluginToolServices> {
  return (input) =>
    Effect.gen(function* () {
      const { run } = (yield* ToolContext).env;
      // A one-shot run has no later turn to take the delivery: refuse rather
      // than launch work nobody collects.
      if (noLaterTurn(run)) {
        return yield* new ToolError(
          `${provider.name} is unavailable in one-shot runs: it delivers its result as a follow-up message, and this run ends after the current cycle so no follow-up can be collected. Delegate with \`agent\`, which returns the child's result directly.`,
        );
      }
      const resumeId = provider.resumeId(input);
      if (resumeId === undefined)
        return yield* launchTurn(provider, input, undefined);
      const claimThread = yield* provider.store;
      // The claim is taken with interruption masked, so it is never left
      // standing with no one to close it; only the launch is interruptible. A
      // launch that fails before its turn started closes the claim; the turn
      // closes it as it ends.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const claim = yield* claimThread(resumeId);
          if (claim === undefined)
            return yield* new ToolError(
              `${provider.threadLabel} '${resumeId}' is still processing a turn. Wait for its result (a follow-up message) before sending it another instruction.`,
            );
          return yield* restore(
            Effect.suspend(() => launchTurn(provider, input, claim)),
          ).pipe(
            Effect.onError((cause) =>
              Scope.close(claim, Exit.failCause(cause)),
            ),
          );
        }),
      );
    }).pipe(Effect.withSpan(`${provider.name}.execute`));
}

/** Prepare the provider's launch and start its child run through the
 *  plugin's run door; the receipt is the tool's result. */
function launchTurn<I extends { readonly prompt: string }, S, R>(
  provider: AgentCliProvider<I, S, R>,
  input: I,
  claim: Scope.Closeable | undefined,
): Effect.Effect<ToolResult, ToolError, R | PluginToolServices> {
  return Effect.gen(function* () {
    const launch = yield* provider.prepare(input);
    // An external CLI drives this agent: the CLI is both the agent name and
    // the driving tool, and `identity.tool` is what gates native-only
    // affordances (resume/rerun) off for this cohort.
    const runId = yield* (yield* ChildRuns)
      .launchProcess({
        identity: { kind: 'agent', agent: provider.name, tool: provider.name },
        // Synthetic run metadata: the CLI runs outside the normal run loop,
        // so the model's reference is stated here rather than inherited
        // from the generic AgentConfig defaults.
        config: Schema.decodeUnknownSync(AgentConfigSchema)({
          agent: provider.name,
          model: launch.modelRef,
          instruction: input.prompt,
        }),
        description: input.prompt,
        turn: ({ logger, runId }) =>
          childTurn({
            family: provider.family,
            prompt: input.prompt,
            runId,
            logger,
            turn: launch.turn(logger),
            claim,
          }),
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new ToolError(
              `Failed to register ${provider.label} run. ${toErrorMessage(error)}`,
              { cause: error },
            ),
        ),
      );
    return executed(
      [
        launch.launchedLine,
        `Run ID: ${runId}`,
        `Result will be delivered as a follow-up message when the turn completes. The delivery includes the ${provider.idField}. Pass it back on a later call to continue the ${provider.threadLabel}.`,
      ].join('\n'),
      `Launched ${provider.label}: ${previewLabel(input.prompt)}`,
    );
  });
}

/**
 * The agent-CLI child's one turn ({@link ProcessTurn}): the provider's turn
 * with its wall time, its usage on the child's trace, its delivery or error
 * report, and the thread's claim closed as the turn ends.
 */
function childTurn(params: {
  family: string;
  prompt: string;
  runId: RunId;
  logger: AgentTrace;
  turn: Effect.Effect<AgentCliTurn, ToolError>;
  /** The claim on the thread this turn continues, closed as it ends. */
  claim: Scope.Closeable | undefined;
}): ProcessTurn {
  const { family, prompt, runId, logger, claim } = params;
  const run = Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const turn = yield* params.turn;
    const wallTimeMs = (yield* Clock.currentTimeMillis) - startedAt;
    const wallTime = `${(wallTimeMs / 1000).toFixed(1)}s`;
    // Every turn the provider returns, a failed one included, reports its
    // spend: the child has no model rows, so its `usage` rows are its one
    // record of spend.
    if (turn.usage) {
      logger.info('Tokens', {
        data: {
          input: turn.usage.inputTokens,
          output: turn.usage.outputTokens,
        },
      });
      logger.emit({ type: 'usage', usage: turn.usage });
    }
    logger.info(`Turn completed in ${wallTime}`);
    if (turn.failure !== undefined) {
      logger.error(turn.failure);
      return {
        report: {
          family,
          runId,
          prompt,
          lines: turn.lines,
          message: turn.failure,
        },
        failure: turn.failure,
      };
    }
    return {
      report: {
        family,
        runId,
        prompt,
        attributes: turn.attributes,
        wallTime,
        response: turn.response,
        ...(turn.usage !== null && { usage: turn.usage }),
        lines: turn.lines,
      },
    };
  }).pipe(
    Effect.onExit((exit) =>
      claim === undefined ? Effect.void : Scope.close(claim, exit),
    ),
  );
  return {
    run,
    reportError: (error) => ({
      family,
      runId,
      prompt,
      message: toErrorMessage(error),
    }),
  };
}
