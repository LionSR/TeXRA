// Local imports
import { type AgentTrace, startCompactionActivity } from '@agent/trace';
import type {
  TokenCountOptions,
  TokenValidationResult,
} from '@agent/types/ModelHandlerContracts';
import { attachContextWindowError } from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import {
  buildErrorLogData,
  getSdkErrorMessage,
} from '@common/errors/sdkError/providerErrorFormat';
import { clamp } from '@utils/core';

// Local file imports
import { roundedUtilizationPercent } from '../support/contextUtilization';
import { logCompactionEvent } from '../support/compactionLogging';
import { AUXILIARY_MAX_RETRIES } from '../support/auxiliaryRetry';
import {
  CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
  COMPACTION_USER_PROMPT,
  estimateTokensFromText,
} from '../contextManagementConstants';
import {
  contentToText,
  createInputText,
  isMessageItem,
} from './openAIResponseContent';
import type { ServerChainState } from '../support/ServerChainState';

// Third-party imports
import type OpenAI from 'openai';
import type {
  CompactedResponse,
  Response,
  ResponseCompactParams,
  ResponseInputItem,
} from 'openai/resources/responses/responses';

/**
 * Result from compactConversation including messages and state updates.
 * State updates are returned but not applied - caller is responsible for
 * applying them only after successful API call to prevent stale state on retry.
 *
 * `sourceMessages` is the exact `messages` array reference compaction ran
 * against — it's how {@link createResponseImpl} recognizes a same-turn retry
 * (PocketFlow's `Node._exec` reuses the same `prepRes`, hence the same
 * `messages` reference, across retry attempts) and reuses this result
 * instead of re-running compaction. That reuse is what keeps this payload's
 * retry lifetime matched to {@link ServerChainState.clearChainForCompaction}'s
 * anchor clear, which already survives retries permanently — without it, the
 * anchor clear alone would survive while this payload got wiped every
 * attempt, forcing a redundant re-compaction on each retry.
 *
 * Reference equality alone cannot distinguish a same-turn retry from the
 * next turn, since `ModelInvocationNode.post()` mutates the shared messages
 * array in place (same reference survives across turns too). The field is
 * therefore also cleared unconditionally by {@link applyCompactionState} on
 * every successful call, so it can never outlive the turn it was computed
 * for; the `sourceMessages` check only ever matters while an attempt from
 * this same turn is still retrying after a failure.
 */
export interface OpenAICompactionResult {
  compactedMessages: ResponseInputItem[];
  tokensAfter: number;
  sourceMessages: ResponseInputItem[];
  sourceFingerprint: string;
}

/**
 * The handler surface {@link OpenAICompactionCoordinator} reads: capability
 * and routing predicates (suppliers rather than snapshots, since several
 * depend on the active credential route or provider profile), the chain-state
 * collaborator compaction mutates, and callbacks into the base handler for
 * token counting, validation, and the client-side summarization scaffold.
 */
interface OpenAICompactionHost {
  /** The `previous_response_id` chain anchor + conversation bookkeeping. */
  readonly chainState: ServerChainState;
  /** Model wire id used in compact/summarize request params. */
  readonly modelFullName: string;
  /** Supplier rather than a snapshot: the handler's logger can be replaced
   *  after construction via `setLogger()`. */
  getLogger(): AgentTrace;
  supportsReasoning(): boolean;
  supportsManualCompaction(): boolean;
  supportsTokenCounting(): boolean;
  storesResponsesServerSide(): boolean;
  isOpenRouterRoutingEnabled(): boolean;
  getEffectiveContextWindow(): number;
  getEffectiveInputTokenLimit(): number;
  getCompactionThresholdPercent(): number;
  getTokenSafetyBuffer(): number;
  isCompactionRequested(): boolean;
  consumeCompactionRequest(): boolean;
  messagesTailFingerprint(messages: ResponseInputItem[]): string;
  estimateTokenCount(
    messages: ResponseInputItem[],
    options?: TokenCountOptions<OpenAI>,
  ): Promise<number>;
  extractResponseText(response: Response): string;
  validateTokenLimits(
    inputTokens: number,
    maxTokens: number,
    contextWindow: number,
    tokenBuffer?: number,
  ): TokenValidationResult;
  logMaxTokensReduced(params: {
    tokensBefore: number;
    tokensBeforeIsEstimate?: boolean;
    contextWindow: number;
    utilizationPercent?: number;
    originalMaxTokens: number;
    reducedMaxTokens: number;
    details: string;
  }): void;
  runClientCompaction(
    messages: ResponseInputItem[],
    tokensBefore: number,
    summarize: (
      conversationMessages: ResponseInputItem[],
      systemPrompt: string,
    ) => Promise<{ summaryText: string; outputTokens: number }>,
    buildSummaryMessage: (summary: string) => ResponseInputItem,
  ): Promise<{
    compactedMessages: ResponseInputItem[];
    didCompact: boolean;
  }>;
}

