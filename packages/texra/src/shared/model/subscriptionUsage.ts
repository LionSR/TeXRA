import { Schema } from 'effect';
import {
  DeclinableUsageRouteSchema,
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

export const SubscriptionUsageWindowSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  percentUsed: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)).check(
    Schema.isLessThanOrEqualTo(100),
  ),
  resetAt: Schema.optional(NonNegativeIntSchema),
});
export type SubscriptionUsageWindow =
  (typeof SubscriptionUsageWindowSchema)['Type'];

/**
 * What the process knows of one subscription plan's quota: its windows as
 * last learned and when, or why none is known. `unobserved` is a plan whose
 * replies state its quota and none has arrived in this process yet. The one
 * record every meter reads: the status bar's, the settings page's and the
 * terminal's.
 */
export const PlanUsageSchema = Schema.Struct({
  plan: DeclinableUsageRouteSchema,
  /** The plan's tier as its provider names it, when it says: plans of one
   *  route differ in their windows and limits, so the name is the
   *  provider's and no window is assumed. */
  planName: Schema.optional(Schema.NonEmptyString),
  windows: Schema.Array(SubscriptionUsageWindowSchema),
  /** When the windows were learned, in epoch milliseconds. */
  at: Schema.optional(NonNegativeIntSchema),
  unknown: Schema.optional(
    Schema.Literals(['unobserved', ...PlanQuotaFailureSchema.literals]),
  ),
});
export type PlanUsage = typeof PlanUsageSchema.Type;

/** Each coding plan's usage, by the provider that reports it. */
export const SubscriptionUsageSnapshotsSchema = Schema.Record(
  SubscriptionUsageProviderSchema,
  PlanUsageSchema,
);
export type SubscriptionUsageSnapshots =
  (typeof SubscriptionUsageSnapshotsSchema)['Type'];
