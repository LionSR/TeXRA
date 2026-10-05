import { z } from 'zod';

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

const SubscriptionUsageProviderSchema = z.enum(SUBSCRIPTION_USAGE_PROVIDERS);
export type SubscriptionUsageProvider = z.infer<
  typeof SubscriptionUsageProviderSchema
>;

const SubscriptionUsageWindowSchema = z.object({
  name: z.string().min(1),
  percentUsed: z.number().min(0).max(100),
  percentRemaining: z.number().min(0).max(100),
  resetAt: z.int().nonnegative().optional(),
  limitWindowSeconds: z.int().positive().optional(),
});
export type SubscriptionUsageWindow = z.infer<
  typeof SubscriptionUsageWindowSchema
>;

const SubscriptionUsageSnapshotBaseSchema = z.object({
  provider: SubscriptionUsageProviderSchema,
  providerName: z.string().min(1),
  planName: z.string().min(1),
  fetchedAt: z.int().nonnegative(),
});

const SubscriptionUsageSnapshotSchema = z.discriminatedUnion('state', [
  SubscriptionUsageSnapshotBaseSchema.extend({
    state: z.literal('available'),
    windows: z.array(SubscriptionUsageWindowSchema).min(1),
  }),
  SubscriptionUsageSnapshotBaseSchema.extend({
    state: z.literal('unavailable'),
    windows: z.tuple([]),
    reason: z.enum([
      'missing_credentials',
      'invalid_credentials',
      'request_failed',
      'malformed_response',
    ]),
  }),
]);
export type SubscriptionUsageSnapshot = z.infer<
  typeof SubscriptionUsageSnapshotSchema
>;

export const SubscriptionUsageSnapshotsSchema = z.record(
  SubscriptionUsageProviderSchema,
  SubscriptionUsageSnapshotSchema,
);
export type SubscriptionUsageSnapshots = z.infer<
  typeof SubscriptionUsageSnapshotsSchema
>;
