import { AsyncLocalStorage } from 'node:async_hooks';

import { noopTrace, type AgentTrace } from '@agent/trace';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { AgentProposalCoordinator } from './AgentProposalCoordinator';
import type { PlanApprovalCoordinator } from './PlanApprovalCoordinator';
import type { RetryRequestCoordinatorImpl } from './RetryRequestCoordinator';

export interface RunCoordinators {
  readonly plan: PlanApprovalCoordinator;
  readonly proposal: AgentProposalCoordinator;
  readonly retry: RetryRequestCoordinatorImpl;
}

/**
 * Ambient per-run context stored in an {@link AsyncLocalStorage} scope.
 *
 * Tools and utilities that cannot take explicit parameters reach host services
 * via `tryUseRunContext()`. The canonical source of truth for all of these
 * fields is {@link AgentLaunchContext} / {@link AgentCore}; the values here
 * are projected once by `agentContextToRunContext` in `AgentLaunchContext.ts`
 * at the moment `withExecutionRunContext` is entered.
 *
 * **Field naming mismatches with AgentCore** (unavoidable — interfaces were
 * designed independently):
 *   - `AgentCore.logger`  → `RunContext.trace`
 *   - `AgentConfig.agent` → `RunContext.agentName`
 *   - `AgentConfig.model` → `RunContext.model`
 *
 * **Staleness**: `model` is snapshotted at run start. After a mid-session
 * model switch (`onModelChanged` in `executeAgent`), `RunContext.model` lags
 * behind `AgentLaunchContext.config.model`. Tools that delegate subagents
 * and inherit the parent model (e.g. `delegate_agent`) will use the stale
 * value. This is a known limitation of the snapshot approach.
 */
export interface RunContext {
  readonly runtimeHost: AgentRuntimeHost;
  readonly streamId?: StreamTabId;
  readonly executionId?: ExecutionId;
  /**
   * Discriminated-event SDK channel for this run. Defaults to `noopTrace`
   * when the context is created without a trace (e.g. in tests).
   *
   * Most tools receive the trace via explicit parameter threading rather than
   * reading it here; this field exists for test helpers and future SDK
   * consumers that need the trace without access to the full AgentLaunchContext.
   */
  readonly trace: AgentTrace;
  readonly coordinators?: RunCoordinators;
  /**
   * Model short name snapshotted at run start (e.g. "opus46T"). May be stale
   * after `onModelChanged` — see interface-level note above.
   */
  readonly model?: string;
  /** Agent name (e.g. "orchestrator", "search-agent"). */
  readonly agentName?: string;
  /** Working directory override for tool calls (e.g. a git worktree path). */
  readonly workingDirectory?: string;
  /**
   * Delegation depth: 0 for root (user-initiated), N for a subagent N levels
   * deep. Read by delegation tools to compute the child's depth.
   */
  readonly delegationDepth?: number;
  /** Whether approval or user prompts cannot be answered by the current host. */
  readonly approvalPromptsUnavailable?: boolean;
  /** Whether this run should stop after one tool-use cycle instead of idling. */
  readonly stopAfterCycle?: boolean;
}

export interface CreateRunContextOptions {
  runtimeHost: AgentRuntimeHost;
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  /**
   * Discriminated-event channel for the run. When omitted, the context uses
   * `noopTrace`.
   */
  trace?: AgentTrace;
  coordinators?: RunCoordinators;
  model?: string;
  agentName?: string;
  workingDirectory?: string;
  delegationDepth?: number;
  approvalPromptsUnavailable?: boolean;
  stopAfterCycle?: boolean;
}

const runContextScope = new AsyncLocalStorage<RunContext>();

export function createRunContext(options: CreateRunContextOptions): RunContext {
  if (options.runtimeHost == null) {
    throw new Error('createRunContext requires an explicit runtimeHost');
  }

  return Object.freeze({
    runtimeHost: options.runtimeHost,
    streamId: options.streamId,
    executionId: options.executionId,
    trace: options.trace ?? noopTrace,
    coordinators: options.coordinators,
    model: options.model,
    agentName: options.agentName,
    workingDirectory: options.workingDirectory,
    delegationDepth: options.delegationDepth,
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    stopAfterCycle: options.stopAfterCycle,
  });
}

/**
 * Run code with an active per-run context.
 *
 * The context is populated by `withExecutionRunContext` (in
 * `AgentLaunchContext.ts`), which projects an {@link AgentLaunchContext} into
 * the ALS scope. Tools and utilities call `tryUseRunContext()` to read it.
 */
export function withRunContext<T>(
  context: RunContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return runContextScope.run(context, fn);
}

/** Return the active run context, or throw if none is installed. */
export function useRunContext(): RunContext {
  const context = runContextScope.getStore();
  if (!context) {
    throw new Error('useRunContext() called outside withRunContext()');
  }
  return context;
}

/** Return the active run context when called from a run, otherwise undefined. */
export function tryUseRunContext(): RunContext | undefined {
  return runContextScope.getStore();
}
