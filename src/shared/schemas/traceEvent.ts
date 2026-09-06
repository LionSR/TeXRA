/** Trace inputs used by the same transcript fold during live display and replay. */
// Shared contracts and utilities
import { z } from 'zod';

import { ActiveSkillsSnapshotSchema } from './activeSkills';
import { ContextStateDataSchema } from './contextManagement';
import { ExecutionIdSchema } from './identifiers';
import { LogLevelSchema } from './log';
import { RunOutcomeSchema } from './stream';
import { AgentCategorySchema } from './agent';
import { RetryErrorInfoSchema } from './errors';
import { StageKindSchema } from './taskGroup';
import { ExtendedTokenUsageStatsSchema, RunUsageTotalsSchema } from './usage';
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

/** Terminal errors retain the trace contract's local/provider distinction. */
const ResultErrorSchema = z
  .discriminatedUnion('kind', [
    RetryErrorInfoSchema.pick({
      message: true,
      userRetryable: true,
      streamDiagnostics: true,
      partialText: true,
    })
      .partial()
      .extend({ kind: z.enum(['abort', 'disk-full']) }),
    RetryErrorInfoSchema.partial().extend({
      kind: z.enum(['context-window', 'missing-api-key', 'unexpected']),
    }),
  ])
  .readonly();

/** One canonical terminal-result payload for trace publication and storage. */
export const ResultEventSchema = trace('result', {
  outcome: RunOutcomeSchema,
  executionId: z.string(),
  streamId: z.string(),
  agentName: z.string(),
  category: AgentCategorySchema,
  isSubagent: z.boolean(),
  error: ResultErrorSchema.optional(),
  usage: RunUsageTotalsSchema.optional(),
}).readonly();
export type ResultEvent = z.infer<typeof ResultEventSchema>;

/** Named arms let the durable vocabulary omit the transient chunk explicitly. */
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
    status: z.enum(['completed', 'failed', 'in_progress']),
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
    storageKey: ExecutionIdSchema,
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

/** Deltas are fold inputs only; they never enter the durable event vocabulary. */
const TranscriptChunkSchema = trace('stream.chunk', {
  id: z.string(),
  text: z.string(),
});
const TranscriptEventSchema = z.discriminatedUnion('type', [
  TranscriptChunkSchema,
  ...Object.values(TranscriptEventSchemas),
]);
export type TranscriptEvent = z.infer<typeof TranscriptEventSchema>;

const TRANSCRIPT_EVENT_TYPES = new Set<string>(
  Object.values(TranscriptEventSchemas).map(
    (schema) => schema.shape.type.value,
  ),
);

/** Trace rows consumed by the transcript projection, including listing arms. */
export function isTranscriptEvent<T extends { type: string }>(
  event: T,
): event is Extract<T, { type: TranscriptEvent['type'] }> {
  return (
    event.type === 'stream.chunk' || TRANSCRIPT_EVENT_TYPES.has(event.type)
  );
}
