import { z } from 'zod';

import { RunIdSchema } from './identifiers';

export const WORKFLOW_RUN_LIFECYCLE = {
  WAITING: 'waiting',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
} as const;
const WorkflowRunLifecycleSchema = z.enum(WORKFLOW_RUN_LIFECYCLE);
type WorkflowRunLifecycle = z.infer<typeof WorkflowRunLifecycleSchema>;

/**
 * The one status vocabulary of a workflow-script call, shared by the
 * persisted row and the `workflow.call` progress card. `declared` is a
 * `meta.tasks` plan label the script has not issued as a call, whatever
 * stage gate it sits behind; every other status is an issued call.
 */
export const WORKFLOW_CALL_STATUS = {
  DECLARED: 'declared',
  PLANNED: 'planned',
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  CACHED: 'cached',
} as const;
const WorkflowCallStatusSchema = z.enum(WORKFLOW_CALL_STATUS);
export type WorkflowCallStatus = z.infer<typeof WorkflowCallStatusSchema>;

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

const WorkflowRunLiveTimestampsSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
  completedAt: z.never().optional(),
});
const WorkflowRunTerminalTimestampsSchema =
  WorkflowRunLiveTimestampsSchema.extend({
    completedAt: z.iso.datetime(),
  });
const WorkflowRunStageSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  order: z.int().nonnegative(),
  lifecycle: WorkflowRunLifecycleSchema,
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
});
const WorkflowRunAttemptSchema = z.strictObject({
  number: z.int().positive(),
  id: RunIdSchema.optional(),
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

const WorkflowRunCallBaseSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string(),
  stageId: z.string().min(1).optional(),
  files: WorkflowCallFilesSchema,
  attempts: z.array(WorkflowRunAttemptSchema),
  costUsd: z.number().nonnegative().optional(),
  kind: z.never().optional(),
  agent: z.never().optional(),
  model: z.never().optional(),
  childRunId: z.never().optional(),
  settledBySweep: z.never().optional(),
  error: z.never().optional(),
});

/** Facts of the actual `agent()` invocation; every non-declared call has them. */
const WorkflowRunIssuedCallSchema = WorkflowRunCallBaseSchema.extend({
  kind: WorkflowCallKindSchema,
  agent: z.string().optional(),
  /** Declared by the script at issue time, then the host-resolved model. */
  model: z.string().optional(),
  childRunId: RunIdSchema.optional(),
});

/**
 * A skipped call is the one status both a declared plan label and an issued
 * call can end in: the settle sweep skips whatever the run never reached,
 * and a user skips an issued call. Only the latter carries `kind`.
 */
const WorkflowRunSkippedCallSchema = WorkflowRunIssuedCallSchema.extend({
  status: z.literal(WORKFLOW_CALL_STATUS.SKIPPED),
  kind: WorkflowCallKindSchema.optional(),
  settledBySweep: z.literal(true).optional(),
  timestamps: WorkflowRunTerminalTimestampsSchema,
}).superRefine((call, context) => {
  if (call.kind === undefined && call.settledBySweep !== true) {
    context.addIssue({
      code: 'custom',
      path: ['settledBySweep'],
      message: 'An unissued skipped workflow call must be sweep-settled.',
    });
  }
});

/**
 * Canonical persisted state of one workflow-script call. Status owns the
 * lifecycle metadata it admits.
 */
