/**
 * Conversation compaction for the tool-use loop: a run-scoped step beside
 * the loop that writes the one row that shortens history, `model.compaction`
 * with cause `context-limit`, from the ledger-retained history and nothing
 * else. The trigger is the compaction threshold setting measured against the
 * bound model's context window (a live input estimate where the provider
 * offers one, a text-length estimate otherwise) or a `/compact` request; the
 * replacement is a summary the bound model itself produces through a
 * throwaway `generateTurn`, folded back as one user message. Every skip and
 * every failure is logged and shown as a compaction activity, never silent.
 *
 * The compaction prompts, the summary cap and the token heuristic live here
 * because this is the reader that owns them on the run loop; the handler
 * tree's non-loop paths import them from here until that tree goes.
 */
import { Cause, Effect, Exit } from 'effect';

import {
  logContextManagementEvent,
  startCompactionActivity,
  type AgentTrace,
} from '@agent/trace';
import type { TurnRequest, TurnResult } from '@llm/turn';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import {
  MODEL_COMPACTION_THRESHOLD_SETTING,
  ModelCompactionThresholdPercentSchema,
  type RunId,
} from '@shared/schemas';
import type { DatabaseWriteFailed } from '@shared/session/database';
import type { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { getValidatedConfig } from '@utils/config/configUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { rowAggregate, type Message } from '../loop/rows';
import type { BoundModel } from './modelBinding';

/** Max tokens for the compaction summary response. */
const CLIENT_COMPACTION_SUMMARY_MAX_TOKENS = 2000;

/**
 * Prefix prepended to a compaction summary when it is folded back into the
 * conversation as a synthetic user message, so the resumed-conversation
 * marker stays identical across providers.
 */
const COMPACTION_SUMMARY_PREFIX = '[Previous conversation summary]\n\n';

/**
 * Rough chars-per-token ratio for estimating token counts without a
 * tokenizer. ~4 chars/token is the standard approximation for GPT-family
 * models on English and code. Used only where exact counting is unavailable.
 */
const ESTIMATED_CHARS_PER_TOKEN = 4;

/**
 * Heuristic token estimate for `text` when no tokenizer or counting API is
 * available. Deliberately coarse; callers pair it with a safety buffer.
 */
function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / ESTIMATED_CHARS_PER_TOKEN);
}

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
  readonly tokensAfterIsEstimate?: boolean;
}

function logCompactionEvent({
  logger,
  tokensBefore,
  tokensAfter,
  contextWindow,
  details,
  tokensAfterIsEstimate = false,
}: LogCompactionEventOptions): void {
  const reduction = tokensBefore - tokensAfter;
  const reductionPercent =
    tokensBefore > 0 ? ((reduction / tokensBefore) * 100).toFixed(1) : '0';
  const afterPrefix = tokensAfterIsEstimate ? '~' : '';

  logContextManagementEvent(
    logger,
    `Compacted conversation: ${tokensBefore.toLocaleString()} → ${afterPrefix}${tokensAfter.toLocaleString()} tokens (${reductionPercent}% reduction)`,
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

/** The compaction threshold setting, validated like its sibling readers. */
function compactionThresholdPercent(): number {
  return getValidatedConfig(
    MODEL_COMPACTION_THRESHOLD_SETTING.configKey,
    ModelCompactionThresholdPercentSchema,
    MODEL_COMPACTION_THRESHOLD_SETTING.defaultValue,
  );
}

/** The text of a history, for the estimate a provider cannot give. */
function historyText(messages: readonly Message[]): string {
  const pieces: string[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        for (const part of result.content) {
          if (part.kind === 'text') pieces.push(part.text);
        }
      }
      continue;
    }
    for (const part of message.content) {
      if (part.kind === 'text') pieces.push(part.text);
      else if (part.kind === 'message') {
        for (const piece of part.content) pieces.push(piece.text);
      }
    }
  }
  return pieces.join('\n');
}

/** The assistant text of the summary turn, joined. */
function summaryText(turn: TurnResult): string {
  return turn.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('')
    .trim();
}

