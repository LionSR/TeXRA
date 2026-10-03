/**
 * Canonical onboarding-funnel copy (PRD: agent-native onboarding — one
 * funnel, three surfaces).
 *
 * The CLI first-run picker, the extension/desktop welcome card, and the
 * walkthrough import these strings instead of paraphrasing each other, so the
 * choice order can never drift between surfaces.
 * Surface-specific hints (e.g. "run `texra auth chatgpt login`" vs. a settings link) stay
 * in the surface that owns them.
 *
 * Where a choice names one of the two ways model calls are paid for, the name
 * comes from `modelAccess.ts` so the first-run picker and the model-access
 * setting cannot call the same choice two different things.
 */

import { OWN_API_KEYS } from './modelAccess';

/** The one credential prompt: the extension/desktop card and the CLI's
 *  first-run picker carry the same title. */
export const ONBOARDING_CARD_TITLE = 'Connect a model';

/**
 * What TeXRA is, in one line, wherever a first impression forms: a capable
 * theorist, and one that works with you rather than around you.
 */
export const TEXRA_TAGLINE = 'Your AI theorist. It proposes; you decide.';

/** State 0 choice 1. */
export const ONBOARDING_CHOICE_CHATGPT = {
  label: 'Use ChatGPT subscription',
  description:
    'OpenAI models through ChatGPT Plus, Pro, or Team; no API key needed',
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

/** The card's lede: what connecting a model leads to. */
export const ONBOARDING_CARD_LEDE =
  'Sign in with ChatGPT or add an API key. Then the setup assistant checks this project, picks your agent team, and starts your first task.';

/**
 * The API-key banner: shown once a task has finished and no sign-in or API
 * key can reach a model now; before that, the card above is the one prompt.
 * It says what is true now, not that a credential was lost: a task may have
 * finished on a route the check does not count.
 */
export const CREDENTIAL_LOST_NOTICE =
  'No ChatGPT sign-in or API key can reach a model right now. Connect a model to continue.';

/** State 0 choice 4 - quiet link, persists the shared declined flag. */
export const ONBOARDING_CHOICE_SKIP_LABEL = 'Skip for now';

/**
 * State 1 handoff sentence: a credential just landed and the setup assistant
 * owns the next step. The CLI prints it as a transcript notice when the setup
 * agent takes over the first-run session; the extension/desktop setup card
 * shows it under the "Credential ready" title. Surface-specific hints (the
 * CLI's `/agent`, the card's Run-setup button) stay in the surface.
 */
export const ONBOARDING_SETUP_HANDOFF =
  "You're starting with the setup assistant: it checks your environment, applies the right agent team, and helps you run your first task.";
