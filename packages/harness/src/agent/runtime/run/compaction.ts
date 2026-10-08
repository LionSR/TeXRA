/**
 * Conversation compaction for the tool-use loop: a run-scoped step beside
 * the loop that writes a `context.edit` with cause `compaction` (trigger
 * `context-limit` at the threshold share of the bound model's window, or
 * `user` for a `/compact`), replacing the history it summarized. A
 * threshold compaction runs in the background ({@link backgroundCompaction});
 * a `/compact` waits for its own. The replacement is a summary the bound
 * model produces through the invoker's priced `call`, its attempts recorded
 * on the run's history, folded back as one user message. Every skip and
 * failure is logged and shown as a compaction activity, never silent.
 */
import { Cause, Effect, Exit, Fiber, type Scope } from 'effect';

import {
  logContextManagementEvent,
  startCompactionActivity,
  type AgentTrace,
} from '@agent/trace';
import type { StateReadFailed } from '@platform/interfaces';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import {
  MODEL_COMPACTION_THRESHOLD_SETTING,
  type RunId,
} from '@shared/schemas';
import type { DatabaseWriteFailed } from '@shared/session/database';
import type { RunHistoryRefused } from '@shared/session/runHistory';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { rowAggregate, type Message } from '../loop/rows';
import { contextTokens, estimateMessageTokens } from './contextTokens';
import { turnText } from './turnText';
import type { ModelInvoker } from '../ModelInvoker';
import type { CallResult } from './modelCall';
import type { BoundModel } from './modelBinding';
import type { RunCell } from '../loop/runProgram';

/**
 * Prefix prepended to a compaction summary when it is folded back into the
 * conversation as a synthetic user message, so the resumed-conversation
 * marker stays identical across providers.
 */
const COMPACTION_SUMMARY_PREFIX = '[Previous conversation summary]\n\n';

/** System prompt used for conversation compaction. */
export const COMPACTION_SYSTEM_PROMPT = `Summarize the conversation below. Preserve:
- The original user request and goals
- All key decisions made
- File paths and code changes discussed or made
- Tool call results and their outcomes
- Current state of the task (what is done, what is pending)
- Any errors encountered and how they were resolved

Write a structured summary with enough context to continue the task. Output only the summary.`;

/** Final user instruction that makes the compaction task explicit after history. */
const COMPACTION_USER_PROMPT =
  'Summarize the conversation history above now. Follow the compaction instructions exactly and output only the summary.';

interface LogCompactionEventOptions {
  readonly logger: AgentTrace;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly contextWindow: number;
  readonly details: string;
}

function logCompactionEvent({
  logger,
  tokensBefore,
  tokensAfter,
  contextWindow,
  details,
}: LogCompactionEventOptions): void {
  const reduction = tokensBefore - tokensAfter;
  const reductionPercent =
    tokensBefore > 0 ? ((reduction / tokensBefore) * 100).toFixed(1) : '0';

  logContextManagementEvent(
    logger,
    `Compacted conversation: ${tokensBefore.toLocaleString()} → ~${tokensAfter.toLocaleString()} tokens (${reductionPercent}% reduction)`,
    {
      action: 'compaction',
      tokensBefore,
      tokensAfter,
      contextWindow,
      utilizationBefore: roundedUtilizationPercent(tokensBefore, contextWindow),
      utilizationAfter: roundedUtilizationPercent(tokensAfter, contextWindow),
      details,
    },
  );
}

interface CompactionInput {
  readonly runId: RunId;
  readonly logger: AgentTrace;
  readonly bound: BoundModel;
  /** The run's invoker, which makes the summary call. */
  readonly invoker: ModelInvoker['Service'];
  /** The run's cell, which the summary's attempt rows commit through. */
  readonly cell: RunCell;
  /** The session's setting slots: the threshold is a live per-check read. */
  readonly stores: SettingsStores;
  /** Compact regardless of the threshold: a `/compact` request. `null`
   *  leaves the decision to the threshold. */
  readonly force: 'request' | null;
  /** The `/compact` requests it answers, consumed with its edit. */
  readonly answers?: readonly RunHistoryDraft[];
}

