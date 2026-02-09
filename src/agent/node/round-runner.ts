/**
 * Round management as a composable function over PersistedFlow.
 *
 * Usage:
 * ```
 * const pf = new PersistedFlow(startNode, kv);
 * pf.setServices(services);
 * await runWithRounds(pf, shared, { hooks: { ... } });
 * ```
 */

import { EXECUTION_STATUS, type ExecutionStatus } from '@shared/schemas';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import type { AgentLogStage } from '@logger/AgentLogger';
import { isRoundAtOrBeyondLimit } from './round-bounds';
import type { PersistedFlow } from './persisted-flow';

export interface RoundAwareState {
  currentRound: number;
  totalRounds: number;
  continueRounds: boolean;
}

export interface RoundLifecycleHooks<S extends RoundAwareState, Svc = unknown> {
  createRoundStage?: (
    roundIndex: number,
    parentStage: AgentLogStage | null,
  ) => Promise<AgentLogStage>;
  onStageCreated?: (stage: AgentLogStage) => void;
  checkInterruption?: () => boolean;
  resetForNextRound?: (shared: S) => void;
}

export interface RoundRunnerConfig<S extends RoundAwareState, Svc = unknown> {
  hooks?: RoundLifecycleHooks<S, Svc>;
  parentStage?: AgentLogStage | null;
}

function withinStage<T>(
  stage: AgentLogStage | null,
  fn: () => Promise<T>,
): Promise<T> {
  return stage ? stage.within(fn) : fn();
}

export async function runWithRounds<
  S extends RoundAwareState,
  P extends Record<string, unknown>,
  Svc,
>(
  pf: PersistedFlow<S, P, Svc>,
  shared: S,
  config?: RoundRunnerConfig<S, Svc>,
): Promise<ExecutionStatus> {
  const hooks = config?.hooks;
  const parentStage = config?.parentStage ?? null;
  let currentRoundStage: AgentLogStage | null = null;
  let status: ExecutionStatus = EXECUTION_STATUS.COMPLETED;

  await pf.init(shared);
  let currentShared = shared;

  try {
    // Create initial round stage (r0)
    if (hooks?.createRoundStage) {
      currentRoundStage = await hooks.createRoundStage(
        currentShared.currentRound,
        parentStage,
      );
      hooks.onStageCreated?.(currentRoundStage);
    }

    let stepResult = await withinStage(currentRoundStage, () =>
      pf.publicStepWithResult(),
    );
    while (stepResult.hasMore) {
      currentShared = stepResult.shared;

      if (hooks?.checkInterruption?.()) {
        currentShared.continueRounds = false;
        break;
      }

      if (stepResult.action === FlowTransition.CONTINUE_NEXT_ROUND) {
        // End previous round stage
        currentRoundStage?.end();
        currentRoundStage = null;

        // Increment round (single source of truth)
        currentShared.currentRound += 1;
        hooks?.resetForNextRound?.(currentShared);
        await pf.setShared(currentShared);

        // Create new stage if still in bounds
        if (
          !isRoundAtOrBeyondLimit(
            currentShared.currentRound,
            currentShared.totalRounds,
          )
        ) {
          if (hooks?.createRoundStage) {
            currentRoundStage = await hooks.createRoundStage(
              currentShared.currentRound,
              parentStage,
            );
            hooks.onStageCreated?.(currentRoundStage);
          }
        }
      }

      stepResult = await withinStage(currentRoundStage, () =>
        pf.publicStepWithResult(),
      );
    }

    currentShared = stepResult.shared;

    // Determine final status
    const completedAllRounds = isRoundAtOrBeyondLimit(
      currentShared.currentRound + 1,
      currentShared.totalRounds,
    );
    const wasInterrupted =
      !completedAllRounds &&
      (hooks?.checkInterruption?.() || !currentShared.continueRounds);
    if (wasInterrupted) {
      status = EXECUTION_STATUS.INTERRUPTED;
    }
  } catch (error) {
    status = EXECUTION_STATUS.ERROR;
    throw error;
  } finally {
    currentRoundStage?.end();
  }

  return status;
}
