import { toErrorMessage } from '@common/errors/errorMessage';

import { formatCliApiMode, getCliApiMode } from './apiAccessMode';
import { fetchRelayUsageSummary, type RelayUsageSummary } from './relayUsage';
import { getCliAuthProfile } from './supabaseAuth';

function formatUsd(value: number): string {
  return value.toFixed(2);
}

export function formatRelayUsageStatus(summary: RelayUsageSummary): string {
  return `relay usage: $${formatUsd(summary.costUsd)} / $${formatUsd(summary.limitUsd)} (${summary.usagePercent.toFixed(1)}%), $${formatUsd(summary.remainingUsd)} remaining`;
}

export async function loadCliApiStatusLines(): Promise<string[]> {
  const [mode, profile] = [getCliApiMode(), await getCliAuthProfile()];
  const lines = [
    `api: ${formatCliApiMode(mode)}`,
    profile.authenticated
      ? `auth: signed in${profile.accountLabel ? ` as ${profile.accountLabel}` : ''}`
      : 'auth: signed out',
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
