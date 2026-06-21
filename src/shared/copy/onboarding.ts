/**
 * Canonical onboarding-funnel copy (PRD: agent-native onboarding — one
 * funnel, three surfaces).
 *
 * The CLI first-run picker, the extension/desktop welcome card, and the
 * walkthrough import these strings instead of paraphrasing each other, so the
 * choice order and recommendation can never drift between surfaces.
 * Surface-specific hints (e.g. "run `texra login`" vs. a settings link) stay
 * in the surface that owns them.
 */

export const ONBOARDING_CARD_TITLE = 'Welcome to TeXRA';

/** State 0 choice 1 — recommended. */
export const ONBOARDING_CHOICE_SIGN_IN = {
  label: 'Sign in — free for academics',
  description: 'Researcher Access: no API key needed (recommended)',
} as const;

/** State 0 choice 2. */
export const ONBOARDING_CHOICE_CHATGPT = {
  label: 'Use ChatGPT subscription',
  description: 'Codex models through your ChatGPT plan',
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
  'Setup is the doorman, polish is the demo, the orchestrator is the habit.';
