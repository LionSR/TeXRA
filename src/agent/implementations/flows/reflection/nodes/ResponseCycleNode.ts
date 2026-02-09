/**
 * ResponseCycleNode - Runs a response cycle flow with separate cycle state.
 *
 * ## Separate State Architecture
 *
 * Creates a dedicated ResponseCycleShared object for the cycle flow, keeping
 * cycle-internal fields off the outer ReflectionFlowShared. Results needed by
 * downstream nodes (endTurn, outputLocation) are propagated in post().
 *
 * This matches the pattern used by ToolUseCycleNode: construct cycle state,
 * run flow, interpret completion, sync results back.
 *
 * ## PocketFlow pattern:
 * - prep(): Reconstruct state slices from snapshots
 * - exec(): Create cycle state, run ResponseCycleFlow on it
 * - post(): Propagate results to shared for downstream nodes
 *
 * Services accessed via native `this.services`:
 * - modelHandler, logger, setting, prompt, config, context, etc.
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { recordRound } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createResponseCycleFlow,
  type ResponseCycleShared,
} from '@agent/core/flows/ResponseCycleFlow';
import type {
  AgentRunStateSnapshot,
  ConversationRoundStateSnapshot,
} from '@agent/core/AgentState';
import { buildCycleServices } from '@agent/core/flows/CycleServices';
import type { AgentFileLocation } from '@utils/files';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Prep result carries reconstructed state slices.
 * - State slices (run, round, workspace): Reconstructed from snapshots, modified by cycle
 * - outputLocation: Computed once per round
 */
interface CyclePrepInput {
  shared: ReflectionFlowShared;
  outputLocation: AgentFileLocation;
  run: AgentRunStateSnapshot;
  workspace: AgentWorkspaceState;
  round: ConversationRoundStateSnapshot;
}

/**
 * Cycle outcome — single discriminated union that maps 1:1 to post() actions.
 */
type CycleOutcome =
  | { outcome: 'completed'; endTurn: boolean }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; error: Error };

// ============================================================================
// Node Implementation
// ============================================================================

export class ResponseCycleNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  /**
   * Reconstruct state slices and prepare for cycle execution.
   */
  async prep(shared: ReflectionFlowShared): Promise<CyclePrepInput> {
    const { context } = shared;

    if (!context) {
      throw new Error(
        'Context not prepared - PrepareContextNode must run first',
      );
    }

    // Reconstruct workspace from snapshot (has internal data structures: Sets, Maps)
    const workspace = AgentWorkspaceState.fromSnapshot(
      shared.workspaceSnapshot,
    );
    // Run and round are plain data — use directly from shared state
    const run = shared.runStateSnapshot;
    const round = context.stateRoundSnapshot;

    return {
      shared,
      outputLocation: this.services.getOutputFileLocation(shared.currentRound),
      round,
      run,
      workspace,
    };
  }

  /**
   * Execute response cycle on a separate cycle state object.
   *
   * Creates a ResponseCycleShared, runs the cycle flow on it,
   * and returns the interpreted result. Cycle-internal fields
   * stay on the cycle object — only endTurn propagates to shared via post().
   */
  async exec(prepRes: CyclePrepInput): Promise<CycleOutcome> {
    const { shared } = prepRes;
    const context = shared.context!; // Validated in prep()

    // Initialize output file and prefill before starting cycle
    const [prefillEndsTurn, initializedMessages] =
      await this.services.modelHandler.initializeOutputAndPrefill(
        this.services.config,
        this.services.setting,
        context.messages,
        prepRes.workspace,
        prepRes.outputLocation,
        context.prefill,
      );

    // If prefill already completes the response, mark as completed
    if (prefillEndsTurn) {
      return { outcome: 'completed', endTurn: true };
    }

    try {
      // Create separate cycle state (cycle-internal fields stay here)
      const cycleShared: ResponseCycleShared = {
        messages: initializedMessages,
        outputLocation: prepRes.outputLocation,
        endTurn: false,
        shouldStop: false,
        outputExists: false,
        systemPrompt: undefined,
        responseObject: undefined,
        responseTimeMs: undefined,
        stopReason: undefined,
        processedResponse: undefined,
        lastError: undefined,
      };

      // Create and run the flow on the separate cycle state
      const flow = createResponseCycleFlow<C>();
      flow.setServices(
        await buildCycleServices(this.services, {
          round: prepRes.round,
          run: prepRes.run,
          workspace: prepRes.workspace,
        }),
      );
      await flow.run(cycleShared);

      // Determine outcome from cycle state (single interpretation)
      if (cycleShared.shouldStop && cycleShared.lastError) {
        return {
          outcome: 'failed',
          error: new Error(cycleShared.lastError.message),
        };
      }
      if (
        cycleShared.shouldStop &&
        !cycleShared.lastError &&
        !cycleShared.endTurn
      ) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', endTurn: cycleShared.endTurn };
    } catch (error) {
      // Error path: finalize round on unexpected errors
      recordRound(prepRes.run, prepRes.round);
      if (this.services.onRoundFinalized) {
        await this.services.onRoundFinalized(prepRes.run);
      }
      return {
        outcome: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  async execFallback(
    _prepRes: CyclePrepInput,
    error: Error,
  ): Promise<CycleOutcome> {
    return { outcome: 'failed', error };
  }

  /**
   * Propagate cycle results to shared and update snapshots.
   *
   * Sets fields needed by downstream nodes (OutputNode reads endTurn,
   * outputLocation) and persisted state (lastError for resume).
   */
  async post(
    shared: ReflectionFlowShared,
    prepRes: CyclePrepInput,
    execRes: CycleOutcome,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    // Set output location for downstream nodes (OutputNode reads it)
    shared.outputLocation = prepRes.outputLocation;

    if (execRes.outcome === 'failed') {
      logger.error(`Response cycle failed: ${execRes.error.message}`);
      shared.lastError = { message: execRes.error.message, retryable: false };
      throw execRes.error;
    }

    // Propagate endTurn for downstream nodes (OutputNode reads it)
    shared.endTurn = execRes.outcome === 'completed' ? execRes.endTurn : false;

    if (execRes.outcome === 'cancelled') {
      logger.debug('Response cycle cancelled by user');
      shared.continueRounds = false;
      shared.lastError = undefined;
      return FlowTransition.DEFAULT;
    }

    // completed — clear any previous error, update snapshots
    shared.lastError = undefined;
    shared.runStateSnapshot = prepRes.run;
    shared.workspaceSnapshot = prepRes.workspace.toSnapshot();

    // Sync conversation state — initializeOutputAndPrefill returns the same
    // array reference, so in-place modifications by the cycle flow (compaction,
    // continuation prompts) are visible through context.messages.
    shared.conversation = shared.context!.messages;
    shared.roundStateSnapshots.push(shared.context!.stateRoundSnapshot);

    return FlowTransition.DEFAULT;
  }
}
