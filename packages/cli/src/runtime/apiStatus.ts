import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { configuredApiKeyProviders } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { CODING_PLAN_SUBSCRIPTIONS } from '@shared/codingPlanSubscriptions';
import { formatSubscriptionUsageSummary } from '@shared/subscriptionUsagePresentation';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
} from '@shared/schemas';
import { providerDisplayName } from '@shared/constants/providers';
import { OWN_API_KEYS } from '@shared/copy/modelAccess';
import { RESEARCHER_ACCESS_AUTH } from '@shared/copy/accountAuth';
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';

import {
  formatCliChatGptPreference,
  formatCliGrokPreference,
  formatCliCodingPlanPreference,
  formatCliModelAccessRoute,
  formatCliModelAccessRouteInline,
  cliCodingPlanStatus,
  type CliModelAccessStatus,
} from './modelAccessRoute';
import { readCliModelAccessStatus } from './modelAccessSelection';
import { getCliAuthProfile, type CliAuthProfile } from './supabaseAuth';

interface SubscriptionUsageReader {
  getUsage(
    provider: SubscriptionUsageProvider,
    options?: { readonly forceRefresh?: boolean },
  ): Promise<SubscriptionUsageSnapshot>;
}

const SubscriptionUsage = new SubscriptionUsageService();

/** Prefix of the signed-in auth status line — the TUI's launcher compacts the
 *  auth line by truncating the trailing segments behind this prefix. */
export const AUTH_SIGNED_IN_LINE_PREFIX = 'auth: signed in';

/** Separator between the segments that make up an auth status line (account,
 *  usage). The launcher truncates at this to keep the status line short. */
export const AUTH_STATUS_SEGMENT_SEPARATOR = ' · ';

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
  readonly access: CliModelAccessStatus;
  readonly lines: readonly string[];
}

/** Read both account sessions and the effective model-access route. */
export async function loadCliModelAccessOverview(): Promise<CliModelAccessOverview> {
  const [access, profile] = await Promise.all([
    readCliModelAccessStatus(),
    getCliAuthProfile(),
  ]);
  const lines = [
    `ChatGPT preference: ${formatCliChatGptPreference(access)}`,
    `Grok preference: ${formatCliGrokPreference(access)}`,
    ...CODING_PLAN_SUBSCRIPTIONS.map(
      (plan) =>
        `${plan.displayName} preference: ${formatCliCodingPlanPreference(access, plan)}`,
    ),
    `Otherwise: ${formatCliModelAccessRoute('personal')}`,
    formatAccountStatusLine(
      RESEARCHER_ACCESS.label,
      profile.authenticated,
      profile.accountLabel,
    ),
  ];
  if (profile.note) lines.push(profile.note);
  return {
    access,
    lines,
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

const CLI_API_STATUS_ACTION_HINTS: Record<
  'signedIn' | 'signedOut' | 'signedOutWithPersonalKey',
  string
> = {
  signedIn: 'actions: choose Model access below; `texra logout` signs out',
  signedOut: `actions: ${RESEARCHER_ACCESS_AUTH.actionHintLoginOrKey}`,
  signedOutWithPersonalKey:
    'actions: choose Model access below; provider keys are configured',
};

export function formatCliApiStatusActionHint(
  profile: Pick<CliAuthProfile, 'authenticated'>,
  options: { readonly hasPersonalKey?: boolean } = {},
): string {
  if (profile.authenticated) return CLI_API_STATUS_ACTION_HINTS.signedIn;
  return options.hasPersonalKey === true
    ? CLI_API_STATUS_ACTION_HINTS.signedOutWithPersonalKey
    : CLI_API_STATUS_ACTION_HINTS.signedOut;
}

async function personalKeyProviders(): Promise<string[]> {
  return configuredApiKeyProviders(platform().secrets);
}

interface LoadCliApiStatusOptions {
  readonly includeActionHint?: boolean;
}

/** Compact status lines used by the launcher. */
export async function loadCliApiStatus(
  options: LoadCliApiStatusOptions = {},
): Promise<readonly string[]> {
  const [profile, configuredPersonalKeyProviders] = await Promise.all([
    getCliAuthProfile(),
    personalKeyProviders(),
  ]);
  const authLine = formatCliAuthStatusLine(profile);
  const hasPersonalKey = configuredPersonalKeyProviders.length > 0;
  const actionHint = options.includeActionHint
    ? formatCliApiStatusActionHint(profile, { hasPersonalKey })
    : undefined;

  const personalKeysLine = formatPersonalApiKeysLine(
    configuredPersonalKeyProviders,
  );

  return [
    `api: ${formatCliModelAccessRouteInline('personal')}`,
    ...(personalKeysLine ? [personalKeysLine] : []),
    authLine,
    ...(profile.note ? [profile.note] : []),
    ...(actionHint ? [actionHint] : []),
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
  options: {
    readonly subscriptionUsage?: SubscriptionUsageReader;
    readonly now?: number;
  } = {},
): Promise<string[]> {
  const [access, profile, providers] = await Promise.all([
    readCliModelAccessStatus(),
    getCliAuthProfile(),
    personalKeyProviders(),
  ]);
  // Detailed /api status is user-invoked, so reopening it is the manual refresh
  // path. Ordinary chat startup and the status bar never call this service.
  const usageReader = options.subscriptionUsage ?? SubscriptionUsage;
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
  const routes = {
    chatGpt: {
      preferred: access.preferences.chatGpt === 'on',
      account: formatAccountStatus(
        access.chatGptSignedIn,
        access.chatGptAccountLabel,
      ),
    },
    grok: {
      preferred: access.preferences.grok === 'on',
      account: formatAccountStatus(
        access.grokSignedIn,
        access.grokAccountLabel,
      ),
    },
  };
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
    routes.chatGpt.preferred,
    access.chatGptSignedIn,
    'sign in required',
    routes.chatGpt.account,
  );
  if (chatGptLine) lines.push(withUsage(chatGptLine, chatGptUsage));

  const grokLine = formatModelPreferenceLine(
    'Grok',
    routes.grok.preferred,
    access.grokSignedIn,
    'sign in required',
    routes.grok.account,
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

  lines.push(`Otherwise: ${formatCliModelAccessRoute('personal')}`);

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
