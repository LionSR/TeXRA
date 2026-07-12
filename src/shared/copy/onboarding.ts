/**
 * Canonical onboarding-funnel copy (PRD: agent-native onboarding — one
 * funnel, three surfaces).
 *
 * The CLI first-run picker, the extension/desktop welcome card, and the
 * walkthrough import these strings instead of paraphrasing each other, so the
 * choice order can never drift between surfaces.
 * Surface-specific hints (e.g. "run `texra login`" vs. a settings link) stay
 * in the surface that owns them.
 */

export const ONBOARDING_CARD_TITLE = 'Welcome to TeXRA';

/** State 0 choice 1. */
export const ONBOARDING_CHOICE_CHATGPT = {
  label: 'Use ChatGPT subscription',
  description:
    'OpenAI models through ChatGPT Plus, Pro, or Team; no API key needed',
} as const;

/** State 0 choice 2. */
export const ONBOARDING_CHOICE_SIGN_IN = {
  label: 'Sign in with Researcher Access',
  description: 'Free for academics; no API key needed',
} as const;

/** State 0 choice 3. */
export const ONBOARDING_CHOICE_API_KEY = {
  label: 'Use your own provider API key',
  description: 'Anthropic, OpenAI, Google, and more',
} as const;

/** State 0 choice 4 - quiet link, persists the shared declined flag. */
export const ONBOARDING_CHOICE_SKIP_LABEL = 'Skip for now';

/**
 * The one-line narrative every surface hangs off. Used by the walkthrough and
 * docs lede; product surfaces express it through behavior, not this sentence.
 */
export const ONBOARDING_NARRATIVE =
  'Run setup once: TeXRA checks LaTeX, applies the right agent team, and starts your first polish.';
