import { z } from 'zod';

import { ExecutionIdSchema, StreamTabIdSchema } from './identifiers';

export const WORKFLOW_EXECUTION_LIFECYCLE = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
} as const;
const WorkflowExecutionLifecycleSchema = z.enum(WORKFLOW_EXECUTION_LIFECYCLE);
type WorkflowExecutionLifecycle = z.infer<
  typeof WorkflowExecutionLifecycleSchema
>;

export const WORKFLOW_CALL_STATUS = {
  PLANNED: 'planned',
  STAGE_BLOCKED: 'stageBlocked',
  /** Issued, held for the user's per-call or per-phase review before queueing. */
  AWAITING_APPROVAL: 'awaitingApproval',
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  CACHED: 'cached',
} as const;
const WorkflowExecutionCallStatusSchema = z.enum(WORKFLOW_CALL_STATUS);
type WorkflowExecutionCallStatus = z.infer<
  typeof WorkflowExecutionCallStatusSchema
>;

/**
 * What an interactive control request does to the workflow-script `agent()`
 * attempt it targets: `skip` resolves the call without journaling it (its
 * result is the engine's skipped sentinel), `retry` discards the attempt and
 * re-runs the call as a fresh one whose result the call resolves with.
 *
 * One vocabulary for both sides — the engine that acts on a request and the
 * host UI that offers it — so a control a host can name is always a control
 * the engine implements.
 */
export type WorkflowControlAction = 'skip' | 'retry';

const WorkflowExecutionTimestampsSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});
const WorkflowExecutionStageSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  order: z.int().nonnegative(),
  lifecycle: WorkflowExecutionLifecycleSchema,
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
});
const WorkflowExecutionAttemptSchema = z.strictObject({
  number: z.int().positive(),
  id: ExecutionIdSchema.optional(),
  childStreamId: StreamTabIdSchema.optional(),
  model: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});
export const WORKFLOW_CALL_KIND = {
  /** Whole-document workflow-agent run: file inputs in, edited files out. */
  DOCUMENT: 'document',
  /** Tool-use run that finishes by submitting a schema-validated value. */
  STRUCTURED: 'structured',
} as const;
const WorkflowCallKindSchema = z.enum(WORKFLOW_CALL_KIND);
export type WorkflowCallKind = z.infer<typeof WorkflowCallKindSchema>;

/** File basenames one issued call was handed, by workflow-agent role. */
export const WorkflowCallFilesSchema = z.strictObject({
  input: z.array(z.string()),
  context: z.array(z.string()),
  media: z.array(z.string()),
});

const WorkflowExecutionCallShape = z.strictObject({
  id: z.string().min(1),
  label: z.string(),
  stageId: z.string().min(1).optional(),
  /**
   * Set the moment the script actually issues `agent()` for this call. A
   * call without it is a `meta.tasks` plan label the run has not reached —
   * first-class, so no consumer infers "declared only" from empty files or
   * an absent agent (both also true of a structured call).
   */
  issued: z.literal(true).optional(),
  /** Result contract of the call; absent until the call is issued. */
  kind: WorkflowCallKindSchema.optional(),
  agent: z.string().optional(),
  /** Declared by the script at issue time, then the host-resolved model. */
  model: z.string().optional(),
  files: WorkflowCallFilesSchema,
  childExecutionId: ExecutionIdSchema.optional(),
  childStreamId: StreamTabIdSchema.optional(),
  attempts: z.array(WorkflowExecutionAttemptSchema),
  status: WorkflowExecutionCallStatusSchema,
  /**
   * The terminal sweep (`finish()`) assigned this call's outcome because the
   * run ended while the call had not settled itself — not-reached plans and
   * abandoned live calls. First-class so consumers never infer "swept" from
   * the human-facing note strings. Absent means the call settled through its
   * own path.
   */
  settledBySweep: z.literal(true).optional(),
  error: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  timestamps: WorkflowExecutionTimestampsSchema,
});
/**
 * Shapes an older build persisted, normalized here ahead of the strict shape
 * so a `meta.json` snapshot of an interrupted run `hydrate()` must still
 * recover keeps parsing instead of failing strictObject's unrecognized-key
 * check. Dropped keys: `stageTitle` (a denormalized duplicate of the
 * referenced stage's title — resolve it with `stageTitleFor`), `blockedReason`
 * (derivable from `status`, the stage, and `settledBySweep`), and
 * `timestamps.queuedAt` (never read). Dropped value: the transient `starting`
 * call status, folded into `running`.
 */
const WorkflowExecutionCallSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const {
    stageTitle: _stageTitle,
    blockedReason: _blockedReason,
    timestamps,
    ...rest
  } = value as Record<string, unknown>;
  if (rest.status === 'starting') rest.status = WORKFLOW_CALL_STATUS.RUNNING;
  if (!timestamps || typeof timestamps !== 'object') {
    return { ...rest, timestamps };
  }
  const { queuedAt: _queuedAt, ...keptTimestamps } = timestamps as Record<
    string,
    unknown
  >;
  return { ...rest, timestamps: keptTimestamps };
}, WorkflowExecutionCallShape);
export type WorkflowExecutionCall = z.infer<typeof WorkflowExecutionCallSchema>;

type WorkflowExecutionCounts = Record<WorkflowExecutionCallStatus, number> & {
  readonly total: number;
  readonly waiting: number;
};

/**
 * The one owner of "how many calls are in each state". Derived from the calls
 * themselves at the read boundary rather than stored beside them, so a tally
 * can never disagree with the array it summarizes. `waiting` is the composite
 * every consumer asks for: planned plus stage-blocked.
 */
export function deriveWorkflowCounts(
  calls: readonly Pick<WorkflowExecutionCall, 'status'>[],
): WorkflowExecutionCounts {
  const byStatus = Object.fromEntries(
    Object.values(WORKFLOW_CALL_STATUS).map((status) => [status, 0]),
  ) as Record<WorkflowExecutionCallStatus, number>;
  for (const call of calls) byStatus[call.status] += 1;
  return {
    total: calls.length,
    waiting:
      byStatus.planned + byStatus.stageBlocked + byStatus.awaitingApproval,
    ...byStatus,
  };
}

/**
 * A call's stage title, resolved from `stageId` against the snapshot's own
 * stages — the one owner, so a call can never carry a stage name that
 * disagrees with the stage it points at.
 */
export function stageTitleFor(
  snapshot: Pick<WorkflowExecutionSnapshot, 'stages'>,
  call: Pick<WorkflowExecutionCall, 'stageId'>,
): string | undefined {
  return snapshot.stages.find((stage) => stage.id === call.stageId)?.title;
}

export const TERMINAL_WORKFLOW_CALL_STATUSES: ReadonlySet<WorkflowExecutionCallStatus> =
  new Set([
    WORKFLOW_CALL_STATUS.COMPLETED,
    WORKFLOW_CALL_STATUS.FAILED,
    WORKFLOW_CALL_STATUS.CANCELLED,
    WORKFLOW_CALL_STATUS.SKIPPED,
    WORKFLOW_CALL_STATUS.CACHED,
  ]);
const TERMINAL_LIFECYCLES = new Set<WorkflowExecutionLifecycle>([
  WORKFLOW_EXECUTION_LIFECYCLE.COMPLETED,
  WORKFLOW_EXECUTION_LIFECYCLE.FAILED,
  WORKFLOW_EXECUTION_LIFECYCLE.SKIPPED,
  WORKFLOW_EXECUTION_LIFECYCLE.CANCELLED,
]);

