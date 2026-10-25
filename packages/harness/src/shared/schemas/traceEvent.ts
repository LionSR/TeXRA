/** Trace inputs used by the same transcript fold during live display and replay. */
// Shared contracts and utilities
import { Schema } from 'effect';

import { ContextStateDataSchema } from './contextManagement';
import { JsonValueSchema } from './jsonValue';
import { FileListEntrySchema, LogLevelSchema, MessageTypeSchema } from './log';
import { ToolCallStatusSchema, ToolCardSchema } from './progressView/data';
import { RunOutcomeSchema } from './run';
import { StageKindSchema } from './taskGroup';
import { ExtendedTokenUsageStatsSchema } from './usage';

function trace<T extends string, const F extends Schema.Struct.Fields>(
  type: T,
  fields: F,
) {
  return Schema.Struct({
    type: Schema.Literal(type),
    stageId: Schema.optional(Schema.String),
    ...fields,
  });
}

/** Durable transcript vocabulary; session events extend each arm. */
export const TranscriptEventSchema = Schema.Union([
  trace('log', {
    level: LogLevelSchema,
    message: Schema.String,
    data: Schema.optional(JsonValueSchema),
    messageType: Schema.optional(MessageTypeSchema),
  }),
  trace('stage.start', {
    id: Schema.String,
    label: Schema.String,
    parentId: Schema.optional(Schema.NullOr(Schema.String)),
    kind: Schema.optional(Schema.NullOr(StageKindSchema)),
  }),
  trace('stage.end', { id: Schema.String, status: RunOutcomeSchema }),
  trace('tool.start', {
    logId: Schema.String,
    toolName: Schema.String,
    input: JsonValueSchema,
    /** A script's call: the guest's latest `phase()` title when it issued
     *  the call (`script.call.phase`). */
    phase: Schema.optional(Schema.String),
    /** The intent attempt the card opens for, from the second on. */
    attempt: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(2)),
    ),
    /** The card the tool states for this call (`ToolUseLog.card`). */
    card: Schema.optional(ToolCardSchema),
  }),
  /**
   * On a run with a run history the card stores no output: `result` is projected
   * at read time from the `tool.result` it commits with and its `tool.start`
   * input (`rowCodec.ts`), and `files` names what the call edited. A run
   * without a run history (an agent-CLI child) stores `result` here.
   */
  trace('tool.end', {
    logId: Schema.String,
    status: ToolCallStatusSchema,
    result: Schema.optional(JsonValueSchema),
    files: Schema.optional(Schema.Array(FileListEntrySchema)),
  }),
  /**
   * One priced model turn of the row's run: never a running total, so a
   * run's usage is the sum of its rows. A run with a run history stores none: the
   * database projects one from each priced `model.message` response and
   * `context.edit` summary (`Database`'s display reads). A child's spend
   * is on the child's own run, never on its parent's. An
   * agent-CLI child, which has no run history, stores one per turn. `elapsedTime`
   * is the turn's response time in seconds.
   */
  trace('usage', { usage: ExtendedTokenUsageStatsSchema }),
  trace('context.state', {
    inputTokens: ContextStateDataSchema.fields.inputTokens,
    contextWindow: ContextStateDataSchema.fields.contextWindow,
  }),
  trace('stream.start', {
    id: Schema.String,
    kind: MessageTypeSchema,
  }),
  trace('stream.end', {
    id: Schema.String,
    finalText: Schema.optional(Schema.String),
  }),
  /** Authoritative final assistant text for the round that just ended the
   *  turn, decided once at the flow boundary (after replacement-rule
   *  cleanup) and carried as data from there. Fires at every mid-run turn
   *  boundary, not only the terminal round. The round's MODEL_RESPONSE stream carries raw
   *  provider chunks, so subscribers reconcile that stream's entry to this
   *  text rather than assume the two match. */
  trace('response.finalized', { text: Schema.String }),
]);

export type TranscriptEvent = typeof TranscriptEventSchema.Type;

const TRANSCRIPT_EVENT_TYPES = new Set<string>(
  TranscriptEventSchema.members.map((schema) => schema.fields.type.literal),
);

/** Trace rows consumed by the transcript projection, including listing arms. */
export function isTranscriptEvent<T extends { type: string }>(
  event: T,
): event is Extract<T, { type: TranscriptEvent['type'] }> {
  return TRANSCRIPT_EVENT_TYPES.has(event.type);
}