const WorkflowRunCallSchema = z
  .discriminatedUnion('status', [
    WorkflowRunCallBaseSchema.extend({
      status: z.literal(WORKFLOW_CALL_STATUS.DECLARED),
      timestamps: WorkflowRunLiveTimestampsSchema,
    }),
    WorkflowRunIssuedCallSchema.extend({
      status: z.literal(WORKFLOW_CALL_STATUS.PLANNED),
      timestamps: WorkflowRunLiveTimestampsSchema,
    }),
    WorkflowRunIssuedCallSchema.extend({
      status: z.literal(WORKFLOW_CALL_STATUS.QUEUED),
      timestamps: WorkflowRunLiveTimestampsSchema,
    }),
    WorkflowRunIssuedCallSchema.extend({
      status: z.literal(WORKFLOW_CALL_STATUS.RUNNING),
      timestamps: WorkflowRunLiveTimestampsSchema,
    }),
    WorkflowRunIssuedCallSchema.extend({
      status: z.literal(WORKFLOW_CALL_STATUS.COMPLETED),
      timestamps: WorkflowRunTerminalTimestampsSchema,
    }),
    WorkflowRunIssuedCallSchema.extend({
      status: z.literal(WORKFLOW_CALL_STATUS.FAILED),
      settledBySweep: z.literal(true).optional(),
      error: z.string(),
      timestamps: WorkflowRunTerminalTimestampsSchema,
    }),
    WorkflowRunIssuedCallSchema.extend({
      status: z.literal(WORKFLOW_CALL_STATUS.CANCELLED),
      settledBySweep: z.literal(true).optional(),
      timestamps: WorkflowRunTerminalTimestampsSchema,
    }),
    WorkflowRunSkippedCallSchema,
    WorkflowRunIssuedCallSchema.extend({
      status: z.literal(WORKFLOW_CALL_STATUS.CACHED),
      timestamps: WorkflowRunTerminalTimestampsSchema,
    }),
  ])
  .superRefine((call, context) => {
    for (const [attemptIndex, attempt] of call.attempts.entries()) {
      if (attempt.number !== attemptIndex + 1) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', attemptIndex, 'number'],
          message: 'Workflow attempt numbers must be contiguous from 1.',
        });
      }
      if (
        (attemptIndex < call.attempts.length - 1 ||
          TERMINAL_WORKFLOW_CALL_STATUSES.has(call.status)) &&
        attempt.completedAt === undefined
      ) {
        context.addIssue({
          code: 'custom',
          path: ['attempts', attemptIndex, 'completedAt'],
          message:
            attemptIndex < call.attempts.length - 1
              ? 'A superseded workflow attempt requires completedAt.'
              : 'A terminal workflow call cannot have an open attempt.',
        });
      }
    }
  });
export type WorkflowRunCall = z.infer<typeof WorkflowRunCallSchema>;

type WorkflowRunCounts = Record<WorkflowCallStatus, number> & {
  readonly total: number;
  readonly waiting: number;
};

/**
 * The one owner of "how many calls are in each state". Derived from the calls
 * themselves at the read boundary rather than stored beside them, so a tally
 * can never disagree with the array it summarizes. `waiting` is the composite
 * every consumer asks for: every call not yet queued, declared plus planned.
 */
export function deriveWorkflowCounts(
  calls: readonly Pick<WorkflowRunCall, 'status'>[],
): WorkflowRunCounts {
  const byStatus = Object.fromEntries(
    Object.values(WORKFLOW_CALL_STATUS).map((status) => [status, 0]),
  ) as Record<WorkflowCallStatus, number>;
  for (const call of calls) byStatus[call.status] += 1;
  return {
    total: calls.length,
    waiting: byStatus.declared + byStatus.planned,
    ...byStatus,
  };
}

/**
 * A call's stage title, resolved from `stageId` against the snapshot's own
 * stages — the one owner, so a call can never carry a stage name that
 * disagrees with the stage it points at.
 */
export function stageTitleFor(
  snapshot: Pick<WorkflowRunSnapshot, 'stages'>,
  call: Pick<WorkflowRunCall, 'stageId'>,
): string | undefined {
  return snapshot.stages.find((stage) => stage.id === call.stageId)?.title;
}

export const TERMINAL_WORKFLOW_CALL_STATUSES: ReadonlySet<WorkflowCallStatus> =
  new Set([
    WORKFLOW_CALL_STATUS.COMPLETED,
    WORKFLOW_CALL_STATUS.FAILED,
    WORKFLOW_CALL_STATUS.CANCELLED,
    WORKFLOW_CALL_STATUS.SKIPPED,
    WORKFLOW_CALL_STATUS.CACHED,
  ]);
const TERMINAL_LIFECYCLES = new Set<WorkflowRunLifecycle>([
  WORKFLOW_RUN_LIFECYCLE.COMPLETED,
  WORKFLOW_RUN_LIFECYCLE.FAILED,
  WORKFLOW_RUN_LIFECYCLE.SKIPPED,
  WORKFLOW_RUN_LIFECYCLE.CANCELLED,
]);

export const WorkflowRunSnapshotSchema = z
  .strictObject({
    lifecycle: WorkflowRunLifecycleSchema,
    currentStageId: z.string().min(1).optional(),
    stages: z.array(WorkflowRunStageSchema),
    calls: z.array(WorkflowRunCallSchema),
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
      (stage) => stage.lifecycle === WORKFLOW_RUN_LIFECYCLE.ACTIVE,
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
        stage.lifecycle !== WORKFLOW_RUN_LIFECYCLE.WAITING &&
        stage.lifecycle !== WORKFLOW_RUN_LIFECYCLE.ACTIVE &&
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
export type WorkflowRunSnapshot = z.infer<typeof WorkflowRunSnapshotSchema>;
