import type { SubscriptionUsageWindow } from '@shared/schemas/subscriptionUsage';

export {
  SubscriptionUsageSnapshotSchema,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageWindow,
} from '@shared/schemas/subscriptionUsage';

export interface ParsedSubscriptionUsage {
  readonly planName?: string;
  readonly windows: readonly SubscriptionUsageWindow[];
}
