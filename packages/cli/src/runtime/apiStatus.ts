import { configuredApiKeyProviders } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { OWN_API_KEYS } from '@shared/copy/modelAccess';
import { RESEARCHER_ACCESS_AUTH } from '@shared/copy/accountAuth';
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatPercent } from '@utils/text/stringUtils';

import { getCliApiMode } from './apiAccessMode';
import {
  formatCliChatGptPreference,
  formatCliGlmCodingPlanPreference,
  formatCliGrokPreference,
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
  if (profile.authenticated && profile.tier) {
    return `${account} · tier: ${profile.tier}`;
  }
  return account;
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
    `Grok preference: ${formatCliGrokPreference(access)}`,
    `Kimi Code preference: ${formatCliKimiCodePreference(access)}`,
    `GLM Coding Plan preference: ${formatCliGlmCodingPlanPreference(access)}`,
    `Otherwise: ${formatCliModelAccessRoute(access.apiFallback)}`,
    formatAccountStatusLine(
      RESEARCHER_ACCESS.label,
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
  label: string = OWN_API_KEYS.inline,
): string | undefined {
  if (personalKeyProviders.length === 0) return undefined;
  const providers = personalKeyProviders
    .map((provider) => PROVIDER_DISPLAY_NAMES[provider] ?? provider)
    .join(', ');
  return `${label}: ${providers}`;
}

const SIGN_IN_ACTION_HINT = `actions: choose Model access below; ${RESEARCHER_ACCESS_AUTH.actionHintLogin}`;

const CLI_API_STATUS_ACTION_HINTS: Record<
  ApiAccessMode,
  Record<'signedIn' | 'signedOut' | 'signedOutWithPersonalKey', string>
> = {
  included: {
    signedIn:
      'actions: choose Model access below; `texra login --select-account` changes account',
    signedOut: SIGN_IN_ACTION_HINT,
    signedOutWithPersonalKey: SIGN_IN_ACTION_HINT,
  },
  personal: {
    signedIn: 'actions: choose Model access below; `texra logout` signs out',
    signedOut: `actions: ${RESEARCHER_ACCESS_AUTH.actionHintLoginOrKey}`,
    signedOutWithPersonalKey:
      'actions: choose Model access below; provider keys are configured',
  },
};

export function formatCliApiStatusActionHint(
  mode: ApiAccessMode,
  profile: Pick<CliAuthProfile, 'authenticated'>,
  options: { readonly hasPersonalKey?: boolean } = {},
): string {
  const hints = CLI_API_STATUS_ACTION_HINTS[mode];
  if (profile.authenticated) return hints.signedIn;
  return options.hasPersonalKey === true
    ? hints.signedOutWithPersonalKey
    : hints.signedOut;
}

async function personalKeyProviders(): Promise<string[]> {
  return configuredApiKeyProviders(platform().secrets);
}

interface CliApiStatus {
  /** Compact lines used by the launcher. */
  readonly lines: readonly string[];
}

interface LoadCliApiStatusOptions {
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
    return 'included usage: run `texra login` to view usage (TEXRA_RELAY_TOKEN on its own cannot read it)';
  }
  try {
    const usageTier = (await resolveCliUsageTier(profile)) ?? 'free';
    return formatRelayUsageStatus(
      await fetchRelayUsageSummary({ tier: usageTier }),
    );
  } catch (error: unknown) {
    return `included usage: ${toErrorMessage(error)}`;
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
  if (mode === 'included') {
    const usage = await loadIncludedUsageLine(profile);
    if (usage) {
      authLine = `${authLine} · ${usage}`;
    }
  }

  return {
    lines: [
      `api: ${formatCliModelAccessRouteInline(mode)}`,
      ...(personalKeysLine ? [personalKeysLine] : []),
      authLine,
      ...(profile.note ? [profile.note] : []),
      ...(actionHint ? [actionHint] : []),
    ],
  };
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
    grok: {
      preferred: access.preferences.grok === 'on',
      account: formatAccountStatus(
        access.grokSignedIn,
        access.grokAccountLabel,
      ),
    },
    kimiCode: {
      preferred: access.preferences.kimiCode === 'on',
      credential:
        access.kimiCodeKeySet === true
          ? 'key configured'
          : 'key not configured',
    },
    glmCode: {
      preferred: access.preferences.glmCode === 'on',
      credential:
        access.glmKeySet === true ? 'key configured' : 'key not configured',
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

  const chatGptLine = formatModelPreferenceLine(
    'ChatGPT',
    routes.chatGpt.preferred,
    access.chatGptSignedIn,
    'sign in required',
    routes.chatGpt.account,
  );
  if (chatGptLine) lines.push(chatGptLine);

  const grokLine = formatModelPreferenceLine(
    'Grok',
    routes.grok.preferred,
    access.grokSignedIn,
    'sign in required',
    routes.grok.account,
  );
  if (grokLine) lines.push(grokLine);

  const kimiLine = formatModelPreferenceLine(
    'Kimi Code',
    routes.kimiCode.preferred,
    access.kimiCodeKeySet === true,
    'key required',
    routes.kimiCode.credential,
  );
  if (kimiLine) lines.push(kimiLine);

  const glmLine = formatModelPreferenceLine(
    'GLM Coding Plan',
    routes.glmCode.preferred,
    access.glmKeySet === true,
    'key required',
    routes.glmCode.credential,
  );
  if (glmLine) lines.push(glmLine);

  const fallbackLine = `Otherwise: ${formatCliModelAccessRoute(access.apiFallback)}`;
  if (routes.fallback.kind === 'included') {
    lines.push(
      [
        fallbackLine,
        routes.fallback.account,
        routes.fallback.tier,
        routes.fallback.usage,
      ]
        .filter((part): part is string => part !== undefined)
        .join(' · '),
    );
  } else {
    lines.push(fallbackLine);
  }

  const otherPersonalKeys = formatPersonalApiKeysLine(
    providers.filter((provider) => provider !== 'kimiCode'),
    'Other API keys',
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
