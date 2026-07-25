import type { UsageRoute } from '@shared/schemas';

import { parseCliApiMode, type CliApiMode } from './apiAccessMode';

export const CLI_MODEL_ACCESS_DESCRIPTION =
  'Toggle subscription preferences or choose the API fallback.';

export type CliModelAccessRoute =
  'chatgpt' | 'kimi-code' | 'included' | 'personal';

type CliSubscriptionPreferenceState = 'off' | 'on';
type CliSubscriptionProvider = 'chatgpt' | 'kimi-code';

interface CliSubscriptionPreferences {
  readonly chatGpt: CliSubscriptionPreferenceState;
  readonly kimiCode: CliSubscriptionPreferenceState;
}

export type CliModelAccessSelection =
  | {
      readonly kind: 'subscription-preference';
      readonly provider: CliSubscriptionProvider;
      readonly state: CliSubscriptionPreferenceState;
    }
  | {
      readonly kind: 'api-fallback';
      readonly apiMode: CliApiMode;
    };

type CliApiFallbackSelection = Extract<
  CliModelAccessSelection,
  { readonly kind: 'api-fallback' }
>;

const cliApiFallbackSelections = Object.freeze({
  included: Object.freeze({
    kind: 'api-fallback',
    apiMode: 'included',
  }),
  personal: Object.freeze({
    kind: 'api-fallback',
    apiMode: 'personal',
  }),
} as const satisfies Record<CliApiMode, CliApiFallbackSelection>);

export interface CliModelAccessStatus {
  readonly apiFallback: CliApiMode;
  /** Independent provider preferences; either, both, or neither may be on. */
  readonly preferences: CliSubscriptionPreferences;
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
  readonly kimiCodeKeySet?: boolean;
  readonly texraSignedIn?: boolean;
}

interface CliModelAccessItem {
  readonly value: CliModelAccessSelection;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
}

type CliModelAccessItemsInput =
  | {
      readonly kind: 'loaded';
      readonly access: CliModelAccessStatus;
    }
  | {
      readonly kind: 'pending';
      readonly state: 'failed' | 'loading';
    };

/** Return the stable selection object for one API fallback. */
export function cliApiFallbackSelection(
  apiMode: CliApiMode,
): CliApiFallbackSelection {
  return cliApiFallbackSelections[apiMode];
}

export function parseCliModelAccessSelection(
  input: string,
): CliModelAccessSelection | undefined {
  const apiMode = parseCliApiMode(input);
  if (apiMode) return cliApiFallbackSelection(apiMode);

  switch (input.trim().toLowerCase()) {
    case 'chatgpt':
    case 'subscription':
      return {
        kind: 'subscription-preference',
        provider: 'chatgpt',
        state: 'on',
      };
    case 'kimi':
    case 'kimicode':
    case 'kimi-code':
      return {
        kind: 'subscription-preference',
        provider: 'kimi-code',
        state: 'on',
      };
    default:
      return undefined;
  }
}

/** Prefer the route that produced usage; otherwise describe the next request. */
export function resolveCliModelAccessRoute({
  apiMode,
  subscriptionActive,
  kimiCodeActive,
  usageRoute,
}: {
  readonly apiMode: CliApiMode;
  readonly subscriptionActive: boolean;
  readonly kimiCodeActive?: boolean;
  readonly usageRoute?: UsageRoute;
}): CliModelAccessRoute {
  if (usageRoute !== undefined) {
    switch (usageRoute) {
      case 'chatgpt-subscription':
        return 'chatgpt';
      case 'kimi-code-subscription':
        return 'kimi-code';
      case 'relay':
        return 'included';
      case 'api-key':
        // A completed request's route cannot change, so never relabel ordinary
        // API-key usage from live preferences.
        return 'personal';
      default:
        return usageRoute satisfies never;
    }
  }
  if (subscriptionActive) return 'chatgpt';
  // The Kimi Code route only describes personal access — under included
  // access the relay owns eligible models.
  if (kimiCodeActive === true && apiMode === 'personal') return 'kimi-code';
  return apiMode;
}

export function shortCliModelAccessRoute(route: CliModelAccessRoute): string {
  if (route === 'chatgpt') return 'subscription';
  return route;
}

