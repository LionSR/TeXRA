import { beforeAll, describe, expect, it } from 'vitest';

import { loadSourceModule } from './loadSourceModule.ts';

describe('desktop navigation policy', () => {
  let isAllowedExternalUrl: (url: string) => boolean;

  beforeAll(async () => {
    ({ isAllowedExternalUrl } = await loadSourceModule(
      '@desktop/main/desktopNavigationPolicy',
    ));
  });

  it('does not allow third-party Supabase project subdomains', () => {
    // Only texra.ai is allowed; a blanket
    // *.supabase.co allow-rule would let any Supabase project be opened.
    expect(isAllowedExternalUrl('https://abc.supabase.co/auth/v1')).toBe(false);
    expect(isAllowedExternalUrl('https://supabase.co/')).toBe(false);
  });

  it('rejects suffix-spoof and path-spoof attacks', () => {
    expect(isAllowedExternalUrl('https://texra.ai.evil.com/')).toBe(false);
    expect(isAllowedExternalUrl('https://github.com.evil.com/')).toBe(false);
    expect(
      isAllowedExternalUrl('https://attacker.com/?redirect=texra.ai'),
    ).toBe(false);
  });
});
