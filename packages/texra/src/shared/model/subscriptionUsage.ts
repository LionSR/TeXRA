import { Schema, Struct } from 'effect';

/**
 * The subscriptions whose usage is reported. Storage owns the enum, so a
 * catalog change is never a silent stored format change; a coding plan's
 * `usageProvider` in the llm catalog is passed where this type is expected,
 * so a plan it lacks does not compile.
 */
export const SUBSCRIPTION_USAGE_PROVIDERS = Object.freeze([
  'chatgpt',
  'kimiCode',
  'glmCodingPlan',
] as const);

const SubscriptionUsageProviderSchema = Schema.Enum(
  SUBSCRIPTION_USAGE_PROVIDERS,
);
export type SubscriptionUsageProvider =
  (typeof SubscriptionUsageProviderSchema)['Type'];

const SubscriptionUsageWindowSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1)),
  percentUsed: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(100),
  ),
  percentRemaining: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(100),
  ),
  resetAt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limitWindowSeconds: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0)),
  ),
});
export type SubscriptionUsageWindow =
  (typeof SubscriptionUsageWindowSchema)['Type'];

const SubscriptionUsageSnapshotBaseSchema = Schema.Struct({
  provider: SubscriptionUsageProviderSchema,
  providerName: Schema.String.check(Schema.isMinLength(1)),
  planName: Schema.String.check(Schema.isMinLength(1)),
  fetchedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