/**
 * The compaction lane of {@link ModelHandlerOpenAIResponse}: the pending
 * compaction-result cache (whose reference-equality and clear-on-success
 * lifetime semantics move here intact), the threshold/routing trigger
 * predicates, both compaction transports (stateful `/responses/compact` and
 * the client-side summarize-and-resend fallback), the token-count failure
 * fallback, and the one-shot retry-source guard. The handler constructs this
 * once per instance and keeps thin delegates where tests reach the seam.
 */
export class OpenAICompactionCoordinator {
  /** Internal compaction recovery already attempted during this public call. */
  retrySource: 'threshold' | 'overflow' | null = null;

  /** The pending compaction payload; see {@link OpenAICompactionResult} for
   *  the same-turn-retry lifetime semantics this cache obeys. */
  result?: OpenAICompactionResult;

  constructor(private readonly host: OpenAICompactionHost) {}

  /**
   * Calculate the absolute token threshold based on the model's context window
   * and the configured percentage threshold.
   */
  getCompactionTokenThreshold(): number {
    const percent = this.host.getCompactionThresholdPercent();
    if (percent <= 0) {
      return 0;
    }
    return Math.floor(
      (percent / 100) * this.host.getEffectiveInputTokenLimit(),
    );
  }

  /**
   * Whether this route can compact at all: compaction is supported, not
   * routed through OpenRouter (which may not support compaction), and there
   * is prior conversation to compact. Shared by the manual/requested flag
   * path and the live-count decision in {@link createResponseImpl}.
   */
  canCompactRoute(): boolean {
    return (
      this.host.supportsManualCompaction() &&
      !this.host.isOpenRouterRoutingEnabled() &&
      this.host.chainState.getCumulativeInputTokens() > 0
    );
  }

  /**
   * Check if the conversation should be compacted.
   *
   * Automatic compaction is decided by the live pre-flight token count in
   * {@link createResponseImpl} — one measurement of the CURRENT request owns
   * the decision (it mints its own compaction request and retries
   * internally). The cumulative-usage threshold below is only the fallback
   * decision for models that cannot count tokens pre-flight; the cumulative
   * figure comes from the PREVIOUS successful response and goes stale the
   * moment a single turn adds a large input.
   */
  shouldCompact(): boolean {
    if (!this.host.supportsManualCompaction()) {
      this.host.consumeCompactionRequest();
      return false;
    }

    // Manual/requested compaction bypasses threshold checks.
    // The flag is NOT cleared here - the caller clears it after compaction
    // is attempted to preserve the request across retries.
    if (this.host.isCompactionRequested()) {
      return this.canCompactRoute();
    }

    if (this.host.supportsTokenCounting()) {
      // The live pre-flight count decides for counting-capable models.
      // Deliberate tradeoff: if the count API soft-fails for a turn, that
      // turn has no automatic compaction trigger at all (the stale cumulative
      // figure is not consulted) — the API enforces the window, and an
      // API-side overflow still recovers via handleCreateResponseError's
      // compact-and-retry. Costs one extra round-trip in that rare failure
      // mode; keeps the live count the single decision owner.
      return false;
    }

    const thresholdPercent = this.host.getCompactionThresholdPercent();
    if (thresholdPercent <= 0) {
      return false;
    }
    if (this.host.isOpenRouterRoutingEnabled()) {
      // Same exclusion as canCompactRoute(): OpenRouter conversations compact
      // through ModelHandlerOpenRouterNative. Nothing is logged here because
      // the capability gate above already returns for every OpenRouter-routed
      // request — no provider profile grants supportsManualCompaction on that
      // route — so this only pins the invariant.
      return false;
    }
    const threshold = this.getCompactionTokenThreshold();
    return this.host.chainState.getCumulativeInputTokens() > threshold;
  }

