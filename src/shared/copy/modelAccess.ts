/**
 * Canonical user-facing vocabulary for how model calls are paid for.
 *
 * Two concepts, two names, everywhere: model calls covered by your TeXRA plan
 * are "included access", and model calls billed to your own provider accounts
 * are "your own API keys". Settings pickers, quota notices, and model
 * availability messages import these strings instead of paraphrasing the
 * transport ("relay") or the internal enum values ('included' / 'personal'),
 * which stay wire identifiers and never reach the screen.
 *
 * "Researcher Access" is the free program you sign in to, not a name for
 * included access; that copy lives in `onboarding.ts`.
 */

import type { UsageRoute } from '@shared/schemas';

/** Model calls paid for by your TeXRA plan. */
export const INCLUDED_ACCESS = {
  /** Standalone display name, e.g. a section heading or a status chip. */
  label: 'Included access',
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
  /** Standalone display name, e.g. a section heading or a status chip. */
  label: 'Your own API keys',
  /** Same name inside a sentence. */
  inline: 'your own API keys',
  /** Model-access picker option. */
  option: {
    label: 'Use your own API keys',
    description:
      'Model calls are billed to your own accounts at OpenAI, Anthropic, and other providers. You get higher limits, plus the models your plan does not cover.',
  },
} as const;

/** User-facing label and plan status for a {@link UsageRoute}. The label is
 *  the payment surface's display name — "included access", "your own API
 *  keys", or the subscription it runs on — and `subscription` marks routes
 *  covered by a top-up-free subscription plan. Hosts (CLI exit summary,
 *  extension usage panel) share this so payment attribution can't drift
 *  between surfaces. */
export interface UsageRouteBadge {
  readonly label: string;
  readonly subscription: boolean;
}

/** Map a usage route to its display badge, or undefined when the route is
 *  unknown/unset. */
export function usageRouteBadge(
  route: UsageRoute | undefined,
): UsageRouteBadge | undefined {
  switch (route) {
    case 'chatgpt-subscription':
      return { label: 'ChatGPT', subscription: true };
    case 'xai-subscription':
      return { label: 'Grok', subscription: true };
    case 'kimi-code-subscription':
      return { label: 'Kimi Code', subscription: true };
    case 'relay':
      return { label: INCLUDED_ACCESS.inline, subscription: false };
    case 'api-key':
      return { label: OWN_API_KEYS.inline, subscription: false };
    default:
      return undefined;
  }
}
