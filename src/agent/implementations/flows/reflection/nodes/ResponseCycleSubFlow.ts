/**
 * ResponseCycleSubFlow - Native flow nesting for response cycles.
 *
 * This replaces ResponseCycleNode by using the TranslatingFlow pattern.
 * Instead of a wrapper node that creates and runs a flow, this IS a flow
 * that can be wired directly into ReflectionFlow's graph.
 *
 * ## Architecture
 *
 * - Extends TranslatingFlow for type translation between outer/inner shared
 * - Can be used as a node in ReflectionFlow (Flow extends BaseNode)
 * - Handles all translation in prepContext()/applyResults()
 *
 * ## Comparison to ResponseCycleNode
 *
 * Before (wrapper node pattern):
 *   ReflectionFlow → ResponseCycleNode.exec() → creates ResponseCycleFlow → runs it
 *
 * After (native nesting pattern):
 *   ReflectionFlow → ResponseCycleSubFlow._run() → runs internal nodes directly
 */

import {
  TranslatingFlow,
  type InnerFlowContext,
} from '@agent/core/flows/TranslatingFlow';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { buildBaseCycleOptions } from '@agent/implementations/flows/common';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from '@agent/core/flows/ResponseCycleFlow';
import { createRetryState } from '@agent/core/flows/RetryState';
import { interpretCycleCompletion } from '@agent/core/flows/CommonCycleTypes';
import { finalizeRound } from '@agent/core/flows/CycleServices';
import type { AgentFileLocation } from '@utils/files';

import {
  getWorkspaceState,
  updateWorkspaceSnapshot,
  type ReflectionFlowShared,
  type RoundContext,
} from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Translation context extracted from outer shared.
 * Contains everything needed to create and run the inner flow.
 */
interface CycleContext {
  context: RoundContext;
  currentRound: number;
  outputLocation: AgentFileLocation;
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
  /** True if prefill already completed the response (skip model call) */
  prefillEndsTurn: boolean;
  /** Messages after prefill initialization */
  initializedMessages: any[];
}

// ============================================================================
// SubFlow Implementation
// ============================================================================

/**
 * ResponseCycleSubFlow - A flow that can be used as a node in ReflectionFlow.
 *
 * This IS a Flow (extends TranslatingFlow which extends Flow).
 * When wired into ReflectionFlow's graph, _run() handles type translation.
 */
