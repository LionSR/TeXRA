/**
 * Canonical user-facing vocabulary for how model calls are paid for.
 *
 * Model calls billed to your own provider accounts are "your own API keys".
 * Settings pickers, compact status labels, and model availability messages
 * import these strings instead of paraphrasing the internal enum values,
 * which stay wire identifiers and never reach the screen.
 *
 * "Researcher Access" is the program you sign in to; that copy lives in
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

/** User-facing labels and plan status for a {@link UsageRoute}. `label` is
 *  the detailed payment name, `compactLabel` is its width-constrained badge
 *  name, and `subscription` marks routes covered by a top-up-free plan. Hosts
 *  share this contract so payment attribution and compact copy cannot drift. */
interface UsageRouteBadge {
  readonly label: string;
  readonly compactLabel: string;
  readonly subscription: boolean;
}

/** Map a usage route to its display badge, or undefined when the route is
 *  unknown/unset. */
export function usageRouteBadge(
  route: UsageRoute | undefined,
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
    case 'chatgpt-subscription':
      return { label: 'ChatGPT', compactLabel: 'ChatGPT', subscription: true };
    case 'xai-subscription':
      return { label: 'Grok', compactLabel: 'Grok', subscription: true };
    // LEGACY: usage recorded on the retired relay route (producers removed
    // 2026-08, docs/proposals/2026-08-18-relay-removal-and-recovery.md);
    // kept so historical transcripts render honestly. Delete after 2026-11.
    case 'relay':
      return {
        label: 'included access',
        compactLabel: 'Included',
        subscription: false,
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
 * Four outcomes: a subscription route with zero cost is free, a known route
 * is billed "via" its payment name, an unknown route with a cost shows the
 * bare amount, and an unknown route with no cost has nothing to say
 * (`undefined`) so callers can omit the line entirely rather than print
 * "$0.000" for a session that never reached a model.
 */
export function usageCostLabel(
  cost: number,
  route: UsageRoute | undefined,
): string | undefined {
  const badge = usageRouteBadge(route);
  if (!badge) return cost > 0 ? formatCostUsd(cost) : undefined;
  if (badge.subscription && cost === 0) return `Free via ${badge.label}`;
  return `${formatCostUsd(cost)} via ${badge.label}`;
}
