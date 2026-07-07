import { AsyncLocalStorage } from 'node:async_hooks';

import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { ToolEditApprovalPort } from '@platform/interfaces/toolEditApproval';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionHandle } from './SessionHandle';

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
  /** Agent name (e.g. "orchestrator", "search-agent"). */
  readonly agentName: string;
  /** Session that owns this run's coordination state. */
  readonly session: SessionHandle;
}

interface BareRunContext extends RunContextCommon {
  readonly kind: 'bare';
  readonly streamId?: StreamTabId;
  readonly executionId?: ExecutionId;
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
    'streamId' | 'executionId' | 'agentName' | 'session'
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

type CommonRunContextFieldNames =
  | 'runtimeHost'
  | 'streamId'
  | 'executionId'
  | 'agentName'
  | 'workingDirectory'
  | 'delegationDepth'
  | 'approvalPromptsUnavailable'
  | 'runtimeUnavailableTools'
  | 'stopAfterCycle'
  | 'session'
  | 'toolEditApprovalHandler';

/**
 * Fields shared by both `RunContext` kinds, forwarded as-is from the input
 * options. The return type is `Pick<T, ...>` (rather than inferred from the
 * function body) so the `live` branch's `CreateLaunchRunContextFields`
 * guarantees — e.g. a required `streamId` — survive the call instead of
 * widening back to the optional `bare` shape.
 */
function commonRunContextFields<T extends CreateRunContextBase>(
  options: T,
): Pick<T, CommonRunContextFieldNames> {
  return {
    runtimeHost: options.runtimeHost,
    streamId: options.streamId,
    executionId: options.executionId,
    agentName: options.agentName,
    workingDirectory: options.workingDirectory,
    delegationDepth: options.delegationDepth,
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
    stopAfterCycle: options.stopAfterCycle,
    session: options.session,
    toolEditApprovalHandler: options.toolEditApprovalHandler,
  } as Pick<T, CommonRunContextFieldNames>;
}

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

  if (options.modelSource === 'live') {
    const { getModel, model } = options;
    return Object.freeze({
      kind: 'launch',
      ...commonRunContextFields(options),
      get model() {
        return getModel() ?? model;
      },
    });
  }

  const { model } = options;
  return Object.freeze({
    kind: 'bare',
    ...commonRunContextFields(options),
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
