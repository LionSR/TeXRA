import { z } from 'zod';

import { RunIdSchema } from './identifiers';

/**
 * The one status vocabulary of a workflow-script call, as the `workflow.call`
 * progress card carries it. `declared` is a `meta.tasks` plan label the
 * script has not issued as a call, whatever stage gate it sits behind; every
 * other status is an issued call.
 */
export const WORKFLOW_CALL_STATUS = {
  DECLARED: 'declared',
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

// One statement of which statuses are terminal, in the one place both readers
// can reach: the runtime membership test below and the type-level exclusions
// near `WorkflowCallLiveStatus`. A tuple, not a bare Set, so the derived union
// member cannot drift from the five literals the Set holds.
const TERMINAL_WORKFLOW_CALL_STATUSES = [
  WORKFLOW_CALL_STATUS.COMPLETED,
  WORKFLOW_CALL_STATUS.FAILED,
  WORKFLOW_CALL_STATUS.CANCELLED,
  WORKFLOW_CALL_STATUS.SKIPPED,
  WORKFLOW_CALL_STATUS.CACHED,
] as const satisfies readonly WorkflowCallStatus[];

type TerminalWorkflowCallStatus =
  (typeof TERMINAL_WORKFLOW_CALL_STATUSES)[number];

const TERMINAL_WORKFLOW_CALL_STATUS_SET: ReadonlySet<WorkflowCallStatus> =
  new Set(TERMINAL_WORKFLOW_CALL_STATUSES);

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
export const WorkflowControlActionSchema = z.enum(['skip', 'retry']);
export type WorkflowControlAction = z.infer<typeof WorkflowControlActionSchema>;

export const WORKFLOW_CALL_KIND = {
  /** Whole-document workflow-agent run: file inputs in, edited files out. */
  DOCUMENT: 'document',
  /** Tool-use run that finishes by submitting a schema-validated value. */
  STRUCTURED: 'structured',
} as const;
const WorkflowCallKindSchema = z.enum(WORKFLOW_CALL_KIND);
export type WorkflowCallKind = z.infer<typeof WorkflowCallKindSchema>;

/** File basenames one issued call was handed, by workflow-agent role. */
const WorkflowCallFilesSchema = z.strictObject({
  input: z.array(z.string()),
  context: z.array(z.string()),
  media: z.array(z.string()),
});

export const WorkflowCallIdentitySchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .describe('Stable identity for one workflow-script agent call.'),
  label: z
    .string()
    .trim()
    .min(1)
    .describe('Human-readable call name shown on progress surfaces.'),
  phase: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Optional declared workflow phase containing the call.'),
});
export type WorkflowCallIdentity = z.infer<typeof WorkflowCallIdentitySchema>;

/**
 * The declared shape of a workflow script — `meta.phases` in order and
 * `meta.tasks` — as both the approval proposal and the plan marker carry it.
 * A phase's position is its index in the array.
 */
export const WorkflowDeclaredPlanSchema = z.strictObject({
  phases: z.array(z.strictObject({ title: z.string().min(1) })),
  tasks: z.array(WorkflowCallIdentitySchema),
});
export type WorkflowDeclaredPlan = z.infer<typeof WorkflowDeclaredPlanSchema>;

/**
 * The declared plan of one workflow-script attempt — every `meta.phases`
 * entry and every `meta.tasks` entry, in script order — recorded once on the
 * transcript when the attempt's run state is constructed. Phases and
 * calls the run has reached are projected as stages and cards; this marker is
 * what lets a host list the ones it has not reached yet without opening their
 * stage (a `stage.start` prints the phase divider into scrollback).
 */
export const WorkflowPlanMarkerSchema = WorkflowDeclaredPlanSchema.extend({
  kind: z.literal('workflowPlan'),
  attemptId: z.string().min(1),
});
export type WorkflowPlanMarker = z.infer<typeof WorkflowPlanMarkerSchema>;

const WorkflowCallTerminalMetadataSchema = z.strictObject({
  durationMs: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});

const WorkflowCallProgressBaseSchema = WorkflowCallIdentitySchema.extend({
  /**
   * Facts of the actual `agent()` invocation, present once the script issues
   * the call: its result contract, the agent and model it runs (declared by
   * the script, then host-resolved), and the file basenames it was handed.
   * A declared plan label carries none of them.
   */
  kind: WorkflowCallKindSchema.optional(),
  agent: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  files: WorkflowCallFilesSchema.optional(),
  /**
   * Physical attempt number of this call across interactive retries within
   * one script attempt, present from the second attempt on. A durable resume
   * is a new script attempt under its own `attemptId` and starts at 1.
   * Distinct from `attemptId`, the whole-script projection attempt. The label
   * is never rewritten to say "retry".
   */
  attemptNumber: z.int().min(2).optional(),
  /**
   * Physical workflow-script projection attempt. All progress records from one
   * run share this id; older persisted transcripts may omit it. A malformed
   * present value must fail parsing: treating corrupted attempt ownership as
   * absent could mix a prior run's task into the current live projection.
   */
  attemptId: z.string().min(1).optional(),
  /**
   * The live child run executing this call. Absent for planned, cached, and
   * not-yet-launched calls.
   */
  childRunId: RunIdSchema.optional(),
});

/**
 * Canonical state of one declared or dynamically issued workflow-script call.
 * The status discriminant prevents terminal-only metadata from appearing on a
 * call that has not started.
 */
