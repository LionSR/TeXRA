import type { SubscriptionUsageWindow } from '@shared/schemas';

export interface ParsedSubscriptionUsage {
  readonly planName?: string;
  readonly windows: readonly SubscriptionUsageWindow[];
}
