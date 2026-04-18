/**
 * Shared user-facing copy for the sponsor-credit promotion and the relay
 * privacy guarantee.
 *
 * Single source of truth for LoginBanner, ProfileInfo, and any other UI that
 * needs to surface the same message. Update here when the promo terms change.
 */

/**
 * Short one-liner suitable for a banner subtitle (sign-in callout, getting
 * started). Plain text — no HTML.
 */
export const PROMO_NOTICE_SHORT =
  'Sign in for free access to GPT-5, Claude Sonnet 4.6, Gemini, and more. ' +
  'Your messages go directly to the model provider — TeXRA never stores or ' +
  'trains on your conversations.';

/**
 * Structured fragments for the full Settings → Profile notice. Strings are
 * DOM-agnostic; the caller wraps `*Emphasized` and `*Code` fragments in its
 * own `<strong>` / `<code>` elements rather than rendering raw HTML.
 */
export const PROMO_NOTICE_LONG = {
  promoLead:
    'Thanks to sponsor credits, every tier currently has access to all ' +
    'models — except the ',
  promoCode: 'gpt-5-pro',
  promoTail: ' series, which stays reserved for Ultra.',
  privacyLead:
    'Your conversations are sent directly to the model provider: TeXRA ',
  privacyDoesNot: 'does not',
  privacyMiddle: ' store your prompts or responses, and they are ',
  privacyNever: 'never',
  privacyTrailing: ' used for training.',
} as const;