export interface CompactionInput {
  readonly runId: RunId;
  readonly ledger: RunLedger['Service'];
  readonly logger: AgentTrace;
  readonly bound: BoundModel;
  /** The system text and tools of the turn about to be issued: the input
   *  estimate counts the request as it will be sent. */
  readonly system: string | undefined;
  readonly tools: TurnRequest['tools'];
  /** A `/compact` request: compact regardless of the threshold. */
  readonly force: boolean;
}

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
): Effect.fn.Return<RunState, RunLedgerRefused | DatabaseWriteFailed> {
  const { runId, ledger, logger, bound, force } = input;
  const percent = compactionThresholdPercent();
  if (!force && percent <= 0) return state;
  const conversation = state.messages;
  if (conversation.length <= 2) {
    if (force) logger.debug('Conversation too short for compaction, skipping');
    return state;
  }
  const contextWindow = bound.contextWindow;
  let tokensBefore: number;
  let tokensBeforeIsEstimate = false;
  if (force) {
    tokensBefore = estimateTokensFromText(historyText(conversation));
    tokensBeforeIsEstimate = true;
  } else {
    // The live count where the provider offers one, counted on the request as
    // it will be sent; a count that fails is logged and the text heuristic
    // decides, so a counting outage never disables the threshold.
    let counted: number | null = null;
    if (bound.model.estimateInputTokens && contextWindow > 0) {
      const prepared = yield* Effect.exit(
        bound.model.prepareTurn({
          mode: 'foreground',
          ...(input.system !== undefined ? { system: input.system } : {}),
          messages: conversation,
          ...(input.tools !== undefined ? { tools: input.tools } : {}),
          ...(state.continuation !== null &&
          state.continuation.origin.protocol === bound.origin.protocol &&
          state.continuation.origin.requestedModel ===
            bound.origin.requestedModel
            ? { continuation: state.continuation }
            : {}),
        }),
      );
      if (Exit.isFailure(prepared)) {
        if (Cause.hasInterrupts(prepared.cause)) return yield* Effect.interrupt;
        logger.debug('Compaction preflight could not prepare the request.', {
          data: Cause.squash(prepared.cause),
        });
      } else if (prepared.value.mode === 'foreground') {
        const estimate = yield* Effect.exit(
          bound.model.estimateInputTokens(prepared.value),
        );
        if (Exit.isFailure(estimate)) {
          if (Cause.hasInterrupts(estimate.cause)) {
            return yield* Effect.interrupt;
          }
          logger.debug(
            'Token counting failed; the compaction threshold uses a text estimate.',
            { data: Cause.squash(estimate.cause) },
          );
        } else {
          counted = estimate.value.inputTokens;
        }
      }
    }
    if (counted === null) {
      tokensBefore = estimateTokensFromText(historyText(conversation));
      tokensBeforeIsEstimate = true;
    } else {
      tokensBefore = counted;
    }
    const threshold = Math.floor((percent / 100) * contextWindow);
    if (contextWindow <= 0 || tokensBefore <= threshold) return state;
  }

  logger.debug(
    force
      ? 'Compacting conversation (manually requested)'
      : 'Compacting conversation (token threshold exceeded)',
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
  const summarized = yield* Effect.exit(
    Effect.gen(function* () {
      const prepared = yield* bound.model.prepareTurn({
        mode: 'foreground',
        system: COMPACTION_SYSTEM_PROMPT,
        messages: [
          ...conversation,
          {
            role: 'user',
            content: [{ kind: 'text', text: COMPACTION_USER_PROMPT }],
          },
        ],
        tools: [],
        maxOutputTokens: CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
      });
      if (prepared.mode !== 'foreground') {
        return yield* Effect.die(
          new Error('A foreground compaction request resolved as background.'),
        );
      }
      return yield* bound.model.generateTurn(prepared);
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
    return state;
  }
  const summary = summaryText(summarized.value);
  if (!summary) {
    logger.warn('Compaction returned empty summary, skipping');
    activity.finish('skipped');
    return state;
  }
  const replacement: Message = {
    role: 'user',
    content: [{ kind: 'text', text: `${COMPACTION_SUMMARY_PREFIX}${summary}` }],
  };
  const tokensAfter = Math.max(
    1,
    estimateTokensFromText(`${COMPACTION_SUMMARY_PREFIX}${summary}`),
  );
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
        cause: 'context-limit',
        continuation: null,
        continuationDropped:
          state.continuation === null ? null : 'history-replaced',
      },
    },
  ]);
  logCompactionEvent({
    logger,
    tokensBefore,
    tokensAfter,
    contextWindow,
    details: `${conversation.length} messages summarized${tokensBeforeIsEstimate ? ' (estimated input)' : ''}`,
    tokensAfterIsEstimate: true,
  });
  activity.finish('completed');
  return compacted;
});
