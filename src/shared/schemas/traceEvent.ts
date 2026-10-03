/** Trace inputs used by the same transcript fold during live display and replay. */
// Shared contracts and utilities
import { z } from 'zod';

import { ContextStateDataSchema } from './contextManagement';
import { JsonValueSchema } from './jsonValue';
import { FileListEntrySchema, LogLevelSchema, MessageTypeSchema } from './log';
import { ToolCallStatusSchema } from './progressView/data';
import { RunOutcomeSchema } from './run';
import { StageKindSchema } from './taskGroup';
import { ExtendedTokenUsageStatsSchema } from './usage';

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
    data: JsonValueSchema.optional(),
    messageType: MessageTypeSchema.optional(),
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
    input: JsonValueSchema,
    /** A script's call: the guest's latest `phase()` title when it issued
     *  the call (`script.call.phase`). */
    phase: z.string().optional(),
    /** The intent attempt the card opens for, from the second on. */
    attempt: z.int().min(2).optional(),
  }),
  /**
   * On a run with a run history the card stores no output: `result` is projected
   * at read time from the `tool.result` it commits with and its `tool.start`
   * input (`rowCodec.ts`), and `files` names what the call edited. A run
   * without a run history (an agent-CLI child) stores `result` here.
   */
  toolEnd: trace('tool.end', {
    logId: z.string(),
    status: ToolCallStatusSchema,
    result: JsonValueSchema.optional(),
    files: z.array(FileListEntrySchema).optional(),
  }),
  /**
   * One priced model turn of the row's run: never a running total, so a
   * run's usage is the sum of its rows. A run with a run history stores none: the
   * database projects one from each priced `model.message` response and
   * `context.edit` summary (`Database`'s display reads). A child's spend
   * is on the child's own run, never on its parent's. An
   * agent-CLI child, which has no run history, stores one per turn. `elapsedTime`
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
  streamStart: trace('stream.start', {
    id: z.string(),
    kind: MessageTypeSchema,
  }),
  streamEnd: trace('stream.end', {
    id: z.string(),
    finalText: z.string().optional(),
  }),
  /** Authoritative final assistant text for the round that just ended the
   *  turn, decided once at the flow boundary (after replacement-rule
   *  cleanup) and carried as data from there. Fires at every mid-run turn
   *  boundary, not only the terminal round (#7086). The round's MODEL_RESPONSE stream carries raw
   *  provider chunks, so subscribers reconcile that stream's entry to this
   *  text rather than assume the two match. */
  response: trace('response.finalized', { text: z.string() }),
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