  /**
   * Compact the conversation to reduce context size via OpenAI's stateful
   * `/responses/compact` endpoint, which replaces prior assistant messages,
   * tool calls, and results with a single encrypted compaction item.
   *
   * Only usable when {@link storesResponsesServerSide} is true — the compact
   * endpoint acts on a stored server-side response, which a `store: false`
   * backend (the ChatGPT-subscription/Codex profile) never has. That backend
   * is compacted via {@link compactConversationClientSide} instead, a
   * distinct code path that never calls this endpoint.
   *
   * State updates are stored in compactionResult but NOT applied immediately.
   * The caller must apply them only after successful API call to prevent
   * stale state if the API call fails and needs to retry.
   *
   * @param client - OpenAI client instance
   * @param messages - Current conversation messages
   * @param systemPrompt - Optional system instructions
   * @param signal - Optional abort signal
   * @returns The compacted messages array, or original messages if compaction fails
   */
  async compactConversation(
    client: OpenAI,
    messages: ResponseInputItem[],
    systemPrompt?: string,
    signal?: AbortSignal,
    convertedTools?: unknown[],
  ): Promise<ResponseInputItem[]> {
    const tokensBefore = this.host.chainState.getCumulativeInputTokens();
    const contextWindow = this.host.getEffectiveContextWindow();

    this.host.getLogger().debug('Compacting conversation', {
      data: {
        inputTokens: tokensBefore,
        utilizationPercent: roundedUtilizationPercent(
          tokensBefore,
          contextWindow,
        ),
        contextWindow,
      },
    });

    const compactParams: ResponseCompactParams = {
      model: this.host.modelFullName,
      input: messages,
    };

    if (systemPrompt) {
      compactParams.instructions = systemPrompt;
    }

    // NOTE: Do NOT pass previous_response_id here.
    // We're sending the full message history in `input`, so passing
    // previous_response_id would cause double-counting and exceed context window.

    const activity = startCompactionActivity(this.host.getLogger());
    try {
      const compactedResponse: CompactedResponse = await client
        .withOptions({ maxRetries: AUXILIARY_MAX_RETRIES })
        .responses.compact(compactParams, { signal });

      // Note: SDK types CompactedResponse.output as ResponseOutputItem[], but the
      // compact endpoint returns ResponseInputItem[] suitable for re-submission.
      const compactedMessages =
        compactedResponse.output as unknown as ResponseInputItem[];
      if (compactedMessages.length === 0) {
        this.host
          .getLogger()
          .warn('Compaction returned no reusable context, skipping');
        this.result = undefined;
        activity.finish('skipped');
        return messages;
      }

      // CRITICAL: Clear the chain anchor now that compaction has replaced the
      // server-side history. Must happen BEFORE estimateTokenCount — otherwise the
      // count would include the full previous conversation on top of the compacted
      // messages, massively inflating the result.
      this.host.chainState.clearChainForCompaction();

      // Count the actual tokens of the compacted messages rather than relying on
      // usage fields from the compact response (usage.input_tokens is the cost of
      // the compact operation's input, and usage.output_tokens may not match the
      // input token cost when these items are re-submitted).
      let tokensAfter: number;
      try {
        tokensAfter = await this.host.estimateTokenCount(compactedMessages, {
          client,
          signal,
          systemPrompt,
          tools: convertedTools,
        });
      } catch (err) {
        // Fall back to output_tokens if token counting fails. Log so a degraded
        // post-compaction token estimate is visible rather than silent.
        this.host
          .getLogger()
          .debug(
            'Post-compaction token counting failed; falling back to output_tokens',
            {
              data: buildErrorLogData(err, {
                operation: 'post-compaction token counting',
              }),
            },
          );
        // NOTE: It's unclear what output_tokens represents exactly for the compact
        // endpoint — it may be the generation cost rather than the reusable content
        // size. This fallback is a best-effort estimate until OpenAI clarifies.
        tokensAfter = compactedResponse.usage.output_tokens;
      }

      logCompactionEvent({
        logger: this.host.getLogger(),
        tokensBefore,
        tokensAfter,
        contextWindow,
        details: `OpenAI Responses API compaction: ${compactedResponse.output.length} items`,
      });

      // Store compacted messages for use in this request.
      // Mark as pending compaction - state will be finalized after successful API call.
      // This prevents stale state if API call fails and needs retry.
      this.result = {
        compactedMessages,
        tokensAfter,
        sourceMessages: messages,
        sourceFingerprint: this.host.messagesTailFingerprint(messages),
      };

      activity.finish('completed');
      return compactedMessages;
    } catch (err) {
      const userAborted = isUserAbort(err);
      activity.finish(userAborted ? 'cancelled' : 'failed');
      signal?.throwIfAborted();
      if (userAborted) throw err;
      this.host
        .getLogger()
        .warn(
          `Compaction failed, continuing with original messages: ${getSdkErrorMessage(err)}`,
          {
            data: buildErrorLogData(err, { operation: 'compact conversation' }),
          },
        );
      this.result = undefined;
      return messages;
    }
  }

