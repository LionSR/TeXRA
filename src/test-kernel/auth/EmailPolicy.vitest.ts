import { describe, expect, it } from 'vitest';

import { checkEmailDomain } from '../../../supabase/functions/_shared/emailPolicy';

describe('checkEmailDomain', () => {
  it('blocks disposable email domains exactly', () => {
    expect(checkEmailDomain('user@mailinator.com')).toMatchObject({
      allowed: false,
      reason: 'disposable-domain:mailinator.com',
    });
  });

  it('blocks subdomains of disposable email domains', () => {
    expect(checkEmailDomain('user@inbound.mailinator.com')).toMatchObject({
      allowed: false,
      reason: 'disposable-domain:mailinator.com',
    });
  });

  it('blocks subdomains of privacy-relay email domains', () => {
    expect(checkEmailDomain('user@relay.proton.me')).toMatchObject({
      allowed: false,
      reason: 'privacy-relay-domain:proton.me',
    });
  });

  it('does not block unrelated domains that merely contain a listed domain', () => {
    expect(checkEmailDomain('user@mailinator.com.example.org')).toEqual({
      allowed: true,
    });
    expect(checkEmailDomain('user@notmailinator.com')).toEqual({
      allowed: true,
    });
  });

  it('normalizes domain case and whitespace before matching', () => {
    expect(checkEmailDomain('user@ InboxBear.com ')).toMatchObject({
      allowed: false,
      reason: 'disposable-domain:inboxbear.com',
    });
  });
});
