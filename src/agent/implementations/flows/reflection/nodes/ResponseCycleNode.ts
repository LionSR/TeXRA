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
import { recordRound } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createResponseCycleFlow,
  initializeCycleFields,
} from '@agent/core/flows/ResponseCycleFlow';
import {
  type CycleStateSlices,
  type ResponseCycleServices,
} from '@agent/core/flows/CycleServices';
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
 * Prep result carries shared reference and reconstructed state slices.
 * - shared: Reference for native nesting (cycle runs directly on it)
 * - context/currentRound: Accessed via shared, not duplicated here
 * - State slices (run, round, workspace): Reconstructed from snapshots, modified by cycle
 * - outputLocation: Computed once per round
 */
interface CyclePrepInput extends CycleStateSlices {
  shared: ReflectionFlowShared;
  outputLocation: AgentFileLocation;
}

/**
 * Cycle outcome — single discriminated union that maps 1:1 to post() actions.
 * Replaces the prior chain: shared flags → interpretCycleCompletion() → CycleCompletionResult
 * → CycleExecResult wrapping → post() re-destructuring.
 */
type CycleOutcome =
  | { outcome: 'completed' }
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
   * Also stores shared reference for native nesting in exec().
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
   * Execute response cycle with native nesting.
   *
   * Runs ResponseCycleFlow directly on the outer shared state
   * (ReflectionFlowShared), eliminating the translation layer.
   * Cycle results are written directly to shared's cycle fields.
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
      shared.endTurn = true;
      shared.messages = initializedMessages;
      shared.outputLocation = prepRes.outputLocation;
      return { outcome: 'completed' };
    }

    const onRoundFinalized = this.services.getUsageRecorder();

    try {
      // Initialize all cycle fields in one call (replaces 11 individual assignments + assertion)
      initializeCycleFields(
        shared,
        initializedMessages,
        prepRes.outputLocation,
      );

      // Create and run the flow directly on shared (native nesting)
      const flow = createResponseCycleFlow<C>();
      const modelHandler = this.services.modelHandler;
      const clientRef = { current: await modelHandler.getClient() };
      const flowServices: ResponseCycleServices<C> & {
        refreshClient: () => Promise<void>;
      } = {
        modelHandler: this.services.modelHandler,
        setting: this.services.setting,
        prompt: this.services.prompt,
        logger: this.services.logger,
        streamId: this.services.streamId,
        executionId: this.services.executionId,
        userVarChannels: this.services.userVarChannels,
        checkInterruption: this.services.checkInterruption,
        setAbortController: this.services.setAbortController,
        config: this.services.config,
        fileService: this.services.fileService,
        get client() {
          return clientRef.current;
        },
        round: prepRes.round,
        run: prepRes.run,
        workspace: prepRes.workspace,
        onRoundFinalized,
        async refreshClient() {
          clientRef.current = await modelHandler.getClient();
        },
      };
      flow.setServices(flowServices);
      await flow.run(shared);

      // Determine outcome directly from shared state flags (single interpretation)
      if (shared.shouldStop && shared.lastError) {
        return {
          outcome: 'failed',
          error: new Error(shared.lastError.message),
        };
      }
      if (shared.shouldStop && !shared.lastError && !shared.endTurn) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed' };
    } catch (error) {
      // Error path: finalize round on unexpected errors
      recordRound(prepRes.run, prepRes.round);
      if (onRoundFinalized) {
        await onRoundFinalized(prepRes.run);
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
   * Update snapshots and handle cycle outcome.
   *
   * With native nesting, cycle results are already in shared's cycle fields.
   * CycleOutcome maps 1:1 to actions — no re-interpretation needed.
   */
  async post(
    shared: ReflectionFlowShared,
    prepRes: CyclePrepInput,
    execRes: CycleOutcome,
  ): Promise<string | undefined> {
    const { logger } = this.services;

    if (execRes.outcome === 'failed') {
      logger.error(`Response cycle failed: ${execRes.error.message}`);
      shared.lastError = { message: execRes.error.message, retryable: false };
      throw execRes.error;
    }

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
    shared.conversation = shared.context!.messages;
    shared.roundStateSnapshots.push(shared.context!.stateRoundSnapshot);

    return FlowTransition.DEFAULT;
  }
}
