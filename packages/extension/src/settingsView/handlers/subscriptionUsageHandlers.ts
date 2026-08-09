import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
} from '@shared/schemas';
import type * as vscode from 'vscode';

const SUBSCRIPTION_USAGE_PROVIDERS = [
  'chatgpt',
  'kimiCode',
  'glmCodingPlan',
  'grok',
] as const;

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
  const [chatgpt, kimiCode, glmCodingPlan, grok] = await Promise.all(
    SUBSCRIPTION_USAGE_PROVIDERS.map((provider) =>
      reader.getUsage(provider, { forceRefresh }),
    ),
  );
  await webview.postMessage({
    command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
    snapshots: { chatgpt, kimiCode, glmCodingPlan, grok },
  });
}
