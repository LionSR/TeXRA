/**
 * The vocabulary of the run registry: the shapes its admission, stop and
 * lineage surfaces are written in.
 *
 * Kept beside the registry rather than inside it so the roster
 * (`runRoster.ts`) and the registry itself name one set of types instead of
 * re-declaring the child-activation and stop shapes they both handle.
 */

import type { Deferred, Effect, Fiber } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type {
  FinalizeRunInput,
  FinalizeRunResult,
} from '@agent/storage/runLifecycle';
import type { RunId, SessionEventDraft, RunPhase } from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import type { LiveToolUseFlowContext } from './RunHandle';

/**
 * Child policy shared by `kill()` and `stopAgentRun()`. The caller owns the
 * decision because only it knows which gesture it is serving: the configured
 * stop surfaces resolve it through `detachSubagentsOnStop()`, the CLI's
 * bare-Escape stop always detaches, and shutdown always cascades. Omitting
 * the field means cascade, since a child left running has no owner.
 */
export interface RunStop {
  /** Whether a live interrupt target took the stop, asked rather than read:
   *  the two child policies decide it at different moments. A cascading stop
   *  interrupts at admission and answers straight away; a detaching one
   *  interrupts only after {@link settlement} has committed the detach batch
   *  and severed the children locally, so it answers `false` until that has
   *  run. A caller that must decide synchronously is therefore a caller that
   *  cascades (headless shutdown, session close). */
  readonly accepted: () => boolean;
  /** Fails when a durable fact the stop owed storage was refused: the detach
   *  batch a `detachActiveChildren` stop commits is one such fact, and a
   *  caller that reported the stop done over it would be lying about it. */
  readonly settlement: Effect.Effect<void, Error>;
}

export interface RunStopOptions {
  readonly detachActiveChildren?: boolean;
}

/**
 * A native child loop's lineage for the loop's whole life: from the
 * synchronous start of the loop, across every turn handle it tracks and
 * untracks, until its final result has reached the parent. The parent counts
 * it as an active child throughout, so its continuation stays recoverable
 * until the last delivery landed. Child-run loops use their run handle.
 */
export interface ChildRunActivation {
  readonly runId: RunId;
  readonly parentRunId: RunId;
  readonly interrupt: () => void;
  readonly detach: () => void;
  readonly isDetached: () => boolean;
}

/**
 * A run parked at WAITING: the fiber its generation stayed on, inside the
 * scope that holds the run's teardown. Completing the latch ends the run
 * through the lifecycle's terminal path; interrupting the fiber where it
 * waits ends the park alone, which is what a resumed generation does.
 */
export interface ParkedRun {
  readonly fiber: Fiber.Fiber<void>;
  readonly stopped: Deferred.Deferred<void>;
}

/**
 * Where a follow-up for a run goes: a live flow context, the run's
 * retained queue (a WAITING or resuming cursor, or a parent whose children
 * are still active), or nowhere in this process.
 */
export type ToolUseFollowUpTarget =
  | {
      readonly kind: 'active';
      readonly context: LiveToolUseFlowContext;
    }
  | { readonly kind: 'queue' }
  | {
      readonly kind: 'no_session';
      readonly runStatus: RunPhase | undefined;
    };

export type ManualCompactionRequestResult =
  | {
      readonly kind: 'requested';
      readonly runId: RunId;
      readonly session: SessionHandle;
    }
  | {
      readonly kind: 'no_active_tool_use';
      readonly runId?: RunId;
    };

/**
 * The registry reads a run's phase from the session's fold (`RunView.status`,
 * one run model, 3.3) and keeps no phase of its own; the session routes each
 * phase-moving row it committed through `handleStatus` once the view has
 * folded it, so the registry's waiters and child rosters follow the one rail
 * every renderer reads and never read it a row behind.
 */
export interface RunRegistryInit {
  readonly runView: (runId: RunId) => RunView | undefined;
  /** The session's awaited publisher (`SessionHandle.commit`) for the
   *  registry's own durable fact, a severed parent edge (`run.detach`). One
   *  batch carries every child of a detaching parent, so it is no single
   *  run's fact and no run's drain would ever hear it refused: the caller
   *  that asked for the sever is the one owner that can. */
  readonly commit: (
    events: readonly SessionEventDraft[],
  ) => Effect.Effect<void, Error>;
  readonly approvals: SessionApprovals;
  readonly finalizeRun: (
    input: FinalizeRunInput,
  ) => Effect.Effect<FinalizeRunResult, Error>;
  /**
   * Admit one run's claim (`SessionHandle.acquireClaims`) and hand back its
   * release. A run aggregate takes an append from its claim holder alone, so
   * a stop that reached no live handle takes the claim the same fenced way a
   * decision over a dead owner does (`SessionRequests.decide`) before it
   * writes the run's terminal row.
   */
  readonly acquireRunClaim: (
    runId: RunId,
  ) => Effect.Effect<Effect.Effect<void, Error>, Error>;
}