/** Why a compaction runs, as its `context.edit` records it. */
const COMPACTION_TRIGGER = {
  request: 'user',
  threshold: 'context-limit',
} as const;

/** Why a compaction runs, as its debug line names it. */
const COMPACTION_REASON = {
  request: 'manually requested',
  threshold: 'token threshold exceeded',
} as const;

type Reason = keyof typeof COMPACTION_REASON;

/** A summary the bound model produced of messages `[0, to)`. */
interface Summary {
  readonly replacement: Message;
  readonly usage: CallResult['usage'];
  readonly to: number;
  readonly tokensBefore: number;
  readonly contextWindow: number;
  readonly activity: ReturnType<typeof startCompactionActivity>;
  readonly cell: RunCell; // its attempts committed through it; it lands here
}

/** Whether the history has reached the threshold share of the window. */
const overThreshold = Effect.fn('compaction.overThreshold')(function* (
  state: RunState,
  input: Pick<CompactionInput, 'stores' | 'bound'>,
) {
  const percent = yield* readSettingFrom<number>(
    input.stores,
    MODEL_COMPACTION_THRESHOLD_SETTING.configKey,
  );
  const contextWindow = input.bound.contextWindow;
  return (
    percent > 0 &&
    contextWindow > 0 &&
    contextTokens(state) > Math.floor((percent / 100) * contextWindow)
  );
});

/**
 * Summarize the whole history `state` holds, or null when it is too short
 * to summarize or the summary failed, each logged and shown as the
 * compaction's activity, never silent.
 */
const summarize = Effect.fn('compaction.summarize')(function* (
  state: RunState,
  input: Pick<CompactionInput, 'logger' | 'bound' | 'invoker' | 'cell'>,
  reason: Reason,
): Effect.fn.Return<Summary | null> {
  const { logger, bound } = input;
  const conversation = state.messages;
  if (conversation.length <= 2) {
    if (reason !== 'threshold') {
      logger.debug('Conversation too short for compaction, skipping');
    }
    return null;
  }
  const contextWindow = bound.contextWindow;
  const tokensBefore = contextTokens(state);
  logger.debug(`Compacting conversation (${COMPACTION_REASON[reason]})`, {
    data: {
      inputTokens: tokensBefore,
      utilizationPercent: roundedUtilizationPercent(
        tokensBefore,
        contextWindow,
      ),
      contextWindow,
    },
  });
  const activity = startCompactionActivity(logger);
  // The summary is a model call like any other: the invoker gates, prices
  // and reports it, and its usage rides the edit that lands it. It leaves
  // out the context updates: the next step renders them into the system
  // text anew. Its output fits what its input leaves of the window, up to
  // the model's own limit; a limit too small for a manual thinking budget
  // runs without thinking (the model's rule, not this one's).
  const summarized = yield* Effect.exit(
    input.invoker.call(input.cell, {
      mode: 'foreground',
      system: COMPACTION_SYSTEM_PROMPT,
      messages: [
        ...conversation.filter(({ role }) => role !== 'system'),
        {
          role: 'user',
          content: [{ kind: 'text', text: COMPACTION_USER_PROMPT }],
        },
      ],
      tools: [],
      maxOutputTokens: Math.max(
        1,
        Math.min(
          bound.config.maxOutputTokens,
          contextWindow > 0 ? contextWindow - tokensBefore : Infinity,
        ),
      ),
    }),
  );
  if (Exit.isFailure(summarized)) {
    if (Cause.hasInterrupts(summarized.cause)) {
      activity.finish('cancelled');
      return yield* Effect.interrupt;
    }
    activity.finish('failed');
    logger.warn(
      `Compaction failed, continuing with original messages: ${toErrorMessage(Cause.squash(summarized.cause))}`,
      { data: Cause.squash(summarized.cause) },
    );
    return null;
  }
  // The summary turn's own text, trimmed: an empty summary is skipped.
  const summary = turnText(summarized.value.turn).trim();
  if (!summary) {
    logger.warn('Compaction returned empty summary, skipping');
    activity.finish('skipped');
    return null;
  }
  return {
    replacement: {
      role: 'user',
      content: [
        { kind: 'text', text: `${COMPACTION_SUMMARY_PREFIX}${summary}` },
      ],
    },
    usage: summarized.value.usage,
    to: conversation.length,
    tokensBefore,
    contextWindow,
    activity,
    cell: input.cell,
  };
});

