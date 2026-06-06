import { platform } from '@platform/platform';
import { toErrorMessage } from '@common/errors/errorMessage';
import { API_PROVIDERS, lookupApiKeyOrigin } from '@model/apiProviders';

import { formatCliAccountLabelForDisplay } from './accountDisplay';
import {
  formatCliApiMode,
  getCliApiMode,
  type CliApiMode,
} from './apiAccessMode';
import { fetchRelayUsageSummary, type RelayUsageSummary } from './relayUsage';
import { getCliAuthProfile, type CliAuthProfile } from './supabaseAuth';

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0%';
  if (value < 1) return '<1%';
  return `${value.toFixed(1)}%`;
}

export function formatRelayUsageStatus(summary: RelayUsageSummary): string {
  const used = formatPercent(summary.usagePercent);
  const remaining = formatPercent(Math.max(0, 100 - summary.usagePercent));
  return `relay usage this month: ${used} used, ${remaining} remaining`;
}

export function formatCliAuthStatusLine(
  profile: Pick<CliAuthProfile, 'authenticated' | 'accountLabel'>,
): string {
  if (!profile.authenticated) return 'auth: signed out';
  return `auth: signed in${
    profile.accountLabel
      ? ` as ${formatCliAccountLabelForDisplay(profile.accountLabel)}`
      : ''
  }`;
}

/**
 * Warn when a provider key is present at the same time as a relay sign-in: the
 * active `--api-mode` / `/api` setting decides which is actually used, so a
 * stale env key can silently shadow a fresh login (a documented footgun in
 * comparable CLIs). Returns `undefined` unless both credential paths exist.
 */
export function formatApiKeyShadowWarning(
  authenticated: boolean,
  hasPersonalKey: boolean,
): string | undefined {
  if (!authenticated || !hasPersonalKey) return undefined;
  return 'note: a provider API key is set while signed in — `--api-mode` (or `/api`) controls which one is used.';
}

export function formatCliApiStatusActionHint(
  mode: CliApiMode,
  profile: Pick<CliAuthProfile, 'authenticated'>,
): string {
  if (mode === 'included') {
    return profile.authenticated
      ? 'actions: `texra login --select-account` changes account; `--api-mode personal` uses provider keys'
      : 'actions: `texra login` enables included relay; `--api-mode personal` uses provider keys';
  }
  return profile.authenticated
    ? 'actions: `--api-mode included` uses relay; `texra logout` signs out'
    : 'actions: configure a provider key, or run `texra login` for included relay';
}

async function anyPersonalKeyPresent(): Promise<boolean> {
  const secrets = platform().secrets;
  const origins = await Promise.all(
    API_PROVIDERS.map((provider) => lookupApiKeyOrigin(secrets, provider)),
  );
  return origins.some((origin) => origin !== 'none');
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
  const actionHint = options.includeActionHint
    ? formatCliApiStatusActionHint(mode, profile)
    : undefined;

  if (profile.authenticated) {
    const shadowWarning = formatApiKeyShadowWarning(
      true,
      await anyPersonalKeyPresent(),
    );
    if (shadowWarning) lines.push(shadowWarning);
  }

  if (profile.tier) lines.push(`tier: ${profile.tier}`);
  if (!profile.authenticated || !profile.tier) {
    if (actionHint) lines.push(actionHint);
    return lines;
  }

  try {
    lines.push(
      formatRelayUsageStatus(
        await fetchRelayUsageSummary({ tier: profile.tier }),
      ),
    );
  } catch (error: unknown) {
    lines.push(`relay usage: unavailable (${toErrorMessage(error)})`);
  }

  if (actionHint) lines.push(actionHint);
  return lines;
}
