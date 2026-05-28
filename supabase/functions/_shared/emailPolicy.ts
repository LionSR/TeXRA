/**
 * Sign-up policy checks shared across edge functions.
 *
 * Two gates are enforced at the auth-github exchange when a *new* user is
 * about to be created:
 *
 *   1. Email domain is not in a blocklist of disposable / privacy-relay
 *      providers that are routinely used to farm the free tier.
 *   2. The GitHub account is at least MIN_GITHUB_ACCOUNT_AGE_DAYS old.
 *
 * Both checks are intentionally only enforced at user creation. Existing
 * users keep their access regardless of the lists below.
 */

export const MIN_GITHUB_ACCOUNT_AGE_DAYS = 30;

/**
 * Disposable / throwaway mailbox providers.
 *
 * These produce zero legitimate signups in practice and have been observed
 * directly farming the Researcher Access Program.
 */
const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'atomicmail.io',
  'tempmail.com',
  'temp-mail.org',
  'temp-mail.io',
  '10minutemail.com',
  '10minutemail.net',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamail.org',
  'sharklasers.com',
  'grr.la',
  'mailinator.com',
  'mailinator.net',
  'throwaway.email',
  'throwawaymail.com',
  'fakeinbox.com',
  'yopmail.com',
  'yopmail.net',
  'mintemail.com',
  'dispostable.com',
  'mailnesia.com',
  'getairmail.com',
  'emailondeck.com',
  'dropmail.me',
  'maildrop.cc',
  'getnada.com',
  'inboxbear.com',
  'mohmal.com',
  'tutanota-temp.com',
  'spambox.us',
  'trashmail.com',
  'trashmail.de',
]);

/**
 * Privacy mail providers that, while legitimate, are disproportionately used
 * for free-tier abuse here. Treated the same as disposable for now — see ToS.
 * Kept as a separate list so we can flip it to soft-review later without
 * touching the disposable list.
 */
const PRIVACY_RELAY_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'protonmail.com',
  'protonmail.ch',
  'proton.me',
  'pm.me',
]);

export type EmailPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; userMessage: string };

function normalizeDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

export function checkEmailDomain(email: string): EmailPolicyDecision {
  const domain = normalizeDomain(email);
  if (!domain) {
    return {
      allowed: false,
      reason: 'invalid-email',
      userMessage:
        'The email address on your GitHub account is malformed. Please set a valid primary email on GitHub and retry.',
    };
  }

  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    return {
      allowed: false,
      reason: `disposable-domain:${domain}`,
      userMessage:
        `Sign-up is restricted: "${domain}" is a disposable / temporary email provider. ` +
        'Please sign in with a GitHub account that uses your primary institutional, ' +
        'employer, or long-term personal email address. ' +
        'If you believe this is in error, contact contact@texra.ai.',
    };
  }

  if (PRIVACY_RELAY_EMAIL_DOMAINS.has(domain)) {
    return {
      allowed: false,
      reason: `privacy-relay-domain:${domain}`,
      userMessage:
        `Sign-up via "${domain}" is currently not accepted for the Researcher ` +
        'Access Program due to repeated abuse. Please sign in with a GitHub ' +
        'account that uses your primary institutional or long-term personal ' +
        'email address. If this is your only email and you are a legitimate ' +
        'researcher, contact contact@texra.ai for an exception.',
    };
  }

  return { allowed: true };
}

export function checkGitHubAccountAge(
  githubCreatedAt: string | null | undefined,
  now: Date = new Date(),
): EmailPolicyDecision {
  if (!githubCreatedAt) {
    return {
      allowed: false,
      reason: 'missing-github-created-at',
      userMessage:
        'Could not determine your GitHub account creation date. Please retry, ' +
        'or contact contact@texra.ai if the problem persists.',
    };
  }

  const created = new Date(githubCreatedAt);
  if (Number.isNaN(created.getTime())) {
    return {
      allowed: false,
      reason: 'invalid-github-created-at',
      userMessage:
        'Could not parse your GitHub account creation date. Please retry, ' +
        'or contact contact@texra.ai if the problem persists.',
    };
  }

  const ageMs = now.getTime() - created.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);

  if (ageDays < MIN_GITHUB_ACCOUNT_AGE_DAYS) {
    const remaining = Math.ceil(MIN_GITHUB_ACCOUNT_AGE_DAYS - ageDays);
    return {
      allowed: false,
      reason: `github-account-too-young:${ageDays.toFixed(1)}d`,
      userMessage:
        `Sign-up requires a GitHub account at least ${MIN_GITHUB_ACCOUNT_AGE_DAYS} days old. ` +
        `Your GitHub account is currently ${Math.max(0, Math.floor(ageDays))} days old ` +
        `(please retry in about ${remaining} day${remaining === 1 ? '' : 's'}). ` +
        'If you are a legitimate researcher and need access sooner, contact ' +
        'contact@texra.ai for an exception.',
    };
  }

  return { allowed: true };
}
