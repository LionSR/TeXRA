import { beforeAll, describe, expect, it } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopAuthBrowserModule {
  isAllowedAuthUrl(url: string): boolean;
  isAuthCallbackRedirect(url: string): boolean;
}

async function loadAuthBrowser(): Promise<DesktopAuthBrowserModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAuthBrowser.ts'))
  ) as Promise<DesktopAuthBrowserModule>;
}

describe('desktop in-app auth browser', () => {
  let isAllowedAuthUrl: (url: string) => boolean;
  let isAuthCallbackRedirect: (url: string) => boolean;

  beforeAll(async () => {
    ({ isAllowedAuthUrl, isAuthCallbackRedirect } = await loadAuthBrowser());
  });

  describe('isAllowedAuthUrl', () => {
    it('allows the TeXRA and Supabase endpoints the flow starts from', () => {
      // Unlike the app's general navigation policy, the auth window must allow
      // Supabase project subdomains: `signInWithOAuth` returns a URL on the
      // project host, and that URL is the flow's entry point.
      expect(
        isAllowedAuthUrl('https://remote.texra.ai/auth/v1/authorize'),
      ).toBe(true);
      expect(
        isAllowedAuthUrl('https://abc.supabase.co/auth/v1/authorize'),
      ).toBe(true);
    });

    it('allows the GitHub and Google identity providers', () => {
      expect(isAllowedAuthUrl('https://github.com/login/oauth/authorize')).toBe(
        true,
      );
      expect(
        isAllowedAuthUrl('https://accounts.google.com/o/oauth2/auth'),
      ).toBe(true);
      // Consent screens pull assets and continue-screens from these.
      expect(isAllowedAuthUrl('https://ssl.gstatic.com/accounts/x.png')).toBe(
        true,
      );
      expect(
        isAllowedAuthUrl('https://avatars.githubusercontent.com/u/1'),
      ).toBe(true);
    });

    it('rejects suffix-spoof hosts that merely end with a provider name', () => {
      // The check is host === suffix || host.endsWith('.' + suffix); a bare
      // endsWith would accept every one of these.
      expect(isAllowedAuthUrl('https://github.com.evil.com/login')).toBe(false);
      expect(isAllowedAuthUrl('https://evil-github.com/login')).toBe(false);
      expect(isAllowedAuthUrl('https://notsupabase.co/auth')).toBe(false);
      expect(isAllowedAuthUrl('https://texra.ai.attacker.test/')).toBe(false);
    });

    it('rejects non-https schemes so a downgrade cannot render in app chrome', () => {
      expect(isAllowedAuthUrl('http://github.com/login/oauth/authorize')).toBe(
        false,
      );
      expect(isAllowedAuthUrl('javascript:alert(1)')).toBe(false);
      expect(isAllowedAuthUrl('file:///etc/passwd')).toBe(false);
    });

    it('rejects an unrelated host and malformed input', () => {
      expect(isAllowedAuthUrl('https://attacker.test/phish')).toBe(false);
      expect(isAllowedAuthUrl('not-a-url')).toBe(false);
      expect(isAllowedAuthUrl('')).toBe(false);
    });

    it('does not treat the texra:// callback as renderable content', () => {
      // The callback must be intercepted, never loaded: it has no fetchable
      // body, so navigating to it would surface a load error exactly when
      // sign-in succeeded.
      expect(isAllowedAuthUrl('texra://auth-callback?app_nonce=abc')).toBe(
        false,
      );
    });
  });

  describe('isAuthCallbackRedirect', () => {
    it('detects the texra:// callback that terminates the flow', () => {
      expect(
        isAuthCallbackRedirect('texra://auth-callback?app_nonce=abc'),
      ).toBe(true);
      // Nonce validation is the auth layer's job (it owns the pending-attempt
      // state); this predicate only decides "stop navigating and hand off".
      expect(isAuthCallbackRedirect('texra://auth-callback')).toBe(true);
    });

    it('does not match provider or app URLs', () => {
      expect(isAuthCallbackRedirect('https://github.com/login')).toBe(false);
      expect(isAuthCallbackRedirect('https://remote.texra.ai/auth/v1')).toBe(
        false,
      );
      expect(isAuthCallbackRedirect('')).toBe(false);
    });
  });
});
