/**
 * Canonical user-facing vocabulary for how model calls are paid for.
 *
 * Two concepts use canonical forms for each context. Model calls covered by
 * your TeXRA plan are "included access", and model calls billed to your own
 * provider accounts are "your own API keys". Settings pickers, quota notices,
 * compact status labels, and model availability messages import these strings
 * instead of paraphrasing the transport ("relay") or the internal enum values
 * ('included' / 'personal'), which stay wire identifiers and never reach the
 * screen.
 *
 * "Researcher Access" is the free program you sign in to, not a name for
 * included access; that copy lives in `onboarding.ts`.
 */

import type { UsageRoute } from '@shared/schemas';

/** Model calls paid for by your TeXRA plan. */
export const INCLUDED_ACCESS = {
  /** Standalone display name, e.g. a section heading or detailed status. */
  label: 'Included access',
  /** Width-constrained badge or status label. */
  compactLabel: 'Included',
  /** Same name inside a sentence. */
  inline: 'included access',
  /** Model-access picker option. */
  option: {
    label: 'Use included access',
    description:
      'Model calls are covered by your TeXRA plan, with no setup needed. OpenRouter is the exception: those models always use your OpenRouter key.',
  },
  /** Shown once the month's included access is spent. */
  usedUp: {
    statement: "You've used all of this month's included access.",
    nextStep:
      'Switch to your own API keys to keep going, or wait until next month.',
  },
} as const;

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
  switch (route) {
    case 'chatgpt-subscription':
      return { label: 'ChatGPT', compactLabel: 'ChatGPT', subscription: true };
    case 'xai-subscription':
      return { label: 'Grok', compactLabel: 'Grok', subscription: true };
    case 'kimi-code-subscription':
      return {
        label: 'Kimi Code',
        compactLabel: 'Kimi Code',
        subscription: true,
      };
    case 'relay':
      return {
        label: INCLUDED_ACCESS.inline,
        compactLabel: INCLUDED_ACCESS.compactLabel,
        subscription: false,
      };
    case 'api-key':
      return {
        label: OWN_API_KEYS.inline,
        compactLabel: OWN_API_KEYS.compactLabel,
        subscription: false,
      };
    default:
      return undefined;
  }
}