export class ResponseCycleSubFlow<C = unknown> extends TranslatingFlow<
  ReflectionFlowShared,
  ResponseCycleShared,
  CycleContext,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  /**
   * Prepare translation context from outer shared.
   *
   * Extracts what's needed from ReflectionFlowShared to create
   * ResponseCycleShared and run the inner flow.
   */
  async prepContext(shared: ReflectionFlowShared): Promise<CycleContext | null> {
    const {
      fileService,
      config,
      setting,
      userVarChannels,
      getOutputFileLocation,
      modelHandler,
    } = this.services;
    const { currentRound, context } = shared;

    if (!context) {
      throw new Error(
        'Context not prepared - PrepareContextNode must run first',
      );
    }

    // Reconstruct state instances from snapshots
    const workspace = getWorkspaceState(shared);
    const run = AgentRunState.fromSnapshot(shared.runStateSnapshot);
    const round = ConversationRoundState.fromSnapshot(
      context.stateRoundSnapshot,
    );

    // Determine output location for this round
    const outputLocation = getOutputFileLocation(currentRound);

    // Initialize output file and prefill before starting cycle
    const [prefillEndsTurn, initializedMessages] =
      await modelHandler.initializeOutputAndPrefill(
        config,
        setting,
        context.messages,
        workspace,
        outputLocation,
        context.prefill,
      );

    return {
      context,
      currentRound,
      outputLocation,
      round,
      run,
      workspace,
      prefillEndsTurn,
      initializedMessages,
    };
  }

  /**
   * Create inner flow and shared state.
   *
   * Builds ResponseCycleShared from the translation context
   * and creates a configured ResponseCycleFlow.
   */
  createInnerFlow(context: CycleContext): InnerFlowContext<ResponseCycleShared> {
    const services = this.services;
    const { userVarChannels } = services;

    // If prefill ends turn, we'll handle it in applyResults
    // Create a minimal shared state for the skip case
    if (context.prefillEndsTurn) {
      return {
        flow: createResponseCycleFlow<C>(),
        shared: {
          state: {
            messages: context.initializedMessages,
            outputLocation: context.outputLocation,
            endTurn: true,
            shouldStop: true,
            outputExists: false,
          } as ResponseCycleState,
          retryState: createRetryState(),
        },
      };
    }

    // Build ResponseCycleOptions
    const cycleOptions = {
      ...buildBaseCycleOptionsSync(services),
      userVars: { ...userVarChannels.input, ...userVarChannels.transient },
      agentConfig: services.config,
      fileService: services.fileService,
    };

    const onRoundFinalized = services.getUsageRecorder();

    // Create inner shared state
    const innerShared: ResponseCycleShared = {
      state: {
        messages: context.initializedMessages,
        outputLocation: context.outputLocation,
        endTurn: false,
        shouldStop: false,
        outputExists: false,
        systemPrompt: undefined,
        debug: undefined,
        responseObject: undefined,
        responseTimeMs: undefined,
        stopReason: undefined,
        processedResponse: undefined,
      } as ResponseCycleState,
      retryState: createRetryState(),
    };

    // Create and configure inner flow
    const flow = createResponseCycleFlow<C>();
    flow.setServices({
      ...cycleOptions,
      round: context.round,
      run: context.run,
      workspace: context.workspace,
      onRoundFinalized,
    });

    return { flow, shared: innerShared };
  }

  /**
   * Apply inner flow results back to outer shared.
   *
   * Translates ResponseCycleShared results into ReflectionFlowShared updates.
   */
  async applyResults(
    shared: ReflectionFlowShared,
    inner: ResponseCycleShared | null,
    context: CycleContext | null,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    // Handle skip case (context is null)
    if (!context) {
      // This shouldn't happen in normal operation
      logger.error('ResponseCycleSubFlow: No context in applyResults');
      throw new Error('ResponseCycleSubFlow: prepContext returned null unexpectedly');
    }

    // Handle prefill ends turn case
    if (context.prefillEndsTurn) {
      shared.runStateSnapshot = context.run.toSnapshot();
      updateWorkspaceSnapshot(shared, context.workspace);
      shared.endTurn = true;
      shared.outputLocation = context.outputLocation;
      shared.conversation = context.context.messages;
      shared.roundStateSnapshots.push(context.context.stateRoundSnapshot);
      shared.lastRetryError = undefined;
      return FlowTransition.DEFAULT;
    }

    // Handle error from inner flow (shouldn't happen with current flow design)
    if (!inner) {
      logger.error('ResponseCycleSubFlow: No inner shared after flow execution');
      throw new Error('Inner flow did not produce results');
    }

    // Interpret completion from inner flow state
    const completion = interpretCycleCompletion(inner.state, inner.retryState);

    if (completion.userCancelled) {
      logger.debug('Response cycle cancelled by user');
      shared.continueRounds = false;
      shared.endTurn = false;
      shared.outputLocation = context.outputLocation;
      shared.lastRetryError = undefined;
      return FlowTransition.DEFAULT;
    }

    if (completion.failedWithError) {
      logger.error(`Response cycle failed: ${completion.errorMessage}`);
      shared.lastRetryError = {
        message: completion.errorMessage ?? 'Unknown error',
        retryable: false,
      };
      throw new Error(completion.errorMessage ?? 'Unknown error');
    }

    // Success - update shared state
    shared.lastRetryError = undefined;
    shared.runStateSnapshot = context.run.toSnapshot();
    updateWorkspaceSnapshot(shared, context.workspace);
    shared.endTurn = inner.state.endTurn;
    shared.outputLocation = context.outputLocation;
    shared.conversation = context.context.messages;
    shared.roundStateSnapshots.push(context.context.stateRoundSnapshot);

    return FlowTransition.DEFAULT;
  }
}

/**
 * Synchronous version of buildBaseCycleOptions for use in createInnerFlow.
 * The async version is needed because client creation may be async,
 * but for the SubFlow pattern we need to build options synchronously.
 *
 * TODO: Consider making client creation lazy or caching it.
 */
function buildBaseCycleOptionsSync<C>(services: ReflectionServices<C>) {
  return {
    logger: services.logger,
    modelHandler: services.modelHandler,
    client: services.client,
    agentSetting: services.setting,
    agentPrompt: services.prompt,
    context: services.context,
    checkInterruption: services.checkInterruption,
  };
}
