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
