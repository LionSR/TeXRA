// Sign-up policy checks enforced at user creation (existing users are never re-checked).

const MIN_GITHUB_ACCOUNT_AGE_DAYS = 30;

// Disposable mailbox providers observed farming the Researcher Access Program.
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

// Privacy-relay providers disproportionately used for free-tier abuse.
// Kept separate from DISPOSABLE so it can be moved to soft-review independently.
const PRIVACY_RELAY_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'protonmail.com',
  'protonmail.ch',
  'proton.me',
  'pm.me',
]);

/**
 * Blocked-domain categories, checked in order. Each carries its own reason
 * prefix and user message so a category can be added, reworded, or moved to
 * soft-review without touching the matching logic.
 */
const BLOCKED_DOMAIN_POLICIES: readonly {
  domains: ReadonlySet<string>;
  reasonPrefix: string;
  userMessage: (domain: string) => string;
}[] = [
  {
    domains: DISPOSABLE_EMAIL_DOMAINS,
    reasonPrefix: 'disposable-domain',
    userMessage: (domain) =>
      `Sign-up is restricted: "${domain}" is a disposable / temporary email provider. ` +
      'Please sign in with a GitHub account that uses your primary institutional, ' +
      'employer, or long-term personal email address. ' +
      'If you believe this is in error, contact contact@texra.ai.',
  },
  {
    domains: PRIVACY_RELAY_EMAIL_DOMAINS,
    reasonPrefix: 'privacy-relay-domain',
    userMessage: (domain) =>
      `Sign-up via "${domain}" is currently not accepted for the Researcher ` +
      'Access Program due to repeated abuse. Please sign in with a GitHub ' +
      'account that uses your primary institutional or long-term personal ' +
      'email address. If this is your only email and you are a legitimate ' +
      'researcher, contact contact@texra.ai for an exception.',
  },
];

type EmailPolicyDecision =
  { allowed: true } | { allowed: false; reason: string; userMessage: string };

function normalizeDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

function findBlockedDomain(
  domain: string,
  blockedDomains: ReadonlySet<string>,
): string | null {
  let candidate = domain;

  while (candidate) {
    if (blockedDomains.has(candidate)) return candidate;

    const dot = candidate.indexOf('.');
    if (dot < 0) return null;
    candidate = candidate.slice(dot + 1);
  }

  return null;
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

  for (const policy of BLOCKED_DOMAIN_POLICIES) {
    const blockedDomain = findBlockedDomain(domain, policy.domains);
    if (blockedDomain) {
      return {
        allowed: false,
        reason: `${policy.reasonPrefix}:${blockedDomain}`,
        userMessage: policy.userMessage(blockedDomain),
      };
    }
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

  const ageDays = (now.getTime() - created.getTime()) / 86_400_000;

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
