import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
  SubscriptionUsageSnapshots,
} from '@shared/schemas';
import type * as vscode from 'vscode';

export interface SubscriptionUsageReader {
  getUsage(
    provider: SubscriptionUsageProvider,
    options?: { readonly forceRefresh?: boolean },
  ): Promise<SubscriptionUsageSnapshot>;
  invalidate(provider?: SubscriptionUsageProvider): void;
}

/** Fetch and post one sanitized snapshot for every subscription provider. */
export async function sendSubscriptionUsage(
  webview: vscode.Webview,
  reader: SubscriptionUsageReader,
  forceRefresh = false,
): Promise<void> {
  // Each snapshot key is the provider id itself, so key and provider can never
  // drift apart the way a positional destructure would allow.
  const snapshots: SubscriptionUsageSnapshots = {
    chatgpt: await reader.getUsage('chatgpt', { forceRefresh }),
    kimiCode: await reader.getUsage('kimiCode', { forceRefresh }),
    glmCodingPlan: await reader.getUsage('glmCodingPlan', { forceRefresh }),
  };
  await webview.postMessage({
    command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
    snapshots,
  });
}
