/**
 * Canonical onboarding-funnel copy (PRD: agent-native onboarding — one
 * funnel, three surfaces).
 *
 * The CLI first-run picker, the extension/desktop welcome card, and the
 * walkthrough import these strings instead of paraphrasing each other, so the
 * choice order can never drift between surfaces.
 * Surface-specific hints (e.g. "run `texra login`" vs. a settings link) stay
 * in the surface that owns them.
 *
 * Where a choice names one of the two ways model calls are paid for, the name
 * comes from `modelAccess.ts` so the first-run picker and the model-access
 * setting cannot call the same choice two different things.
 */

import { OWN_API_KEYS } from './modelAccess';

export const ONBOARDING_CARD_TITLE = 'Welcome to TeXRA';

/** State 0 choice 1. */
export const ONBOARDING_CHOICE_CHATGPT = {
  label: 'Use ChatGPT subscription',
  description:
    'OpenAI models through ChatGPT Plus, Pro, or Team; no API key needed',
} as const;

/**
 * The academic program you sign in to for the hosted research-agent catalog.
 */
export const RESEARCHER_ACCESS = {
  label: 'Researcher Access',
} as const;

/**
 * State 0 choice 2. Same name as the model-access setting's option, so the
 * first-run picker and the settings radio group cannot drift apart; the
 * description stays short here because the picker shows one line per choice.
 */
export const ONBOARDING_CHOICE_API_KEY = {
  label: OWN_API_KEYS.option.label,
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

/**
 * State 1 handoff sentence: a credential just landed and the setup assistant
 * owns the next step. The CLI prints it as a transcript notice when the setup
 * agent takes over the first-run session; the extension/desktop setup card
 * shows it under the "Credential ready" title. Surface-specific hints (the
 * CLI's `/agent`, the card's Run-setup button) stay in the surface.
 */
export const ONBOARDING_SETUP_HANDOFF =
  "You're starting with the setup assistant: it checks your environment, applies the right agent team, and helps you run your first task.";
