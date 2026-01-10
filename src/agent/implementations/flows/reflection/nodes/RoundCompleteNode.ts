/**
 * RoundCompleteNode - Determines whether to continue to next round or finalize.
 *
 * Checks bounds, interruption, and continue flag to decide next action.
 * RoundPersistedFlow owns round lifecycle; this node only signals intent.
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

  async prep(shared: ReflectionFlowShared): Promise<RoundCompletePrepInput> {
    return {
      currentRound: shared.currentRound,
      totalRounds: shared.totalRounds,
      continueRounds: shared.continueRounds,
    };
  }

  async exec(
    prepRes: RoundCompletePrepInput,
  ): Promise<RoundCompleteExecResult> {
    const { checkInterruption, logger } = this.services;
    const { currentRound, totalRounds, continueRounds } = prepRes;

    const nextRound = currentRound + 1;
    // Display rounds as 1-indexed for user-friendly logging
    const displayCurrent = currentRound + 1;
    const displayNext = nextRound + 1;

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

    // Continue to next round
    logger.debug(
      `Round ${displayCurrent} complete, continuing to round ${displayNext}`,
    );
    return { kind: 'continue' };
  }

  /**
   * Route based on decision. RoundPersistedFlow owns all round lifecycle
   * (incrementing, stages, workspace reset) - this node only signals intent.
   */
  async post(
    _shared: ReflectionFlowShared,
    _prepRes: RoundCompletePrepInput,
    execRes: RoundCompleteExecResult,
  ): Promise<string | undefined> {
    return execRes.kind === 'finalize'
      ? FlowTransition.FINALIZE
      : FlowTransition.CONTINUE_NEXT_ROUND;
  }
}
