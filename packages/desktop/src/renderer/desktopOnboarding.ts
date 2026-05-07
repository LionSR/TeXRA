import { TEXRA_ICON_LIBRARY } from '@shared/wa/webAwesomeIcons';

import type { DesktopRoute } from '../desktopShellMessages';
import { isCommandPaletteShortcut } from './desktopCommandPalette';

export interface DesktopFirstRunWalkthroughOptions {
  document: Document;
  dismiss(): void;
  setRoute(route: DesktopRoute): void;
}

export interface DesktopFirstRunWalkthrough {
  element: HTMLElement;
  isVisible(): boolean;
  show(): void;
  hide(): void;
}

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function createFirstRunWalkthrough({
  document,
  dismiss: postDismissed,
  setRoute,
}: DesktopFirstRunWalkthroughOptions): DesktopFirstRunWalkthrough {
  const element = document.createElement('section');
  element.className = 'desktop-onboarding';
  element.hidden = true;
  element.setAttribute('role', 'dialog');
  element.setAttribute('aria-modal', 'true');
  element.setAttribute('aria-labelledby', 'desktop-onboarding-title');
  element.innerHTML = `
    <div class="desktop-onboarding-panel">
      <header class="desktop-onboarding-header">
        <wa-icon class="desktop-onboarding-icon" library="${TEXRA_ICON_LIBRARY}" name="circle-info" variant="solid" aria-hidden="true"></wa-icon>
        <div>
          <h1 id="desktop-onboarding-title">Welcome to TeXRA Desktop</h1>
          <p>Start from a workspace, configure model access, choose an agent, and run without switching to VS Code.</p>
        </div>
      </header>
      <ol class="desktop-onboarding-steps">
        <li>
          <span class="desktop-onboarding-step-index">1</span>
          <div>
            <strong>Open a workspace</strong>
            <span>Pick the folder that contains the paper or project files.</span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">2</span>
          <div>
            <strong>Set up model access</strong>
            <span>Sign in for included access or add provider keys in Settings.</span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">3</span>
          <div>
            <strong>Choose an agent</strong>
            <span>Select a workflow agent, direct agent, or tool-use agent.</span>
          </div>
        </li>
        <li>
          <span class="desktop-onboarding-step-index">4</span>
          <div>
            <strong>Start a run</strong>
            <span>Use the launcher and follow live output in Progress.</span>
          </div>
        </li>
      </ol>
      <footer class="desktop-onboarding-actions">
        <wa-button class="desktop-secondary-button" appearance="outlined" data-onboarding-settings>
          Open Settings
        </wa-button>
        <wa-button class="desktop-secondary-button" appearance="outlined" data-onboarding-launcher>
          Go to Launcher
        </wa-button>
        <wa-button class="desktop-primary-button" appearance="filled" variant="brand" data-onboarding-dismiss>
          Got it
        </wa-button>
      </footer>
    </div>
  `;
  let previousFocus: HTMLElement | null = null;

  const getFocusableElements = (): HTMLElement[] =>
    [...element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (candidate) =>
        !candidate.hasAttribute('disabled') &&
        candidate.getAttribute('aria-hidden') !== 'true',
    );

  const hide = (): void => {
    const restoreFocus = previousFocus;
    element.hidden = true;
    previousFocus = null;
    restoreFocus?.focus();
  };
  const focusFirstControl = (): void => {
    const dismissButton = element.querySelector<HTMLElement>(
      '[data-onboarding-dismiss]',
    );
    (dismissButton ?? getFocusableElements()[0])?.focus();
  };
  const show = (): void => {
    if (element.hidden) {
      previousFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    }
    element.hidden = false;
    focusFirstControl();
  };
  const dismiss = (): void => {
    hide();
    postDismissed();
  };
  const dismissAndShowRoute = (route: DesktopRoute): void => {
    dismiss();
    setRoute(route);
  };
  const onClick = (selector: string, handler: () => void): void => {
    element
      .querySelector<HTMLElement>(selector)
      ?.addEventListener('click', handler);
  };

  onClick('[data-onboarding-settings]', () => dismissAndShowRoute('settings'));
  onClick('[data-onboarding-launcher]', () => dismissAndShowRoute('main'));
  onClick('[data-onboarding-dismiss]', dismiss);
  document.addEventListener('focusin', (event) => {
    if (element.hidden) return;
    if (event.target instanceof Node && element.contains(event.target)) return;
    focusFirstControl();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (element.hidden) return;
      if (isCommandPaletteShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const focusedIndex = focusable.indexOf(
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : focusable[0],
      );
      const currentIndex = focusedIndex === -1 ? 0 : focusedIndex;
      const nextIndex = event.shiftKey
        ? (currentIndex - 1 + focusable.length) % focusable.length
        : (currentIndex + 1) % focusable.length;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    },
    true,
  );

  return { element, isVisible: () => !element.hidden, show, hide };
}