  /**
   * Client-side compaction fallback for backends that cannot use the
   * stateful `/responses/compact` endpoint (see {@link compactConversation})
   * because they don't store responses server-side — the ChatGPT-subscription
   * (Codex) backend forces `store: false` on every request, so there is no
   * stored response for the compact endpoint to act on (#7213). Summarizes
   * the conversation locally via a throwaway system-prompt-swap call to the
   * same Responses API, then resends a single summary message instead of the
   * full history. Reuses the `ModelHandler.runClientCompaction` scaffold
   * already shared by the Chat Completions, OpenRouter-native, and Google
   * Interactions handlers.
   *
   * The summarization call always streams: this path only ever runs under a
   * profile that also forces `streaming: 'forced'` (see
   * `getStreamingConfig`), and a non-streaming request would receive an SSE
   * body it can't parse.
   *
   * State updates are stored in compactionResult but NOT applied immediately,
   * mirroring {@link compactConversation} — the caller applies them only
   * after a successful API call so a failed retry doesn't see stale state.
   *
   * @param client - OpenAI client instance
   * @param messages - Current conversation messages
   * @param signal - Optional abort signal
   * @returns The compacted messages array, or original messages if compaction fails
   */
  async compactConversationClientSide(
    client: OpenAI,
    messages: ResponseInputItem[],
    signal?: AbortSignal,
  ): Promise<ResponseInputItem[]> {
    const tokensBefore = this.host.chainState.getCumulativeInputTokens();
    const contextWindow = this.host.getEffectiveContextWindow();

    this.host.getLogger().debug('Compacting conversation (client-side)', {
      data: {
        inputTokens: tokensBefore,
        utilizationPercent: roundedUtilizationPercent(
          tokensBefore,
          contextWindow,
        ),
        contextWindow,
      },
    });

    const { compactedMessages, didCompact } =
      await this.host.runClientCompaction(
        messages,
        tokensBefore,
        async (conversationMessages, compactionSystemPrompt) => {
          const stream = await client
            .withOptions({ maxRetries: AUXILIARY_MAX_RETRIES })
            .responses.stream(
              {
                model: this.host.modelFullName,
                instructions: compactionSystemPrompt,
                input: [
                  ...conversationMessages,
                  {
                    type: 'message',
                    role: 'user',
                    content: [createInputText(COMPACTION_USER_PROMPT)],
                  },
                ],
                max_output_tokens: CLIENT_COMPACTION_SUMMARY_MAX_TOKENS,
                store: this.host.storesResponsesServerSide(),
                ...(this.host.supportsReasoning() && {
                  reasoning: { effort: 'low' },
                }),
              },
              { signal },
            );

          // The ChatGPT-subscription (Codex) backend strips `max_output_tokens`
          // at the wire (it answers `400 Unsupported parameter: max_output_tokens`
          // — see rewriteCodexRequestBody), so the summary cap cannot be enforced
          // server-side on this path, and this client-side path only ever runs for
          // that stateless profile. Enforce the cap locally instead: stop
          // consuming and abort the request once the streamed summary reaches the
          // cap, bounding both the resent summary size and the summarization
          // turn's latency. Under a backend that does honor `max_output_tokens`
          // the stream ends first, so this ceiling is never hit.
          let streamedText = '';
          for await (const event of stream) {
            if (event.type !== 'response.output_text.delta') continue;
            streamedText += event.delta;
            if (
              estimateTokensFromText(streamedText) >=
              CLIENT_COMPACTION_SUMMARY_MAX_TOKENS
            ) {
              stream.abort();
              return {
                summaryText: streamedText.trim(),
                outputTokens: estimateTokensFromText(streamedText),
              };
            }
          }

          // Prefer the text accumulated from the deltas above: the Codex backend
          // leaves the completed response's `output`/`output_text` empty (the same
          // reason executeStreamingPath rebuilds from `output_text.delta`), so
          // extracting only from finalResponse() would yield an empty summary and
          // silently skip compaction. Fall back to finalResponse() extraction only
          // when no text was streamed.
          const summaryResponse = await stream.finalResponse();
          const summaryText =
            streamedText.trim() ||
            this.host.extractResponseText(summaryResponse).trim();
          return {
            summaryText,
            outputTokens:
              summaryResponse.usage?.output_tokens ??
              estimateTokensFromText(summaryText),
          };
        },
        (summary): ResponseInputItem => ({
          type: 'message',
          role: 'user',
          content: [createInputText(summary)],
        }),
      );

    if (!didCompact) {
      this.result = undefined;
      return compactedMessages;
    }

    // CRITICAL: clear now, before this handler builds the next request —
    // the compacted messages replace the discarded history, so a stale
    // previousResponseId must never be resent alongside them (same reason as
    // compactConversation()'s stateful path).
    this.host.chainState.clearChainForCompaction();
    this.result = {
      compactedMessages,
      // Bookkeeping must reflect the INPUT cost of resending the compacted
      // payload next turn (system items + the summary message with its
      // "[Previous conversation summary]" prefix), not the OUTPUT cost of
      // generating the summary — mirroring the stateful path, which counts the
      // compacted items' input tokens. `applyTokenCountFailureFallback()`
      // prefers this value over the chain's cumulative count, and on the Codex
      // profile it is load-bearing: token counting
      // is unavailable and the route-input-limit guard fails the request
      // locally when the estimate + safety buffer overflow that limit, so an
      // output-token underestimate could let through a request the backend
      // then rejects.
      tokensAfter: this.estimateResentInputTokens(compactedMessages),
      sourceMessages: messages,
      sourceFingerprint: this.host.messagesTailFingerprint(messages),
    };
    return compactedMessages;
  }

