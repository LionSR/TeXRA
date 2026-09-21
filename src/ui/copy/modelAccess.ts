/**
 * Canonical user-facing vocabulary for how model calls are paid for.
 *
 * Model calls billed to your own provider accounts are "your own API keys".
 * Settings pickers, compact status labels, and model availability messages
 * import these strings instead of paraphrasing the internal enum values,
 * which stay wire identifiers and never reach the screen.
 *
 * "TeXRA account" is the account you sign in to; that copy lives in
 * `onboarding.ts`.
 */

import type { UsageRoute } from '@shared/schemas';
import { codingPlanForUsageRoute } from '@shared/codingPlanSubscriptions';
import { assertNever } from '@utils/core';
import { formatCostUsd } from '@utils/text/stringUtils';

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
    description:
      'Model calls are billed to your own accounts at OpenAI, Anthropic, and other providers. You get higher limits, plus the models your plan does not cover.',
  },
} as const;

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
  const codingPlan = codingPlanForUsageRoute(route);
  if (codingPlan) {
    return {
      label: codingPlan.displayName,
      compactLabel: codingPlan.displayName,
      subscription: true,
    };
  }
  switch (route) {
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
    case 'kimi-code-subscription':
    case 'glm-coding-plan-subscription':
      throw new Error(`Missing coding-plan copy for usage route: ${route}`);
    case undefined:
      return undefined;
    default:
      return assertNever(route, 'Unhandled usage route');
  }
}

/**
 * One sentence stating what a usage record cost and who paid for it.
 *
 * Four outcomes: a subscription route with zero cost is stated as included in
 * the plan that covers it, a known route is billed "via" its payment name, an
 * unknown route with a cost shows the bare amount, and an unknown route with
 * no cost has nothing to say (`undefined`) so callers can omit the line
 * entirely rather than print "$0.000" for a session that never reached a
 * model.
 *
 * A covered call never says "free": the user is paying for the plan, and
 * "free" reads as "nothing paid for this".
 */
export function usageCostLabel(
  cost: number,
  route: UsageRoute | undefined,
  plan?: string,
): string | undefined {
  const badge = usageRouteBadge(route, plan);
  if (!badge) return cost > 0 ? formatCostUsd(cost) : undefined;
  if (badge.subscription && cost === 0) return `Included in ${badge.label}`;
  return `${formatCostUsd(cost)} via ${badge.label}`;
}
