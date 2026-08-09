import { z } from 'zod';

const SubscriptionUsageProviderSchema = z.enum([
  'chatgpt',
  'kimiCode',
  'glmCodingPlan',
  'grok',
]);
export type SubscriptionUsageProvider = z.infer<
  typeof SubscriptionUsageProviderSchema
>;

const SubscriptionUsageWindowSchema = z.object({
  name: z.string().min(1),
  percentUsed: z.number().min(0).max(100),
  percentRemaining: z.number().min(0).max(100),
  resetAt: z.number().int().nonnegative().optional(),
  limitWindowSeconds: z.number().int().positive().optional(),
});
export type SubscriptionUsageWindow = z.infer<
  typeof SubscriptionUsageWindowSchema
>;

const SubscriptionUsageSnapshotBaseSchema = z.object({
  provider: SubscriptionUsageProviderSchema,
  providerName: z.string().min(1),
  planName: z.string().min(1),
  fetchedAt: z.number().int().nonnegative(),
});

export const SubscriptionUsageSnapshotSchema = z.discriminatedUnion('state', [
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
      'unsupported',
      'request_failed',
      'malformed_response',
    ]),
  }),
]);
export type SubscriptionUsageSnapshot = z.infer<
  typeof SubscriptionUsageSnapshotSchema
>;

export const SubscriptionUsageSnapshotsSchema = z.object({
  chatgpt: SubscriptionUsageSnapshotSchema,
  kimiCode: SubscriptionUsageSnapshotSchema,
  glmCodingPlan: SubscriptionUsageSnapshotSchema,
  grok: SubscriptionUsageSnapshotSchema,
});
export type SubscriptionUsageSnapshots = z.infer<
  typeof SubscriptionUsageSnapshotsSchema
>;
