/**
 * ResponseCycleCompositionNode - Runs a response cycle as a sub-flow.
 *
 * This node composes ResponseCycleFlow (pure flow pattern) rather than
 * calling runResponseCycle() function (hybrid pattern).
 *
 * Responsibilities:
 * - Reconstruct state slices from snapshots
 * - Build ResponseCycleOptions from services
 * - Run ResponseCycleFlow as a sub-flow
 * - Extract results back to ReflectionFlowShared
 *
 * PocketFlow pattern:
 * - prep(): Reconstruct state slices and output location
 * - exec(): Run the composed sub-flow with slices
 * - post(): Update shared state snapshots with results
 *
 * Services accessed via native `this.services`:
 * - modelHandler, logger, setting, prompt, config, context, etc.
 */

import { Node, Flow } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
  buildBaseCycleOptions,
} from '@agent/implementations/flows/common';
import { ConversationRoundState, AgentRunState } from '@agent/core/AgentState';
import type { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
  type ResponseCycleState,
} from '@agent/core/flows/ResponseCycleFlow';
import { createRetryState } from '@agent/core/flows/RetryState';
import { interpretCycleCompletion } from '@agent/core/flows/CommonCycleTypes';
import {
  finalizeRound,
  type ResponseCycleOptions,
  type ResponseCycleParams,
} from '@agent/core/flows/CycleServices';
import type { AgentFileLocation } from '@utils/files';

