/** Trace inputs used by the same transcript fold during live display and replay. */
// Shared contracts and utilities
import { z } from 'zod';

import { ActiveSkillsSnapshotSchema } from './activeSkills';
import { ContextStateDataSchema } from './contextManagement';
import { RunIdSchema } from './identifiers';
import { LogLevelSchema } from './log';
import { ToolCallStatusSchema } from './progressView/data';
import { RunOutcomeSchema } from './run';
import { StageKindSchema } from './taskGroup';
import { ExtendedTokenUsageStatsSchema } from './usage';
import {
  WorkflowCallProgressSchema,
  WorkflowPlanMarkerSchema,
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
    phases: WorkflowPlanMarkerSchema.shape.phases.readonly(),
    tasks: WorkflowPlanMarkerSchema.shape.tasks.readonly(),
  }),
  workflowCall: trace('workflow.call', {
    logId: z.string(),
    call: WorkflowCallProgressSchema,
  }),
  skills: trace('skills.snapshot', {
    skills: ActiveSkillsSnapshotSchema.shape.skills.readonly(),
  }),
  usage: trace('usage', {
    /** The run this spend is attributed to: the row's own run, or the
     *  agent-CLI child a parent logs a turn for through its own trace. */
    runId: RunIdSchema,
    usage: ExtendedTokenUsageStatsSchema,
    recordTranscript: z.boolean().optional(),
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
