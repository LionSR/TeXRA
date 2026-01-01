/**
 * RoundCompleteNode - Handles round completion and continuation logic.
 *
 * Responsibilities:
 * - Check if more rounds should run (bounds, interruption, flags)
 * - Signal intent to RoundPersistedFlow (CONTINUE_NEXT_ROUND or FINALIZE)
 *
 * Note: RoundPersistedFlow OWNS the round increment. This node only signals
 * intent, and the flow handles all round lifecycle (increment, stages, reset).
 *
 * PocketFlow pattern:
 * - prep(): Extract current state
 * - exec(): Determine next action (pure logic)
 * - post(): Route based on decision
 *
 * Services accessed via native `this.services`:
 * - logger, checkInterruption
 */

import { Node } from '@agent/node';
import { isRoundAtOrBeyondLimit } from '@agent/node/round-bounds';
import {
  NODE_NO_RETRY,
  NODE_NO_WAIT,
} from '@agent/implementations/flows/common';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

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
      currentRound: shared.currentRound,
      totalRounds: shared.totalRounds,
      continueRounds: shared.continueRounds,
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

    // Check if we've completed all rounds (single source of truth for bounds)
    if (isRoundAtOrBeyondLimit(nextRound, totalRounds)) {
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
   * Route based on decision.
   *
   * RoundPersistedFlow OWNS all round lifecycle:
   * - Incrementing currentRound (single source of truth)
   * - Stage lifecycle (end old stage, create new stage)
   * - Workspace reset (via resetForNextRound hook)
   *
   * This node only signals intent via FlowTransitions.
   */
  async post(
    _shared: ReflectionFlowShared,
    _prepRes: RoundCompletePrepInput,
    execRes: RoundCompleteExecResult,
  ): Promise<string | undefined> {
    if (execRes.kind === 'finalize') {
      return FlowTransition.FINALIZE;
    }

    // Signal intent to continue - RoundPersistedFlow will:
    // 1. Increment currentRound (single source of truth)
    // 2. End old round stage
    // 3. Call resetForNextRound hook (workspace reset)
    // 4. Create new round stage
    return FlowTransition.CONTINUE_NEXT_ROUND;
  }
}
