/**
 * Canonical user-facing vocabulary for how model calls are paid for.
 *
 * Model calls billed to your own provider accounts are "your own API keys".
 * Settings pickers, compact status labels, and model availability messages
 * import these strings instead of paraphrasing the internal enum values,
 * which stay wire identifiers and never reach the screen.
 */

import { formatCostUsd } from '@texra-ai/harness/transcript';
import { absurd, String as Str } from 'effect';
import { codingPlanForUsageRoute } from '@texra/shared/model/codingPlans';
import { CHATGPT_AUTH, GROK_AUTH } from '@ui/copy/accountAuth';
import { formatResetDuration } from '@ui/copy/format';
import type {
  DeclinableUsageRoute,
  RetryPermission,
  TokenUsageStats,
  UsageRoute,
} from '@texra-ai/harness/schemas';

/** The words for each `ModelOptionData.availability` kind. */
export const MODEL_AVAILABILITY_LABEL = {
  'provider-key': 'API key set',
  'missing-key': 'Missing API key',
  'key-unreadable': 'API key unreadable',
  'subscription-access': CHATGPT_AUTH.subscriptionLabel,
  'xai-subscription-access': GROK_AUTH.subscriptionLabel,
  retired: 'Retired',
  unserved: 'Unavailable',
  'unknown-model': 'Unknown model',
} as const;

/**
 * Each plan a model call can bill through, as a person knows it: the name of
 * its switch, which a used-up plan is called by, and what the model takes
 * with the switch off, which a retry moves onto once the plan is used up.
 * Keyed by the route that bills through the plan, the route the harness's
 * failure and fallback notice record.
 */
const PLAN_NAMES = Object.freeze({
  'chatgpt-subscription': {
    plan: CHATGPT_AUTH.subscriptionLabel,
    fallback: 'your own OpenAI API key',
  },
  'xai-subscription': {
    plan: GROK_AUTH.subscriptionLabel,
    fallback: 'your own xAI API key',
  },
  'kimi-code-subscription': {
    plan: codingPlanForUsageRoute('kimi-code-subscription').preferenceLabel,
    fallback: 'your own Moonshot API keys',
  },
  'glm-coding-plan-subscription': {
    plan: codingPlanForUsageRoute('glm-coding-plan-subscription')
      .preferenceLabel,
    fallback: 'the regular GLM endpoint',
  },
} satisfies Record<DeclinableUsageRoute, { plan: string; fallback: string }>);

/** What a model of `route`'s plan takes with the plan's switch off. */
export function planFallbackName(route: DeclinableUsageRoute): string {
  return PLAN_NAMES[route].fallback;
}

/**
 * A model call's failure as a person reads it: a used-up plan in these
 * words, from the facts the run recorded (the plan, its tier and when it
 * resets); any other failure as the harness worded it.
 */
export function modelFailureText({
  message,
  classification,
}: Pick<
  RetryPermission['errorDetails'],
  'message' | 'classification'
>): string {
  if (classification === undefined) return message;
  switch (classification.kind) {
    case 'missing-api-key':
    case 'context-window':
    case 'upstream-credit':
      return message;
    default: {
      const { plan, fallback } = PLAN_NAMES[classification.kind];
      const tier = classification.planType
        ? ` (${Str.capitalize(classification.planType)} plan)`
        : '';
      const reset =
        classification.resetsInMs === undefined
          ? ''
          : ` Resets in ${formatResetDuration(classification.resetsInMs)}.`;
      return `${plan} usage limit reached${tier}.${reset} Switch to ${fallback} to keep working, or wait until the limit resets.`;
    }
  }
}

/** The notice of a used-up plan's automatic retry on the model's own key. */
export function quotaFallbackNoticeText(route: DeclinableUsageRoute): string {
  const { plan, fallback } = PLAN_NAMES[route];
  return `${plan} usage limit reached; retrying with ${fallback}.`;
}

/** Model calls paid for by your own provider accounts. */
export const OWN_API_KEYS = {
  /** Standalone display name, e.g. a section heading or detailed status. */
  label: 'Your own API keys',
  /** Width-constrained badge or status label. */
  compactLabel: 'API keys',
  /** Same name inside a sentence. */
  inline: 'your own API keys',
  /** Model-access picker option. */
  option: {
    label: 'Use your own API keys',
  },
} as const;

/** One plan's API-credit reminder: the hint under its provider's key row
 *  and the page that carries the amounts, which change. */
export interface PlanCredits {
  readonly hint: string;
  readonly docLabel: string;
  readonly docUrl: string;
}

/**
 * The reminders beside a provider key for consumer plans that include API
 * credits, keyed by the provider whose key spends them. Claude Max and Team
 * plans include monthly Claude API credits, spent through an ordinary Console
 * API key once a Console organization is linked to the plan. ChatGPT Pro and
 * Business plans include monthly OpenAI API credits, claimed in ChatGPT's
 * billing settings for an API organization the subscriber owns and spent
 * through an ordinary OpenAI API key; the ChatGPT sign-in (Codex) does not
 * draw on them. Amounts stay on the linked pages because they change.
 */