/**
 * Land `summary`, computed at edit `base`: messages `[0, summary.to)` are
 * replaced by it, and a provider-side continuation over the old history is
 * dropped with them. What the loop appended since stays after it.
 */
const land = Effect.fn('compaction.land')(function* (
  input: Pick<CompactionInput, 'runId' | 'logger' | 'answers'>,
  summary: Summary,
  base: number | null,
  reason: Reason,
) {
  // Onto the cell's state, which holds the summary's own attempt rows.
  const state = yield* summary.cell.current;
  const compacted = yield* summary.cell.append([
    ...(input.answers ?? []),
    {
      type: 'context.edit',
      aggregateId: rowAggregate(input.runId),
      payload: {
        cause: 'compaction',
        trigger: COMPACTION_TRIGGER[reason],
        base,
        range: { from: 0, to: summary.to },
        messages: [summary.replacement],
        usage: summary.usage,
      },
    },
  ]);
  logCompactionEvent({
    logger: input.logger,
    // The history it replaces now, what the loop appended since included.
    tokensBefore: contextTokens(state),
    tokensAfter: Math.max(1, estimateMessageTokens(compacted.messages)),
    contextWindow: summary.contextWindow,
    details: `${summary.to} messages summarized`,
  });
  summary.activity.finish('completed');
  return compacted;
});

/**
 * Compact the run's history when it reaches the configured share of the
 * bound model's context window, or when asked to, waiting for the summary.
 * Returns the folded state after the `context.edit` row, or the state
 * unchanged when nothing was compacted (below the threshold, too short to
 * summarize, or a summary attempt that failed, which is logged and shown,
 * never a stop).
 */
const compactIfNeeded = Effect.fn('compaction.check')(function* (
  state: RunState,
  input: CompactionInput,
): Effect.fn.Return<
  RunState,
  RunHistoryRefused | DatabaseWriteFailed | StateReadFailed
> {
  const reason = input.force ?? 'threshold';
  if (input.force === null && !(yield* overThreshold(state, input)))
    return state;
  const summary = yield* summarize(state, input, reason);
  if (summary === null) return yield* input.cell.current; // its attempts
  return yield* land(input, summary, state.lastEdit, reason);
});

/**
 * The tool-use loop's compaction (durable harness, gap 4). Crossing the
 * threshold starts the summary on a fiber in the run's scope, and a later
 * request boundary of the turn, or its end at the latest, lands it as the
 * edit of messages `[0, to)` at the `base` it was computed from. A binding
 * that carries one turn at a time waits for it instead. Every other edit of
 * the view (a `/compact`, a model switch, a reset, a handoff) settles this
 * first ({@link settle}), so no summary meets a view another edit moved. A
 * history past the window waits for the summary; a `/compact` settles, then
 * summarizes the whole history.
 */
export interface BackgroundCompaction {
  /** At a request boundary, no attempt open; `requests` consume `/compact`s.
   *  Each operation commits through `cell` and answers its state. */
  readonly atBoundary: (
    cell: RunCell,
    bound: BoundModel,
    requests: readonly RunHistoryDraft[],
  ) => Effect.Effect<
    RunState,
    RunHistoryRefused | DatabaseWriteFailed | StateReadFailed
  >;
  /**
   * At the end of a turn: wait for the summary being made, and land it. A
   * summary does not outlive the turn that started it, so a process that
   * exits while the run is idle loses none, and its activity closes before
   * the turn's `waiting`.
   */
  readonly finish: (
    cell: RunCell,
  ) => Effect.Effect<RunState, RunHistoryRefused | DatabaseWriteFailed>;
  /** Before another edit of the view: land a finished summary, cut short
   *  one still running (`why` says what edit is coming). */
  readonly settle: (
    cell: RunCell,
    why: string,
  ) => Effect.Effect<RunState, RunHistoryRefused | DatabaseWriteFailed>;
}

