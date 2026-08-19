import type { UsageRoute } from '@shared/schemas';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
  type CodingPlanSubscriptionId,
} from '@shared/codingPlanSubscriptions';
import { OWN_API_KEYS } from '@shared/copy/modelAccess';

// Kept to one rendered row: the /api form and the orchestration header both
// budget a single line for this description.
export const CLI_MODEL_ACCESS_DESCRIPTION =
  'Set subscription preferences and how the rest is paid for.';

export type CliModelAccessRoute =
  | 'chatgpt'
  | 'grok'
  | 'kimi-code'
  | 'glm-code'
  // LEGACY: renders historical usage recorded on the retired relay route
  // (removed 2026-08; see docs/proposals/2026-08-18-relay-removal-and-recovery.md).
  | 'included'
  | 'personal';

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
}

export type CliModelAccessSelection = {
  readonly kind: 'subscription-preference';
  readonly provider: CliSubscriptionProvider;
  readonly state: CliSubscriptionPreferenceState;
};

export interface CliModelAccessStatus {
  /** Independent provider preferences; either, both, or neither may be on. */
  readonly preferences: CliSubscriptionPreferences;
  readonly chatGptSignedIn: boolean;
  readonly chatGptAccountLabel?: string;
  readonly grokSignedIn: boolean;
  readonly grokAccountLabel?: string;
  readonly codingPlans: Readonly<
    Record<CodingPlanSubscriptionId, CliCodingPlanStatus>
  >;
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

export function parseCliModelAccessSelection(
  input: string,
): CliModelAccessSelection | undefined {
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
  subscriptionActive,
  grokSubscriptionActive,
  kimiCodeActive,
  glmCodingPlanActive,
  usageRoute,
}: {
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
  if (kimiCodeActive === true) return 'kimi-code';
  if (glmCodingPlanActive === true) return 'glm-code';
  return 'personal';
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
      return 'Included';
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
      return 'Included access';
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

/** Read one plan from the canonical status map. */
export function cliCodingPlanStatus(
  status: CliModelAccessStatus,
  plan: CodingPlanSubscription,
): CliCodingPlanStatus {
  return status.codingPlans[plan.id];
}

/** Format any catalogued coding-plan preference. */
export function formatCliCodingPlanPreference(
  status: CliModelAccessStatus,
  plan: CodingPlanSubscription,
): string {
  const state = cliCodingPlanStatus(status, plan);
  return formatCliKeyedSubscriptionPreference(state.preferred, state.keySet);
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
  return [...oauthPreferenceItems, ...codingPlanItems];
}

/** Compact configuration summary; observed per-request routes use UsageRoute. */
export function formatCliModelAccessSummary(
  status: CliModelAccessStatus,
): string {
  const chatGpt = status.preferences.chatGpt === 'on' ? 'On' : 'Off';
  const grok = status.preferences.grok === 'on' ? 'On' : 'Off';
  const codingPlans = CODING_PLAN_SUBSCRIPTIONS.map((plan) => {
    const label = plan.displayName.split(' ')[0];
    return `${label} ${cliCodingPlanStatus(status, plan).preferred ? 'On' : 'Off'}`;
  });
  return `ChatGPT ${chatGpt} · Grok ${grok} · ${codingPlans.join(' · ')} · otherwise: ${formatCliModelAccessRouteInline('personal')}`;
}
