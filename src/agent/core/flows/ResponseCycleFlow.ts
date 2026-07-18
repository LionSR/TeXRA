import { dirname } from 'node:path';

import { z } from 'zod';

import { BaseNode, Flow } from '@agent/node';
import { getSystemPromptWithRules } from '@agent/prompt';
import { recordRound } from '@agent/core/state/AgentState';
import type { NormalizedUsage } from '@agent/types/NormalizedUsage';
import {
  BaseCycleFieldsSchema,
  defaultPostCompactionContext,
  extractModelResponse,
  resetCycleState,
  saveCycleDebug,
  SkippableNodeResult,
} from '@agent/core/flows/CommonCycleTypes';
import {
  isTokenLimitStopReason,
  type ProviderStopReason,
} from '@agent/types/StopReasonTypes';
import type { ProviderUsage } from '@agent/core/usage/ResponseUsage';
import { K_SLICE } from '@agent/core/constants';
import { useLaunchRunContext } from '@agent/runtime/RunContext';
import { bestConnectionMethod } from '@agent/runtime/textConnection';
import type { ToolDefinition } from '@model';
import { MESSAGE_TYPES, AgentFileLocationSchema } from '@shared/schemas';
import { OUTPUT_END_TAG } from '@shared/constants/outputProtocol';
import { AbsoluteFS, FlexibleFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { extractScratchpad } from '@utils/text/xmlUtils';

import { FlowTransition } from './FlowTransitions';
import { ModelInvocationNode } from './ModelInvocationNode';
import type { ResponseCycleServices } from './CycleServices';

// ============================================================================
// Cycle Fields Schema (Extends Base)
// ============================================================================

/**
 * Schema for serializable response cycle fields.
 *
 * Extends BaseCycleFieldsSchema with response-specific fields for output tracking.
 *
 * ## Field Categories
 *
 * From BaseCycleFieldsSchema (shared with ToolUseRoundFlow):
 * - messages, shouldStop, endTurn, responseTimeMs, stopReason, lastError
 *
 * Response-specific fields:
 * - outputExists, outputLocation, processedResponse
 *
 * ## Serialization
 *
 * All fields here are natively serializable (structuredClone compatible).
 * Non-serializable fields (debug, responseObject) are in CycleTransientFields.
 */
const CycleFieldsSchema = BaseCycleFieldsSchema.extend({
  /** Whether output file exists */
  outputExists: z.boolean(),
  /** Agent output location selected before this cycle starts. */
  outputLocation: AgentFileLocationSchema,
  /** Processed response text */
  processedResponse: z.string().optional(),
});

/** Serializable cycle fields derived from schema */
type CycleFields = z.infer<typeof CycleFieldsSchema>;

/**
 * Transient cycle fields that are NOT serialized.
 *
 * These contain non-serializable data (unknown response objects)
 * and are regenerated each cycle execution.
 *
 * NOTE: All debug options (context and file options) are derived from
 * services/shared at each `maybeSaveDebugObject` call site. Nothing is
 * stored in shared state.
 */
interface CycleTransientFields {
  /** System prompt for model (regenerated from agent prompt each cycle) */
  systemPrompt?: string;
  /** Raw response from model (type unknown, not serialized) */
  responseObject?: unknown;
}

/**
 * Full cycle shared type combining serializable and transient fields.
 *
 * This is what cycle nodes operate on. ResponseCycleNode creates a
 * dedicated instance for each cycle, keeping cycle fields off the
 * outer ReflectionFlowShared.
 */
export type ResponseCycleShared = CycleFields & CycleTransientFields;

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
class ResponsePrepNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ResponsePrepResult> {
    const { prompt, userVarChannels, checkInterruption } = this.services;
    const interrupted = checkInterruption();
    const exists = await FlexibleFS.exists(shared.outputLocation);
    const systemPrompt = interrupted
      ? undefined
      : await getSystemPromptWithRules(prompt.systemPrompt, {
          ...userVarChannels.input,
          ...userVarChannels.transient,
        });

    return { interrupted, exists, systemPrompt };
  }

  async post(
    shared: ResponseCycleShared,
    prepRes: ResponsePrepResult,
  ): Promise<string | undefined> {
    if (prepRes.interrupted) {
      resetCycleState(shared, ['responseObject', 'processedResponse']);
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { round } = this.services;
    shared.outputExists = prepRes.exists;
    shared.systemPrompt = prepRes.systemPrompt;
    resetCycleState(shared, ['responseObject', 'processedResponse']);

    await saveCycleDebug(shared.messages, 'messages', this.services, {
      continuationCount: round.continuationCount,
      baseName: 'response',
      outputFile: shared.outputLocation.relativePath,
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
  responseUsage: ProviderUsage;
  normalizedUsage?: NormalizedUsage;
}

/**
 * Discriminated on `hasResponse`: `newResponse`/`processedResponse`/
 * `bestConnector`/`updatedLastResponse`/`updatedAccumulatedOutput` are only
 * ever set together (see the `if (newResponse)` block below), so modeling
 * them as one correlated variant instead of five independently-optional
 * fields removes the need to re-derive that correlation with separate null
 * checks in `post()`.
 */
type ProcessResult =
  | (ProcessResultCommon & { hasResponse: false })
  | (ProcessResultCommon & {
      hasResponse: true;
      newResponse: string;
      processedResponse: string;
      bestConnector: string;
      updatedLastResponse: string;
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
}>;

export function responseCycleToolsForModel<C>(
  services: Pick<
    ResponseCycleServices<C>,
    'modelHandler' | 'setting' | 'toolRegistry'
  >,
): ToolDefinition[] | undefined {
  if (!services.modelHandler.capabilities.supportsFunctionCalling) {
    return undefined;
  }
  const runContext = useLaunchRunContext();
  const runtimeUnavailable = new Set(runContext.runtimeUnavailableTools ?? []);
  return services.setting.tools.filter(
    (tool) =>
      !runtimeUnavailable.has(tool.name) &&
      (runContext.approvalPromptsUnavailable !== true ||
        services.toolRegistry.get(tool.name)?.requiresApproval !== true),
  );
}

/**
 * Transforms the raw model response into output-ready text, updates usage metrics,
 * and persists incremental tool-state derived from the result.
 *
 * PocketFlow compliance:
 * - prep() extracts only the data needed by exec()
 * - exec() performs pure computation, no side effects
 * - post() applies all side effects (store updates)
 */
class ResponseProcessNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ProcessPrepResult> {
    const { assembly } = this.services.workspace;
    return {
      shouldStop: shared.shouldStop,
      responseObject: shared.responseObject,
      responseTimeMs: shared.responseTimeMs,
      lastResponse: assembly.lastResponse,
      accumulatedOutput: assembly.accumulatedOutput,
    };
  }

  async exec(prepRes: ProcessPrepResult): Promise<ProcessNodeResult> {
    const { logger } = this.services;

    if (prepRes.shouldStop || !prepRes.responseObject) {
      return { kind: 'skipped' };
    }

    const stage = logger.openStage('Process response', {
      skip: true,
    });

    return stage.run(async () => {
      const {
        text: newResponse,
        usage: responseUsage,
        stopReason,
        thinking: thinkingContent,
        useStreaming,
        normalizedUsage,
      } = extractModelResponse(
        prepRes.responseObject,
        prepRes.responseTimeMs,
        OUTPUT_END_TAG,
        this.services,
        { normalizeNullUsage: true },
      );

      if (newResponse) {
        logger.debug(`Model response: ${newResponse.slice(0, 100)}`);
      }
      if (prepRes.responseTimeMs != null) {
        logger.debug(
          `Response time: ${(prepRes.responseTimeMs / 1000).toFixed(2)}s`,
        );
      }
      logger.debug(`Stop reason: ${stopReason}`);
      logger.debug(`Token usage: ${JSON.stringify(responseUsage)}`);

      if (thinkingContent && !useStreaming) {
        logger.info(thinkingContent, {
          messageType: MESSAGE_TYPES.THINKING,
        });
      }

      const scratchpad = await extractScratchpad(newResponse, 'scratchpad');
      if (scratchpad) {
        logger.info(scratchpad, {
          messageType: MESSAGE_TYPES.SCRATCHPAD,
        });
      }

      const common = {
        stopReason,
        useStreaming,
        responseUsage,
        normalizedUsage,
      };

      if (!newResponse) {
        return { kind: 'success', value: { ...common, hasResponse: false } };
      }

      // Text cleanup (replacementEngine.applyAll) is applied once inside each
      // handler's extractResponse, so newResponse is already cleaned here.
      // Re-applying would run non-idempotent custom replacements twice.
      const processedResponse = newResponse;

      const connector = await bestConnectionMethod(
        prepRes.lastResponse.slice(-K_SLICE),
        processedResponse.slice(0, K_SLICE),
      );
      const bestConnector = connector.connector;
      const updatedAccumulatedOutput =
        prepRes.accumulatedOutput + bestConnector + processedResponse;

      return {
        kind: 'success',
        value: {
          ...common,
          hasResponse: true,
          newResponse,
          processedResponse,
          bestConnector,
          updatedLastResponse: processedResponse,
          updatedAccumulatedOutput,
        },
      };
    });
  }

  async post(
    shared: ResponseCycleShared,
    prepRes: ProcessPrepResult,
    execRes: ProcessNodeResult,
  ): Promise<string | undefined> {
    const { round, workspace, logger, modelHandler } = this.services;

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
      shared.processedResponse = undefined;
      shared.endTurn = false;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    workspace.assembly.lastResponse = result.updatedLastResponse;
    workspace.assembly.accumulatedOutput = result.updatedAccumulatedOutput;
    shared.processedResponse = result.processedResponse;

    const { outputLocation } = shared;
    const connector = result.bestConnector;

    await AbsoluteFS.ensureDir(dirname(outputLocation.absolutePath));

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
      await FlexibleFS.appendFile(
        outputLocation,
        connector + result.processedResponse,
      );
    }

    const responseUsage = result.responseUsage ?? {};
    const usageSummary = Object.entries(responseUsage)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    logger.debug(`Usage summary: ${usageSummary}`);

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
 * Finalizes the response cycle by recording round statistics.
 * All flow exit paths route through this node to ensure proper cleanup.
 *
 * PocketFlow pattern: Single finalization point in the flow graph.
 * No guard flags needed (graph ensures single execution).
 */
class ResponseCycleFinalizeNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleServices<C>
> {
  /** Finalize the round by recording stats and invoking callback. */
  async exec(): Promise<void> {
    const { round, run, onRoundFinalized, logger } = this.services;
    recordRound(run, round);
    // Best-effort finalization callback. `ResponseCycleNode` (the reflection
    // wrapper) re-runs recordRound + onRoundFinalized from its catch block as a
    // safety net for nodes that throw *before* reaching this single
    // finalization point. Guarding the callback here keeps this node from
    // throwing *after* recordRound has already mutated run state — otherwise
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
 *
 * PocketFlow compliance:
 * - prep() extracts only the data needed by exec()
 * - exec() performs pure computation using prepRes
 * - post() applies all side effects
 */
class ResponseContinuationNode<C> extends BaseNode<
  ResponseCycleShared,
  ResponseCycleServices<C>
> {
  async prep(shared: ResponseCycleShared): Promise<ContinuationPrepResult> {
    if (shared.shouldStop || !shared.stopReason || !shared.processedResponse) {
      return { kind: 'skipped' };
    }

    return {
      kind: 'success',
      value: {
        interrupted: this.services.checkInterruption(),
        stopReason: shared.stopReason,
        processedResponse: shared.processedResponse,
      },
    };
  }

  async exec(prepRes: ContinuationPrepResult): Promise<ContinuationNodeResult> {
    const { round, run, modelHandler, setting } = this.services;

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
        },
      };
    }

    const { endTurn: shouldEndTurn, shouldStop } =
      modelHandler.checkStopConditions(
        stopReason,
        processedResponse,
        round,
        run,
        setting,
      );

    const shouldContinue = modelHandler.shouldContinue(
      stopReason,
      processedResponse,
      setting,
    );
    const reachedTokenLimit = isTokenLimitStopReason(stopReason);

    return {
      kind: 'success',
      value: {
        shouldEndTurn,
        shouldStop,
        shouldContinue,
        reachedTokenLimit,
      },
    };
  }

  async post(
    shared: ResponseCycleShared,
    _prepRes: ContinuationPrepResult,
    execRes: ContinuationNodeResult,
  ): Promise<string | undefined> {
    const { round, workspace, logger, modelHandler, setting, config } =
      this.services;

    if (execRes.kind === 'skipped') {
      shared.endTurn = false;
      shared.shouldStop = true;
      return FlowTransition.COMPLETE;
    }

    const { shouldEndTurn, shouldStop, shouldContinue, reachedTokenLimit } =
      execRes.value;
    shared.endTurn = shouldEndTurn;
    shared.shouldStop = shouldStop;

    if (shouldStop || !(shouldContinue || reachedTokenLimit)) {
      return FlowTransition.COMPLETE;
    }

    round.continuationCount += 1;
    logger.info(`Starting continuation #${round.continuationCount}`, {
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });

    if (reachedTokenLimit) {
      logger.info('Continuing after hitting the model token limit', {
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
    }

    modelHandler.addContinueMessage(shared.messages, workspace, setting);

    return FlowTransition.CONTINUE;
  }
}

/**
 * Creates a response cycle flow with services injected directly.
 *
 * The returned flow uses the services pattern:
 * - Services are passed via `setServices()` (options flattened)
 * - Only mutable state flows through the shared context
 *
 * @example
 * ```typescript
 * const flow = createResponseCycleFlow<MyContext>();
 * flow.setServices({ ...options, store });
 * await flow.run(sharedState);
 * ```
 */
export function createResponseCycleFlow<C>(): Flow<
  ResponseCycleShared,
  ResponseCycleServices<C>
> {
  const prepNode = new ResponsePrepNode<C>();
  const invokeNode = new ModelInvocationNode<
    ResponseCycleShared,
    ResponseCycleServices<C>
  >({
    operationName: 'Model invocation',
    streaming: false,
    backgroundModeAware: true,
    getSystemPrompt: (shared) => shared.systemPrompt,
    getEndTag: () => OUTPUT_END_TAG,
    getTools: responseCycleToolsForModel,
    storeResponse: (shared, response) => {
      shared.responseObject = response;
    },
    getPostCompactionContext: defaultPostCompactionContext,
    getDebugFileOptions: (shared, services) => ({
      continuationCount: services.round.continuationCount,
      baseName: 'response',
      outputFile: shared.outputLocation.relativePath,
    }),
  });
  const processNode = new ResponseProcessNode<C>();
  const continuationNode = new ResponseContinuationNode<C>();
  const finalizeNode = new ResponseCycleFinalizeNode<C>();

  prepNode.next(invokeNode);
  invokeNode.next(processNode);
  processNode.next(continuationNode);

  prepNode.on(FlowTransition.COMPLETE, finalizeNode);
  invokeNode.on(FlowTransition.COMPLETE, finalizeNode);
  processNode.on(FlowTransition.COMPLETE, finalizeNode);
  continuationNode.on(FlowTransition.COMPLETE, finalizeNode);

  continuationNode.on(FlowTransition.CONTINUE, prepNode);

  return new Flow<ResponseCycleShared, ResponseCycleServices<C>>(prepNode);
}
