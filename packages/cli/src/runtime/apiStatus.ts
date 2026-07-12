import { platform } from '@platform/platform';
import { API_PROVIDERS, lookupApiKeyOrigin } from '@model/apiProviders';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatPercent } from '@utils/text/stringUtils';

import {
  formatCliApiMode,
  getCliApiMode,
  type CliApiMode,
} from './apiAccessMode';
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
  profile: Pick<CliAuthProfile, 'authenticated' | 'accountLabel'>,
): string {
  if (!profile.authenticated) return 'auth: signed out';
  return `auth: signed in${profile.accountLabel ? ` as ${profile.accountLabel}` : ''}`;
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

export async function loadCliApiStatusLines(
  options: {
    readonly apiMode?: CliApiMode;
    readonly includeActionHint?: boolean;
  } = {},
): Promise<string[]> {
  const mode = options.apiMode ?? getCliApiMode();
  const profile = await getCliAuthProfile();
  const lines = [
    `api: ${formatCliApiMode(mode)}`,
    formatCliAuthStatusLine(profile),
  ];
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
    if (shadowWarning) lines.push(shadowWarning);
  }

  if (profile.note) lines.push(profile.note);

  if (profile.tier) lines.push(`tier: ${profile.tier}`);
  if (profile.authenticated && profile.tier) {
    // Usage reads usage_logs via PostgREST with a session token; a
    // relay-scoped CI token cannot read it. Explain the limitation (same as
    // `texra auth usage`) instead of surfacing a generic fetch error — but a
    // session alongside the env token can still read its own usage.
    const canReadUsage =
      profile.credentialSource !== 'relayToken' ||
      (await getCliSessionAccessToken()) !== null;
    if (!canReadUsage) {
      lines.push(
        'included usage: not available with a CI relay token (run `texra login` to view usage)',
      );
    } else {
      try {
        const usageTier = (await resolveCliUsageTier(profile)) ?? 'free';
        lines.push(
          formatRelayUsageStatus(
            await fetchRelayUsageSummary({ tier: usageTier }),
          ),
        );
      } catch (error: unknown) {
        lines.push(`included usage: unavailable (${toErrorMessage(error)})`);
      }
    }
  }

  if (actionHint) lines.push(actionHint);
  return lines;
}
