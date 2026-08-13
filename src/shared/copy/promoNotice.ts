/**
 * Shared user-facing copy for the sponsor-credit promotion and the relay
 * privacy guarantee.
 *
 * Single source of truth for LoginBanner, ApiAccessSection, and any other UI
 * that needs to surface the same message. Update here when the promo terms
 * change.
 */

/**
 * Short banner copy (sign-in callout), split into a value `lead` and a lighter
 * privacy `fineprint` so the banner can render a clear two-tier hierarchy.
 * Plain text — no HTML.
 */
export const PROMO_NOTICE_SHORT = {
  lead: 'Free access to a rotating selection of leading research models.',
  fineprint:
    'TeXRA only forwards your messages to the model provider — it does not ' +
    'store them.',
} as const;

/**
 * Structured fragments for the full Settings → Profile notice. Strings are
 * DOM-agnostic; the caller wraps `promoCode` in a `<code>` element and
 * `privacyNot`/`privacyNever` in `<strong>` elements. Only "not" (not the
 * full "does not") is bolded — matching the original markup.
 */
export const PROMO_NOTICE_LONG = {
  promoLead:
    'Thanks to sponsor credits, every tier currently has access to all ' +
    'models — except the ',
  promoCode: 'gpt-5-pro',
  promoTail: ' series, which stays reserved for Ultra.',
  privacyLead:
    'Your conversations are forwarded to the model provider: TeXRA does ',
  privacyNot: 'not',
  privacyMiddle: ' permanently store your prompts or responses, and they are ',
  privacyNever: 'never',
  privacyTrailing: ' used for training.',
  supportLead: 'Help keep the relay running for everyone — support TeXRA via ',
  supportSponsorsUrl: 'https://github.com/sponsors/texra-ai',
  supportSponsorsLabel: 'GitHub Sponsors',
  supportMiddle: ' or ',
  supportCoffeeUrl: 'https://buymeacoffee.com/texra.ai',
  supportCoffeeLabel: 'Buy Me a Coffee',
  supportTail: '.',
} as const;
