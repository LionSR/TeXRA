// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports - shared constants and types
import { HOST_BRIDGE_API_KEY } from '@shared/hostBridgeTypes';

// Local imports - component type (type-only: the module loads inside the DOM harness)
import type { MainApp } from '@webview/frontend/MainApp';

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

/**
 * Pins the host gating in MainApp's template.
 *
 * The desktop host must not show `<latexdiffs-section>`: its actions post
 * LATEXDIFF / LATEXDIFFVC / packLatexdiffvc / cleanLatexdiffvc, and the
 * Electron shell registers no handler for any of them, so rendering it there
 * would produce controls that silently do nothing.
 *
 * That is enforced structurally — `render()` returns a separate desktop
 * template before it ever reaches the section — rather than by a local
 * `isDesktopHost` ternary. A redundant second guard used to sit on the section
 * itself; two refactors deleted it as dead code and were right, but nothing
 * proved it either way. These tests assert the observable behavior, so
 * whichever shape `render()` takes, a regression fails here.
 *
 * `isDesktopHost` (src/shared/BaseWebviewApp.ts) is true when the element
 * carries `data-desktop-view` or `window.texraDesktop` exists; the desktop
 * renderer sets the attribute, and the extension host sets neither. These
 * tests mount both ways and assert the section appears only on the extension
 * host, so deleting either guard fails here instead of shipping.
 */

// Install the host-bridge stub at module scope, BEFORE the DOM harness imports
// MainApp — `hostBridge` resolves this global at module load. This suite makes
// no assertions on posted messages; the stub only keeps mounting from throwing.
(globalThis as Record<string, unknown>)[HOST_BRIDGE_API_KEY] = {
  postMessage: () => {},
  getState: () => ({}),
  setState: () => {},
};

// Dynamically imported after the DOM harness has installed globals and loaded
// MainApp; a static import would evaluate the state module too early.
let mainViewState: typeof import('@webview/frontend/mainViewState');

function hasSection(element: MainApp, tag: string): boolean {
  return element.shadowRoot?.querySelector(tag) != null;
}

/**
 * Mounts `<main-app>` and settles the onboarding funnel.
 *
 * Both steps matter. `data-desktop-view` must be set before append, because
 * `isDesktopHost` is read during the first render. The funnel must be settled
 * after append, because MainApp's constructor calls `resetMainViewState()`,
 * which puts the signal back to 'pending' — and 'pending' renders a loading
 * skeleton with no launcher body, so every gated section would read as absent
 * and the assertions would pass for the wrong reason.
 */
async function mountMainApp(options: { desktop: boolean }): Promise<MainApp> {
  const element = document.createElement('main-app') as unknown as MainApp;
  if (options.desktop) {
    (element as unknown as HTMLElement).setAttribute(
      'data-desktop-view',
      'main',
    );
  }
  document.body.append(element as unknown as HTMLElement);
  await element.updateComplete;
  mainViewState.onboardingFunnelState$.set('done');
  await element.updateComplete;
  return element;
}

describe('MainApp desktop host gating', () => {
  useLitComponentTestDom(() => import('@webview/frontend/MainApp'));

  beforeAll(async () => {
    mainViewState = await import('@webview/frontend/mainViewState');
  });

  it.each([
    { host: 'extension', desktop: false, visible: true },
    { host: 'desktop', desktop: true, visible: false },
  ])(
    'gates the latexdiffs section and view header by host: $host',
    async ({ desktop, visible }) => {
      const element = await mountMainApp({ desktop });

      expect(hasSection(element, 'latexdiffs-section')).toBe(visible);
      expect(hasSection(element, '.view-header')).toBe(visible);
    },
  );
});
