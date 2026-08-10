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
  QUEUED: 'queued',
  STARTING: 'starting',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
  CACHED: 'cached',
} as const;
const WorkflowExecutionCallStatusSchema = z.enum(WORKFLOW_CALL_STATUS);
export type WorkflowExecutionCallStatus = z.infer<
  typeof WorkflowExecutionCallStatusSchema
>;

const WorkflowExecutionTimestampsSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  queuedAt: z.iso.datetime().optional(),
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
const WorkflowExecutionCallSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string(),
  stageId: z.string().min(1).optional(),
  stageTitle: z.string().min(1).optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  files: z.strictObject({
    input: z.array(z.string()),
    context: z.array(z.string()),
    media: z.array(z.string()),
  }),
  childExecutionId: ExecutionIdSchema.optional(),
  childStreamId: StreamTabIdSchema.optional(),
  attempts: z.array(WorkflowExecutionAttemptSchema),
  status: WorkflowExecutionCallStatusSchema,
  blockedReason: z.string().optional(),
  error: z.string().optional(),
  costUsd: z.number().nonnegative().optional(),
  timestamps: WorkflowExecutionTimestampsSchema,
});
export type WorkflowExecutionCall = z.infer<typeof WorkflowExecutionCallSchema>;

const WorkflowExecutionCountsSchema = z.strictObject({
  total: z.int().nonnegative(),
  waiting: z.int().nonnegative(),
  planned: z.int().nonnegative(),
  stageBlocked: z.int().nonnegative(),
  queued: z.int().nonnegative(),
  starting: z.int().nonnegative(),
  running: z.int().nonnegative(),
  completed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
  skipped: z.int().nonnegative(),
  cached: z.int().nonnegative(),
});
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
    counts: WorkflowExecutionCountsSchema,
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
    const actualCounts = Object.fromEntries(
      Object.values(WORKFLOW_CALL_STATUS).map((status) => [status, 0]),
    ) as Record<WorkflowExecutionCallStatus, number>;
    for (const [index, call] of snapshot.calls.entries()) {
      if (callIds.has(call.id))
        context.addIssue({
          code: 'custom',
          path: ['calls', index, 'id'],
          message: `Duplicate workflow call id "${call.id}".`,
        });
      callIds.add(call.id);
      actualCounts[call.status] += 1;
      if (call.stageId !== undefined) {
        const stage = snapshot.stages.find(
          (candidate) => candidate.id === call.stageId,
        );
        if (!stage || call.stageTitle !== stage.title)
          context.addIssue({
            code: 'custom',
            path: ['calls', index, 'stageId'],
            message: 'A workflow call stage must reference a matching stage.',
          });
      } else if (call.stageTitle !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['calls', index, 'stageTitle'],
          message: 'Workflow call stageTitle requires stageId.',
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
    for (const status of Object.values(WORKFLOW_CALL_STATUS)) {
      if (snapshot.counts[status] !== actualCounts[status])
        context.addIssue({
          code: 'custom',
          path: ['counts', status],
          message: `Workflow ${status} count must equal direct calls.`,
        });
    }
    if (snapshot.counts.total !== snapshot.calls.length)
      context.addIssue({
        code: 'custom',
        path: ['counts', 'total'],
        message: 'Workflow total count must equal direct calls.',
      });
    if (
      snapshot.counts.waiting !==
      actualCounts.planned + actualCounts.stageBlocked
    )
      context.addIssue({
        code: 'custom',
        path: ['counts', 'waiting'],
        message:
          'Workflow waiting count must equal planned plus stage-blocked calls.',
      });
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
