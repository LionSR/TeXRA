/**
 * ResponseCycleNode - Runs a response cycle flow with native nesting.
 *
 * ## Native Nesting Architecture
 *
 * Instead of creating a separate shared state for the cycle flow, this node
 * runs the cycle directly on ReflectionFlowShared. This eliminates the
 * translation layer between inner/outer shared types.
 *
 * The cycle flow modifies ReflectionFlowShared's cycle fields directly:
 * - messages, shouldStop, endTurn, outputExists, outputLocation
 * - responseTimeMs, stopReason, systemPrompt, debug, responseObject, processedResponse
 * - lastError
 *
 * ## PocketFlow pattern:
 * - prep(): Reconstruct state slices, populate cycle fields on shared
 * - exec(): Run ResponseCycleFlow directly on shared (native nesting)
 * - post(): Update snapshots from slices (cycle results already in shared)
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
  assertCycleFieldsPopulated,
} from '@agent/core/flows/ResponseCycleFlow';
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
  /** Reference to outer shared for native nesting (cycle runs directly on it) */
  shared: ReflectionFlowShared;
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
   * Reconstruct state slices and prepare for cycle execution.
   * Also stores shared reference for native nesting in exec().
   */
  async prep(shared: ReflectionFlowShared): Promise<CyclePrepInput> {
    const { getOutputFileLocation } = this.services;
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

    return {
      context,
      currentRound,
      outputLocation,
      round,
      run,
      workspace,
      shared, // Pass shared for native nesting
    };
  }

  /**
   * Execute response cycle with native nesting.
   *
   * Runs ResponseCycleFlow directly on the outer shared state
   * (ReflectionFlowShared), eliminating the translation layer.
   * Cycle results are written directly to shared's cycle fields.
   */
  async exec(prepRes: CyclePrepInput): Promise<CycleExecResult> {
    const services = this.services;
    const { shared } = prepRes;

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

    // If prefill already completes the response, return success with endTurn=true
    if (prefillEndsTurn) {
      // Update shared directly for native nesting
      shared.endTurn = true;
      shared.messages = initializedMessages;
      shared.outputLocation = prepRes.outputLocation;
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

    // Build ResponseCycleOptions from services
    const { userVarChannels } = services;
    const cycleOptions = {
      ...(await buildBaseCycleOptions(services)),
      userVars: { ...userVarChannels.input, ...userVarChannels.transient },
      agentConfig: services.config,
      fileService: services.fileService,
    };

    const onRoundFinalized = this.services.getUsageRecorder();

    try {
      // === NATIVE NESTING: Populate cycle fields directly on shared ===
      shared.messages = initializedMessages;
      shared.outputLocation = prepRes.outputLocation;
      shared.endTurn = false;
      shared.shouldStop = false;
      shared.outputExists = false;
      shared.systemPrompt = undefined;
      shared.debug = undefined;
      shared.responseObject = undefined;
      shared.responseTimeMs = undefined;
      shared.stopReason = undefined;
      shared.processedResponse = undefined;
      shared.lastError = undefined;

      // Create and run the flow directly on shared (native nesting)
      const flow = createResponseCycleFlow<C>();
      flow.setServices({
        ...cycleOptions,
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        onRoundFinalized,
      });

      // Validate and narrow type - asserts all required cycle fields are populated
      assertCycleFieldsPopulated(shared);
      await flow.run(shared);

      // Interpret completion from shared (results are already there)
      const completion = interpretCycleCompletion(shared, {
        lastError: shared.lastError,
      });

      return {
        kind: 'success',
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        endTurn: shared.endTurn,
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
   * Update snapshots and handle errors.
   *
   * With native nesting, cycle results are already in shared's cycle fields.
   * This method just updates snapshots and handles error/cancellation paths.
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

    // Success - clear any previous error
    shared.lastRetryError = undefined;

    // Update snapshots from slices (cycle results already in shared via native nesting)
    shared.runStateSnapshot = execRes.run.toSnapshot();
    updateWorkspaceSnapshot(shared, execRes.workspace);

    // Sync conversation state - messages modified in-place during cycle
    shared.conversation = prepRes.context.messages;

    // Store round state snapshot
    shared.roundStateSnapshots.push(prepRes.context.stateRoundSnapshot);

    return FlowTransition.DEFAULT;
  }
}