import {
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
 * State slices for cycle execution.
 * Using slices directly instead of AgentSharedStore wrapper.
 */
interface CycleStateSlices {
  round: ConversationRoundState;
  run: AgentRunState;
  workspace: AgentWorkspaceState;
}

interface CyclePrepInput extends CycleStateSlices {
  context: RoundContext;
  currentRound: number;
  outputLocation: AgentFileLocation;
}

type CycleExecResult =
  | ({
      kind: 'success';
      endTurn: boolean;
      failedWithError: boolean;
      errorMessage?: string;
      userCancelled: boolean;
    } & CycleStateSlices)
  | { kind: 'error'; error: Error };

// ============================================================================
// Node Implementation
// ============================================================================

export class ResponseCycleCompositionNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  private cycleFlow: Flow<ResponseCycleShared, ResponseCycleParams<C>>;

  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
    this.cycleFlow = createResponseCycleFlow<C>();
  }

  /**
   * Build shared store and determine output location.
   */
  async prep(shared: ReflectionFlowShared): Promise<CyclePrepInput> {
    const {
      fileService,
      config,
      setting,
      userVarChannels,
      getOutputFileLocation,
    } = this.services;
    const { currentRound, context, workspace, runState } = shared;

    if (!context) {
      throw new Error(
        'Context not prepared - PrepareContextNode must run first',
      );
    }

    // Access state directly (class instances in shared state)
    // Use slices directly - no wrapper needed
    const run = runState;
    const round = ConversationRoundState.fromSnapshot(
      context.stateRoundSnapshot,
    );

    // Determine output location for this round (delegates to agent for polymorphism)
    const outputLocation = getOutputFileLocation(currentRound);

    return {
      context,
      currentRound,
      outputLocation,
      round,
      run,
      workspace,
    };
  }

  /**
   * Run ResponseCycleFlow as a sub-flow.
   */
  async exec(prepRes: CyclePrepInput): Promise<CycleExecResult> {
    const services = this.services;

    // Initialize output file and prefill before starting cycle
    // This handles: writing prefill to file, updating messages with assistant prefill,
    // and detecting if existing output completes the response (endTurn=true)
    const [prefillEndsTurn, initializedMessages] =
      await services.modelHandler.initializeOutputAndPrefill(
        services.config,
        services.setting,
        prepRes.context.messages,
        prepRes.workspace,
        prepRes.outputLocation,
        prepRes.context.prefill,
      );

    // If prefill already completes the response, return success with endTurn=true
    // This happens on resume when replaying completed rounds - the output file
    // already contains the full response, so we skip the model call.
    // Note: initializeOutputAndPrefill() modifies prepRes.context.messages in-place
    // (adding the assistant response), so post() will sync this to shared.conversation.
    if (prefillEndsTurn) {
      return {
        kind: 'success',
        endTurn: true,
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        failedWithError: false,
        userCancelled: false,
      };
    }

    // Build ResponseCycleOptions from services using helper (eliminates manual field copying)
    // buildBaseCycleOptions handles all AgentCycleBaseOptions fields
    const cycleOptions: ResponseCycleOptions<C> = {
      ...buildBaseCycleOptions(services),
      // Override userVars with merged input + transient
      userVars: this.getUserVars(),
      // ResponseCycleOptions specific fields
      agentConfig: services.config,
      fileService: services.fileService,
    };

    // Create cycle shared state with initialized messages
    const cycleShared: ResponseCycleShared = {
      state: {
        messages: initializedMessages,
        outputLocation: prepRes.outputLocation,
        endTurn: false,
        shouldStop: false,
        outputExists: false,
        systemPrompt: undefined,
        debug: undefined,
        responseObject: undefined,
        responseTimeMs: undefined,
        stopReason: undefined,
        processedResponse: undefined,
      } satisfies ResponseCycleState,
      retryState: createRetryState(),
    };

    // Get the finalization callback for this round
    const onRoundFinalized = this.services.getUsageRecorder();

    try {
      // Inject services directly and run sub-flow
      // Use slices directly - no AgentSharedStore wrapper
      this.cycleFlow.setServices({
        ...cycleOptions,
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        onRoundFinalized, // Pass callback so FinalizeNode can invoke it
      });
      await this.cycleFlow.run(cycleShared);

      // Success: FinalizeNode has already called finalizeRound()
      // Use shared interpretation logic (single source of truth)
      const completion = interpretCycleCompletion(
        cycleShared.state,
        cycleShared.retryState,
      );

      return {
        kind: 'success',
        endTurn: cycleShared.state.endTurn,
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        ...completion,
      };
    } catch (error) {
      // Error path: FinalizeNode may not have run, so finalize here
      // Use helper function directly (single source of truth for finalization logic)
      await finalizeRound({
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        onRoundFinalized,
      });
      return {
        kind: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Handle cycle failure.
   */
  async execFallback(
    _prepRes: CyclePrepInput,
    error: Error,
  ): Promise<CycleExecResult> {
    return { kind: 'error', error };
  }

  /**
   * Update shared state with cycle results.
   *
   * Errors are thrown directly - agent.run() catches and handles cleanup.
   */
  async post(
    shared: ReflectionFlowShared,
    prepRes: CyclePrepInput,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    if (execRes.kind === 'error') {
      logger.error(`Response cycle failed: ${execRes.error.message}`);
      // Store error in shared state for persistence (enables proper resume behavior)
      shared.lastRetryError = {
        message: execRes.error.message,
        retryable: false,
      };
      throw execRes.error;
    }

    if (execRes.userCancelled) {
      logger.debug('Response cycle cancelled by user');
      shared.continueRounds = false;
      // Clear stale state to prevent OutputNode from processing previous round's data
      shared.endTurn = false;
      shared.outputLocation = prepRes.outputLocation;
      // Clear any previous error - user cancellation is not an error
      shared.lastRetryError = undefined;
      // User cancellation is not an error - just stop gracefully
      return FlowTransition.DEFAULT;
    }

    if (execRes.failedWithError) {
      logger.error(`Response cycle failed: ${execRes.errorMessage}`);
      // Store error in shared state for persistence
      shared.lastRetryError = {
        message: execRes.errorMessage ?? 'Unknown error',
        retryable: false,
      };
      throw new Error(execRes.errorMessage ?? 'Unknown error');
    }

    // Success - clear any previous error
    shared.lastRetryError = undefined;

    // State was mutated in-place during cycle execution.
    // With lazy persistence, changes persist automatically at round boundaries.
    // Note: execRes contains the same references as shared.workspace/runState
    shared.endTurn = execRes.endTurn;
    shared.outputLocation = prepRes.outputLocation;

    // Sync conversation state - messages are modified in-place during cycle
    // (via updateMessageContentWithPrefill) and must be propagated for multi-round flows
    shared.conversation = prepRes.context.messages;

    // Store round state snapshot for later (already a snapshot, just push directly)
    shared.roundStateSnapshots.push(prepRes.context.stateRoundSnapshot);

    // Continue to OutputNode
    return FlowTransition.DEFAULT;
  }

  /**
   * Get user variables for prompt rendering.
   * Merges input (frozen base) with transient (runtime modifications).
   */
  private getUserVars(): Record<string, any> {
    const channels = this.services.userVarChannels;
    return {
      ...channels.input,
      ...channels.transient,
    };
  }
}