export const backgroundCompaction = Effect.fn('compaction.background')(
  function* (
    input: Omit<CompactionInput, 'force' | 'bound' | 'cell'>,
  ): Effect.fn.Return<BackgroundCompaction, never, Scope.Scope> {
    const scope = yield* Effect.scope;
    /** The summary being made off the loop, of the view at `base`. */
    let pending: {
      readonly base: number | null;
      readonly fiber: Fiber.Fiber<Summary | null>;
    } | null = null;

    /** Land the pending summary's outcome, and forget it. */
    const landPending = (cell: RunCell, exit: Exit.Exit<Summary | null>) => {
      const base = pending?.base ?? null;
      pending = null;
      if (Exit.isSuccess(exit))
        return exit.value === null
          ? cell.current
          : land(input, exit.value, base, 'threshold');
      // A failed summary call is the summary's own warning; this is a
      // defect in making one.
      input.logger.warn(
        `A background compaction stopped: ${toErrorMessage(Cause.squash(exit.cause))}`,
        { data: Cause.squash(exit.cause) },
      );
      return cell.current;
    };

    const settle = Effect.fn('compaction.settle')(function* (
      cell: RunCell,
      why: string,
    ) {
      if (pending === null) return yield* cell.current;
      const running = pending.fiber;
      const finished = yield* Effect.sync(() => running.pollUnsafe());
      if (finished !== undefined) return yield* landPending(cell, finished);
      yield* Fiber.interrupt(running);
      // It may have finished as the interrupt landed: that summary lands.
      const raced = running.pollUnsafe();
      if (raced !== undefined && Exit.isSuccess(raced))
        return yield* landPending(cell, raced);
      pending = null;
      input.logger.warn(
        `A background compaction was cut short (${why}); nothing it summarized was applied.`,
      );
      return yield* cell.current;
    });

    const atBoundary = Effect.fn('compaction.atBoundary')(function* (
      cell: RunCell,
      bound: BoundModel,
      requests: readonly RunHistoryDraft[],
    ) {
      if (requests.length > 0) {
        const settled = yield* settle(cell, 'a /compact replaces it');
        return yield* compactIfNeeded(settled, {
          ...input,
          cell,
          bound,
          force: 'request',
          answers: requests,
        });
      }
      let state = yield* cell.current;
      // A history past the window cannot go out: it waits for the summary.
      const full =
        bound.contextWindow > 0 && contextTokens(state) >= bound.contextWindow;
      if (pending !== null) {
        const running = pending.fiber;
        const finished = full
          ? yield* Fiber.await(running)
          : yield* Effect.sync(() => running.pollUnsafe());
        if (finished === undefined) return state;
        const landed = yield* landPending(cell, finished);
        // One that produced no summary leaves the decision to this
        // boundary's history.
        if (landed.lastEdit !== state.lastEdit) return landed;
        state = landed;
      }
      // A binding that carries one turn at a time (a Responses WebSocket)
      // cannot make the summary beside the request: it waits.
      if (bound.persistentConnection)
        return yield* compactIfNeeded(state, {
          ...input,
          cell,
          bound,
          force: null,
        });
      if (!(yield* overThreshold(state, { ...input, bound }))) return state;
      pending = {
        base: state.lastEdit,
        fiber: yield* summarize(
          state,
          { ...input, cell, bound },
          'threshold',
        ).pipe(Effect.forkIn(scope)),
      };
      return full ? yield* finish(cell) : state;
    });

    /** Wait for the summary being made, and land it. */
    const finish = Effect.fn('compaction.finish')(function* (cell: RunCell) {
      if (pending === null) return yield* cell.current;
      return yield* landPending(cell, yield* Fiber.await(pending.fiber));
    });

    return { atBoundary, settle, finish };
  },
);
