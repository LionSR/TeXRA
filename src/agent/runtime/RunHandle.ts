/**
 * Live run handle and terminal settlement.
 *
 * A handle owns one run's identity, its parent edge, its live control
 * surfaces (the tool-use flow, the run lease), and its exactly-once
 * terminal settlement. A run's stop is its fiber's interruption
 * (`RunRegistry.interrupt`), never a call on this handle. Termination
 * policy lives with the owning registry.
 */

import type { AgentTrace } from '@agent/trace';
import type { ToolUseFlowContext } from '@agent/runtime/loop/toolUse';
import type {
  AgentCategory,
  RunId,
  RunIdentity,
  RunPhase,
} from '@shared/schemas';
import { runIdentityName } from '@shared/schemas';

/** A tracked run's status line: the stream's phase, and how long it has
 *  been running while active. */
export interface RunStatusInfo {
  status: RunPhase;
  elapsed: string | null;
}

/**
 * The run's immutable birth facts, the same values `run.start` publishes and
 * `registerRun` persists. `category` is the launch-time in-memory
 * config's run mode — never re-read from a persisted record or a
 * display projection.
 */
export interface RunFacts {
  readonly runId: RunId;
  readonly identity: RunIdentity;
  readonly category: AgentCategory;
}

/** One live parent edge, retained by a native activation and its handles. */
export interface RunParent {
  current: RunId | null;
}
/**
 * The projection of the flow's {@link ToolUseFlowContext} that a run handle
 * retains for its lifetime.
 *
 * This is derived from — not a parallel re-declaration of — {@link
 * ToolUseFlowContext}, so a shape change to either surface fails type-checking
 * instead of silently diverging: every member is picked through from the flow
 * context's own type. The loop's context is deliberately richer (it owns the
 * run's `FollowUps` lease and the bound model); the handle keeps only what a
 * consumer of an attached run needs. A live `flowContext` is attached via
 * `attachToolUseFlow` for the duration of one turn.
 */
export type LiveToolUseFlowContext = Pick<
  ToolUseFlowContext,
  | 'ownerSession'
  | 'requestImmediateCompaction'
  | 'modelSwitchDisabledReason'
  | 'switchModel'
  | 'interrupt'
>;

/**
 * Handle for agent-based runs (workflow or toolUse subagents). A handle
 * with a parent represents a child whose results route to that parent.
 */
export class RunHandle<
  Trace extends AgentTrace | undefined = AgentTrace | undefined,
> {
  /**
   * Epoch ms when this handle generation was created. The value remains on a
   * handle while it is parked at WAITING. Resume constructs and tracks a
   * replacement handle, whose `startedAt` is stamped anew. This feeds the
   * `executions` tool's `Started:` line.
   * Durable run creation time is `RunView.launchedAt`.
   */
  readonly startedAt = Date.now();
  /** @internal The roster shares this cell across one activation's handles. */
  parentState: RunParent;
  private toolUseFlowContext?: LiveToolUseFlowContext;

  /** Whether a caller has claimed the run's exactly-once terminal outcome. */
  private terminalClaimed = false;
  /**
   * The background OS process this run owns, when a strategy declared one
   * (a background bash child): the narrow survivor of the interrupt-handler
   * slot, read only by `RunRegistry.killBackgroundProcesses` to reach a
   * leaked process at shutdown WITHOUT ending agent runs (#8155) — the
   * opposite contract of a run stop, which is the run fiber's interruption.
   */
  backgroundProcess?: { kill(): void };

  constructor(
    /**
     * The run's birth facts, the same object its `run.start` published and its
     * `run.end` row closes. Held whole rather than copied field by field,
     * so the handle and the event plane cannot describe the run differently.
     */
    readonly run: RunFacts,
    parent: RunId | null,
    /** The run's discriminated-event channel, for run-scoped subscribers:
     *  present on every launched run, absent on a process or external-CLI
     *  run's handle, which the type parameter records. */
    readonly trace: Trace = undefined as Trace,
  ) {
    this.parentState = { current: parent };
  }

  get runId(): RunId {
    return this.run.runId;
  }

  get identity(): RunIdentity {
    return this.run.identity;
  }

  get agentName(): string {
    return runIdentityName(this.run.identity);
  }

  get category(): AgentCategory {
    return this.run.category;
  }

  /**
   * Atomically claim the exactly-once terminal finalization of this handle.
   * Returns true for exactly one caller — the flag flips synchronously in the
   * same tick as the check, so two `finalizeRunTerminal` calls racing across
   * await points (e.g. a lifecycle arm vs a concurrent finalize of the same
   * handle) cannot both win. A stop of a run parked at WAITING ends the run
   * through this same gate, since its parked fiber finalizes the run itself,
   * so the lifecycle and a stop cannot both publish a terminal outcome.
   */
  claimTerminalFinalize(): boolean {
    if (this.terminalClaimed) return false;
    this.terminalClaimed = true;
    return true;
  }

  /** The launching run, or null for a root and for a detached child. */
  get parent(): RunId | null {
    return this.parentState.current;
  }

  get isChild(): boolean {
    return this.parentState.current !== null;
  }

  /**
   * The parent this run's results route to, or `undefined` once the run has
   * none (a root run, or a child detached by the roster).
   */
  get deliveryTarget(): RunId | undefined {
    return this.parentState.current ?? undefined;
  }

  /**
   * True when this run is a live child whose results deliver to
   * `callerRunId` — the one caller-ownership authorization check. Reads the
   * live parent edge, so a detached child answers false to its former
   * orchestrator.
   */
  isOwnedBy(callerRunId: RunId | null | undefined): boolean {
    return callerRunId != null && this.parentState.current === callerRunId;
  }

  attachToolUseFlow(context: LiveToolUseFlowContext): void {
    if (this.category !== 'toolUse') {
      throw new Error('Only tool-use run handles can attach tool flows.');
    }
    this.toolUseFlowContext = context;
  }

  detachToolUseFlow(context: LiveToolUseFlowContext): void {
    if (this.toolUseFlowContext !== context) return;
    this.toolUseFlowContext = undefined;
  }

  getToolUseFlow(): LiveToolUseFlowContext | undefined {
    return this.toolUseFlowContext;
  }
}

/**
 * A launched run's handle as `onRun` hands it to the caller: every launch
 * constructs it over the run's own trace, so the trace is present by type.
 */
export type AgentRunHandle = Pick<
  RunHandle<AgentTrace>,
  | 'runId'
  | 'parent'
  | 'isChild'
  | 'identity'
  | 'category'
  | 'agentName'
  | 'startedAt'
  | 'trace'
  | 'deliveryTarget'
>;
