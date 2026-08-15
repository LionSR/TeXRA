import { AsyncLocalStorage } from 'node:async_hooks';

import type { ExecutionId, StreamTabId } from '@shared/schemas';
import type { RunScope } from './RunScope';

import type { SessionHostInteractions } from './HostInteractions';
import type { ModelCell } from './ModelCell';
import type { SessionHandle } from './SessionHandle';

interface RunContextCommon {
  /**
   * Current model short name for this run (e.g. "opus46T"), read through the
   * run's model cell so a mid-run swap is visible to every reader.
   */
  readonly model?: string;
  readonly approvalPromptsUnavailable?: boolean;
  readonly onApprovalPolicyDenial?: () => void;
  readonly runtimeUnavailableTools?: readonly string[];
  readonly stopAfterCycle?: boolean;
}

export interface LaunchRunContext extends RunContextCommon {
  readonly kind: 'launch';
  readonly runScope: RunScope;
}

type BareRunIdentity = Partial<
  Pick<
    RunScope,
    'streamId' | 'executionId' | 'agentName' | 'workingDirectory' | 'session'
  >
>;

interface BareRunContext extends RunContextCommon, BareRunIdentity {
  readonly kind: 'bare';
}

/**
 * Per-run ambient context.
 *
 * The `launch` variant is projected from AgentLaunchContext and guarantees the
 * run-identifying fields. The `bare` variant is for manually constructed test
 * and one-shot tool contexts whose available run fields are explicitly
 * supplied.
 */
export type RunContext = LaunchRunContext | BareRunContext;

// ---------------------------------------------------------------------------
// CreateRunContextOptions — the input side.  `runScope` discriminates: launch
// contexts carry the run's scope, bare contexts name their run fields directly.
// ---------------------------------------------------------------------------

interface CreateRunContextCommon {
  /**
   * The run's model channel, held as a pointer rather than copied: a launch
   * context passes the run's live {@link ModelCell}, a manually built one
   * passes a frozen one-shot cell.
   */
  modelCell?: Pick<ModelCell, 'modelId'>;
  approvalPromptsUnavailable?: boolean;
  onApprovalPolicyDenial?: () => void;
  runtimeUnavailableTools?: readonly string[];
  stopAfterCycle?: boolean;
}

interface CreateBareRunContextOptions
  extends CreateRunContextCommon, BareRunIdentity {
  runScope?: undefined;
}

interface CreateLaunchRunContextOptions extends CreateRunContextCommon {
  runScope: RunScope;
}

export type CreateRunContextOptions =
  CreateLaunchRunContextOptions | CreateBareRunContextOptions;

const runContextScope = new AsyncLocalStorage<RunContext>();

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type CommonRunContextFieldNames =
  | 'approvalPromptsUnavailable'
  | 'onApprovalPolicyDenial'
  | 'runtimeUnavailableTools'
  | 'stopAfterCycle';

/**
 * Fields shared by both `RunContext` kinds, forwarded as-is from the input
 * options.
 */
function commonRunContextFields<T extends CreateRunContextCommon>(
  options: T,
): Pick<T, CommonRunContextFieldNames> {
  return {
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    onApprovalPolicyDenial: options.onApprovalPolicyDenial,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
    stopAfterCycle: options.stopAfterCycle,
  } satisfies Pick<T, CommonRunContextFieldNames>;
}

/**
 * Build a run context.
 *
 * A `runScope` produces a `launch` context with full run identity; without one
 * the result is a `bare` context for tests and one-shot tool environments.
 * Both read `model` off the supplied cell, so the model a reader sees is the
 * one the cell holds at read time.
 */
export function createRunContext(options: CreateRunContextOptions): RunContext {
  const { modelCell } = options;
  if (options.runScope) {
    return Object.freeze({
      kind: 'launch',
      ...commonRunContextFields(options),
      runScope: options.runScope,
      get model() {
        return modelCell?.modelId;
      },
    });
  }

  return Object.freeze({
    kind: 'bare',
    ...commonRunContextFields(options),
    streamId: options.streamId,
    executionId: options.executionId,
    agentName: options.agentName,
    workingDirectory: options.workingDirectory,
    session: options.session,
    get model() {
      return modelCell?.modelId;
    },
  } satisfies BareRunContext);
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
 * Read a field shared by `RunScope` and `BareRunContext`, dispatching on
 * context kind — `launch` contexts read through `runScope`, `bare` contexts
 * read the field directly.
 */
function getRunContextField<K extends keyof RunScope & keyof BareRunContext>(
  field: K,
  context: RunContext | undefined,
): RunScope[K] | BareRunContext[K] | undefined {
  return context?.kind === 'launch'
    ? context.runScope[field]
    : context?.[field];
}

/** Return the session's host interactions for a context, reading launch contexts through RunScope. */
export function getRunContextInteractions(
  context: RunContext | undefined = tryUseRunContext(),
): SessionHostInteractions | undefined {
  return getRunContextSession(context)?.interactions;
}

/** Return the stream id for a context, reading launch contexts through RunScope. */
export function getRunContextStreamId(
  context: RunContext | undefined = tryUseRunContext(),
): StreamTabId | undefined {
  return getRunContextField('streamId', context);
}

/** Return the execution id for a context, reading launch contexts through RunScope. */
export function getRunContextExecutionId(
  context: RunContext | undefined = tryUseRunContext(),
): ExecutionId | undefined {
  return getRunContextField('executionId', context);
}

/** Return the agent name for a context, reading launch contexts through RunScope. */
export function getRunContextAgentName(
  context: RunContext | undefined = tryUseRunContext(),
): string | undefined {
  return getRunContextField('agentName', context);
}

/** Return the working directory for a context, reading launch contexts through RunScope. */
export function getRunContextWorkingDirectory(
  context: RunContext | undefined = tryUseRunContext(),
): string | undefined {
  return getRunContextField('workingDirectory', context);
}

/** Return the owner session for a context, reading launch contexts through RunScope. */
export function getRunContextSession(
  context: RunContext | undefined = tryUseRunContext(),
): SessionHandle | undefined {
  return getRunContextField('session', context);
}
