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

export const ContextManagementDataSchema = Schema.Union([
  MaxTokensReducedDataSchema,
  TokensFreedDataSchema,
]);

export type ContextManagementData = typeof ContextManagementDataSchema.Type;

/**
 * Lifecycle event for one context-compaction operation. Completion statistics
 * remain in {@link ContextManagementDataSchema}; this smaller payload lets
 * hosts project one stable activity row from start through its terminal state.
 */
export const CompactionActivityDataSchema = Schema.Struct({
  activity: Schema.Literal('context_compaction'),
  operationId: Schema.String.check(Schema.isMinLength(1)),
  state: Schema.Literals([
    'started',
    'completed',
    'failed',
    'cancelled',
    'skipped',
  ]),
});

export type CompactionActivityData =
  (typeof CompactionActivityDataSchema)['Type'];
export type CompactionActivityOutcome = Exclude<
  CompactionActivityData['state'],
  'started'
>;

export const ContextStateDataSchema = Schema.Struct({
  inputTokens: TokenCountSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationPercent: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ContextStateData = typeof ContextStateDataSchema.Type;
