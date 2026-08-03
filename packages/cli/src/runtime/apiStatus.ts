import { API_PROVIDERS, lookupApiKeyOrigin } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import type { ApiAccessMode } from '@shared/schemas/profileViewMessages';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatPercent } from '@utils/text/stringUtils';

import { getCliApiMode } from './apiAccessMode';
import {
  formatCliChatGptPreference,
  formatCliKimiCodePreference,
  formatCliModelAccessRoute,
  formatCliModelAccessRouteInline,
  type CliModelAccessStatus,
} from './modelAccessRoute';
import { readCliModelAccessStatus } from './modelAccessSelection';
import { fetchRelayUsageSummary, type RelayUsageSummary } from './relayUsage';
import {
  getCliAuthProfile,
  getCliSessionAccessToken,
  resolveCliUsageTier,
  type CliAuthProfile,
} from './supabaseAuth';

export function formatRelayUsageStatus(summary: RelayUsageSummary): string {
  const used = formatPercent(summary.usagePercent, 1);
  const remaining = formatPercent(Math.max(0, 100 - summary.usagePercent), 1);
  return `included usage this month: ${used} used, ${remaining} remaining`;
}

export function formatCliAuthStatusLine(
  profile: Pick<CliAuthProfile, 'authenticated' | 'accountLabel'> & {
    readonly tier?: string;
  },
): string {
  const account = formatAccountStatusLine(
    'auth',
    profile.authenticated,
    profile.accountLabel,
  );
  return profile.authenticated && profile.tier
    ? `${account} · tier: ${profile.tier}`
    : account;
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
export async function loadCliModelAccessOverview(
  options: { readonly apiMode?: ApiAccessMode } = {},
): Promise<CliModelAccessOverview> {
  const apiMode = options.apiMode ?? getCliApiMode();
  const [access, profile] = await Promise.all([
    readCliModelAccessStatus(apiMode),
    getCliAuthProfile(),
  ]);
  const lines = [
    `ChatGPT preference: ${formatCliChatGptPreference(access)}`,
    `Kimi Code preference: ${formatCliKimiCodePreference(access)}`,
    `API fallback: ${formatCliModelAccessRoute(access.apiFallback)}`,
    formatAccountStatusLine(
      'TeXRA',
      profile.authenticated,
      profile.accountLabel,
    ),
  ];
  if (profile.note) lines.push(profile.note);
  return {
    access: { ...access, texraSignedIn: profile.authenticated },
    lines,
  };
}

/** Format a neutral personal-key inventory. */
export function formatPersonalApiKeysLine(
  personalKeyProviders: readonly string[],
  label = 'personal API keys',
): string | undefined {
  if (personalKeyProviders.length === 0) return undefined;
  const providers = personalKeyProviders
    .map((provider) => PROVIDER_DISPLAY_NAMES[provider] ?? provider)
    .join(', ');
  return `${label}: ${providers}`;
}

const CLI_API_STATUS_ACTION_HINTS: Record<
  ApiAccessMode,
  Record<'signedIn' | 'signedOut' | 'signedOutWithPersonalKey', string>
> = {
  included: {
    signedIn:
      'actions: choose Model access below; `texra login --select-account` changes account',
    signedOut:
      'actions: choose Model access below; `texra login` signs in to Researcher Access',
    signedOutWithPersonalKey:
      'actions: choose Model access below; `texra login` signs in to Researcher Access',
  },
  personal: {
    signedIn: 'actions: choose Model access below; `texra logout` signs out',
    signedOut:
      'actions: choose Model access below, add a provider key, or sign in with Researcher Access',
    signedOutWithPersonalKey:
      'actions: choose Model access below; provider keys are configured',
  },
};

export function formatCliApiStatusActionHint(
  mode: ApiAccessMode,
  profile: Pick<CliAuthProfile, 'authenticated'>,
  options: { readonly hasPersonalKey?: boolean } = {},
): string {
  const signedOutState =
    options.hasPersonalKey === true ? 'signedOutWithPersonalKey' : 'signedOut';
  return CLI_API_STATUS_ACTION_HINTS[mode][
    profile.authenticated ? 'signedIn' : signedOutState
  ];
}

async function personalKeyProviders(): Promise<string[]> {
  const secrets = platform().secrets;
  const origins = await Promise.all(
    API_PROVIDERS.map((provider) => lookupApiKeyOrigin(secrets, provider)),
  );
  return API_PROVIDERS.filter((_, index) => origins[index] !== 'none');
}

export interface CliApiStatus {
  /** Compact lines used by the launcher. */
  readonly lines: readonly string[];
}

export interface LoadCliApiStatusOptions {
  readonly apiMode?: ApiAccessMode;
  readonly includeActionHint?: boolean;
}

async function loadIncludedUsageLine(
  profile: CliAuthProfile,
): Promise<string | undefined> {
  if (!profile.authenticated || !profile.tier) return undefined;
  // Usage reads usage_logs via PostgREST with a session token; a relay-scoped
  // CI token cannot read it, while a session alongside that token can.
  const canReadUsage =
    profile.credentialSource !== 'relayToken' ||
    (await getCliSessionAccessToken()) !== null;
  if (!canReadUsage) {
    return 'included usage: not available with a CI relay token (run `texra login` to view usage)';
  }
  try {
    const usageTier = (await resolveCliUsageTier(profile)) ?? 'free';
    return formatRelayUsageStatus(
      await fetchRelayUsageSummary({ tier: usageTier }),
    );
  } catch (error: unknown) {
    return `included usage: unavailable (${toErrorMessage(error)})`;
  }
}

export async function loadCliApiStatus(
  options: LoadCliApiStatusOptions = {},
): Promise<CliApiStatus> {
  const mode = options.apiMode ?? getCliApiMode();
  const [profile, configuredPersonalKeyProviders] = await Promise.all([
    getCliAuthProfile(),
    personalKeyProviders(),
  ]);
  let authLine = formatCliAuthStatusLine(profile);
  const hasPersonalKey = configuredPersonalKeyProviders.length > 0;
  const actionHint = options.includeActionHint
    ? formatCliApiStatusActionHint(mode, profile, { hasPersonalKey })
    : undefined;

  const personalKeysLine = formatPersonalApiKeysLine(
    configuredPersonalKeyProviders,
  );
  const supplementalLines = [
    ...(personalKeysLine ? [personalKeysLine] : []),
    ...(profile.note ? [profile.note] : []),
  ];
  if (profile.authenticated && profile.tier) {
    const usage = await loadIncludedUsageLine(profile);
    if (usage) {
      authLine = `${authLine} · ${usage}`;
    }
  }

  return {
    lines: [
      `api: ${formatCliModelAccessRouteInline(mode)}`,
      authLine,
      ...supplementalLines,
      ...(actionHint ? [actionHint] : []),
    ],
  };
}

/** Render each detailed account/access fact on its owning route. */
export async function loadCliDetailedAccountStatusLines(options: {
  readonly apiMode: ApiAccessMode;
}): Promise<string[]> {
  const [access, profile, providers] = await Promise.all([
    readCliModelAccessStatus(options.apiMode),
    getCliAuthProfile(),
    personalKeyProviders(),
  ]);
  const includedUsage =
    access.apiFallback === 'included'
      ? await loadIncludedUsageLine(profile)
      : undefined;
  const routes = {
    chatGpt: {
      preferred: access.preferences.chatGpt === 'on',
      account: formatAccountStatus(
        access.chatGptSignedIn,
        access.chatGptAccountLabel,
      ),
    },
    kimiCode: {
      preferred: access.preferences.kimiCode === 'on',
      credential:
        access.kimiCodeKeySet === true
          ? 'key configured'
          : 'key not configured',
    },
    fallback:
      access.apiFallback === 'included'
        ? {
            kind: 'included' as const,
            account: formatAccountStatus(
              profile.authenticated,
              profile.accountLabel,
            ),
            tier: profile.authenticated ? profile.tier : undefined,
            usage: includedUsage,
          }
        : { kind: 'personal' as const },
  };
  const lines: string[] = [];
  if (routes.chatGpt.preferred || access.chatGptSignedIn) {
    const account =
      routes.chatGpt.preferred && !access.chatGptSignedIn
        ? 'sign in required'
        : routes.chatGpt.account;
    lines.push(
      `ChatGPT: ${routes.chatGpt.preferred ? 'preferred' : 'not preferred'} · ${account}`,
    );
  }
  if (routes.kimiCode.preferred || access.kimiCodeKeySet === true) {
    const credential =
      routes.kimiCode.preferred && access.kimiCodeKeySet !== true
        ? 'key required'
        : routes.kimiCode.credential;
    lines.push(
      `Kimi Code: ${routes.kimiCode.preferred ? 'preferred' : 'not preferred'} · ${credential}`,
    );
  }
  if (routes.fallback.kind === 'included') {
    lines.push(
      [
        'Fallback: Included TeXRA access',
        routes.fallback.account,
        routes.fallback.tier,
        routes.fallback.usage,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' · '),
    );
  } else {
    lines.push('Fallback: Personal API keys');
  }

  const otherPersonalKeys = formatPersonalApiKeysLine(
    providers.filter((provider) => provider !== 'kimiCode'),
    'Other personal keys',
  );
  if (otherPersonalKeys) lines.push(otherPersonalKeys);
  if (profile.note) lines.push(profile.note);
  return lines;
}

export async function loadCliApiStatusLines(
  options: LoadCliApiStatusOptions = {},
): Promise<string[]> {
  return [...(await loadCliApiStatus(options)).lines];
}
