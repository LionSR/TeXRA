/**
 * The vocabulary of the run registry: the shapes its admission, stop and
 * lineage surfaces are written in.
 *
 * Kept beside the registry rather than inside it so the roster
 * (`runRoster.ts`) and the registry itself name one set of types instead of
 * re-declaring the child-activation and stop shapes they both handle.
 */

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionApprovals } from '@agent/runtime/runApprovalQueue';
import type {
  FinalizeRunInput,
  FinalizeRunResult,
} from '@agent/storage/runLifecycle';
import type { RunId, SessionEventDraft, RunPhase } from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import type { Effect } from 'effect';
import type { LiveToolUseFlowContext, RunParent } from './RunHandle';

/**
 * Child policy shared by `kill()` and `stopAgentRun()`. An explicit value
 * wins: the CLI's bare-Escape stop always detaches and shutdown always
 * cascades. A `run.stop` request that leaves it unset is resolved by the
 * session request handler through `detachSubagentsOnStop()`. `Runs` itself
 * still reads a missing option as cascade, since a child left running has no
 * owner.
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
 * A child loop's stop target and lineage for the loop's whole life: from the
 * synchronous launch until its final result has reached the parent, including
 * preparation before the engine tracks its handle and terminal delivery after
 * it. Every child loop carries one so the run's stop
 * (`RunRegistry.interrupt`) always finds a live target, including the
 * inter-turn gap when no flow context is attached.
 */
export interface ChildRunActivation {
  readonly runId: RunId;
  parent: RunParent;
  readonly interrupt: () => void;
  /**
   * A native child (true) counts as its parent's active child until the last
   * delivery landed, so a terminal parent's continuation stays recoverable
   * (`RunRegistry.getToolUseFollowUpTarget` queues a follow-up into it). A
   * process child (false) must not: its reservation would make a terminal
   * parent look recoverable after it can no longer accept either user input
   * or the child's result.
   */
  readonly retainsTerminalParent: boolean;
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
 * The registry, and the stopper it hands this reader to, read a run's phase
 * from the session's fold (`RunView.status`,
 * one run model, 3.3) and keep no phase of their own; the session routes each
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
