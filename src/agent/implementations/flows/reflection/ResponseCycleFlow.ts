import * as path from 'node:path';

import { BaseNode, Flow } from '@agent/node';
import { getSystemPromptWithRules } from '@agent/prompt/PromptBuilder';
import { recordCycleMetrics } from '@agent/core/state/AgentState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  type BaseCycleFields,
  defaultPostCompactionContext,
  extractModelResponse,
  resetCycleState,
  saveCycleDebug,
  type SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
import {
  ANTHROPIC_STOP,
  GOOGLE_FINISH,
  isContextWindowExceededStopReason,
  isTokenLimitStopReason,
  OPENAI_CHAT_FINISH,
  type ProviderStopReason,
} from '@agent/types/StopReasonTypes';
import { K_SLICE } from '@agent/core/constants';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { ModelInvocationNode } from '@agent/core/flows/ModelInvocationNode';
import type { ResponseCycleServices } from '@agent/core/flows/CycleServices';
import {
  type AgentFileLocation,
  MESSAGE_TYPES,
  OUTPUT_END_TAG,
  SCRATCHPAD_TAG,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { extractScratchpad } from '@utils/text/xmlExtraction';

// Reflection owns conversation limits and document completion, not the provider.
const CONTINUE_LIMIT = 10;
const INPUT_TOKEN_LIMIT = 1500000;
const OUTPUT_TOKEN_LIMIT_FACTOR = 2.5;
const END_TURN_REASONS: ProviderStopReason[] = [
  ANTHROPIC_STOP.END_TURN,
  ANTHROPIC_STOP.STOP_SEQUENCE,
  OPENAI_CHAT_FINISH.STOP,
  GOOGLE_FINISH.STOP,
];

// ============================================================================
// Cycle Fields
// ============================================================================

/** Shared state for one response cycle. */
export interface ResponseCycleShared extends BaseCycleFields {
  /** Whether output file exists */
  outputExists: boolean;
  /** Agent output location selected before this cycle starts. */
  outputLocation: AgentFileLocation;
  /** Processed response text */
  processedResponse?: string;
  /** System prompt for model (regenerated from agent prompt each cycle) */
  systemPrompt?: string;
  /** Raw response from model (type unknown, not serialized) */
  responseObject?: unknown;
  /** Whether this cycle already retried once with forced context compaction. */
  contextWindowRecoveryAttempted?: boolean;
  /** Ownership token for clearing this cycle's pending compaction request. */
  contextWindowRecoveryRequestId?: number;
}

/** Prep result for ResponsePrepNode - captures interruption status and initial state. */
interface ResponsePrepResult {
  interrupted: boolean;
  exists: boolean;
  systemPrompt?: string;
}

/**
 * Prepares a response cycle by hydrating prompts, checking interruptions, and
 * establishing debug metadata before invoking the model.
 */
class ResponsePrepNode extends BaseNode<
  ResponseCycleShared,
  ResponseCycleServices
> {
  override async prep(
    shared: ResponseCycleShared,
  ): Promise<ResponsePrepResult> {
    const { prompt, userVarChannels, runScope } = this.services;
    const interrupted = runScope.signal.aborted;
    const exists = await AbsoluteFS.exists(shared.outputLocation.absolutePath);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(prompt.systemPrompt, userVarChannels);

    return { interrupted, exists, systemPrompt };
  }

  override async post(
    shared: ResponseCycleShared,
    prepRes: ResponsePrepResult,
  ): Promise<string | undefined> {
    resetCycleState(shared, ['responseObject', 'processedResponse']);

    if (prepRes.interrupted) {
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { round } = this.services;
    shared.outputExists = prepRes.exists;
    shared.systemPrompt = prepRes.systemPrompt;

    // The request messages and the response are saved from different nodes;
    // each names its own file so neither round nor object kind collides.
    await saveCycleDebug(shared.messages, 'messages', this.services, {
      continuationCount: round.continuationCount,
      baseName: `r${round.roundIndex}_messages`,
    });

    return FlowTransition.DEFAULT;
  }
}

/**
 * Data extracted by prep() for response processing.
 * Note: outputLocation and outputExists are accessed directly from shared
 * in post() since they're only needed there.
 */
interface ProcessPrepResult {
  shouldStop: boolean;
  responseObject: unknown;
  responseTimeMs?: number;
  lastResponse: string;
  accumulatedOutput: string;
}

interface ProcessResultCommon {
  stopReason: ProviderStopReason;
  useStreaming: boolean;
  normalizedUsage?: NormalizedUsage;
}

/**
 * Discriminated on `hasResponse`: `processedResponse`/`bestConnector`/
 * `updatedAccumulatedOutput` are only ever set together, so modeling them as
 * one correlated variant instead of independently-optional fields removes the
 * need to re-derive that correlation with separate null checks in `post()`.
 */
type ProcessResult =
  | (ProcessResultCommon & { hasResponse: false })
  | (ProcessResultCommon & {
      hasResponse: true;
      processedResponse: string;
      bestConnector: string;
      updatedAccumulatedOutput: string;
    });

type ProcessNodeResult = SkippableNodeResult<ProcessResult>;

/**
 * Data extracted by prep() for continuation decision.
 */
interface ContinuationPrepData {
  interrupted: boolean;
  stopReason: ProviderStopReason;
  processedResponse: string;
}

type ContinuationPrepResult = SkippableNodeResult<ContinuationPrepData>;

type ContinuationNodeResult = SkippableNodeResult<{
  shouldEndTurn: boolean;
  shouldStop: boolean;
  shouldContinue: boolean;
  reachedTokenLimit: boolean;
  contextWindowExceeded: boolean;
}>;

/**
 * Transforms the raw model response into output-ready text, updates usage metrics,
 * and persists incremental tool-state derived from the result.
 */
class ResponseProcessNode extends BaseNode<
  ResponseCycleShared,
  ResponseCycleServices
> {
  override async prep(shared: ResponseCycleShared): Promise<ProcessPrepResult> {
    const { assembly } = this.services.workspace;
    return {
      shouldStop: shared.shouldStop,
      responseObject: shared.responseObject,
      responseTimeMs: shared.responseTimeMs,
      lastResponse: assembly.lastResponse,
      accumulatedOutput: assembly.accumulatedOutput,
    };
  }

  override async exec(prepRes: ProcessPrepResult): Promise<ProcessNodeResult> {
    const { logger } = this.services;

    if (prepRes.shouldStop || !prepRes.responseObject) {
      return { kind: 'skipped' };
    }

    const stage = logger.openStage('Process response', {
      skip: true,
    });

    return stage.run(async () => {
      // A host-supplied processor is applied once inside each handler's
      // extractResponse, so this text is already in its final form.
      // Re-applying would run non-idempotent custom replacements twice.
      const {
        text: processedResponse,
        usage: normalizedUsage,
        stopReason,
        thinking: thinkingContent,
        useStreaming,
      } = extractModelResponse(
        prepRes.responseObject,
        prepRes.responseTimeMs,
        OUTPUT_END_TAG,
        this.services,
        { normalizeNullUsage: true },
      );

      if (processedResponse) {
        logger.debug(`Model response: ${processedResponse.slice(0, 100)}`);
      }
      if (prepRes.responseTimeMs != null) {
        logger.debug(
          `Response time: ${(prepRes.responseTimeMs / 1000).toFixed(2)}s`,
        );
      }
      logger.debug(`Stop reason: ${stopReason}`);

      if (thinkingContent && !useStreaming) {
        logger.info(thinkingContent, {
          messageType: MESSAGE_TYPES.THINKING,
        });
      }

      const scratchpad = await extractScratchpad(
        processedResponse,
        SCRATCHPAD_TAG,
      );
      if (scratchpad) {
        logger.info(scratchpad, {
          messageType: MESSAGE_TYPES.SCRATCHPAD,
        });
      }

      if (!processedResponse) {
        return {
          kind: 'success',
          value: {
            hasResponse: false,
            stopReason,
            useStreaming,
            normalizedUsage,
          },
        };
      }

      const common = {
        stopReason,
        useStreaming,
        normalizedUsage,
      };

      const bestConnector =
        await this.services.runScope.session.responseTextProcessing.connectResponseText(
          prepRes.lastResponse.slice(-K_SLICE),
          processedResponse.slice(0, K_SLICE),
        );
      const updatedAccumulatedOutput =
        prepRes.accumulatedOutput + bestConnector + processedResponse;

      return {
        kind: 'success',
        value: {
          ...common,
          hasResponse: true,
          processedResponse,
          bestConnector,
          updatedAccumulatedOutput,
        },
      };
    });
  }

  override async post(
    shared: ResponseCycleShared,
    prepRes: ProcessPrepResult,
    execRes: ProcessNodeResult,
  ): Promise<string | undefined> {
    const { round, workspace, logger } = this.services;
    const modelHandler = this.services.modelCell.handler;

    if (execRes.kind === 'skipped') {
      shared.endTurn = false;
      return FlowTransition.COMPLETE;
    }

    const result = execRes.value;

    if (shared.responseTimeMs != null) {
      round.responseTimeMs += shared.responseTimeMs;
    }

    if (result.normalizedUsage) {
      round.normalizedUsage = result.normalizedUsage;
    }

    shared.stopReason = result.stopReason;

    if (!result.hasResponse) {
      shared.endTurn = false;
      if (isContextWindowExceededStopReason(result.stopReason)) {
        shared.processedResponse = '';
        return FlowTransition.DEFAULT;
      }

      shared.processedResponse = undefined;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    workspace.assembly.lastResponse = result.processedResponse;
    workspace.assembly.accumulatedOutput = result.updatedAccumulatedOutput;
    shared.processedResponse = result.processedResponse;

    const { outputLocation } = shared;
    const connector = result.bestConnector;

    await AbsoluteFS.ensureDir(path.dirname(outputLocation.absolutePath));
    if (!shared.outputExists) {
      logger.debug(`Creating new file: ${outputLocation.absolutePath}`);
      await AbsoluteFS.write(
        outputLocation.absolutePath,
        result.processedResponse,
      );
      shared.outputExists = true;
    } else {
      logger.debug(
        `Appending to existing file: ${outputLocation.absolutePath}`,
      );
      await AbsoluteFS.appendFile(
        outputLocation.absolutePath,
        connector + result.processedResponse,
      );
    }

    logger.debug(`Normalized usage: ${JSON.stringify(result.normalizedUsage)}`);

    logger.debug('Response preview:');
    logger.debug(
      `First ${K_SLICE} chars:\n${result.processedResponse.slice(0, K_SLICE)}`,
    );
    logger.debug(
      `Last ${K_SLICE} chars:\n${result.processedResponse.slice(-K_SLICE)}`,
    );

    modelHandler.updateMessageContent(
      shared.messages,
      connector,
      result.processedResponse,
      workspace,
      shared.responseObject,
    );

    if (result.useStreaming) {
      logger.debug(
        'Using streaming - deferring continuation decision to next stage',
      );
    }

    return FlowTransition.DEFAULT;
  }
}

/**
 * Finalizes the response cycle by recording round statistics. Every flow exit
 * path routes through this single finalization node, so no guard flag is
 * needed: the graph guarantees one execution.
 */
class ResponseCycleFinalizeNode extends BaseNode<
  ResponseCycleShared,
  ResponseCycleServices
> {
  /** Finalize the round by recording stats and invoking callback. */
  override async exec(): Promise<void> {
    const { round, run, onRoundFinalized, logger } = this.services;
    recordCycleMetrics(run, round.responseTimeMs, round.normalizedUsage);
    // Best-effort finalization callback. `ResponseCycleNode` (the reflection
    // wrapper) re-runs recordCycleMetrics + onRoundFinalized from its catch
    // block as a safety net for nodes that throw *before* reaching this single
    // finalization point. Guarding the callback here keeps this node from
    // throwing *after* the metrics have already mutated run state — otherwise
    // that catch would re-record the round and double-count usage/response time.
    try {
      await onRoundFinalized(run);
    } catch (error) {
      logger.warn(
        `Round finalization callback failed: ${toErrorMessage(error)}`,
      );
    }
  }
}

/**
 * Evaluates the processed response to decide whether the agent should end the turn,
 * stop entirely, or enqueue a continuation request.
 */
class ResponseContinuationNode extends BaseNode<
  ResponseCycleShared,
  ResponseCycleServices
> {
  override async prep(
    shared: ResponseCycleShared,
  ): Promise<ContinuationPrepResult> {
    if (
      shared.shouldStop ||
      !shared.stopReason ||
      shared.processedResponse === undefined
    ) {
      return { kind: 'skipped' };
    }

    return {
      kind: 'success',
      value: {
        interrupted: this.services.runScope.signal.aborted,
        stopReason: shared.stopReason,
        processedResponse: shared.processedResponse,
      },
    };
  }

  override async exec(
    prepRes: ContinuationPrepResult,
  ): Promise<ContinuationNodeResult> {
    const { round, run, setting, logger } = this.services;
    const modelHandler = this.services.modelCell.handler;

    if (prepRes.kind === 'skipped') {
      return { kind: 'skipped' };
    }

    const { interrupted, stopReason, processedResponse } = prepRes.value;
    if (interrupted) {
      return {
        kind: 'success',
        value: {
          shouldEndTurn: false,
          shouldStop: true,
          shouldContinue: false,
          reachedTokenLimit: false,
          contextWindowExceeded: false,
        },
      };
    }

    const totals = run.usageAccumulator.totals;
    const maxOutputTokens =
      totals.firstInputTokens > 0
        ? OUTPUT_TOKEN_LIMIT_FACTOR * totals.firstInputTokens
        : Number.POSITIVE_INFINITY;
    const continuationLimitExceeded = round.continuationCount > CONTINUE_LIMIT;
    const inputTokenLimitExceeded = totals.totalInputTokens > INPUT_TOKEN_LIMIT;
    const maxOutputTokensExceeded = totals.totalOutputTokens > maxOutputTokens;
    const shouldEndTurn = END_TURN_REASONS.includes(stopReason ?? '');
    const encounterDocumentTag = processedResponse.includes(OUTPUT_END_TAG);

    // Warn-only by design: this multiplier has never fed `shouldStop`, it just
    // flags a run whose output has run away relative to its first input.
    if (maxOutputTokensExceeded) {
      logger.warn('Output tokens exceed input token multiplier', {
        data: {
          maxOutputTokensFactor: OUTPUT_TOKEN_LIMIT_FACTOR,
          totalOutputTokens: totals.totalOutputTokens,
          firstInputTokens: totals.firstInputTokens,
        },
      });
    }

    const shouldStop =
      encounterDocumentTag ||
      continuationLimitExceeded ||
      inputTokenLimitExceeded;

    if (shouldStop) {
      logger.debug('StopFlags', {
        data: {
          endTurn: shouldEndTurn,
          encounterDocumentTag,
          continuationLimitExceeded,
          inputTokenLimitExceeded,
          maxOutputTokensExceeded,
        },
      });
    }

    const shouldContinue = modelHandler.shouldContinue(
      stopReason,
      processedResponse,
      setting,
    );
    const reachedTokenLimit = isTokenLimitStopReason(stopReason);
    const contextWindowExceeded = isContextWindowExceededStopReason(stopReason);

    return {
      kind: 'success',
      value: {
        shouldEndTurn,
        shouldStop,
        shouldContinue,
        reachedTokenLimit,
        contextWindowExceeded,
      },
    };
  }

  override async post(
    shared: ResponseCycleShared,
    _prepRes: ContinuationPrepResult,
    execRes: ContinuationNodeResult,
  ): Promise<string | undefined> {
    const { round, workspace, logger, setting, config } = this.services;
    const modelHandler = this.services.modelCell.handler;

    if (execRes.kind === 'skipped') {
      shared.endTurn = false;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const {
      shouldEndTurn,
      shouldStop,
      shouldContinue,
      reachedTokenLimit,
      contextWindowExceeded,
    } = execRes.value;
    shared.endTurn = shouldEndTurn;
    shared.shouldStop = shouldStop;

    if (shouldStop) {
      return FlowTransition.COMPLETE;
    }

    if (contextWindowExceeded) {
      if (shared.contextWindowRecoveryAttempted) {
        logger.warn(
          'Model context window still exceeded after forced compaction; stopping to avoid a futile retry.',
        );
        shared.shouldStop = true;
        return FlowTransition.COMPLETE;
      }
      if (!modelHandler.supportsManualCompaction) {
        logger.warn(
          'Model context window exceeded, but compaction is unavailable; stopping to avoid a futile retry.',
        );
        shared.shouldStop = true;
        return FlowTransition.COMPLETE;
      }

      shared.contextWindowRecoveryAttempted = true;
      shared.contextWindowRecoveryRequestId = modelHandler.requestCompaction();
    } else if (!(shouldContinue || reachedTokenLimit)) {
      return FlowTransition.COMPLETE;
    }

    round.continuationCount += 1;
    logger.info(`Starting continuation #${round.continuationCount}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    if (contextWindowExceeded) {
      logger.info('Retrying after forcing model context compaction', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
    } else if (reachedTokenLimit) {
      logger.info('Continuing after hitting the model token limit', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
    }

    modelHandler.addContinueMessage(shared.messages, workspace, setting);

    return FlowTransition.CONTINUE;
  }
}

/**
 * Creates a response cycle flow. The caller injects {@link ResponseCycleServices}
 * through `setServices()`; only mutable state travels in the shared context.
 */
export function createResponseCycleFlow(): Flow<
  ResponseCycleShared,
  ResponseCycleServices
> {
  const prepNode = new ResponsePrepNode();
  const invokeNode = new ModelInvocationNode<
    ResponseCycleShared,
    ResponseCycleServices
  >({
    operationName: 'Model invocation',
    streaming: false,
    backgroundModeAware: true,
    getSystemPrompt: (shared) => shared.systemPrompt,
    getEndTag: () => OUTPUT_END_TAG,
    storeResponse: (shared, response) => {
      shared.responseObject = response;
    },
    getPostCompactionContext: defaultPostCompactionContext,
    getDebugFileOptions: (_shared, services) => ({
      continuationCount: services.round.continuationCount,
      baseName: `r${services.round.roundIndex}_response`,
    }),
  });
  const processNode = new ResponseProcessNode();
  const continuationNode = new ResponseContinuationNode();
  const finalizeNode = new ResponseCycleFinalizeNode();

  prepNode.next(invokeNode);
  invokeNode.next(processNode);
  processNode.next(continuationNode);

  prepNode.on(FlowTransition.COMPLETE, finalizeNode);
  invokeNode.on(FlowTransition.COMPLETE, finalizeNode);
  processNode.on(FlowTransition.COMPLETE, finalizeNode);
  continuationNode.on(FlowTransition.COMPLETE, finalizeNode);

  continuationNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow(prepNode);
}
