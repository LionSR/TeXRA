import { API_PROVIDERS, lookupApiKeyOrigin } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatPercent } from '@utils/text/stringUtils';

import { getCliApiMode, type CliApiMode } from './apiAccessMode';
import {
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

/** Read both account sessions and the effective model-access route. */
export async function loadCliModelAccessOverview(
  options: { readonly apiMode?: CliApiMode } = {},
): Promise<CliModelAccessOverview> {
  const apiMode = options.apiMode ?? getCliApiMode();
  const [access, profile] = await Promise.all([
    readCliModelAccessStatus(apiMode),
    getCliAuthProfile(),
  ]);
  const preferredSubscriptions = [
    access.chatGpt.preferSubscription && access.chatGpt.signedIn
      ? 'ChatGPT'
      : undefined,
    access.kimiCode.preferred && access.kimiCode.keySet
      ? 'Kimi Code'
      : undefined,
  ].filter((value): value is string => value !== undefined);
  const lines = [
    preferredSubscriptions.length > 0
      ? `subscription preferences: ${preferredSubscriptions.join(' + ')}`
      : `model access: ${formatCliModelAccessRoute(apiMode)}`,
    formatAccountStatusLine(
      'ChatGPT',
      access.chatGpt.signedIn,
      access.chatGpt.email ?? access.chatGpt.accountId ?? undefined,
    ),
    `Kimi Code: ${
      access.kimiCode.keySet === true
        ? 'key configured'
        : 'no key (add with /key)'
    }`,
    formatAccountStatusLine(
      'TeXRA',
      profile.authenticated,
      profile.accountLabel,
    ),
  ];
  if (preferredSubscriptions.length > 0) {
    lines.push(`API fallback: ${formatCliModelAccessRoute(apiMode)}`);
  }
  if (profile.note) lines.push(profile.note);
  return {
    access: { ...access, texraSignedIn: profile.authenticated },
    lines,
  };
}

/**
 * Warn when a provider key is present at the same time as a relay sign-in: the
 * active `--api-mode` / `/api` setting decides which is actually used, so a
 * stale env key can silently shadow a fresh login (a documented footgun in
 * comparable CLIs). Returns `undefined` unless both credential paths exist.
 */
export function formatApiKeyShadowWarning(
  authenticated: boolean,
  personalKeyProviders: readonly string[],
): string | undefined {
  if (!authenticated || personalKeyProviders.length === 0) return undefined;
  const providers = personalKeyProviders
    .map((provider) => PROVIDER_DISPLAY_NAMES[provider] ?? provider)
    .join(', ');
  return `available: included TeXRA access; personal API keys: ${providers}`;
}

const CLI_API_STATUS_ACTION_HINTS: Record<
  CliApiMode,
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
  mode: CliApiMode,
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
  /** API account facts appended to the detailed account overview. */
  readonly detailLines: readonly string[];
}

export interface LoadCliApiStatusOptions {
  readonly apiMode?: CliApiMode;
  readonly includeActionHint?: boolean;
}

export async function loadCliApiStatus(
  options: LoadCliApiStatusOptions = {},
): Promise<CliApiStatus> {
  const mode = options.apiMode ?? getCliApiMode();
  const profile = await getCliAuthProfile();
  const supplementalLines: string[] = [];
  const detailLines: string[] = [];
  let authLine = formatCliAuthStatusLine(profile);
  const configuredPersonalKeyProviders =
    options.includeActionHint === true || profile.authenticated
      ? await personalKeyProviders()
      : [];
  const hasPersonalKey = configuredPersonalKeyProviders.length > 0;
  const actionHint = options.includeActionHint
    ? formatCliApiStatusActionHint(mode, profile, { hasPersonalKey })
    : undefined;

  if (profile.authenticated) {
    const shadowWarning = formatApiKeyShadowWarning(
      true,
      configuredPersonalKeyProviders,
    );
    if (shadowWarning) supplementalLines.push(shadowWarning);
  }

  if (profile.note) supplementalLines.push(profile.note);
  detailLines.push(...supplementalLines);
  if (profile.authenticated && profile.tier) {
    detailLines.push(`tier: ${profile.tier}`);
    // Usage reads usage_logs via PostgREST with a session token; a
    // relay-scoped CI token cannot read it. Explain the limitation (same as
    // `texra auth usage`) instead of surfacing a generic fetch error — but a
    // session alongside the env token can still read its own usage.
    const canReadUsage =
      profile.credentialSource !== 'relayToken' ||
      (await getCliSessionAccessToken()) !== null;
    let usage: string;
    if (!canReadUsage) {
      usage =
        'included usage: not available with a CI relay token (run `texra login` to view usage)';
    } else {
      try {
        const usageTier = (await resolveCliUsageTier(profile)) ?? 'free';
        usage = formatRelayUsageStatus(
          await fetchRelayUsageSummary({ tier: usageTier }),
        );
      } catch (error: unknown) {
        usage = `included usage: unavailable (${toErrorMessage(error)})`;
      }
    }
    detailLines.push(usage);
    authLine = `${authLine} · ${usage}`;
  }

  return {
    lines: [
      `api: ${formatCliModelAccessRouteInline(mode)}`,
      authLine,
      ...supplementalLines,
      ...(actionHint ? [actionHint] : []),
    ],
    detailLines,
  };
}

export async function loadCliApiStatusLines(
  options: LoadCliApiStatusOptions = {},
): Promise<string[]> {
  return [...(await loadCliApiStatus(options)).lines];
}
