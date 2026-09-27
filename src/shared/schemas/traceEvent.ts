/** Trace inputs used by the same transcript fold during live display and replay. */
// Shared contracts and utilities
import { z } from 'zod';

import { ActiveSkillsSnapshotSchema } from './activeSkills';
import { ContextStateDataSchema } from './contextManagement';
import { LogLevelSchema } from './log';
import { ToolCallStatusSchema } from './progressView/data';
import { RunOutcomeSchema } from './run';
import { StageKindSchema } from './taskGroup';
import { ExtendedTokenUsageStatsSchema } from './usage';
import {
  WorkflowCallProgressSchema,
  WorkflowDeclaredPlanSchema,
} from './workflowCallProgress';

function trace<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({
    type: z.literal(type),
    stageId: z.string().optional(),
    ...shape,
  });
}

/** Durable transcript vocabulary; session events extend each arm. */
export const TranscriptEventSchemas = {
  log: trace('log', {
    level: LogLevelSchema,
    message: z.string(),
    data: z.unknown().optional(),
    messageType: z.string().optional(),
    verbose: z.boolean().optional(),
  }),
  stageStart: trace('stage.start', {
    id: z.string(),
    label: z.string(),
    parentId: z.string().nullish(),
    kind: StageKindSchema.nullish(),
    index: z.int().nonnegative().nullish(),
    total: z.int().nonnegative().nullish(),
  }),
  stageEnd: trace('stage.end', { id: z.string(), status: RunOutcomeSchema }),
  toolStart: trace('tool.start', {
    logId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
  }),
  toolEnd: trace('tool.end', {
    logId: z.string(),
    status: ToolCallStatusSchema,
    result: z.unknown().optional(),
  }),
  workflowPlan: trace('workflow.plan', {
    attemptId: z.string(),
    phases: WorkflowDeclaredPlanSchema.shape.phases.readonly(),
    tasks: WorkflowDeclaredPlanSchema.shape.tasks.readonly(),
  }),
  workflowCall: trace('workflow.call', {
    logId: z.string(),
    call: WorkflowCallProgressSchema,
  }),
  skills: trace('skills.snapshot', {
    skills: ActiveSkillsSnapshotSchema.shape.skills.readonly(),
  }),
  /**
   * One priced model turn of the row's run: never a running total, so a
   * run's usage is the sum of its rows. A run with a ledger stores none: the
   * database projects one from each priced `model.message` response and from
   * each child's cost a `tool.result` adds (`Database`'s display reads). An
   * agent-CLI child, which has no ledger, stores one per turn. `elapsedTime`
   * is the turn's response time in seconds; `percentageCached` is a
   * statistics row's, never a turn's.
   */
  usage: trace('usage', {
    usage: ExtendedTokenUsageStatsSchema.omit({ percentageCached: true }),
  }),
  context: trace('context.state', {
    inputTokens: ContextStateDataSchema.shape.inputTokens,
    contextWindow: ContextStateDataSchema.shape.contextWindow,
  }),
  streamStart: trace('stream.start', { id: z.string(), kind: z.string() }),
  streamEnd: trace('stream.end', {
    id: z.string(),
    finalText: z.string().optional(),
  }),
  /** Authoritative final assistant text for the round that just ended the
   *  turn, decided once at the flow boundary that sets
   *  `assembly.lastResponse` (after replacement-rule cleanup) and carried as
   *  data from there. Fires at every mid-run turn boundary, not only the
   *  terminal round (#7086). The round's MODEL_RESPONSE stream carries raw
   *  provider chunks, so subscribers reconcile that stream's entry to this
   *  text rather than assume the two match. */
  response: trace('response.finalized', { text: z.string() }),
  domain: trace('domain', {
    key: z.string(),
    data: z.unknown().optional(),
    text: z.string().optional(),
  }),
};

export type TranscriptEvent = z.infer<
  (typeof TranscriptEventSchemas)[keyof typeof TranscriptEventSchemas]
>;

const TRANSCRIPT_EVENT_TYPES = new Set<string>(
  Object.values(TranscriptEventSchemas).map(
    (schema) => schema.shape.type.value,
  ),
);

/** Trace rows consumed by the transcript projection, including listing arms. */
export function isTranscriptEvent<T extends { type: string }>(
  event: T,
): event is Extract<T, { type: TranscriptEvent['type'] }> {
  return TRANSCRIPT_EVENT_TYPES.has(event.type);
}
