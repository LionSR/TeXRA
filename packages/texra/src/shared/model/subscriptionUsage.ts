import { Schema, Struct } from 'effect';
import { NonNegativeIntSchema } from '@texra-ai/harness/schemas';

/**
 * The subscriptions whose usage is reported. Storage owns the enum, so a
 * catalog change is never a silent stored format change; a coding plan's
 * `id` (`CODING_PLAN_SUBSCRIPTIONS`) is declared as this type,
 * so a plan it lacks does not compile.
 */
const SUBSCRIPTION_USAGE_PROVIDERS = Object.freeze([
  'kimiCode',
  'glmCodingPlan',
] as const);

const SubscriptionUsageProviderSchema = Schema.Literals(
  SUBSCRIPTION_USAGE_PROVIDERS,
);
export type SubscriptionUsageProvider =
  (typeof SubscriptionUsageProviderSchema)['Type'];

const SubscriptionUsageWindowSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  percentUsed: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(100),
  ),
  percentRemaining: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(100),
  ),
  resetAt: Schema.optional(NonNegativeIntSchema),
});
export type SubscriptionUsageWindow =
  (typeof SubscriptionUsageWindowSchema)['Type'];

const SubscriptionUsageSnapshotBaseSchema = Schema.Struct({
  providerName: Schema.NonEmptyString,
  planName: Schema.NonEmptyString,
  fetchedAt: NonNegativeIntSchema,
});

const SubscriptionUsageSnapshotSchema = Schema.Union([
  SubscriptionUsageSnapshotBaseSchema.mapFields(
    Struct.assign({
      state: Schema.Literal('available'),
      windows: Schema.Array(SubscriptionUsageWindowSchema).check(
        Schema.isMinLength(1),
      ),
    }),
  ),

  SubscriptionUsageSnapshotBaseSchema.mapFields(
    Struct.assign({
      state: Schema.Literal('unavailable'),
      windows: Schema.Tuple([]),
      reason: Schema.Literals([
        'missing_credentials',
        'invalid_credentials',
        'request_failed',
        'malformed_response',
      ]),
    }),
  ),
]);
export type SubscriptionUsageSnapshot =
  (typeof SubscriptionUsageSnapshotSchema)['Type'];

export const SubscriptionUsageSnapshotsSchema = Schema.Record(
  SubscriptionUsageProviderSchema,
  SubscriptionUsageSnapshotSchema,
);
export type SubscriptionUsageSnapshots =
  (typeof SubscriptionUsageSnapshotsSchema)['Type'];