export const WorkflowExecutionSnapshotSchema = z
  .strictObject({
    lifecycle: WorkflowExecutionLifecycleSchema,
    currentStageId: z.string().min(1).optional(),
    stages: z.array(WorkflowExecutionStageSchema),
    calls: z.array(WorkflowExecutionCallSchema),
    error: z.string().optional(),
    timestamps: z.strictObject({
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
      completedAt: z.iso.datetime().optional(),
    }),
  })
  .superRefine((snapshot, context) => {
    const stageIds = new Set<string>();
    const stageOrders = new Set<number>();
    const activeStages = snapshot.stages.filter(
      (stage) => stage.lifecycle === WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE,
    );
    if (activeStages.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'A workflow snapshot can have at most one active stage.',
      });
    }
    for (const [index, stage] of snapshot.stages.entries()) {
      if (stageIds.has(stage.id))
        context.addIssue({
          code: 'custom',
          path: ['stages', index, 'id'],
          message: `Duplicate workflow stage id "${stage.id}".`,
        });
      if (stageOrders.has(stage.order))
        context.addIssue({
          code: 'custom',
          path: ['stages', index, 'order'],
          message: `Duplicate workflow stage order ${stage.order}.`,
        });
      if (
        stage.lifecycle !== WORKFLOW_EXECUTION_LIFECYCLE.WAITING &&
        stage.lifecycle !== WORKFLOW_EXECUTION_LIFECYCLE.ACTIVE &&
        stage.completedAt === undefined
      ) {
        context.addIssue({
          code: 'custom',
          path: ['stages', index, 'completedAt'],
          message: 'A terminal workflow stage requires completedAt.',
        });
      }
      stageIds.add(stage.id);
      stageOrders.add(stage.order);
    }
    if (snapshot.currentStageId !== activeStages[0]?.id) {
      context.addIssue({
        code: 'custom',
        path: ['currentStageId'],
        message: 'currentStageId must identify the one active workflow stage.',
      });
    }

    const callIds = new Set<string>();
    for (const [index, call] of snapshot.calls.entries()) {
      if (callIds.has(call.id))
        context.addIssue({
          code: 'custom',
          path: ['calls', index, 'id'],
          message: `Duplicate workflow call id "${call.id}".`,
        });
      callIds.add(call.id);
      if (call.stageId !== undefined && !stageIds.has(call.stageId)) {
        context.addIssue({
          code: 'custom',
          path: ['calls', index, 'stageId'],
          message: 'A workflow call stage must reference a matching stage.',
        });
      }
      for (const [attemptIndex, attempt] of call.attempts.entries()) {
        if (attempt.number !== attemptIndex + 1)
          context.addIssue({
            code: 'custom',
            path: ['calls', index, 'attempts', attemptIndex, 'number'],
            message: 'Workflow attempt numbers must be contiguous from 1.',
          });
        if (
          attemptIndex < call.attempts.length - 1 &&
          attempt.completedAt === undefined
        )
          context.addIssue({
            code: 'custom',
            path: ['calls', index, 'attempts', attemptIndex, 'completedAt'],
            message: 'A superseded workflow attempt requires completedAt.',
          });
      }
      if (
        TERMINAL_WORKFLOW_CALL_STATUSES.has(call.status) &&
        call.timestamps.completedAt === undefined
      )
        context.addIssue({
          code: 'custom',
          path: ['calls', index, 'timestamps', 'completedAt'],
          message: 'A terminal workflow call requires completedAt.',
        });
      if (
        TERMINAL_WORKFLOW_CALL_STATUSES.has(call.status) &&
        call.attempts.some((attempt) => attempt.completedAt === undefined)
      )
        context.addIssue({
          code: 'custom',
          path: ['calls', index, 'attempts'],
          message: 'A terminal workflow call cannot have an open attempt.',
        });
    }
    if (TERMINAL_LIFECYCLES.has(snapshot.lifecycle)) {
      if (snapshot.timestamps.completedAt === undefined)
        context.addIssue({
          code: 'custom',
          path: ['timestamps', 'completedAt'],
          message: 'A terminal workflow snapshot requires completedAt.',
        });
      if (
        snapshot.calls.some(
          (call) => !TERMINAL_WORKFLOW_CALL_STATUSES.has(call.status),
        )
      )
        context.addIssue({
          code: 'custom',
          path: ['calls'],
          message: 'A terminal workflow snapshot cannot contain live calls.',
        });
    }
  });
export type WorkflowExecutionSnapshot = z.infer<
  typeof WorkflowExecutionSnapshotSchema
>;
