/**
 * RoundCompleteNode - Determines whether to continue to next round or finalize.
 *
 * Checks bounds, interruption, and continue flag to decide next action.
 * RoundPersistedFlow owns round lifecycle; this node only signals intent.
 */

import { Node } from '@agent/node';
import { isRoundAtOrBeyondLimit } from '@agent/node/round-bounds';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

import type { ReflectionFlowShared } from '../ReflectionFlowState';
import type {
  ReflectionFlowParams,
  ReflectionServices,
} from '../ReflectionServices';

// ============================================================================
// Types
// ============================================================================

/**
 * Prep result carries shared reference for exec access.
 * This avoids re-extracting fields that are already on shared.
 */
interface RoundCompletePrepInput {
  shared: ReflectionFlowShared;
}

type RoundCompleteExecResult = { kind: 'continue' } | { kind: 'finalize' };

// ============================================================================
// Node Implementation
// ============================================================================

export class RoundCompleteNode<C = unknown> extends Node<
  ReflectionFlowShared,
  ReflectionFlowParams,
  ReflectionServices<C>
> {
  async prep(shared: ReflectionFlowShared): Promise<RoundCompletePrepInput> {
    return { shared };
  }

  async exec(
    prepRes: RoundCompletePrepInput,
  ): Promise<RoundCompleteExecResult> {
    const { logger } = this.services;
    const { currentRound, totalRounds, continueRounds } = prepRes.shared;

    const nextRound = currentRound + 1;

    // Check for interruption
    if (this.services.checkInterruption()) {
      logger.debug('Interruption requested - finalizing');
      return { kind: 'finalize' };
    }

    // Check if continue flag is false
    if (!continueRounds) {
      logger.debug('Continue flag is false - finalizing');
      return { kind: 'finalize' };
    }

    // Check if we've completed all rounds (single source of truth for bounds)
    if (isRoundAtOrBeyondLimit(nextRound, totalRounds)) {
      logger.debug(`Completed all ${totalRounds} rounds - finalizing`);
      return { kind: 'finalize' };
    }

    // Continue to next round (display as 1-indexed for user-friendly logging)
    logger.debug(
      `Round ${currentRound + 1} complete, continuing to round ${nextRound + 1}`,
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
