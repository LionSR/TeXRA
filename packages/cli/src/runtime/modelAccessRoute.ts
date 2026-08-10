import type { UsageRoute } from '@shared/schemas';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';

import { parseCliApiMode } from './apiAccessMode';

// Kept to one rendered row: the /api form and the orchestration header both
// budget a single line for this description.
export const CLI_MODEL_ACCESS_DESCRIPTION =
  'Set subscription preferences and how the rest is paid for.';

export type CliModelAccessRoute =
  'chatgpt' | 'grok' | 'kimi-code' | 'included' | 'personal';

type CliSubscriptionPreferenceState = 'off' | 'on';
type CliSubscriptionProvider = 'chatgpt' | 'grok' | 'kimi-code' | 'glm-code';

interface CliSubscriptionPreferences {
  readonly chatGpt: CliSubscriptionPreferenceState;
  readonly grok: CliSubscriptionPreferenceState;
  readonly kimiCode: CliSubscriptionPreferenceState;
  readonly glmCode: CliSubscriptionPreferenceState;
}

export type CliModelAccessSelection =
  | {
      readonly kind: 'subscription-preference';
      readonly provider: CliSubscriptionProvider;
      readonly state: CliSubscriptionPreferenceState;
    }
  | {
      readonly kind: 'api-fallback';
      readonly apiMode: ApiAccessMode;
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
} as const satisfies Record<ApiAccessMode, CliApiFallbackSelection>);

export interface CliModelAccessStatus {
  readonly apiFallback: ApiAccessMode;
  /** Independent provider preferences; either, both, or neither may be on. */
  readonly preferences: CliSubscriptionPreferences;
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
  readonly grokSignedIn: boolean;
  readonly grokAccountLabel?: string;
  readonly kimiCodeKeySet?: boolean;
  readonly glmKeySet?: boolean;
  readonly texraSignedIn?: boolean;
  /** Display names of providers with configured API keys (e.g. `['DeepSeek']`). */
  readonly personalKeyProviders?: readonly string[];
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
  apiMode: ApiAccessMode,
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
    case 'grok':
    case 'xai':
    case 'supergrok':
      return {
        kind: 'subscription-preference',
        provider: 'grok',
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
    case 'glm':
    case 'glmcode':
    case 'glm-code':
    case 'glm-coding':
    case 'glm-coding-plan':
      return {
        kind: 'subscription-preference',
        provider: 'glm-code',
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
  grokSubscriptionActive,
  kimiCodeActive,
  usageRoute,
}: {
  readonly apiMode: ApiAccessMode;
  /** Whether the current model would route through ChatGPT/Codex. */
  readonly subscriptionActive: boolean;
  /** Whether the current model would route through Grok/xAI OAuth. */
  readonly grokSubscriptionActive?: boolean;
  readonly kimiCodeActive?: boolean;
  readonly usageRoute?: UsageRoute;
}): CliModelAccessRoute {
  if (usageRoute !== undefined) {
    switch (usageRoute) {
      case 'chatgpt-subscription':
        return 'chatgpt';
      case 'xai-subscription':
        return 'grok';
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
  if (grokSubscriptionActive === true) return 'grok';
  // The Kimi Code route only describes personal access — under included
  // access the relay owns eligible models.
  if (kimiCodeActive === true && apiMode === 'personal') return 'kimi-code';
  return apiMode;
}

/** Status-bar form of the access route. Width-critical, so every arm is a
 *  short display phrase; the enum value itself never reaches the screen. */
export function shortCliModelAccessRoute(route: CliModelAccessRoute): string {
  switch (route) {
    case 'chatgpt':
    case 'grok':
    case 'kimi-code':
      // The bar names how the call is paid for, not which provider; the /api
      // form and /status name the subscription itself.
      return 'subscription';
    case 'included':
      return INCLUDED_ACCESS.compactLabel;
    case 'personal':
      return OWN_API_KEYS.compactLabel;
    default:
      return route satisfies never;
  }
}

export function formatCliModelAccessRoute(route: CliModelAccessRoute): string {
  switch (route) {
    case 'chatgpt':
      return 'ChatGPT subscription';
    case 'grok':
      return 'Grok subscription';
    case 'kimi-code':
      return 'Kimi Code subscription';
    case 'included':
      return INCLUDED_ACCESS.label;
    case 'personal':
      return OWN_API_KEYS.label;
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
  return route === 'chatgpt' || route === 'grok' || route === 'kimi-code'
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);
}

function formatCliSubscriptionPreference(
  state: CliSubscriptionPreferenceState,
  signedIn: boolean,
  accountLabel: string | undefined,
): string {
  const account = accountLabel ?? 'your account';
  if (state === 'on' && signedIn) return `On · ${account}`;
  if (signedIn) return `Off · ${account}`;
  return state === 'on'
    ? 'On · sign in required'
    : 'Off · sign in required to enable';
}

/** Format the ChatGPT preference independently of credential availability. */
export function formatCliChatGptPreference(
  status: CliModelAccessStatus,
): string {
  return formatCliSubscriptionPreference(
    status.preferences.chatGpt,
    status.chatGptSignedIn,
    status.chatGptAccountLabel,
  );
}

/** Format the Grok preference independently of credential availability. */
export function formatCliGrokPreference(status: CliModelAccessStatus): string {
  return formatCliSubscriptionPreference(
    status.preferences.grok,
    status.grokSignedIn,
    status.grokAccountLabel,
  );
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

/** Format the GLM Coding Plan preference independently of key availability. */
export function formatCliGlmCodingPlanPreference(
  status: CliModelAccessStatus,
): string {
  if (status.preferences.glmCode === 'on' && status.glmKeySet !== true) {
    return 'On · key required';
  }
  if (status.preferences.glmCode === 'on') return 'On · key configured';
  return status.glmKeySet === true
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
    provider: 'grok',
    preference: 'grok',
    label: 'Prefer Grok subscription',
    formatDescription: formatCliGrokPreference,
  },
  {
    provider: 'kimi-code',
    preference: 'kimiCode',
    label: 'Prefer Kimi Code subscription',
    formatDescription: formatCliKimiCodePreference,
  },
  {
    provider: 'glm-code',
    preference: 'glmCode',
    label: 'Prefer GLM Coding Plan',
    formatDescription: formatCliGlmCodingPlanPreference,
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
          ? 'Sign in from Account first'
          : 'Covered by your TeXRA plan',
    },
    {
      value: cliApiFallbackSelection('personal'),
      label: formatCliModelAccessRoute('personal'),
      description: status?.personalKeyProviders?.length
        ? `Configured: ${status.personalKeyProviders.join(', ')}`
        : 'Use keys configured on this computer',
    },
  ];
}

/** Compact configuration summary; observed per-request routes use UsageRoute. */
export function formatCliModelAccessSummary(
  status: CliModelAccessStatus,
): string {
  const chatGpt = status.preferences.chatGpt === 'on' ? 'On' : 'Off';
  const grok = status.preferences.grok === 'on' ? 'On' : 'Off';
  const kimiCode = status.preferences.kimiCode === 'on' ? 'On' : 'Off';
  const glmCode = status.preferences.glmCode === 'on' ? 'On' : 'Off';
  return `ChatGPT ${chatGpt} · Grok ${grok} · Kimi ${kimiCode} · GLM ${glmCode} · otherwise: ${formatCliModelAccessRouteInline(status.apiFallback)}`;
}
