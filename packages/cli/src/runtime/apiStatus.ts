import { toErrorMessage } from '@common/errors/errorMessage';

import { formatCliAccountLabelForDisplay } from './accountDisplay';
import { formatCliApiMode, getCliApiMode } from './apiAccessMode';
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

export async function loadCliApiStatusLines(): Promise<string[]> {
  const mode = getCliApiMode();
  const profile = await getCliAuthProfile();
  const lines = [
    `api: ${formatCliApiMode(mode)}`,
    formatCliAuthStatusLine(profile),
  ];

  if (profile.tier) lines.push(`tier: ${profile.tier}`);
  if (!profile.authenticated || !profile.tier) return lines;

  try {
    lines.push(
      formatRelayUsageStatus(
        await fetchRelayUsageSummary({ tier: profile.tier }),
      ),
    );
  } catch (error: unknown) {
    lines.push(`relay usage: unavailable (${toErrorMessage(error)})`);
  }

  return lines;
}
