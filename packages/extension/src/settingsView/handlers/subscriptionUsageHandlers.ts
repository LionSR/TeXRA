import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  SUBSCRIPTION_USAGE_PROVIDERS,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageSnapshots,
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
  const snapshots = Object.fromEntries(
    await Promise.all(
      SUBSCRIPTION_USAGE_PROVIDERS.map(async (provider) => [
        provider,
        await reader.getUsage(provider, { forceRefresh }),
      ]),
    ),
  ) as SubscriptionUsageSnapshots;
  await webview.postMessage({
    command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
    snapshots,
  });
}
