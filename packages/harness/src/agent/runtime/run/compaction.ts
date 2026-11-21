/**
 * The edits of the model's view a run writes on its own fiber at a request
 * boundary, each a `context.edit`: a summary by an extra model call (cause
 * `compaction`, trigger `context-limit` at the threshold share of the bound
 * model's window, `user` for a `/compact`, `overflow` after a request the
 * window could not hold), or a replacement the agent wrote itself with its
 * `context` tool (cause `edit`), which calls no model. The request each
 * precedes waits for it. A summary, made through the invoker's priced
 * `call` (no row records its attempts), is one user message; so is an
 * agent's replacement. Every edit, skip and failure is logged and shown as
 * a compaction activity. The fork seed (`forkRun.ts`) is the one other
 * writer of a `context.edit`, as a run's first row.
 */
import { Cause, Effect, Exit } from 'effect';

import type { AgentTrace } from '@agent/trace/AgentTrace';
import { startCompactionActivity } from '@agent/trace/traceLogs';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { Settings, type SettingsStores } from '@shared/config/settings';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import { type RunId } from '@shared/schemas';
import type { RunCell } from '@shared/session/runHistory';
import { turnText } from '@shared/session/runFacts';
import type { HistoryMessage } from '@shared/session/historyTurns';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { contextTokens, estimateMessageTokens } from './contextTokens';
import type { ModelInvoker } from '../ModelInvoker';
import type { ModelCallResult } from './modelCall';
import { MODEL_COMPACTION_THRESHOLD_SETTING } from '@shared/state/stateSettings';

/** Prepended to a summary applied back into the conversation as a user
 *  message: the same marker for every provider. */
export const COMPACTION_SUMMARY_PREFIX = '[Previous conversation summary]\n\n';

/** Prepended to the text an agent replaced part of its context with, so a
 *  later read of the view tells it from what the user wrote. */
export const AGENT_REPLACEMENT_PREFIX = '[Context you replaced]\n\n';

/** The one message an agent's replacement `text` stands as in the view. */
export const agentReplacement = (text: string): HistoryMessage => ({
  role: 'user',
  content: [{ kind: 'text', text: `${AGENT_REPLACEMENT_PREFIX}${text}` }],
});

/** The message a `/compact` on an idle run wakes it with (`FollowUpReader.next`);
 *  the compaction at that turn's request boundary consumes the request. */
export const COMPACTION_REQUEST =
  'The user requested immediate context compaction. Do not start a new task; continue only far enough for the runtime to process any available context compaction, and do not claim that compaction has completed.';

