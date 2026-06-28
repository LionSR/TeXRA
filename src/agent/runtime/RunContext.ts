import { AsyncLocalStorage } from 'node:async_hooks';

import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import type { AgentProposalCoordinator } from './AgentProposalCoordinator';
import type { PlanApprovalCoordinator } from './PlanApprovalCoordinator';
import type { RetryRequestCoordinatorImpl } from './RetryRequestCoordinator';
import type { SessionHandle } from './SessionHandle';

export interface RunCoordinators {
  readonly plan: PlanApprovalCoordinator;
  readonly proposal: AgentProposalCoordinator;
  readonly retry: RetryRequestCoordinatorImpl;
}

/**
 * Ambient per-run context stored in an {@link AsyncLocalStorage} scope.
 *
 * Tools and utilities that cannot take explicit parameters reach host services
 * via `tryUseRunContext()`. The canonical source of truth for these fields is
 * {@link AgentLaunchContext} / {@link AgentCore}; the ambient context exposes
 * the subset that tool-side code needs without importing the full launch
 * context.
 *
 * **Why the field names differ from AgentCore.** This is a *flat* ambient
 * projection, not a copy of the nested launch context, so the names describe
 * the run directly rather than mirror `AgentCore`'s shape:
 *   - `AgentConfig.agent`  → `agentName` (`AgentConfig` nests it; here it is flat)
 *   - `AgentConfig.model`  → `model`     (flat + live; see below)
 *
 * The one place that maps `AgentLaunchContext` onto these fields is
 * `agentContextToRunContext` (in `AgentLaunchContext.ts`), so the projection
 * has a single owner and cannot drift across the codebase.
 *
 * `model` is a live property when the context is projected from an
 * {@link AgentLaunchContext}, so mid-session model switches are visible to
 * delegation tools that inherit the parent model.
 */
export interface RunContext {
  readonly runtimeHost: AgentRuntimeHost;
  readonly streamId?: StreamTabId;
  readonly executionId?: ExecutionId;
  readonly coordinators?: RunCoordinators;
  /** Current model short name for this run (e.g. "opus46T"). */
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
  /** Tools unavailable because the current host/runtime cannot support them. */
  readonly runtimeUnavailableTools?: readonly string[];
  /** Whether this run should stop after one tool-use cycle instead of idling. */
  readonly stopAfterCycle?: boolean;
  /**
   * The session that owns this run's coordination state (interrupts,
   * executions, coordinators, subscriptions). Run-scoped code resolves it via
   * `currentSession()` (`tryUseRunContext()?.session ?? defaultSession`);
   * when omitted the default session — which wraps the process singletons by
   * identity — is used, so reads are byte-identical to direct singleton access.
   */
  readonly session?: SessionHandle;
}

export interface CreateRunContextOptions {
  runtimeHost: AgentRuntimeHost;
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  coordinators?: RunCoordinators;
  /** Static model fallback for manually-created run contexts. */
  model?: string;
  /** Live model provider for contexts backed by mutable launch state. */
  getModel?: () => string | undefined;
  agentName?: string;
  workingDirectory?: string;
  delegationDepth?: number;
  approvalPromptsUnavailable?: boolean;
  runtimeUnavailableTools?: readonly string[];
  stopAfterCycle?: boolean;
  session?: SessionHandle;
}

const runContextScope = new AsyncLocalStorage<RunContext>();

export function createRunContext(options: CreateRunContextOptions): RunContext {
  if (options.runtimeHost == null) {
    throw new Error('createRunContext requires an explicit runtimeHost');
  }

  const { getModel, model } = options;

  return Object.freeze<RunContext>({
    runtimeHost: options.runtimeHost,
    streamId: options.streamId,
    executionId: options.executionId,
    coordinators: options.coordinators,
    get model() {
      return getModel?.() ?? model;
    },
    agentName: options.agentName,
    workingDirectory: options.workingDirectory,
    delegationDepth: options.delegationDepth,
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
    stopAfterCycle: options.stopAfterCycle,
    session: options.session,
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
