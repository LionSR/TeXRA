import { describe, expect, it } from 'vitest';

import { checkEmailDomain } from '../../../supabase/functions/_shared/emailPolicy';

describe('checkEmailDomain', () => {
  it.each([
    {
      name: 'blocks disposable email domains exactly',
      email: 'user@mailinator.com',
      reason: 'disposable-domain:mailinator.com',
    },
    {
      name: 'blocks subdomains of disposable email domains',
      email: 'user@inbound.mailinator.com',
      reason: 'disposable-domain:mailinator.com',
    },
    {
      name: 'blocks subdomains of privacy-relay email domains',
      email: 'user@relay.proton.me',
      reason: 'privacy-relay-domain:proton.me',
    },
    {
      name: 'normalizes domain case and whitespace before matching',
      email: 'user@ InboxBear.com ',
      reason: 'disposable-domain:inboxbear.com',
    },
  ])('$name', ({ email, reason }) => {
    expect(checkEmailDomain(email)).toMatchObject({ allowed: false, reason });
  });

  it('does not block unrelated domains that merely contain a listed domain', () => {
    expect(checkEmailDomain('user@mailinator.com.example.org')).toEqual({
      allowed: true,
    });
    expect(checkEmailDomain('user@notmailinator.com')).toEqual({
      allowed: true,
    });
  });
});
