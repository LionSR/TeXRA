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

function formatAccountStatusLine(
  label: string,
  signedIn: boolean,
  accountLabel?: string,
): string {
  if (!signedIn) return `${label}: signed out`;
  return `${label}: signed in${accountLabel ? ` as ${accountLabel}` : ''}`;
}

export interface CliModelAccessOverview {
  readonly access: CliModelAccessStatus;
  readonly lines: readonly string[];
}

interface CliAccessSnapshot {
  readonly access: CliModelAccessStatus;
  readonly profile: CliAuthProfile;
  readonly personalKeyProviders: readonly string[];
}

/** Read the account, route, and credential facts once for every renderer. */
async function loadCliAccessSnapshot(
  apiMode: ApiAccessMode,
  options: { readonly includePersonalKeys?: boolean } = {},
): Promise<CliAccessSnapshot> {
  const [access, profile, configuredPersonalKeyProviders] = await Promise.all([
    readCliModelAccessStatus(apiMode),
    getCliAuthProfile(),
    options.includePersonalKeys ? personalKeyProviders() : Promise.resolve([]),
  ]);
  return {
    access: { ...access, texraSignedIn: profile.authenticated },
    profile,
    personalKeyProviders: configuredPersonalKeyProviders,
  };
}

/** Read both account sessions and the effective model-access route. */
export async function loadCliModelAccessOverview(
  options: { readonly apiMode?: ApiAccessMode } = {},
): Promise<CliModelAccessOverview> {
  const apiMode = options.apiMode ?? getCliApiMode();
  const { access, profile } = await loadCliAccessSnapshot(apiMode);
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
    access,
    lines,
  };
}

/**
 * Format the neutral personal-key inventory from the canonical access facts.
 */
export function formatPersonalApiKeysLine(
  personalKeyProviders: readonly string[],
): string | undefined {
  if (personalKeyProviders.length === 0) return undefined;
  const providers = personalKeyProviders
    .map((provider) => PROVIDER_DISPLAY_NAMES[provider] ?? provider)
    .join(', ');
  return `personal API keys: ${providers}`;
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
  const snapshot = await loadCliAccessSnapshot(mode, {
    includePersonalKeys: true,
  });
  const { personalKeyProviders: configuredPersonalKeyProviders, profile } =
    snapshot;
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

function formatPreferenceState(
  state: 'off' | 'on',
  missingCredential: 'key' | 'sign-in' | undefined,
): string {
  const label = state === 'on' ? 'On' : 'Off';
  if (state === 'off' || missingCredential === undefined) return label;
  return `${label} (${missingCredential === 'key' ? 'key' : 'sign in'} required)`;
}

/** Render the detailed account view once from the canonical access facts. */
export async function loadCliDetailedAccountStatusLines(options: {
  readonly apiMode: ApiAccessMode;
}): Promise<string[]> {
  const {
    access,
    personalKeyProviders: providers,
    profile,
  } = await loadCliAccessSnapshot(options.apiMode, {
    includePersonalKeys: true,
  });
  const chatGpt = formatPreferenceState(
    access.preferences.chatGpt,
    access.chatGptSignedIn ? undefined : 'sign-in',
  );
  const kimiCode = formatPreferenceState(
    access.preferences.kimiCode,
    access.kimiCodeKeySet === true ? undefined : 'key',
  );
  const lines = [
    `Model access: ChatGPT ${chatGpt} · Kimi Code ${kimiCode} · fallback ${formatCliModelAccessRoute(access.apiFallback)}`,
    `Accounts: ChatGPT ${access.chatGptSignedIn ? (access.chatGptAccountLabel ?? 'signed in') : 'signed out'} · TeXRA ${profile.authenticated ? (profile.accountLabel ?? 'signed in') : 'signed out'}`,
    formatPersonalApiKeysLine(providers) ?? 'personal API keys: none',
  ];
  if (profile.note) lines.push(profile.note);
  if (profile.authenticated && profile.tier) {
    const usage = await loadIncludedUsageLine(profile);
    lines.push(`tier: ${profile.tier}${usage ? ` · ${usage}` : ''}`);
  }
  return lines;
}

export async function loadCliApiStatusLines(
  options: LoadCliApiStatusOptions = {},
): Promise<string[]> {
  return [...(await loadCliApiStatus(options)).lines];
}