export function formatCliModelAccessRoute(route: CliModelAccessRoute): string {
  switch (route) {
    case 'chatgpt':
      return 'ChatGPT subscription';
    case 'kimi-code':
      return 'Kimi Code subscription';
    case 'included':
      return 'Included TeXRA access';
    case 'personal':
      return 'Personal API keys';
    default:
      return route satisfies never;
  }
}

/** Sentence-fragment form derived from the canonical access label. */
export function formatCliModelAccessRouteInline(
  route: CliModelAccessRoute,
): string {
  const label = formatCliModelAccessRoute(route);
  // Proper-noun labels keep their casing; plain labels lowercase like prose.
  return route === 'chatgpt' || route === 'kimi-code'
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);
}

/** Format the ChatGPT preference independently of credential availability. */
export function formatCliChatGptPreference(
  status: CliModelAccessStatus,
): string {
  if (status.preferences.chatGpt === 'on' && status.chatGptSignedIn) {
    return `On · ${status.chatGptAccountLabel ?? 'your account'}`;
  }
  if (status.chatGptSignedIn) {
    return `Off · ${status.chatGptAccountLabel ?? 'your account'}`;
  }
  return status.preferences.chatGpt === 'on'
    ? 'On · sign in required'
    : 'Off · sign in required to enable';
}

/** Format the Kimi preference independently of key availability. */
export function formatCliKimiCodePreference(
  status: CliModelAccessStatus,
): string {
  if (status.preferences.kimiCode === 'on' && status.kimiCodeKeySet !== true) {
    return 'On · key required';
  }
  if (status.preferences.kimiCode === 'on') return 'On · key configured';
  return status.kimiCodeKeySet === true
    ? 'Off · key configured'
    : 'Off · key required to enable';
}

const cliSubscriptionAccessItems = [
  {
    provider: 'chatgpt',
    preference: 'chatGpt',
    label: 'Prefer ChatGPT subscription',
    formatDescription: formatCliChatGptPreference,
  },
  {
    provider: 'kimi-code',
    preference: 'kimiCode',
    label: 'Prefer Kimi Code subscription',
    formatDescription: formatCliKimiCodePreference,
  },
] as const satisfies ReadonlyArray<{
  readonly provider: CliSubscriptionProvider;
  readonly preference: keyof CliSubscriptionPreferences;
  readonly label: string;
  readonly formatDescription: (status: CliModelAccessStatus) => string;
}>;

/** Build the canonical choices shown by every model-access picker. */
export function buildCliModelAccessItems(
  input: CliModelAccessItemsInput,
): CliModelAccessItem[] {
  const status = input.kind === 'loaded' ? input.access : undefined;
  let pendingDescription = '';
  if (input.kind === 'pending') {
    pendingDescription =
      input.state === 'loading'
        ? 'Loading current preference'
        : 'Current preference unavailable';
  }
  const preferenceItems = cliSubscriptionAccessItems.map(
    ({ formatDescription, label, preference, provider }) => {
      const state: CliSubscriptionPreferenceState =
        status?.preferences[preference] === 'on' ? 'off' : 'on';
      return {
        value: {
          kind: 'subscription-preference' as const,
          provider,
          state,
        },
        label,
        description: status ? formatDescription(status) : pendingDescription,
        ...(status === undefined ? { disabled: true } : {}),
      };
    },
  ) satisfies CliModelAccessItem[];
  return [
    ...preferenceItems,
    {
      value: cliApiFallbackSelection('included'),
      label: formatCliModelAccessRoute('included'),
      description:
        status?.texraSignedIn === false
          ? 'Sign in through Account to use included models'
          : 'Use your TeXRA account',
    },
    {
      value: cliApiFallbackSelection('personal'),
      label: formatCliModelAccessRoute('personal'),
      description: 'Use keys configured on this computer',
    },
  ];
}

/** Compact configuration summary; observed per-request routes use UsageRoute. */
export function formatCliModelAccessSummary(
  status: CliModelAccessStatus,
): string {
  const chatGpt = status.preferences.chatGpt === 'on' ? 'On' : 'Off';
  const kimiCode = status.preferences.kimiCode === 'on' ? 'On' : 'Off';
  return `ChatGPT ${chatGpt} · Kimi ${kimiCode} · fallback: ${formatCliModelAccessRouteInline(status.apiFallback)}`;
}
