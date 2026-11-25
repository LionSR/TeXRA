import { Schema } from 'effect';
import {
  NonNegativeIntSchema,
  PlanQuotaFailureSchema,
} from '@texra-ai/worldline/schemas';

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
  resetAt: Schema.optional(NonNegativeIntSchema),
});
export type SubscriptionUsageWindow =
  (typeof SubscriptionUsageWindowSchema)['Type'];

const SubscriptionUsageSnapshotSchema = Schema.Union([
  Schema.Struct({
    state: Schema.Literal('available'),
    providerName: Schema.NonEmptyString,
    planName: Schema.NonEmptyString,
    fetchedAt: NonNegativeIntSchema,
    windows: Schema.Array(SubscriptionUsageWindowSchema).check(
      Schema.isMinLength(1),
    ),
  }),
  Schema.Struct({
    state: Schema.Literal('unavailable'),
    reason: PlanQuotaFailureSchema,
  }),
]);
export type SubscriptionUsageSnapshot =
  (typeof SubscriptionUsageSnapshotSchema)['Type'];

export const SubscriptionUsageSnapshotsSchema = Schema.Record(
  SubscriptionUsageProviderSchema,
  SubscriptionUsageSnapshotSchema,
);
export type SubscriptionUsageSnapshots =
  (typeof SubscriptionUsageSnapshotsSchema)['Type'];
