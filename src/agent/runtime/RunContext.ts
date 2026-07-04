import { AsyncLocalStorage } from 'node:async_hooks';

import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { ToolEditApprovalPort } from '@platform/interfaces/toolEditApproval';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { AgentProposalCoordinator } from './AgentProposalCoordinator';
import type { PlanApprovalCoordinator } from './PlanApprovalCoordinator';
import type { RetryRequestCoordinatorImpl } from './RetryRequestCoordinator';
import type { SessionHandle } from './SessionHandle';

export interface RunCoordinators {
  readonly plan: PlanApprovalCoordinator;
  readonly proposal: AgentProposalCoordinator;
  readonly retry: RetryRequestCoordinatorImpl;
}

interface RunContextCommon {
  readonly runtimeHost: AgentRuntimeHost;
  /** Current model short name for this run (e.g. "opus46T"). */
  readonly model?: string;
  readonly workingDirectory?: string;
  readonly delegationDepth?: number;
  readonly approvalPromptsUnavailable?: boolean;
  readonly runtimeUnavailableTools?: readonly string[];
  readonly stopAfterCycle?: boolean;
  /**
   * Per-run override for the host's tool-edit approval UI. Takes priority over
   * `platform().toolEditApproval` when present — hosts that manage more than
   * one concurrent session per process (e.g. desktop's one window per
   * `DesktopAgentExecution`) thread their session-scoped handler here instead
   * of relying on the frozen, process-wide Platform port, which only ever
   * holds one active handler at a time.
   */
  readonly toolEditApprovalHandler?: ToolEditApprovalPort;
}

export interface LaunchRunContext extends RunContextCommon {
  readonly kind: 'launch';
  readonly streamId: StreamTabId;
  readonly executionId: ExecutionId;
  readonly coordinators: RunCoordinators;
  /** Agent name (e.g. "orchestrator", "search-agent"). */
  readonly agentName: string;
  /** Session that owns this run's coordination state. */
  readonly session: SessionHandle;
}

interface BareRunContext extends RunContextCommon {
  readonly kind: 'bare';
  readonly streamId?: StreamTabId;
  readonly executionId?: ExecutionId;
  readonly coordinators?: RunCoordinators;
  /** Agent name (e.g. "orchestrator", "search-agent"). */
  readonly agentName?: string;
  /** Session that owns this run's coordination state. */
  readonly session?: SessionHandle;
}

/**
 * Per-run ambient context.
 *
 * The `launch` variant is projected from AgentLaunchContext and guarantees the
 * run-identifying fields. The `bare` variant is for manually constructed test
 * and one-shot tool contexts where only a runtime host is required.
 */
export type RunContext = LaunchRunContext | BareRunContext;

// ---------------------------------------------------------------------------
// CreateRunContextOptions — the input side.  Uses a discriminated union so
// the model source is explicit: either a live getter (launch path) or a
// static string (manual / test path).
// ---------------------------------------------------------------------------

interface CreateRunContextBase {
  runtimeHost: AgentRuntimeHost;
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  coordinators?: RunCoordinators;
  agentName?: string;
  workingDirectory?: string;
  delegationDepth?: number;
  approvalPromptsUnavailable?: boolean;
  runtimeUnavailableTools?: readonly string[];
  stopAfterCycle?: boolean;
  session?: SessionHandle;
  toolEditApprovalHandler?: ToolEditApprovalPort;
}

type CreateLaunchRunContextFields = Required<
  Pick<
    CreateRunContextBase,
    'streamId' | 'executionId' | 'coordinators' | 'agentName' | 'session'
  >
>;

export type CreateRunContextOptions = CreateRunContextBase &
  (
    | (CreateLaunchRunContextFields & {
        /** Discriminator — live model provider (launch contexts). */
        modelSource: 'live';
        getModel: () => string | undefined;
        /** Static fallback used when getModel() returns undefined. */
        model?: string;
      })
    | {
        /** Discriminator — static model string (manual / test contexts). */
        modelSource?: 'static';
        model?: string;
      }
  );

const runContextScope = new AsyncLocalStorage<RunContext>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a run context from caller-facing model-source options.
 *
 * The input discriminator describes how the model value is read:
 * `modelSource: 'live'` produces a `launch` context with full run identity and
 * a live model getter, while the default `static` path produces a `bare`
 * context for tests and one-shot tool environments.
 */
export function createRunContext(options: CreateRunContextOptions): RunContext {
  if (options.runtimeHost == null) {
    throw new Error('createRunContext requires an explicit runtimeHost');
  }

  const common = {
    runtimeHost: options.runtimeHost,
    streamId: options.streamId,
    executionId: options.executionId,
    coordinators: options.coordinators,
    agentName: options.agentName,
    workingDirectory: options.workingDirectory,
    delegationDepth: options.delegationDepth,
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
    stopAfterCycle: options.stopAfterCycle,
    session: options.session,
    toolEditApprovalHandler: options.toolEditApprovalHandler,
  };

  if (options.modelSource === 'live') {
    const { getModel, model, streamId, executionId, coordinators, agentName, session } = options;
    return Object.freeze({
      kind: 'launch',
      ...common,
      // Re-assert the narrowed (required) fields: `common` was built from the
      // pre-narrowing union type, so its copies of these fields are typed as
      // optional even though `options` here guarantees them present.
      streamId,
      executionId,
      coordinators,
      agentName,
      session,
      get model() {
        return getModel() ?? model;
      },
    });
  }

  const { model } = options;
  return Object.freeze({
    kind: 'bare',
    ...common,
    get model() {
      return model;
    },
  });
}

// ---------------------------------------------------------------------------
// ALS helpers
// ---------------------------------------------------------------------------

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

/**
 * Return the active run context, asserting it is a `launch` context (i.e.
 * `streamId`/`executionId`/`runtimeHost` are guaranteed present).
 *
 * Flow nodes only ever execute inside `withExecutionRunContext` (in
 * `AgentLaunchContext.ts`), which always projects a `launch` context — the
 * `bare` variant of `createRunContext` is exclusively for manually
 * constructed test/one-shot tool contexts. Use this instead of re-deriving
 * these fields on the flow-service bag.
 */
export function useLaunchRunContext(): LaunchRunContext {
  const context = useRunContext();
  if (context.kind !== 'launch') {
    throw new Error('useLaunchRunContext() called outside a launch RunContext');
  }
  return context;
}
