import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

import { ExecutionIdSchema, StreamTabIdSchema } from '@shared/schemas';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

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

// ---------------------------------------------------------------------------
// Zod schemas for runtime objects (z.custom — these are live instances, not
// serializable data, so the validation predicate only guards against nullish)
// ---------------------------------------------------------------------------

const AgentRuntimeHostSchema = z.custom<AgentRuntimeHost>(
  (val): val is AgentRuntimeHost =>
    val != null &&
    typeof val === 'object' &&
    typeof (val as AgentRuntimeHost).emit === 'function',
);

const RunCoordinatorsSchema = z.custom<RunCoordinators>(
  (val): val is RunCoordinators => val != null && typeof val === 'object',
);

const SessionHandleSchema = z.custom<SessionHandle>(
  (val): val is SessionHandle => val != null && typeof val === 'object',
);

// ---------------------------------------------------------------------------
// Shared optional fields (present in both variants)
// ---------------------------------------------------------------------------

const sharedOptionalFields = {
  workingDirectory: z.string().optional(),
  delegationDepth: z.int().nonnegative().optional(),
  approvalPromptsUnavailable: z.boolean().optional(),
  runtimeUnavailableTools: z.array(z.string()).optional(),
  stopAfterCycle: z.boolean().optional(),
};

// ---------------------------------------------------------------------------
// Discriminated union schema
//
// 'launch' — projected from AgentLaunchContext; all run-identifying fields
//           are guaranteed present.
// 'bare'   — manually constructed (tests, one-shot tool environments, etc.);
//           only runtimeHost is required.
// ---------------------------------------------------------------------------

export const RunContextSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('launch'),
    runtimeHost: AgentRuntimeHostSchema,
    streamId: StreamTabIdSchema,
    executionId: ExecutionIdSchema,
    coordinators: RunCoordinatorsSchema,
    /** Current model short name resolved from a live getter (see createRunContext). */
    model: z.string().optional(),
    /** Agent name (e.g. "orchestrator", "search-agent"). */
    agentName: z.string(),
    /** Session that owns this run's coordination state. */
    session: SessionHandleSchema,
    ...sharedOptionalFields,
  }),
  z.object({
    kind: z.literal('bare'),
    runtimeHost: AgentRuntimeHostSchema,
    streamId: StreamTabIdSchema.optional(),
    executionId: ExecutionIdSchema.optional(),
    coordinators: RunCoordinatorsSchema.optional(),
    /** Current model short name for this run (e.g. "opus46T"). */
    model: z.string().optional(),
    /** Agent name (e.g. "orchestrator", "search-agent"). */
    agentName: z.string().optional(),
    /** Session that owns this run's coordination state. */
    session: SessionHandleSchema.optional(),
    ...sharedOptionalFields,
  }),
]);

/** RunContext discriminated union — derived from the Zod schema. */
export type RunContext = z.infer<typeof RunContextSchema>;

/** The launch variant: all run-identifying fields are required. */
export type LaunchRunContext = z.infer<typeof RunContextSchema> & {
  kind: 'launch';
};

/** The bare variant: only runtimeHost is required. */
export type BareRunContext = z.infer<typeof RunContextSchema> & {
  kind: 'bare';
};

// ---------------------------------------------------------------------------
// CreateRunContextOptions — the input side.  Uses a discriminated union so
// the model source is explicit: either a live getter (launch path) or a
// static string (manual / test path).
// ---------------------------------------------------------------------------

export interface CreateRunContextBase {
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
}

export type CreateRunContextOptions = CreateRunContextBase &
  (
    | {
        /** Discriminator — live model provider (launch contexts). */
        modelSource: 'live';
        getModel: () => string | undefined;
        /** Static fallback used when getModel() returns undefined. */
        model?: string;
      }
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

export function createRunContext(options: CreateRunContextOptions): RunContext {
  if (options.runtimeHost == null) {
    throw new Error('createRunContext requires an explicit runtimeHost');
  }

  const kind: RunContext['kind'] =
    options.modelSource === 'live' ? 'launch' : 'bare';

  const { getModel, model } =
    options.modelSource === 'live'
      ? { getModel: options.getModel, model: options.model }
      : {
          getModel: undefined as (() => string | undefined) | undefined,
          model: options.model,
        };

  const base = Object.freeze({
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

  return Object.freeze({ kind, ...base }) as unknown as RunContext;
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
