import { Schema, Struct } from 'effect';

import { NonNegativeIntSchema } from './nonNegativeInt';

const ContextManagementAction = Schema.Literals([
  'clear_tool_uses',
  'clear_thinking',
  'truncation',
  'max_tokens_reduced',
]);

const PositiveTokenCountSchema = Schema.Int.check(Schema.isGreaterThan(0));

const ContextManagementDataBaseSchema = Schema.Struct({
  tokensBefore: NonNegativeIntSchema,
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
      'clear_tool_uses',
      'clear_thinking',
      'truncation',
    ]),
    tokensAfter: NonNegativeIntSchema,
    utilizationAfter: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);

export const ContextManagementDataSchema = Schema.Union([
  MaxTokensReducedDataSchema,
  TokensFreedDataSchema,
]);

export type ContextManagementData = typeof ContextManagementDataSchema.Type;

const UtilizationSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));

const CompactionActivityFields = {
  activity: Schema.Literal('context_compaction'),
  operationId: Schema.NonEmptyString,
};

/**
 * Lifecycle event for one context-compaction operation, so hosts project one
 * stable activity row from its start through its end. A completed compaction
 * carries what it freed: the estimated tokens and the window share before
 * and after.
 */
export const CompactionActivityDataSchema = Schema.Union([
  Schema.Struct({
    ...CompactionActivityFields,
    state: Schema.Literals(['started', 'failed', 'cancelled', 'skipped']),
  }),
  Schema.Struct({
    ...CompactionActivityFields,
    state: Schema.Literal('completed'),
    freed: Schema.Struct({
      tokens: Schema.Int,
      utilizationBefore: UtilizationSchema,
      utilizationAfter: UtilizationSchema,
    }),
  }),
]);

export type CompactionActivityData =
  (typeof CompactionActivityDataSchema)['Type'];
export type CompactionActivityOutcome = Exclude<
  CompactionActivityData['state'],
  'started'
>;

export const ContextStateDataSchema = Schema.Struct({
  inputTokens: NonNegativeIntSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationPercent: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ContextStateData = typeof ContextStateDataSchema.Type;
