import { AsyncLocalStorage } from 'async_hooks';

import { noopTrace, type AgentTrace } from '@agent/trace';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { NestedDelegationConfig } from '@shared/constants/delegationPolicy';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { AgentProposalCoordinator } from './AgentProposalCoordinator';
import type { PlanApprovalCoordinator } from './PlanApprovalCoordinator';
import type { RetryRequestCoordinatorImpl } from './RetryRequestCoordinator';

export interface RunCoordinators {
  readonly plan: PlanApprovalCoordinator;
  readonly proposal: AgentProposalCoordinator;
  readonly retry: RetryRequestCoordinatorImpl;
}

export interface RunContext {
  readonly runtimeHost: AgentRuntimeHost;
  readonly streamId?: StreamTabId;
  readonly executionId?: ExecutionId;
  /**
   * Discriminated-event SDK channel for this run. Subscribe with
   * `trace.subscribe(...)` to receive every event the run emits. Defaults
   * to `noopTrace` when callers don't provide one. Hosts that need their
   * own sugar (TeXRA's TexraTrace) may pass in a subtype.
   */
  readonly trace: AgentTrace;
  readonly coordinators?: RunCoordinators;
  /** Model short name of the executing agent (e.g. "opus46T", "sonnet46T"). */
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
  /**
   * Delegation policy snapshot for this run. Keeps delegation tool enforcement
   * aligned with the tool list shown to the model.
   */
  readonly delegationConfig?: NestedDelegationConfig;
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
  delegationConfig?: NestedDelegationConfig;
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
    delegationConfig: options.delegationConfig,
  });
}

/**
 * Run code with an active per-run context.
 *
 * This is the migration bridge from the older runtime-host ALS and singleton
 * coordinators toward an explicit context rooted at executeAgent().
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