const WorkflowCallSkippedProgressSchema = z.discriminatedUnion('reason', [
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.SKIPPED),
    reason: z.literal('not-reached'),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.SKIPPED),
    reason: z.literal('user'),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
]);

/** The card projection of a persisted call; same status vocabulary. */
export const WorkflowCallProgressSchema = z.discriminatedUnion('status', [
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.DECLARED),
  }),
  /** Issued and waiting for one of the run's concurrency slots. */
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.QUEUED),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.RUNNING),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.COMPLETED),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.CACHED),
  }),
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.CANCELLED),
    // Cancelled is terminal but not a failure, so it intentionally omits the
    // `error` field carried by `failed`; renderers surface it as a stopped
    // state rather than as an exception.
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
  WorkflowCallSkippedProgressSchema,
  WorkflowCallProgressBaseSchema.extend({
    status: z.literal(WORKFLOW_CALL_STATUS.FAILED),
    error: z.string().min(1),
    ...WorkflowCallTerminalMetadataSchema.shape,
  }),
]);

export type WorkflowCallProgress = z.infer<typeof WorkflowCallProgressSchema>;
type WorkflowCallLiveStatus = Exclude<
  WorkflowCallStatus,
  TerminalWorkflowCallStatus
>;
type WorkflowCallTerminalProgress = Exclude<
  WorkflowCallProgress,
  { readonly status: WorkflowCallLiveStatus }
>;
/** A call that has not reached a terminal status — the sweep's subject. */
export type WorkflowCallLiveProgress = Extract<
  WorkflowCallProgress,
  { readonly status: WorkflowCallLiveStatus }
>;

/** One lifecycle predicate shared by persistence and transcript projections. */
export function isTerminalWorkflowCallStatus(
  status: WorkflowCallStatus,
): status is WorkflowCallTerminalProgress['status'] {
  return TERMINAL_WORKFLOW_CALL_STATUS_SET.has(status);
}

export function isTerminalWorkflowCallProgress(
  call: WorkflowCallProgress,
): call is WorkflowCallTerminalProgress {
  return isTerminalWorkflowCallStatus(call.status);
}

/** What a call that was in flight when its host stopped says about itself. */
const INTERRUPTED_WORKFLOW_CALL_ERROR =
  'The previous host stopped before this call completed.';

/**
 * How a host that stopped mid-run leaves one unsettled call — the single
 * vocabulary for an interrupted card.
 *
 * Both settlements use this vocabulary: host exit publishes a canonical
 * workflow.call fact, and workflowRunModel repaints a durably final run when
 * a crash or expired deadline prevented that publication. Replay and the
 * read-time view therefore describe the interrupted call consistently.
 */
export function interruptedWorkflowCall(
  call: WorkflowCallLiveProgress,
): WorkflowCallTerminalProgress {
  // Only a running call had model work in flight; a declared, planned, or
  // queued call was never launched.
  return call.status === 'running'
    ? { ...call, status: 'failed', error: INTERRUPTED_WORKFLOW_CALL_ERROR }
    : { ...call, status: 'skipped', reason: 'not-reached' };
}

export const WORKFLOW_TASK_STATUS_LABEL = {
  declared: 'Planned',
  queued: 'Queued',
  running: 'Running',
  completed: 'Finished',
  cached: 'Reused',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  failed: 'Failed',
} as const satisfies Record<WorkflowCallStatus, string>;

/** What a plan entry the run never ran reads as once the run has ended. */
export const WORKFLOW_NOT_RUN_LABEL = 'Not run';

/** The status word of one card: its status's label, except a call the run
 *  ended before reaching, which was not skipped by anyone — it did not run. */
export function workflowCallStatusLabel(call: WorkflowCallProgress): string {
  return call.status === 'skipped' && call.reason === 'not-reached'
    ? WORKFLOW_NOT_RUN_LABEL
    : WORKFLOW_TASK_STATUS_LABEL[call.status];
}

/**
 * A run's or a phase's calls counted by outcome — the one tally every
 * surface prints, the delivery summary included. `planned` and `notRun` are
 * the same plan entries read before and after the run ends: an entry the
 * script has not issued yet is planned while the run can still reach it and
 * not run once it cannot.
 */
export const WorkflowTallySchema = z.strictObject({
  total: z.int().nonnegative(),
  ok: z.int().nonnegative(),
  running: z.int().nonnegative(),
  queued: z.int().nonnegative(),
  planned: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
  /** Skipped by the user. */
  skipped: z.int().nonnegative(),
  notRun: z.int().nonnegative(),
});
export type WorkflowTally = z.infer<typeof WorkflowTallySchema>;

/** Count `cards` plus `unissued` plan entries that have no card yet. */
export function tallyWorkflowCalls(
  cards: readonly WorkflowCallProgress[],
  unissued: number,
  settled: boolean,
): WorkflowTally {
  const tally = {
    total: cards.length + unissued,
    ok: 0,
    running: 0,
    queued: 0,
    planned: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
    notRun: 0,
  };
  const unrun = settled ? 'notRun' : 'planned';
  tally[unrun] += unissued;
  for (const call of cards) {
    switch (call.status) {
      case 'completed':
      case 'cached':
        tally.ok += 1;
        break;
      case 'running':
      case 'queued':
      case 'failed':
      case 'cancelled':
        tally[call.status] += 1;
        break;
      case 'declared':
        tally[unrun] += 1;
        break;
      case 'skipped':
        tally[call.reason === 'not-reached' ? 'notRun' : 'skipped'] += 1;
        break;
    }
  }
  return tally;
}
