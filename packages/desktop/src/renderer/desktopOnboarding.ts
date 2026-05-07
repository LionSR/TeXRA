import { html, render } from 'lit';
import { waIcon } from '@shared/wa/webAwesomeIcons';

import { isCommandPaletteShortcut } from './desktopCommandPalette';
import type { DesktopRoute } from '../desktopShellMessages';

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
  'wa-button, button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

const ONBOARDING_STEPS: ReadonlyArray<{
  readonly index: string;
  readonly title: string;
  readonly body: string;
}> = [
  {
    index: '1',
    title: 'Open a workspace',
    body: 'Pick the folder that contains the paper or project files.',
  },
  {
    index: '2',
    title: 'Set up model access',
    body: 'Sign in for included access or add provider keys in Settings.',
  },
  {
    index: '3',
    title: 'Choose an agent',
    body: 'Select a workflow agent, direct agent, or tool-use agent.',
  },
  {
    index: '4',
    title: 'Start a run',
    body: 'Use the launcher and follow live output in Progress.',
  },
];

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

  let previousFocus: HTMLElement | null = null;

  const dismissAndShowRoute = (route: DesktopRoute): void => {
    dismiss();
    setRoute(route);
  };

  render(
    html`
      <div class="desktop-onboarding-panel">
        <header class="desktop-onboarding-header">
          ${waIcon('circle-info', { className: 'desktop-onboarding-icon' })}
          <div>
            <h1 id="desktop-onboarding-title">Welcome to TeXRA Desktop</h1>
            <p>
              Start from a workspace, configure model access, choose an agent,
              and run without switching to VS Code.
            </p>
          </div>
        </header>
        <ol class="desktop-onboarding-steps">
          ${ONBOARDING_STEPS.map(
            (step) => html`
              <li>
                <span class="desktop-onboarding-step-index">${step.index}</span>
                <div>
                  <strong>${step.title}</strong>
                  <span>${step.body}</span>
                </div>
              </li>
            `,
          )}
        </ol>
        <footer class="desktop-onboarding-actions">
          <wa-button
            class="desktop-secondary-button"
            appearance="outlined"
            @click=${() => dismissAndShowRoute('settings')}
          >
            Open Settings
          </wa-button>
          <wa-button
            class="desktop-secondary-button"
            appearance="outlined"
            @click=${() => dismissAndShowRoute('main')}
          >
            Go to Launcher
          </wa-button>
          <wa-button
            class="desktop-primary-button"
            appearance="filled"
            variant="brand"
            data-onboarding-dismiss
            @click=${() => dismiss()}
          >
            Got it
          </wa-button>
        </footer>
      </div>
    `,
    element,
  );

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
  function dismiss(): void {
    hide();
    postDismissed();
  }

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
