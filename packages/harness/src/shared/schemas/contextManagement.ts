import { Schema, Struct } from 'effect';

import { TokenCountSchema } from './usage';

const ContextManagementAction = Schema.Literals([
  'compaction',
  'clear_tool_uses',
  'clear_thinking',
  'truncation',
  'max_tokens_reduced',
]);

const PositiveTokenCountSchema = Schema.Int.check(Schema.isGreaterThan(0));

const ContextManagementDataBaseSchema = Schema.Struct({
  tokensBefore: TokenCountSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationBefore: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  details: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
});

const MaxTokensReducedDataSchema = ContextManagementDataBaseSchema.mapFields(
  Struct.assign({
    action: Schema.Literal('max_tokens_reduced'),
    originalMaxTokens: PositiveTokenCountSchema,
    reducedMaxTokens: PositiveTokenCountSchema,
  }),
);

const TokensFreedDataSchema = ContextManagementDataBaseSchema.mapFields(
  Struct.assign({
    action: ContextManagementAction.pick([
      'compaction',
      'clear_tool_uses',
      'clear_thinking',
      'truncation',
    ]),
    tokensAfter: TokenCountSchema,
    utilizationAfter: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

/**
 * The payload of a `context_management` log row: what one context-management
 * action (a compaction, cleared tool uses or thinking, a truncation, or a
 * reduced `max_tokens`) did to the conversation, with the token counts and
 * context-window utilization before and, where tokens were freed, after. The
 * run loop writes it; the compaction activity projection reads it to describe
 * the operation.
 */
export const ContextManagementDataSchema = Schema.Union([
  MaxTokensReducedDataSchema,
  TokensFreedDataSchema,
]);

/** The decoded shape of {@link ContextManagementDataSchema}. */
export type ContextManagementData = typeof ContextManagementDataSchema.Type;

/**
 * Lifecycle event for one context-compaction operation. Completion statistics
 * remain in {@link ContextManagementDataSchema}; this smaller payload lets
 * hosts project one stable activity row from start through its terminal state.
 */
export const CompactionActivityDataSchema = Schema.Struct({
  activity: Schema.Literal('context_compaction'),
  operationId: Schema.NonEmptyString,
  state: Schema.Literals([
    'started',
    'completed',
    'failed',
    'cancelled',
    'skipped',
  ]),
});

/** The decoded shape of {@link CompactionActivityDataSchema}. */
export type CompactionActivityData =
  (typeof CompactionActivityDataSchema)['Type'];
/**
 * How a compaction operation ended: every {@link CompactionActivityData} state
 * except `started`.
 */
export type CompactionActivityOutcome = Exclude<
  CompactionActivityData['state'],
  'started'
>;

/**
 * How full a run's context window is after its latest model response: the
 * input tokens of the last request, the window size, and the percentage used.
 * The session view carries it per run so a usage panel can draw the gauge.
 */
export const ContextStateDataSchema = Schema.Struct({
  inputTokens: TokenCountSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationPercent: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

/** The decoded shape of {@link ContextStateDataSchema}. */
export type ContextStateData = typeof ContextStateDataSchema.Type;