  /**
   * Estimate the input-token cost of resending the compacted payload. The
   * ChatGPT-subscription (Codex) profile — the only backend that reaches
   * {@link compactConversationClientSide} — exposes no token-counting endpoint
   * (`supportsTokenCounting: false`), so {@link estimateTokenCount} throws and
   * the stateful path's exact API count is unavailable; fall back to a
   * text-length heuristic over exactly what gets resent.
   */
  private estimateResentInputTokens(messages: ResponseInputItem[]): number {
    // Flatten message content (string or typed parts) to plain text;
    // non-text items contribute nothing to the estimate.
    const text = messages
      .map((message) =>
        isMessageItem(message) ? contentToText(message.content, '') : '',
      )
      .join('\n');
    return Math.max(1, estimateTokensFromText(text));
  }

  /**
   * Apply compaction state updates after successful API call.
   * Updates conversation state flags.
   *
   * Note: cumulativeInputTokens is NOT updated here - it will be set from
   * response.usage.input_tokens after the API call to reflect actual usage.
   */
  applyCompactionState(): void {
    if (!this.result) return;

    // Reset sent messages counter and mark as compacted so subsequent
    // requests know to send all messages.
    this.host.chainState.markCompactionApplied();

    // Note: the chain anchor is already cleared immediately after compaction
    // (before API call) to avoid "No tool output found" errors.

    // Clear compactionResult now that this successful call has consumed it.
    // This runs only on success (finalizeResponse's success paths), never on
    // a failed attempt that will be retried, so it can't be confused with the
    // same-turn-retry cache check in createResponseImpl(). Clearing here
    // (rather than relying on `sourceMessages !== messages` reference
    // (in)equality) matters because PocketFlow's ModelInvocationNode.post()
    // mutates `shared.messages` in place via replaceMessagesInPlace
    // (length=0 + push), so the array reference is often IDENTICAL across
    // turns, not just across retries of the same turn. Leaving compactionResult
    // set here would make the next turn's genuinely different input look like
    // a same-turn retry, resend this turn's stale compactedMessages, and
    // silently drop everything appended since (tool outputs, new user turns).
    this.result = undefined;
  }

