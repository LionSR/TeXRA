import { Schema } from 'effect';

import { NonNegativeIntSchema } from './nonNegativeInt';

const PositiveTokenCountSchema = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * The one context-management event the run writes: a request's output
 * ceiling lowered to fit what the context window leaves.
 */
export const ContextManagementDataSchema = Schema.Struct({
  action: Schema.Literal('max_tokens_reduced'),
  tokensBefore: NonNegativeIntSchema,
  contextWindow: PositiveTokenCountSchema,
  utilizationBefore: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  details: Schema.optional(Schema.String),
  originalMaxTokens: PositiveTokenCountSchema,
  reducedMaxTokens: PositiveTokenCountSchema,
});

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
 * and after; an edit the agent asked for, with a replacement it wrote, also
 * how many messages it `replaced`.
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
    replaced: Schema.optional(NonNegativeIntSchema),
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
