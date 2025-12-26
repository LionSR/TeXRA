/**
 * RoundCompleteNode - Handles round completion and continuation logic.
 *
 * Responsibilities:
 * - Increment round counter
 * - Check if more rounds should run
 * - Route to next round or finalization
 *
 * PocketFlow pattern:
 * - prep(): Extract current state
 * - exec(): Determine next action (pure logic)
 * - post(): Update state and route
 *
 * Services accessed via native `this.services`:
 * - logger, checkInterruption
 */

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

interface RoundCompletePrepInput {
  currentRound: number;
  totalRounds: number;
  continueRounds: boolean;
  endTurn: boolean;
}

type RoundCompleteExecResult =
  | { kind: 'continue' }
  | { kind: 'finalize'; reason: string };

// ============================================================================
// Node Implementation
// ============================================================================

export class RoundCompleteNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  constructor() {
    super(1, 0); // maxRetries=1, wait=0
  }

  /**
   * Extract state for completion decision.
   */
  async prep(shared: ReflectionFlowShared): Promise<RoundCompletePrepInput> {
    return {
      currentRound: shared.state.currentRound,
      totalRounds: shared.state.totalRounds,
      continueRounds: shared.state.continueRounds,
      endTurn: shared.state.endTurn,
    };
  }

  /**
   * Determine whether to continue or finalize.
   */
  async exec(
    prepRes: RoundCompletePrepInput,
  ): Promise<RoundCompleteExecResult> {
    const { checkInterruption, logger } = this.services;
    const { currentRound, totalRounds, continueRounds, endTurn } = prepRes;

    const nextRound = currentRound + 1;

    // Check for interruption
    const interrupted = await checkInterruption();
    if (interrupted) {
      logger.debug('Interruption requested - finalizing');
      return { kind: 'finalize', reason: 'interrupted' };
    }

    // Check if continue flag is false
    if (!continueRounds) {
      logger.debug('Continue flag is false - finalizing');
      return { kind: 'finalize', reason: 'continue_false' };
    }

    // Check if we've completed all rounds
    if (nextRound >= totalRounds) {
      logger.debug(`Completed all ${totalRounds} rounds - finalizing`);
      return { kind: 'finalize', reason: 'all_rounds_complete' };
    }

    // Check if turn didn't end properly (model didn't complete)
    if (!endTurn) {
      logger.debug('Turn did not end properly - finalizing');
      return { kind: 'finalize', reason: 'turn_incomplete' };
    }

    // Continue to next round
    logger.debug(
      `Round ${currentRound + 1} complete, continuing to round ${nextRound + 1}`,
    );
    return { kind: 'continue' };
  }

  /**
   * Update state and route appropriately.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: RoundCompletePrepInput,
    execRes: RoundCompleteExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'finalize') {
      return FlowTransition.FINALIZE;
    }

    // Increment round for next iteration
    shared.state.currentRound += 1;

    // Create fresh workspace state for new round
    // (round 0's workspace state was created in run() via createInitialReflectionState)
    shared.state.workspaceState = AgentWorkspaceState.create();

    // Loop back to TeXCountNode (start of round pipeline)
    return FlowTransition.CONTINUE;
  }
}
