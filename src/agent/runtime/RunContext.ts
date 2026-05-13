// Third-party imports
import { AsyncLocalStorage } from 'async_hooks';

// Local imports - shared schemas
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { NestedDelegationConfig } from '@shared/constants/delegationPolicy';

// Local imports - runtime
import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { AgentProposalCoordinator } from './AgentProposalCoordinator';
import type { PlanApprovalCoordinator } from './PlanApprovalCoordinator';
import type { RetryRequestCoordinatorImpl } from './RetryRequestCoordinator';

export type RunLogData = Record<string, unknown>;

export interface RunLogger {
  debug(message: string, data?: RunLogData): void;
  info(message: string, data?: RunLogData): void;
  warn(message: string, data?: RunLogData): void;
  error(message: string, data?: RunLogData): void;
}

export type ApprovalHandler<TRequest = unknown, TResult = unknown> = (
  request: TRequest,
) => Promise<TResult> | TResult;

export interface ApprovalHandlers {
  agentProposal?: ApprovalHandler;
  bash?: ApprovalHandler;
  plan?: ApprovalHandler;
  toolEdit?: ApprovalHandler;
}

export interface RunCoordinators {
  readonly plan: PlanApprovalCoordinator;
  readonly proposal: AgentProposalCoordinator;
  readonly retry: RetryRequestCoordinatorImpl;
}

/**
 * Run-owned facts needed while executing tool calls.
 *
 * The active tool-call frame may still carry these fields during migration, but
 * RunContext is the durable owner. Per-call mutable state such as tracker,
 * todo, plan, and streaming callbacks belongs to ToolCallContext.
 */
export interface ToolRunContext {
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  /** Model short name of the parent agent (e.g. "opus46T", "sonnet46T"). */
  model?: string;
  /** Agent name of the parent agent (e.g. "orchestrator", "search-agent"). */
  agentName?: string;
  /** Working directory override for tool calls (e.g. a git worktree path). */
  workingDirectory?: string;
  /** Runtime host inherited from the executing agent. */
  runtimeHost?: AgentRuntimeHost;
  /**
   * Delegation depth of the agent executing this tool call. 0 for root
   * (user-initiated), N for an agent N levels deep. Read by delegation tools
   * to compute the child's depth.
   */
  delegationDepth?: number;
  /**
   * Delegation policy snapshot for the executing agent. Keeps delegation tool
   * enforcement aligned with the tool list shown to the model without carrying
   * a second depth value.
   */
  delegationConfig?: NestedDelegationConfig;
}

export interface RunContext {
  readonly runtimeHost: AgentRuntimeHost;
  readonly streamId?: StreamTabId;
  readonly executionId?: ExecutionId;
  readonly logger: RunLogger;
  readonly approvals: ApprovalHandlers;
  readonly coordinators?: RunCoordinators;
  readonly toolRunContext?: ToolRunContext;
}

export interface CreateRunContextOptions {
  runtimeHost: AgentRuntimeHost;
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  logger?: Partial<RunLogger>;
  approvals?: ApprovalHandlers;
  coordinators?: RunCoordinators;
  toolRunContext?: ToolRunContext;
}

const noopLog = (): void => undefined;
const runContextScope = new AsyncLocalStorage<RunContext>();

export function createRunContext(options: CreateRunContextOptions): RunContext {
  if (options.runtimeHost == null) {
    throw new Error('createRunContext requires an explicit runtimeHost');
  }

  const { logger, approvals } = options;

  return Object.freeze({
    runtimeHost: options.runtimeHost,
    streamId: options.streamId,
    executionId: options.executionId,
    logger: Object.freeze({
      debug: logger?.debug ?? noopLog,
      info: logger?.info ?? noopLog,
      warn: logger?.warn ?? noopLog,
      error: logger?.error ?? noopLog,
    }),
    approvals: Object.freeze({ ...approvals }),
    coordinators: options.coordinators,
    toolRunContext: options.toolRunContext
      ? Object.freeze({ ...options.toolRunContext })
      : undefined,
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

export function resolveRunRuntimeHost(
  explicitHost?: AgentRuntimeHost,
): AgentRuntimeHost {
  return explicitHost ?? useRunContext().runtimeHost;
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
