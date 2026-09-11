import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { configuredApiKeyProviders } from '@model/apiProviders';
import type { PlatformSecrets } from '@platform/secrets';
import { CODING_PLAN_SUBSCRIPTIONS } from '@shared/codingPlanSubscriptions';
import { formatSubscriptionUsageSummary } from '@shared/subscriptionUsagePresentation';
import type { SubscriptionUsageSnapshot } from '@shared/schemas';
import { providerDisplayName } from '@shared/constants/providers';
import { OWN_API_KEYS } from '@shared/copy/modelAccess';
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';

import {
  formatCliChatGptPreference,
  formatCliGrokPreference,
  formatCliCodingPlanPreference,
  formatCliModelAccessRoute,
  formatCliModelAccessRouteInline,
  cliCodingPlanStatus,
  type CliAccountStatus,
} from './modelAccessRoute';
import {
  mergeCliTexraAccountStatus,
  readCliModelAccessStatus,
} from './modelAccessSelection';
import { getCliAuthProfile, type CliAuthProfile } from './supabaseAuth';

/** The one method this module needs, derived from the service that owns it —
 *  the same narrowing the desktop credential controller uses. */
type SubscriptionUsageReader = Pick<SubscriptionUsageService, 'getUsage'>;

export function formatCliAuthStatusLine(
  profile: Pick<CliAuthProfile, 'authenticated' | 'accountLabel'>,
): string {
  return formatAccountStatusLine(
    'auth',
    profile.authenticated,
    profile.accountLabel,
  );
}

function formatAccountStatus(signedIn: boolean, accountLabel?: string): string {
  if (!signedIn) return 'signed out';
  return `signed in${accountLabel ? ` as ${accountLabel}` : ''}`;
}

function formatAccountStatusLine(
  label: string,
  signedIn: boolean,
  accountLabel?: string,
): string {
  return `${label}: ${formatAccountStatus(signedIn, accountLabel)}`;
}

export interface CliModelAccessOverview {
  readonly access: CliAccountStatus;
  readonly lines: readonly string[];
  /** Stale-metadata warning from the auth profile, when any. */
  readonly note?: string;
}

/** Read both account sessions and the effective model-access route. */
export async function loadCliModelAccessOverview(
  secrets: PlatformSecrets,
): Promise<CliModelAccessOverview> {
  const [access, profile] = await Promise.all([
    readCliModelAccessStatus(secrets),
    getCliAuthProfile(),
  ]);
  const lines = [
    `ChatGPT preference: ${formatCliChatGptPreference(access)}`,
    `Grok preference: ${formatCliGrokPreference(access)}`,
    ...CODING_PLAN_SUBSCRIPTIONS.map(
      (plan) =>
        `${plan.displayName} preference: ${formatCliCodingPlanPreference(access, plan)}`,
    ),
    `Otherwise: ${formatCliModelAccessRoute('api-key')}`,
    formatAccountStatusLine(
      RESEARCHER_ACCESS.label,
      profile.authenticated,
      profile.accountLabel,
    ),
  ];
  if (profile.note) lines.push(profile.note);
  return {
    access: mergeCliTexraAccountStatus(access, profile),
    lines,
    note: profile.note,
  };
}

/** Format a neutral personal-key inventory. */
export function formatPersonalApiKeysLine(
  personalKeyProviders: readonly string[],
  label: string = OWN_API_KEYS.inline,
): string | undefined {
  if (personalKeyProviders.length === 0) return undefined;
  const providers = personalKeyProviders
    .map((provider) => providerDisplayName(provider))
    .join(', ');
  return `${label}: ${providers}`;
}

async function personalKeyProviders(
  secrets: PlatformSecrets,
): Promise<string[]> {
  return configuredApiKeyProviders(secrets);
}

/** Compact status lines used by the launcher. */
export async function loadCliApiStatus(
  secrets: PlatformSecrets,
  profile: Pick<CliAuthProfile, 'authenticated' | 'accountLabel' | 'note'>,
): Promise<readonly string[]> {
  const configuredPersonalKeyProviders = await personalKeyProviders(secrets);
  const authLine = formatCliAuthStatusLine(profile);

  const personalKeysLine = formatPersonalApiKeysLine(
    configuredPersonalKeyProviders,
  );

  return [
    `api: ${formatCliModelAccessRouteInline('api-key')}`,
    ...(personalKeysLine ? [personalKeysLine] : []),
    authLine,
    ...(profile.note ? [profile.note] : []),
  ];
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
export async function loadCliDetailedAccountStatusLines(
  secrets: PlatformSecrets,
  options: {
    readonly subscriptionUsage?: SubscriptionUsageReader;
    readonly now?: number;
  } = {},
): Promise<string[]> {
  const [access, profile, providers] = await Promise.all([
    readCliModelAccessStatus(secrets),
    getCliAuthProfile(),
    personalKeyProviders(secrets),
  ]);
  // Detailed /api status is user-invoked, so reopening it is the manual refresh
  // path. Ordinary chat startup and the status bar never call this service, and
  // every read below forces a refresh, so the service is built over the caller's
  // secret store here rather than held as a module singleton.
  const usageReader =
    options.subscriptionUsage ?? new SubscriptionUsageService({ secrets });
  const [chatGptUsage, codingPlanUsageEntries] = await Promise.all([
    access.chatGptSignedIn
      ? usageReader.getUsage('chatgpt', { forceRefresh: true })
      : undefined,
    Promise.all(
      CODING_PLAN_SUBSCRIPTIONS.map(async (plan) => {
        const status = cliCodingPlanStatus(access, plan);
        return [
          plan.id,
          status.keySet
            ? await usageReader.getUsage(plan.usageProvider, {
                forceRefresh: true,
              })
            : undefined,
        ] as const;
      }),
    ),
  ]);
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

  const chatGptLine = formatModelPreferenceLine(
    'ChatGPT',
    access.preferences.chatGpt === 'on',
    access.chatGptSignedIn,
    'sign in required',
    formatAccountStatus(access.chatGptSignedIn, access.chatGptAccountLabel),
  );
  if (chatGptLine) lines.push(withUsage(chatGptLine, chatGptUsage));

  const grokLine = formatModelPreferenceLine(
    'Grok',
    access.preferences.grok === 'on',
    access.grokSignedIn,
    'sign in required',
    formatAccountStatus(access.grokSignedIn, access.grokAccountLabel),
  );
  if (grokLine) lines.push(grokLine);

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
  if (profile.note) lines.push(profile.note);
  return lines;
}