const PLAN_CREDITS: Readonly<Record<string, PlanCredits>> = Object.freeze({
  anthropic: {
    hint: "Claude Max or Team? Your plan includes monthly API credits. Link a Console organization in claude.ai's Billing settings, then add a Console API key here.",
    docLabel: 'About plan API credits',
    docUrl:
      'https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers',
  },
  openai: {
    hint: "ChatGPT Pro or Business? Your plan includes monthly API credits. Claim them in ChatGPT's Billing settings for an API organization you own, then add an OpenAI API key here.",
    docLabel: 'About plan API credits',
    docUrl:
      'https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions',
  },
});

/** The plan-credits reminder for `provider`'s key, or undefined when no
 *  consumer plan of that provider includes API credits. */
export function planCreditsHint(provider: string): PlanCredits | undefined {
  return PLAN_CREDITS[provider];
}

/** The one-line form of the reminders above, where a surface names the
 *  API-key choice once for every provider rather than one row per key. */
export const PLAN_CREDITS_SUMMARY =
  "Claude Max or Team, or ChatGPT Pro or Business? Your plan includes monthly API credits you can spend through that provider's API key.";

/**
 * Display names for the ChatGPT plans the Codex token can name, keyed by the
 * `chatgpt_plan_type` claim. An unlisted plan renders as no plan at all
 * rather than as a raw wire word, so a backend that invents a tier degrades
 * to "ChatGPT subscription" instead of printing "ChatGPT enterprise_v2".
 */
const CHATGPT_PLAN_NAMES: Readonly<Record<string, string>> = Object.freeze({
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  edu: 'Edu',
  enterprise: 'Enterprise',
});

/** The display name for a `chatgpt_plan_type`, or undefined when unknown. */
function chatGptPlanName(planType: string | undefined): string | undefined {
  if (!planType) return undefined;
  return CHATGPT_PLAN_NAMES[planType.trim().toLowerCase()];
}

/** User-facing labels and plan status for a {@link UsageRoute}. `label` is
 *  the detailed payment name, `compactLabel` is its width-constrained badge
 *  name, and `subscription` marks routes covered by a top-up-free plan. Hosts
 *  share this contract so payment attribution and compact copy cannot drift. */
interface UsageRouteBadge {
  readonly label: string;
  readonly compactLabel: string;
  readonly subscription: boolean;
}

/**
 * Map a usage route to its display badge, or undefined when the route is
 * unknown/unset. `plan` is the route's own plan word when it carries one
 * (today only the ChatGPT subscription does); naming the tier is what keeps
 * a subscription call from reading as "free", which users read as "this call
 * was not covered by anything".
 */
export function usageRouteBadge(
  route: UsageRoute | undefined,
  plan?: string,
): UsageRouteBadge | undefined {
  switch (route) {
    case 'kimi-code-subscription':
    case 'glm-coding-plan-subscription': {
      const { displayName } = codingPlanForUsageRoute(route);
      return {
        label: displayName,
        compactLabel: displayName,
        subscription: true,
      };
    }
    case 'chatgpt-subscription': {
      const planName = chatGptPlanName(plan);
      return planName
        ? {
            label: `ChatGPT ${planName}`,
            compactLabel: `ChatGPT ${planName}`,
            subscription: true,
          }
        : {
            label: 'ChatGPT subscription',
            compactLabel: 'ChatGPT',
            subscription: true,
          };
    }
    case 'xai-subscription':
      return {
        label: 'Grok subscription',
        compactLabel: 'Grok',
        subscription: true,
      };
    case 'api-key':
      return {
        label: OWN_API_KEYS.inline,
        compactLabel: OWN_API_KEYS.compactLabel,
        subscription: false,
      };
    case undefined:
      return undefined;
    default:
      return absurd(route);
  }
}

/**
 * One sentence stating what a usage record cost and who paid for it.
 *
 * Three outcomes: a subscription route with zero cost is stated as included in
 * the plan that covers it, a known route is billed "via" its payment name,
 * and an unknown route shows the bare amount. A caller that omits the line
 * for a session that never reached a model tests that itself.
 *
 * A covered call never says "free": the user is paying for the plan, and
 * "free" reads as "nothing paid for this".
 */
export function usageCostLabel({
  cost,
  usageRoute,
  usagePlan,
}: Pick<TokenUsageStats, 'cost' | 'usageRoute' | 'usagePlan'>): string {
  const badge = usageRouteBadge(usageRoute, usagePlan);
  if (!badge) return formatCostUsd(cost);
  if (badge.subscription && cost === 0) return `Included in ${badge.label}`;
  return `${formatCostUsd(cost)} via ${badge.label}`;
}
