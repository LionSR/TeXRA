/**
 * ResponseCycleCompositionNode - Runs a response cycle as a sub-flow.
 *
 * This node composes ResponseCycleFlow (pure flow pattern) rather than
 * calling runResponseCycle() function (hybrid pattern).
 *
 * Responsibilities:
 * - Pass live state instances to cycle flow
 * - Build ResponseCycleOptions from services
 * - Run ResponseCycleFlow as a sub-flow
 * - Extract results back to ReflectionFlowShared
 *
 * PocketFlow pattern:
 * - prep(): Get live state instances and output location
 * - exec(): Run the composed sub-flow with instances
 * - post(): Update control flags in shared state
 *
 * Note: Workspace and run are live instances - mutations from the cycle
 * flow persist automatically via serialization hooks.
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

import type { ReflectionFlowShared, RoundContext } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * State slices for cycle execution.
 * These are live instances from shared - mutations persist automatically.
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
  | {
      kind: 'success';
      endTurn: boolean;
      failedWithError: boolean;
      errorMessage?: string;
      userCancelled: boolean;
    }
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
   * Get live state instances and determine output location.
   */
  async prep(shared: ReflectionFlowShared): Promise<CyclePrepInput> {
    const { getOutputFileLocation } = this.services;
    const { currentRound, context, workspace, run } = shared;

    if (!context) {
      throw new Error(
        'Context not prepared - PrepareContextNode must run first',
      );
    }

    // Round state is per-round, reconstruct from context snapshot
    const round = ConversationRoundState.fromSnapshot(
      context.stateRoundSnapshot,
    );

    // Determine output location for this round
    const outputLocation = getOutputFileLocation(currentRound);

    return {
      context,
      currentRound,
      outputLocation,
      round,
      run,       // Live instance from shared
      workspace, // Live instance from shared
    };
  }

  /**
   * Run ResponseCycleFlow as a sub-flow.
   */
  async exec(prepRes: CyclePrepInput): Promise<CycleExecResult> {
    const services = this.services;

    // Initialize output file and prefill before starting cycle
    const [prefillEndsTurn, initializedMessages] =
      await services.modelHandler.initializeOutputAndPrefill(
        services.config,
        services.setting,
        prepRes.context.messages,
        prepRes.workspace,
        prepRes.outputLocation,
        prepRes.context.prefill,
      );

    // If prefill already completes the response, return success
    if (prefillEndsTurn) {
      return {
        kind: 'success',
        endTurn: true,
        failedWithError: false,
        userCancelled: false,
      };
    }

    // Build ResponseCycleOptions from services
    const cycleOptions: ResponseCycleOptions<C> = {
      ...buildBaseCycleOptions(services),
      userVars: this.getUserVars(),
      agentConfig: services.config,
      fileService: services.fileService,
    };

    // Create cycle shared state
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

    const onRoundFinalized = this.services.getUsageRecorder();

    try {
      // Inject services with live state instances
      // Mutations to run/workspace persist via serialization hooks
      this.cycleFlow.setServices({
        ...cycleOptions,
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        onRoundFinalized,
      });
      await this.cycleFlow.run(cycleShared);

      const completion = interpretCycleCompletion(
        cycleShared.state,
        cycleShared.retryState,
      );

      return {
        kind: 'success',
        endTurn: cycleShared.state.endTurn,
        ...completion,
      };
    } catch (error) {
      // Error path: finalize round for usage tracking
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
   * Note: workspace and run mutations already persisted via live instances.
   */
  async post(
    shared: ReflectionFlowShared,
    prepRes: CyclePrepInput,
    execRes: CycleExecResult,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    if (execRes.kind === 'error') {
      logger.error(`Response cycle failed: ${execRes.error.message}`);
      shared.lastRetryError = {
        message: execRes.error.message,
        retryable: false,
      };
      throw execRes.error;
    }

    if (execRes.userCancelled) {
      logger.debug('Response cycle cancelled by user');
      shared.continueRounds = false;
      shared.endTurn = false;
      shared.outputLocation = prepRes.outputLocation;
      shared.lastRetryError = undefined;
      return FlowTransition.DEFAULT;
    }

    if (execRes.failedWithError) {
      logger.error(`Response cycle failed: ${execRes.errorMessage}`);
      shared.lastRetryError = {
        message: execRes.errorMessage ?? 'Unknown error',
        retryable: false,
      };
      throw new Error(execRes.errorMessage ?? 'Unknown error');
    }

    // Success - update control state
    // Note: workspace and run are live instances, mutations already persisted
    shared.lastRetryError = undefined;
    shared.endTurn = execRes.endTurn;
    shared.outputLocation = prepRes.outputLocation;

    // Sync conversation state
    shared.conversation = prepRes.context.messages;

    // Store round state snapshot
    shared.roundStateSnapshots.push(prepRes.context.stateRoundSnapshot);

    return FlowTransition.DEFAULT;
  }

  /**
   * Get user variables for prompt rendering.
   */
  private getUserVars(): Record<string, any> {
    const channels = this.services.userVarChannels;
    return {
      ...channels.input,
      ...channels.transient,
    };
  }
}