/** System prompt used for conversation compaction. */
const COMPACTION_SYSTEM_PROMPT = `Summarize the conversation below. Preserve:
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

/** What a compaction of a run reads: the run's own services, and the cell
 *  and binding of the request it precedes. */
interface CompactionInput {
  readonly runId: RunId;
  readonly logger: AgentTrace;
  readonly bound: BoundModel;
  /** The run's invoker, which makes the summary call. */
  readonly invoker: ModelInvoker['Service'];
  /** The run's cell: a token renewal reads its declined routes, and the
   *  summary lands on it. */
  readonly cell: RunCell;
  /** The session's setting slots: the threshold is a live per-check read. */
  readonly stores: SettingsStores;
}

/** Why a compaction runs, as its `context.edit` records it (`trigger`),
 *  and how its debug line names it. */
const TRIGGER_DEBUG = {
  user: 'manually requested',
  'context-limit': 'token threshold exceeded',
  overflow: 'context window exceeded',
} as const;

type Trigger = keyof typeof TRIGGER_DEBUG;

/** A summary the bound model produced of messages `[0, to)`. */
interface Summary {
  readonly replacement: RunState['messages'][number];
  readonly usage: ModelCallResult['usage'];
  readonly to: number;
  readonly contextWindow: number;
  readonly activity: ReturnType<typeof startCompactionActivity>;
}

/** Whether the history has reached the threshold share of the window. */
const overThreshold = Effect.fn('compaction.overThreshold')(function* (
  state: RunState,
  input: Pick<CompactionInput, 'stores' | 'bound'>,
) {
  const percent = yield* Settings.get(
    input.stores,
    MODEL_COMPACTION_THRESHOLD_SETTING,
  );
  const contextWindow = input.bound.config.contextWindow;
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
  trigger: Trigger,
): Effect.fn.Return<Summary | null> {
  const { logger, bound } = input;
  // A threshold summary leaves the newest exchange as it is: the last
  // assistant message and what follows it (the results of its calls, or the
  // input that came after), which the model has not answered yet and reads
  // whole. A `/compact` and an overflow summarize everything.
  const answered = state.messages.findLastIndex(
    ({ role }) => role === 'assistant',
  );
  const conversation =
    trigger === 'context-limit'
      ? state.messages.slice(0, Math.max(answered, 0))
      : state.messages;
  if (conversation.length <= 2) {
    if (trigger !== 'context-limit') {
      logger.debug('Conversation too short for compaction, skipping');
    }
    return null;
  }
  const contextWindow = bound.config.contextWindow;
  const tokensBefore = contextTokens(state);
  logger.debug(`Compacting conversation (${TRIGGER_DEBUG[trigger]})`, {
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
  // A model call like any other (gated, priced, reported; its usage rides
  // the edit that lands it), without the context updates, which the next
  // step renders anew. Its output fits what its input leaves of the window,
  // up to the model's limit; a limit too small for a manual thinking budget
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
      activity.finish({ state: 'cancelled' });
      return yield* Effect.interrupt;
    }
    activity.finish({ state: 'failed' });
    logger.warn(
      `Compaction failed, continuing with original messages: ${toErrorMessage(summarized.cause)}`,
      { data: summarized.cause },
    );
    return null;
  }
  // The summary turn's own text, trimmed: an empty summary is skipped.
  const summary = turnText(summarized.value.turn).trim();
  if (!summary) {
    logger.warn('Compaction returned empty summary, skipping');
    activity.finish({ state: 'skipped' });
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
    contextWindow,
    activity,
  };
});

/**
 * Land `summary`, made of `state`: messages `[0, summary.to)` are replaced
 * by it, and a provider-side continuation over the old history is dropped
 * with them.
 */
const land = Effect.fn('compaction.land')(function* (
  input: Pick<CompactionInput, 'runId' | 'logger' | 'cell'>,
  /** The `/compact` requests the edit answers, consumed with it. */
  answers: readonly RunHistoryDraft[],
  summary: Summary,
  state: RunState,
  trigger: Trigger,
) {
  const compacted = yield* input.cell.append([
    ...answers,
    {
      type: 'context.edit',
      aggregateId: input.runId,
      payload: {
        cause: 'compaction',
        trigger,
        range: { from: 0, to: summary.to },
        messages: [summary.replacement],
        usage: summary.usage,
      },
    },
  ]);
  // The summary replaced everything it measured: the estimate of the new
  // view is what remains.
  completed(
    summary.activity,
    contextTokens(state),
    estimateMessageTokens(compacted.messages),
    summary.contextWindow,
  );
  return compacted;
});

/** Finish `activity` with what an edit from `tokensBefore` to `tokens`
 *  freed of a `contextWindow`, and for an agent's edit how many messages it
 *  `replaced`. */
const completed = (
  activity: ReturnType<typeof startCompactionActivity>,
  tokensBefore: number,
  tokens: number,
  contextWindow: number,
  replaced?: number,
) => {
  const tokensAfter = Math.max(1, tokens);
  activity.finish({
    state: 'completed',
    freed: {
      tokens: tokensBefore - tokensAfter,
      utilizationBefore: roundedUtilizationPercent(tokensBefore, contextWindow),
      utilizationAfter: roundedUtilizationPercent(tokensAfter, contextWindow),
    },
    ...(replaced !== undefined && { replaced }),
  });
};

/**
 * Apply the replacements the agent asked for (`RunState.contextEdits`),
 * no attempt open, each its own `context.edit` in the order the state holds
 * them, highest range first: each one's indices are those of the view its
 * response was sent with, which an edit above it leaves as they were. Each
 * edit takes its request off the state, so a resume applies the rest. The
 * tool checked each range against that view; the run history checks the
 * result again as it commits.
 */
export const agentEditsAtBoundary = Effect.fn('compaction.agentEdits')(
  function* (
    input: Pick<CompactionInput, 'runId' | 'logger' | 'cell'>,
    contextWindow: number,
  ) {
    let state = yield* input.cell.current;
    for (const { from, to, with: text } of state.contextEdits) {
      const activity = startCompactionActivity(input.logger);
      const tokensBefore = contextTokens(state);
      state = yield* input.cell.append([
        {
          type: 'context.edit',
          aggregateId: input.runId,
          payload: {
            cause: 'edit',
            trigger: null,
            range: { from, to },
            messages: [agentReplacement(text)],
            usage: null,
          },
        },
      ]);
      // The count after is the run's own after the edit (an estimate, as an
      // edit leaves no provider count for the new view), the figure the
      // context gauge then shows; the tool's `freed` stays the agent's.
      completed(
        activity,
        tokensBefore,
        contextTokens(state),
        contextWindow,
        to - from,
      );
    }
    return state;
  },
);

/**
 * Summarize the history (`summarize` says how much of it) and land the
 * summary, on the caller's fiber:
 * a `/compact`'s answers ride the edit; an overflow's closes the failed
 * request. The state is unchanged when the history is too short to
 * summarize, or the summary attempt failed (logged and shown, never a stop).
 */
const compact = Effect.fn('compaction.compact')(function* (
  input: CompactionInput,
  trigger: Trigger,
  answers: readonly RunHistoryDraft[],
) {
  const state = yield* input.cell.current;
  const summary = yield* summarize(state, input, trigger);
  if (summary === null) return yield* input.cell.current; // nothing landed
  return yield* land(input, answers, summary, state, trigger);
});

/**
 * The compaction a request boundary may need, no attempt open: one for the
 * `/compact`s waiting (`requests`, which the edit consumes), else one when
 * the history has reached the threshold. The request waits for the summary
 * and goes out over the state this answers.
 */
export const compactAtBoundary = Effect.fn('compaction.atBoundary')(function* (
  input: CompactionInput,
  requests: readonly RunHistoryDraft[],
) {
  if (requests.length > 0) return yield* compact(input, 'user', requests);
  const state = yield* input.cell.current;
  if (!(yield* overThreshold(state, input))) return state;
  return yield* compact(input, 'context-limit', []);
});

/**
 * After a request the window could not hold: compact once per turn and
 * answer with the state to send again, or null (the turn fails).
 */
export const compactAfterOverflow = Effect.fn('compaction.afterOverflow')(
  function* (input: CompactionInput) {
    const state = yield* input.cell.current;
    const error = state.invocation?.current.failed?.error;
    if (
      state.overflowCompacted ||
      error?.source !== 'model' ||
      error.kind !== 'context-overflow'
    )
      return null;
    const compacted = yield* compact(input, 'overflow', []);
    // Its edit is what marks the turn compacted: none landed without it.
    return compacted.overflowCompacted ? compacted : null;
  },
);
