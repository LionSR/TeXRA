/**
 * ResponseCycleNode - Runs a response cycle flow.
 *
 * Responsibilities:
 * - Reconstruct state slices from snapshots
 * - Build cycle options from services
 * - Create and run ResponseCycleFlow
 * - Extract results back to ReflectionFlowShared
 *
 * PocketFlow pattern:
 * - prep(): Reconstruct state slices and output location
 * - exec(): Create and run ResponseCycleFlow directly
 * - post(): Update shared state snapshots with results
 *
 * Services accessed via native `this.services`:
 * - modelHandler, logger, setting, prompt, config, context, etc.
 */

import { Node } from '@agent/node';
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

export class ResponseCycleNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(NODE_NO_RETRY, NODE_NO_WAIT);
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
    const { currentRound, context } = shared;

    if (!context) {
      throw new Error(
        'Context not prepared - PrepareContextNode must run first',
      );
    }

    // Reconstruct state instances from snapshots
    // Use slices directly - no wrapper needed
    const workspace = getWorkspaceState(shared);
    const run = AgentRunState.fromSnapshot(shared.runStateSnapshot);
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
   * Execute response cycle directly (no wrapper function).
   *
   * Creates and runs ResponseCycleFlow inline, eliminating the
   * executeResponseCycleCore() wrapper layer.
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

    // Build ResponseCycleOptions from services using helper
    // Await to get fresh client with refreshed auth tokens for each response round
    const { userVarChannels } = services;
    const cycleOptions = {
      ...(await buildBaseCycleOptions(services)),
      userVars: { ...userVarChannels.input, ...userVarChannels.transient },
      agentConfig: services.config,
      fileService: services.fileService,
    };

    const onRoundFinalized = this.services.getUsageRecorder();

    try {
      // Create shared state for the cycle flow
      const shared: ResponseCycleShared = {
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

      // Create and run the flow directly
      const flow = createResponseCycleFlow<C>();
      flow.setServices({
        ...cycleOptions,
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        onRoundFinalized,
      });
      await flow.run(shared);

      // Interpret completion from flow state
      const completion = interpretCycleCompletion(
        shared.state,
        shared.retryState,
      );

      return {
        kind: 'success',
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        endTurn: shared.state.endTurn,
        ...completion,
      };
    } catch (error) {
      // Error path: finalize round on unexpected errors
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

    // Update state from slices - convert to snapshot
    shared.runStateSnapshot = execRes.run.toSnapshot();
    updateWorkspaceSnapshot(shared, execRes.workspace);
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
}
