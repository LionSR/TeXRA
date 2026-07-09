import { AsyncLocalStorage } from 'node:async_hooks';

import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { createRunScope, type RunScope } from './RunScope';

import type { AgentRuntimeHost } from './AgentRuntimeHost';
import type { SessionHandle } from './SessionHandle';

interface RunContextCommon {
  /** Current model short name for this run (e.g. "opus46T"). */
  readonly model?: string;
  readonly delegationDepth?: number;
  readonly approvalPromptsUnavailable?: boolean;
  readonly runtimeUnavailableTools?: readonly string[];
  readonly stopAfterCycle?: boolean;
}

export interface LaunchRunContext extends RunContextCommon {
  readonly kind: 'launch';
  readonly runScope: RunScope;
}

interface BareRunContext extends RunContextCommon {
  readonly kind: 'bare';
  readonly runtimeHost: AgentRuntimeHost;
  readonly streamId?: StreamTabId;
  readonly executionId?: ExecutionId;
  /** Agent name (e.g. "orchestrator", "search-agent"). */
  readonly agentName?: string;
  readonly workingDirectory?: string;
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
  runScope?: RunScope;
  streamId?: StreamTabId;
  executionId?: ExecutionId;
  agentName?: string;
  workingDirectory?: string;
  delegationDepth?: number;
  approvalPromptsUnavailable?: boolean;
  runtimeUnavailableTools?: readonly string[];
  stopAfterCycle?: boolean;
  session?: SessionHandle;
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
  | 'delegationDepth'
  | 'approvalPromptsUnavailable'
  | 'runtimeUnavailableTools'
  | 'stopAfterCycle';

type BareRunContextFieldNames =
  | CommonRunContextFieldNames
  | 'runtimeHost'
  | 'streamId'
  | 'executionId'
  | 'agentName'
  | 'workingDirectory'
  | 'session';

/**
 * Fields shared by both `RunContext` kinds, forwarded as-is from the input
 * options.
 */
function commonRunContextFields<T extends CreateRunContextBase>(
  options: T,
): Pick<T, CommonRunContextFieldNames> {
  return {
    delegationDepth: options.delegationDepth,
    approvalPromptsUnavailable: options.approvalPromptsUnavailable,
    runtimeUnavailableTools: options.runtimeUnavailableTools,
    stopAfterCycle: options.stopAfterCycle,
  } as Pick<T, CommonRunContextFieldNames>;
}

/** Fields used only by the manually constructed `bare` context shape. */
function bareRunContextFields<T extends CreateRunContextBase>(
  options: T,
): Pick<T, BareRunContextFieldNames> {
  return {
    ...commonRunContextFields(options),
    runtimeHost: options.runtimeHost,
    streamId: options.streamId,
    executionId: options.executionId,
    agentName: options.agentName,
    workingDirectory: options.workingDirectory,
    session: options.session,
  } as Pick<T, BareRunContextFieldNames>;
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
    const runScope =
      options.runScope ??
      createRunScope({
        runtimeHost: options.runtimeHost,
        streamId: options.streamId,
        executionId: options.executionId,
        agentName: options.agentName,
        workingDirectory: options.workingDirectory,
        session: options.session,
      });
    return Object.freeze({
      kind: 'launch',
      ...commonRunContextFields(options),
      runScope,
      get model() {
        return getModel() ?? model;
      },
    });
  }

  const { model } = options;
  return Object.freeze({
    kind: 'bare',
    ...bareRunContextFields(options),
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

/** Return the runtime host for a context, reading launch contexts through RunScope. */
export function getRunContextRuntimeHost(
  context: RunContext | undefined = tryUseRunContext(),
): AgentRuntimeHost | undefined {
  return context?.kind === 'launch'
    ? context.runScope.runtimeHost
    : context?.runtimeHost;
}

/** Return the stream id for a context, reading launch contexts through RunScope. */
export function getRunContextStreamId(
  context: RunContext | undefined = tryUseRunContext(),
): StreamTabId | undefined {
  return context?.kind === 'launch'
    ? context.runScope.streamId
    : context?.streamId;
}

/** Return the execution id for a context, reading launch contexts through RunScope. */
export function getRunContextExecutionId(
  context: RunContext | undefined = tryUseRunContext(),
): ExecutionId | undefined {
  return context?.kind === 'launch'
    ? context.runScope.executionId
    : context?.executionId;
}

/** Return the agent name for a context, reading launch contexts through RunScope. */
export function getRunContextAgentName(
  context: RunContext | undefined = tryUseRunContext(),
): string | undefined {
  return context?.kind === 'launch'
    ? context.runScope.agentName
    : context?.agentName;
}

/** Return the working directory for a context, reading launch contexts through RunScope. */
export function getRunContextWorkingDirectory(
  context: RunContext | undefined = tryUseRunContext(),
): string | undefined {
  return context?.kind === 'launch'
    ? context.runScope.workingDirectory
    : context?.workingDirectory;
}

/** Return the owner session for a context, reading launch contexts through RunScope. */
export function getRunContextSession(
  context: RunContext | undefined = tryUseRunContext(),
): SessionHandle | undefined {
  return context?.kind === 'launch'
    ? context.runScope.session
    : context?.session;
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
