import type { DeclinableUsageRoute, UsageRoute } from '@shared/schemas';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
  type CodingPlanSubscriptionId,
} from '@shared/codingPlanSubscriptions';
import {
  SUBSCRIPTION_AUTH_PROVIDERS,
  type SubscriptionAuthStatus,
} from '@shared/settingsView/settingsViewMessages';
import {
  CHATGPT_AUTH,
  GROK_AUTH,
  RESEARCHER_ACCESS_AUTH,
  SUBSCRIPTION_AUTH_COPY,
} from '@ui/copy/accountAuth';
import { OWN_API_KEYS } from '@ui/copy/modelAccess';
import { RESEARCHER_ACCESS } from '@ui/copy/onboarding';

// Kept to one rendered row: the /login form and the account panel both
// budget a single line for this description (75 columns at most).
export const CLI_ACCOUNT_ACCESS_DESCRIPTION =
  'Sign in or out, set subscription preferences, and how the rest is paid for.';

type CliSubscriptionProvider =
  SubscriptionAuthStatus['provider'] | CodingPlanSubscription['cliProvider'];

interface CliCodingPlanStatus {
  readonly preferred: boolean;
  readonly keySet: boolean;
}

export type CliModelAccessSelection = {
  readonly kind: 'subscription-preference';
  readonly provider: CliSubscriptionProvider;
  /** The preference state the selection turns on or off. */
  readonly state: 'off' | 'on';
};

export interface CliModelAccessStatus {
  /** Each OAuth subscription's session and independent preference: the
   *  shape every settings view reads, keyed by its provider. */
  readonly subscriptions: Readonly<
    Record<SubscriptionAuthStatus['provider'], SubscriptionAuthStatus>
  >;
  readonly codingPlans: Readonly<
    Record<CodingPlanSubscriptionId, CliCodingPlanStatus>
  >;
  readonly texraSignedIn?: boolean;
  readonly texraAccountLabel?: string;
}

export type CliAccountStatus = CliModelAccessStatus & {
  readonly texraSignedIn: boolean;
};

interface CliModelAccessItem {
  readonly value: CliModelAccessSelection;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
}

export type CliModelAccessItemsInput =
  | {
      readonly kind: 'loaded';
      readonly access: CliModelAccessStatus;
    }
  | {
      readonly kind: 'pending';
      readonly state: 'failed' | 'loading';
    };

/** Own API keys (or no route yet) are the default; every other route is a
 *  subscription the run can decline. */
export function isSubscriptionRoute(
  route: UsageRoute | undefined,
): route is DeclinableUsageRoute {
  return route !== undefined && route !== 'api-key';
}

export function formatCliModelAccessRoute(
  route: UsageRoute | undefined,
): string {
  switch (route) {
    case 'chatgpt-subscription':
      return CHATGPT_AUTH.subscriptionLabel;
    case 'xai-subscription':
      return GROK_AUTH.subscriptionLabel;
    case 'kimi-code-subscription':
      return 'Kimi Code subscription';
    case 'glm-coding-plan-subscription':
      return 'GLM Coding Plan';
    case undefined:
    case 'api-key':
      return OWN_API_KEYS.label;
    default:
      return route satisfies never;
  }
}

/** Sentence-fragment form derived from the canonical access label. */
export function formatCliModelAccessRouteInline(
  route: UsageRoute | undefined,
): string {
  const label = formatCliModelAccessRoute(route);
  // Proper-noun labels keep their casing; plain labels lowercase like prose.
  return isSubscriptionRoute(route)
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);
}

/** The account a subscription session is signed in as, when it names one. */
export function subscriptionAccountLabel(
  status: SubscriptionAuthStatus,
): string | undefined {
  return status.email ?? status.accountId ?? undefined;
}

/** Format one subscription preference independently of its session. */
export function formatCliSubscriptionPreference(
  status: SubscriptionAuthStatus,
): string {
  const account = subscriptionAccountLabel(status) ?? 'your account';
  if (status.preferSubscription && status.signedIn) return `On · ${account}`;
  if (status.signedIn) return `Off · ${account}`;
  return status.preferSubscription
    ? 'On · sign in required'
    : 'Off · sign in required to enable';
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
  const oauthPreferenceItems = SUBSCRIPTION_AUTH_PROVIDERS.map((provider) => {
    const subscription = status?.subscriptions[provider];
    return {
      value: {
        kind: 'subscription-preference' as const,
        provider,
        state: subscription?.preferSubscription ? 'off' : 'on',
      },
      label: SUBSCRIPTION_AUTH_COPY[provider].preferLabel,
      description: subscription
        ? formatCliSubscriptionPreference(subscription)
        : pendingDescription,
      ...(status === undefined ? { disabled: true } : {}),
    };
  }) satisfies CliModelAccessItem[];
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

export interface CliAccountAccessRow {
  readonly provider: SubscriptionAuthStatus['provider'] | 'texra';
  readonly operation: 'sign-in' | 'sign-out';
  readonly label: string;
  readonly description: string;
}

/**
 * Account rows of the merged account & access surfaces, deduped per provider
 * by sign-in state and stored preference. A signed-in subscription gets
 * exactly one sign-out row. A signed-out one gets a browser sign-in row only
 * when its preference is still 'on' (an expired or revoked session blocking
 * the preference) — with the preference 'off' the toggle row is already the
 * sign-in path, and a second row would be two controls for one action. TeXRA
 * has no toggle, so it gets a sign-out row whenever it is signed in; its
 * sign-in rows stay surface-specific.
 */
export function buildCliAccountAccessRows(
  status: CliModelAccessStatus,
): readonly CliAccountAccessRow[] {
  const rows: CliAccountAccessRow[] = [];
  for (const provider of SUBSCRIPTION_AUTH_PROVIDERS) {
    const subscription = status.subscriptions[provider];
    const copy = SUBSCRIPTION_AUTH_COPY[provider];
    if (subscription.signedIn) {
      rows.push({
        provider,
        operation: 'sign-out',
        label: copy.signOutLabel,
        description:
          subscriptionAccountLabel(subscription) ?? copy.subscriptionLabel,
      });
    } else if (subscription.preferSubscription) {
      rows.push({
        provider,
        operation: 'sign-in',
        label: copy.signInLabel,
        description: copy.signInDescription,
      });
    }
  }
  if (status.texraSignedIn === true) {
    rows.push({
      provider: 'texra',
      operation: 'sign-out',
      label: RESEARCHER_ACCESS_AUTH.signOutDescription,
      description: status.texraAccountLabel ?? RESEARCHER_ACCESS.label,
    });
  }
  return rows;
}
