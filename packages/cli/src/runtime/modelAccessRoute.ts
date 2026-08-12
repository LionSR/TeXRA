import type { UsageRoute } from '@shared/schemas';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
  type CodingPlanSubscriptionId,
} from '@shared/codingPlanSubscriptions';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';

import { parseCliApiMode } from './apiAccessMode';

// Kept to one rendered row: the /api form and the orchestration header both
// budget a single line for this description.
export const CLI_MODEL_ACCESS_DESCRIPTION =
  'Set subscription preferences and how the rest is paid for.';

export type CliModelAccessRoute =
  'chatgpt' | 'grok' | 'kimi-code' | 'glm-code' | 'included' | 'personal';

type CliSubscriptionPreferenceState = 'off' | 'on';
type CliSubscriptionProvider =
  'chatgpt' | 'grok' | CodingPlanSubscription['cliProvider'];

export interface CliCodingPlanStatus {
  readonly preferred: boolean;
  readonly keySet: boolean;
}

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
  /** Canonical coding-plan state; legacy named fields above remain readable. */
  readonly codingPlans?: Readonly<
    Record<CodingPlanSubscriptionId, CliCodingPlanStatus>
  >;
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

  const normalized = input.trim().toLowerCase();
  const codingPlan = CODING_PLAN_SUBSCRIPTIONS.find((plan) =>
    plan.cliAliases.includes(normalized),
  );
  if (codingPlan) {
    return {
      kind: 'subscription-preference',
      provider: codingPlan.cliProvider,
      state: 'on',
    };
  }

  switch (normalized) {
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
  glmCodingPlanActive,
  usageRoute,
}: {
  readonly apiMode: ApiAccessMode;
  /** Whether the current model would route through ChatGPT/Codex. */
  readonly subscriptionActive: boolean;
  /** Whether the current model would route through Grok/xAI OAuth. */
  readonly grokSubscriptionActive?: boolean;
  readonly kimiCodeActive?: boolean;
  readonly glmCodingPlanActive?: boolean;
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
      case 'glm-coding-plan-subscription':
        return 'glm-code';
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
  if (glmCodingPlanActive === true && apiMode === 'personal') return 'glm-code';
  return apiMode;
}

/** Status-bar form of the access route. Width-critical, so every arm is a
 *  short display phrase; the enum value itself never reaches the screen. */
export function shortCliModelAccessRoute(route: CliModelAccessRoute): string {
  switch (route) {
    case 'chatgpt':
    case 'grok':
    case 'kimi-code':
    case 'glm-code':
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
    case 'glm-code':
      return 'GLM Coding Plan';
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
  return route === 'chatgpt' ||
    route === 'grok' ||
    route === 'kimi-code' ||
    route === 'glm-code'
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

function formatCliKeyedSubscriptionPreference(
  preferenceOn: boolean,
  keySet: boolean | undefined,
): string {
  if (preferenceOn && keySet !== true) return 'On · key required';
  if (preferenceOn) return 'On · key configured';
  return keySet === true
    ? 'Off · key configured'
    : 'Off · key required to enable';
}

/** Read one plan from the canonical status map, with named-field fallback. */
export function cliCodingPlanStatus(
  status: CliModelAccessStatus,
  plan: CodingPlanSubscription,
): CliCodingPlanStatus {
  const canonical = status.codingPlans?.[plan.id];
  if (canonical) return canonical;
  return plan.id === 'kimiCode'
    ? {
        preferred: status.preferences.kimiCode === 'on',
        keySet: status.kimiCodeKeySet === true,
      }
    : {
        preferred: status.preferences.glmCode === 'on',
        keySet: status.glmKeySet === true,
      };
}

/** Format any catalogued coding-plan preference. */
export function formatCliCodingPlanPreference(
  status: CliModelAccessStatus,
  plan: CodingPlanSubscription,
): string {
  const state = cliCodingPlanStatus(status, plan);
  return formatCliKeyedSubscriptionPreference(state.preferred, state.keySet);
}

/** Format the Kimi preference independently of key availability. */
export function formatCliKimiCodePreference(
  status: CliModelAccessStatus,
): string {
  const plan = CODING_PLAN_SUBSCRIPTIONS.find(
    (candidate) => candidate.id === 'kimiCode',
  );
  if (!plan) return 'Off · key required to enable';
  return formatCliCodingPlanPreference(status, plan);
}

/** Format the GLM Coding Plan preference independently of key availability. */
export function formatCliGlmCodingPlanPreference(
  status: CliModelAccessStatus,
): string {
  const plan = CODING_PLAN_SUBSCRIPTIONS.find(
    (candidate) => candidate.id === 'glmCodingPlan',
  );
  if (!plan) return 'Off · key required to enable';
  return formatCliCodingPlanPreference(status, plan);
}

const oauthSubscriptionAccessItems = [
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
] as const satisfies ReadonlyArray<{
  readonly provider: 'chatgpt' | 'grok';
  readonly preference: 'chatGpt' | 'grok';
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
  const oauthPreferenceItems = oauthSubscriptionAccessItems.map(
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
  const codingPlanItems = CODING_PLAN_SUBSCRIPTIONS.map((plan) => {
    const planStatus = status ? cliCodingPlanStatus(status, plan) : undefined;
    return {
      value: {
        kind: 'subscription-preference' as const,
        provider: plan.cliProvider,
        state: planStatus?.preferred ? ('off' as const) : ('on' as const),
      },
      label: plan.preferenceLabel,
      description: planStatus
        ? formatCliKeyedSubscriptionPreference(
            planStatus.preferred,
            planStatus.keySet,
          )
        : pendingDescription,
      ...(status === undefined ? { disabled: true } : {}),
    };
  });
  return [
    ...oauthPreferenceItems,
    ...codingPlanItems,
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
  const codingPlans = CODING_PLAN_SUBSCRIPTIONS.map((plan) => {
    const label = plan.apiProvider === 'kimiCode' ? 'Kimi' : 'GLM';
    return `${label} ${cliCodingPlanStatus(status, plan).preferred ? 'On' : 'Off'}`;
  });
  return `ChatGPT ${chatGpt} · Grok ${grok} · ${codingPlans.join(' · ')} · otherwise: ${formatCliModelAccessRouteInline(status.apiFallback)}`;
}
