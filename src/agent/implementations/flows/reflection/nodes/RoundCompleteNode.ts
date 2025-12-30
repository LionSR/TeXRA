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
 * - logger, checkInterruption, runStage
 */

import { Node } from '@agent/node';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

import {
  createFreshWorkspaceSnapshot,
  type ReflectionFlowShared,
} from '../ReflectionFlowState';
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
    super(NODE_NO_RETRY, NODE_NO_WAIT);
  }

  /**
   * Extract state for completion decision.
   */
  async prep(shared: ReflectionFlowShared): Promise<RoundCompletePrepInput> {
    return {
      currentRound: shared.state.currentRound,
      totalRounds: shared.state.totalRounds,
      continueRounds: shared.state.continueRounds,
    };
  }

  /**
   * Determine whether to continue or finalize.
   */
  async exec(
    prepRes: RoundCompletePrepInput,
  ): Promise<RoundCompleteExecResult> {
    const { checkInterruption, logger } = this.services;
    const { currentRound, totalRounds, continueRounds } = prepRes;

    const nextRound = currentRound + 1;

    // Check for interruption
    if (checkInterruption()) {
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

    // Note: endTurn=false means model didn't complete in one shot (continuation, pseudo prefill)
    // This is handled by OutputNode skipping certain processing - it shouldn't stop the flow.
    // The flow should continue to the next round regardless of endTurn.

    // Continue to next round
    logger.debug(
      `Round ${currentRound + 1} complete, continuing to round ${nextRound + 1}`,
    );
    return { kind: 'continue' };
  }

  /**
   * Update state and route appropriately.
   * Manages round stage transitions for UI grouping.
   */
  async post(
    shared: ReflectionFlowShared,
    _prepRes: RoundCompletePrepInput,
    execRes: RoundCompleteExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'finalize') {
      // Don't end round stage here - agent.run() finally block handles it
      // This ensures proper status (ERROR vs STOPPED) is applied
      return FlowTransition.DEFAULT; // Flow ends gracefully
    }

    // === ROUND TRANSITION ===
    // End current round stage (defaults to 'stopped' which indicates completion)
    shared.state.roundStage?.end();

    // Increment round for next iteration
    const nextRound = shared.state.currentRound + 1;
    shared.state.currentRound = nextRound;

    // Create new round stage (r1, r2, etc.) as sibling to r0
    const newRoundStage = await this.services.logger.stage(`r${nextRound}`, {
      parent: this.services.runStage,
    });
    shared.state.roundStage = newRoundStage;

    // Create fresh workspace snapshot for new round
    shared.state.workspaceSnapshot = createFreshWorkspaceSnapshot();

    // Loop back to TeXCountNode (start of round pipeline)
    return FlowTransition.CONTINUE;
  }
}
