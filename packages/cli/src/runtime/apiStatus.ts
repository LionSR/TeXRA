import { Effect } from 'effect';

import {
  CODING_PLAN_SUBSCRIPTIONS,
  configuredApiKeyProviders,
  providerDisplayName,
} from '@texra-ai/llm';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { SubscriptionUsageSnapshot } from '@shared/schemas';
import { SUBSCRIPTION_AUTH_PROVIDERS } from '@shared/model/subscriptionAuth';
import { SUBSCRIPTION_AUTH_COPY } from '@shared/model/accountAuth';
import { formatSubscriptionUsageSummary } from '@texra/shared/subscriptionUsagePresentation';
import { SubscriptionUsageService } from '@texra/controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { OWN_API_KEYS } from '@ui/copy/modelAccess';

import {
  formatCliCodingPlanPreference,
  formatCliModelAccessRoute,
  formatCliSubscriptionPreference,
  cliCodingPlanStatus,
  subscriptionAccountLabel,
  type CliModelAccessStatus,
} from './modelAccessRoute';
import { readCliModelAccessStatus } from './modelAccessSelection';
import type { PlatformSecrets } from '@texra-ai/harness';

/** The one method this module needs, derived from the service that owns it —
 *  the same narrowing the desktop credential controller uses. */
type SubscriptionUsageReader = Pick<SubscriptionUsageService, 'getUsage'>;

function formatAccountStatus(signedIn: boolean, accountLabel?: string): string {
  if (!signedIn) return 'signed out';
  return `signed in${accountLabel ? ` as ${accountLabel}` : ''}`;
}

interface CliModelAccessOverview {
  readonly access: CliModelAccessStatus;
  readonly lines: readonly string[];
}

/**
 * Read the subscription sessions and the effective model-access route. A program,
 * because the coding-plan key status underneath it is one: the chat surface
 * yields it, and a Promise-facing caller settles it on its own runtime.
 */
export const loadCliModelAccessOverview = Effect.fn(
  'apiStatus.loadCliModelAccessOverview',
)(function* (stores: SettingsStores, secrets: PlatformSecrets) {
  const access = yield* readCliModelAccessStatus(stores, secrets);
  const lines = [
    ...SUBSCRIPTION_AUTH_PROVIDERS.map(
      (provider) =>
        `${SUBSCRIPTION_AUTH_COPY[provider].label} preference: ${formatCliSubscriptionPreference(access.subscriptions[provider])}`,
    ),
    ...CODING_PLAN_SUBSCRIPTIONS.map(
      (plan) =>
        `${plan.displayName} preference: ${formatCliCodingPlanPreference(access, plan)}`,
    ),
    `Otherwise: ${formatCliModelAccessRoute('api-key')}`,
  ];
  return { access, lines } satisfies CliModelAccessOverview;
});

/** Format a neutral personal-key inventory. */
function formatPersonalApiKeysLine(
  personalKeyProviders: readonly string[],
  label: string = OWN_API_KEYS.inline,
): string | undefined {
  if (personalKeyProviders.length === 0) return undefined;
  const providers = personalKeyProviders
    .map((provider) => providerDisplayName(provider))
    .join(', ');
  return `${label}: ${providers}`;
}

/**
 * Build one model-preference status line, or undefined when there is nothing
 * to show (neither preferred nor configured).
 */
function formatModelPreferenceLine(
  label: string,
  preferred: boolean,
  configReady: boolean,
  missingMessage: string,
  configStatus: string,
): string | undefined {
  if (!preferred && !configReady) return undefined;
  const status = preferred && !configReady ? missingMessage : configStatus;
  return `${label}: ${preferred ? 'preferred' : 'not preferred'} · ${status}`;
}

/** Render each detailed account/access fact on its owning route. */
export const loadCliDetailedAccountStatusLines = Effect.fn(
  'apiStatus.loadCliDetailedAccountStatusLines',
)(function* (
  stores: SettingsStores,
  secrets: PlatformSecrets,
  options: {
    readonly subscriptionUsage?: SubscriptionUsageReader;
    readonly now?: number;
  } = {},
) {
  const [access, providers] = yield* Effect.all(
    [
      readCliModelAccessStatus(stores, secrets),
      configuredApiKeyProviders(secrets),
    ] as const,
    { concurrency: 'unbounded' },
  );
  // Detailed `/login status` is user-invoked, so reopening it is the manual refresh
  // path. Ordinary chat startup and the status bar never call this service, and
  // every read below forces a refresh, so the service is built over the caller's
  // secret store here rather than held as a module singleton.
  const usageReader =
    options.subscriptionUsage ??
    new SubscriptionUsageService({ secrets, stores });
  const [chatGptUsage, codingPlanUsageEntries] = yield* Effect.all(
    [
      access.subscriptions.chatgpt.signedIn
        ? usageReader.getUsage('chatgpt', { forceRefresh: true })
        : Effect.succeed(undefined),
      Effect.forEach(
        CODING_PLAN_SUBSCRIPTIONS,
        (plan) => {
          const status = cliCodingPlanStatus(access, plan);
          return Effect.map(
            status.keySet
              ? usageReader.getUsage(plan.usageProvider, {
                  forceRefresh: true,
                })
              : Effect.succeed(undefined),
            (usage) => [plan.id, usage] as const,
          );
        },
        { concurrency: 'unbounded' },
      ),
    ] as const,
    { concurrency: 'unbounded' },
  );
  const codingPlanUsage = new Map(codingPlanUsageEntries);
  const lines: string[] = [];
  const withUsage = (
    line: string,
    snapshot: SubscriptionUsageSnapshot | undefined,
  ): string => {
    if (!snapshot) return line;
    const summary = formatSubscriptionUsageSummary(snapshot, options.now);
    return summary ? `${line} · ${summary}` : line;
  };

  for (const provider of SUBSCRIPTION_AUTH_PROVIDERS) {
    const subscription = access.subscriptions[provider];
    const line = formatModelPreferenceLine(
      SUBSCRIPTION_AUTH_COPY[provider].label,
      subscription.preferSubscription,
      subscription.signedIn,
      'sign in required',
      formatAccountStatus(
        subscription.signedIn,
        subscriptionAccountLabel(subscription),
      ),
    );
    // Only the ChatGPT session reports subscription usage.
    if (line) {
      lines.push(provider === 'chatgpt' ? withUsage(line, chatGptUsage) : line);
    }
  }

  for (const plan of CODING_PLAN_SUBSCRIPTIONS) {
    const status = cliCodingPlanStatus(access, plan);
    const line = formatModelPreferenceLine(
      plan.displayName,
      status.preferred,
      status.keySet,
      'key required',
      status.keySet ? 'key configured' : 'key not configured',
    );
    if (line) lines.push(withUsage(line, codingPlanUsage.get(plan.id)));
  }

  lines.push(`Otherwise: ${formatCliModelAccessRoute('api-key')}`);

  const otherPersonalKeys = formatPersonalApiKeysLine(
    providers.filter(
      (provider) =>
        !CODING_PLAN_SUBSCRIPTIONS.some(
          (plan) => plan.exclusiveCredential && plan.apiProvider === provider,
        ),
    ),
    'Other API keys',
  );
  if (otherPersonalKeys) lines.push(otherPersonalKeys);
  return lines;
});
