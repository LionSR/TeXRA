/**
 * Conversation compaction for the tool-use loop: a run-scoped step beside
 * the loop that writes the one row that shortens history, `model.compaction`
 * with cause `context-limit` (or `context-window` when a turn overflowed the
 * window), from the ledger-retained history and nothing else. The trigger is
 * the compaction threshold setting measured against the bound model's
 * context window (the run's `contextTokens`), a `/compact` request, or an
 * overflow; the replacement is a summary the bound model produces through the
 * invoker's priced `call`, folded back as one user message. Every skip and
 * every failure is logged and shown as a compaction activity, never silent.
 *
 * The compaction prompts and the summary cap live here because this is the
 * reader that owns them on the run loop.
 */
import { Cause, Effect, Exit } from 'effect';

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
import type { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { rowAggregate, type Message } from '../loop/rows';
import { contextTokens, estimateMessageTokens } from './contextTokens';
import { turnText } from './turnText';
import type { ModelInvoker } from '../ModelInvoker';
import type { BoundModel } from './modelBinding';

/**
 * Prefix prepended to a compaction summary when it is folded back into the
 * conversation as a synthetic user message, so the resumed-conversation
 * marker stays identical across providers.
 */
const COMPACTION_SUMMARY_PREFIX = '[Previous conversation summary]\n\n';

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
  readonly ledger: RunLedger['Service'];
  readonly logger: AgentTrace;
  readonly bound: BoundModel;
  /** The run's invoker, which makes the summary call. */
  readonly invoker: ModelInvoker['Service'];
  /** The session's setting slots: the threshold is a live per-check read. */
  readonly stores: SettingsStores;
  /**
   * Compact regardless of the threshold: a `/compact` request, or a turn that
   * overflowed the context window (recorded as cause `context-window`, which
   * the fold reads as the round's one overflow recovery). `null` leaves the
   * decision to the threshold.
   */
  readonly force: 'request' | 'overflow' | null;
}

/** Why a compaction runs, as its debug line names it. */
const COMPACTION_REASON = {
  request: 'manually requested',
  overflow: 'context window exceeded',
  threshold: 'token threshold exceeded',
} as const;

/**
 * Compact the run's history when it reaches the configured share of the
 * bound model's context window, or when the user asked for it. Returns the
 * folded state after the `model.compaction` row, or the state unchanged when
 * nothing was compacted (below the threshold, too short to summarize, or a
 * summary attempt that failed, which is logged and shown, never a stop).
 */
export const compactIfNeeded = Effect.fn('compaction.check')(function* (
  state: RunState,
  input: CompactionInput,
): Effect.fn.Return<
  RunState,
  RunLedgerRefused | DatabaseWriteFailed | StateReadFailed
> {
  const { runId, ledger, logger, bound, force } = input;
  const percent = yield* readSettingFrom<number>(
    input.stores,
    MODEL_COMPACTION_THRESHOLD_SETTING.configKey,
  );
  if (force === null && percent <= 0) return state;
  const conversation = state.messages;
  if (conversation.length <= 2) {
    if (force !== null) {
      logger.debug('Conversation too short for compaction, skipping');
    }
    return state;
  }
  const contextWindow = bound.contextWindow;
  const tokensBefore = contextTokens(state);
  if (
    force === null &&
    (contextWindow <= 0 ||
      tokensBefore <= Math.floor((percent / 100) * contextWindow))
  ) {
    return state;
  }

  logger.debug(
    `Compacting conversation (${COMPACTION_REASON[force ?? 'threshold']})`,
    {
      data: {
        inputTokens: tokensBefore,
        utilizationPercent: roundedUtilizationPercent(
          tokensBefore,
          contextWindow,
        ),
        contextWindow,
      },
    },
  );
  const activity = startCompactionActivity(logger);
  // The summary is a model call like any other: the invoker gates, prices
  // and reports it, and its usage rides the row below. It leaves out the
  // context updates: the next step renders them into the system text anew.
  // Its output fits what its input leaves of the window, up to the model's
  // own limit; a limit too small for a manual thinking budget runs without
  // thinking (the model's rule, not this one's).
  const summarized = yield* Effect.exit(
    input.invoker.call(
      {
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
      },
      state.declinedRoutes,
    ),
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
    return state;
  }
  // The summary turn's own text, trimmed: an empty summary is skipped.
  const summary = turnText(summarized.value.turn).trim();
  if (!summary) {
    logger.warn('Compaction returned empty summary, skipping');
    activity.finish('skipped');
    return state;
  }
  const replacement: Message = {
    role: 'user',
    content: [{ kind: 'text', text: `${COMPACTION_SUMMARY_PREFIX}${summary}` }],
  };
  const tokensAfter = Math.max(1, estimateMessageTokens([replacement]));
  // The only row that shortens history: the whole conversation is replaced
  // by the summary, and a provider-side continuation over the old history is
  // dropped with it.
  const compacted = yield* ledger.appendBatch(runId, state, [
    {
      type: 'model.compaction',
      aggregateId: rowAggregate(runId),
      payload: {
        keepPrefix: 0,
        messages: [replacement],
        cause: force === 'overflow' ? 'context-window' : 'context-limit',
        continuation: null,
        usage: summarized.value.usage,
      },
    },
  ]);
  logCompactionEvent({
    logger,
    tokensBefore,
    tokensAfter,
    contextWindow,
    details: `${conversation.length} messages summarized`,
  });
  activity.finish('completed');
  return compacted;
});