  applyTokenCountFailureFallback(maxOutputTokens: number): number {
    // Best available estimate of current input tokens: the post-compaction
    // figure when compaction just happened, else the previous response's
    // cumulative count, else 0 on the first turn.
    const inputEstimate =
      this.result?.tokensAfter ??
      this.host.chainState.getCumulativeInputTokens();
    if (inputEstimate <= 0) return maxOutputTokens;

    const buffer = this.host.getTokenSafetyBuffer();
    const inputTokenLimit = this.host.getEffectiveInputTokenLimit();
    if (inputEstimate + buffer >= inputTokenLimit) {
      const error = new Error(
        `Token estimate (${inputEstimate}) + safety buffer (${buffer}) exceeds route input limit (${inputTokenLimit}).`,
      );
      attachContextWindowError(error);
      throw error;
    }
    const contextWindow = this.host.getEffectiveContextWindow();
    const bufferedMaxTokens = contextWindow - inputEstimate - buffer;
    const validation = this.host.validateTokenLimits(
      inputEstimate,
      maxOutputTokens,
      contextWindow,
      buffer,
    );
    const capped = clamp(
      Math.min(validation.adjustedMaxTokens, bufferedMaxTokens),
      0,
      maxOutputTokens,
    );
    if (capped === maxOutputTokens) return maxOutputTokens;

    this.host.getLogger().debug('Fallback: adjusting max_output_tokens', {
      data: { before: maxOutputTokens, after: capped, inputEstimate },
    });
    this.host.logMaxTokensReduced({
      tokensBefore: inputEstimate,
      tokensBeforeIsEstimate: true,
      contextWindow,
      utilizationPercent: validation.utilizationPercent,
      originalMaxTokens: maxOutputTokens,
      reducedMaxTokens: capped,
      details:
        'OpenAI Response: max_output_tokens reduced from fallback estimate',
    });
    return capped;
  }

  /** Drop a cached compaction result that no longer matches the current input. */
  invalidateStaleCompactionCache(messages: ResponseInputItem[]): void {
    // A same-turn retry (PocketFlow's Node._exec reuses the same prepRes, hence
    // the same `messages` reference, across retry attempts) keeps its cached
    // result — otherwise the chain anchor that compaction already cleared on
    // chainState (which survives retries permanently) would outlive this
    // payload, forcing a redundant re-compaction on every retry. A retained
    // pending response is handled by the caller before this state can be
    // discarded. This reference check alone is NOT sufficient to distinguish a
    // same-turn retry from the next turn, because ModelInvocationNode.post()
    // mutates `shared.messages` in place, so the reference is often identical
    // across turns too; the primary cross-turn guard is applyCompactionState()
    // clearing compactionResult on every successful call. This only matters
    // while a compaction from a still-in-flight (unsuccessful) attempt is pending.
    if (
      this.result !== undefined &&
      (this.result.sourceMessages !== messages ||
        this.result.sourceFingerprint !==
          this.host.messagesTailFingerprint(messages))
    ) {
      // Reference or content changed — a follow-up appended after a failed
      // turn mutates the SAME array in place, so identity alone would replay
      // a stale pre-follow-up payload and silently drop the user's message.
      this.result = undefined;
    }
  }
}
