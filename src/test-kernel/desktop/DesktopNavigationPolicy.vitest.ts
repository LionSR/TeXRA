import { beforeAll, describe, expect, it } from 'vitest';

import { loadSourceModule } from './loadSourceModule.ts';

describe('desktop navigation policy', () => {
  let isAllowedExternalUrl: (url: string) => boolean;

  beforeAll(async () => {
    ({ isAllowedExternalUrl } = await loadSourceModule(
      '@desktop/main/desktopNavigationPolicy',
    ));
  });

  it('allows the texra.ai apex and subdomains over https', () => {
    expect(isAllowedExternalUrl('https://texra.ai/')).toBe(true);
    expect(isAllowedExternalUrl('https://texra.ai/guide/desktop')).toBe(true);
    expect(isAllowedExternalUrl('https://docs.texra.ai/foo')).toBe(true);
  });

  it('allows explicit HTTPS ports on allow-listed hosts', () => {
    expect(isAllowedExternalUrl('https://texra.ai:8443/x')).toBe(true);
    expect(isAllowedExternalUrl('https://github.com:443/owner/repo')).toBe(
      true,
    );
  });

  it('does not allow third-party Supabase project subdomains', () => {
    // Auth uses remote.texra.ai (covered by *.texra.ai); a blanket
    // *.supabase.co allow-rule would let any Supabase project be opened.
    expect(isAllowedExternalUrl('https://abc.supabase.co/auth/v1')).toBe(false);
    expect(isAllowedExternalUrl('https://supabase.co/')).toBe(false);
  });

  it('allows the static https host allow-list', () => {
    expect(isAllowedExternalUrl('https://github.com/owner/repo')).toBe(true);
    expect(
      isAllowedExternalUrl(
        'https://marketplace.visualstudio.com/items?itemName=foo',
      ),
    ).toBe(true);
    expect(isAllowedExternalUrl('https://open-vsx.org/extension/foo')).toBe(
      true,
    );
  });

  it('rejects non-https schemes', () => {
    expect(isAllowedExternalUrl('http://texra.ai/')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedExternalUrl('ftp://texra.ai/')).toBe(false);
  });

  it('rejects suffix-spoof and path-spoof attacks', () => {
    expect(isAllowedExternalUrl('https://texra.ai.evil.com/')).toBe(false);
    expect(isAllowedExternalUrl('https://github.com.evil.com/')).toBe(false);
    expect(
      isAllowedExternalUrl('https://attacker.com/?redirect=texra.ai'),
    ).toBe(false);
  });

  it('rejects malformed inputs', () => {
    expect(isAllowedExternalUrl('not-a-url')).toBe(false);
    expect(isAllowedExternalUrl('')).toBe(false);
    expect(isAllowedExternalUrl('https://')).toBe(false);
  });
});
