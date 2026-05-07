import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
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
  const dialog = document.createElement('wa-dialog');
  dialog.classList.add('desktop-onboarding');
  dialog.withoutHeader = true;
  // The visible <h1> inside the body is the dialog's accessible name; ARIA
  // resolves it via aria-labelledby below. Skip the redundant `label`
  // attribute that would otherwise add an extra aria-label.
  dialog.setAttribute('aria-labelledby', 'desktop-onboarding-title');

  // Distinguishes user-initiated close (Escape / button click) — which posts
  // the dismissed signal back to the host — from programmatic close from
  // setState(shouldShow=false), which would otherwise feedback-loop.
  let suppressNextPost = false;

  const closeDialog = (): void => {
    dialog.open = false;
  };
  const navigateAndClose = (route: DesktopRoute): void => {
    closeDialog();
    setRoute(route);
  };

  render(
    html`
      <header class="desktop-onboarding-header">
        ${waIcon('circle-info', { className: 'desktop-onboarding-icon' })}
        <div>
          <h1 id="desktop-onboarding-title">Welcome to TeXRA Desktop</h1>
          <p>
            Start from a workspace, configure model access, choose an agent, and
            run without switching to VS Code.
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
      <div slot="footer" class="desktop-onboarding-actions">
        <wa-button
          appearance="outlined"
          @click=${() => navigateAndClose('settings')}
        >
          Open Settings
        </wa-button>
        <wa-button
          appearance="outlined"
          @click=${() => navigateAndClose('main')}
        >
          Go to Launcher
        </wa-button>
        <wa-button
          appearance="filled"
          variant="brand"
          data-onboarding-dismiss
          @click=${closeDialog}
        >
          Got it
        </wa-button>
      </div>
    `,
    dialog,
  );

  // wa-dialog handles modal backdrop, focus trap, escape key, and focus
  // restoration automatically. Restore the dismiss-first focus policy
  // (the previous hand-rolled trap focused "Got it" first), and intercept
  // the command-palette shortcut so it doesn't fire while open.
  dialog.addEventListener('wa-after-show', () => {
    dialog.querySelector<HTMLElement>('[data-onboarding-dismiss]')?.focus();
  });
  // Every user-initiated dismissal (Escape, footer buttons) posts the
  // dismissed signal back to the host. Programmatic hide() suppresses the
  // post via suppressNextPost to avoid a feedback loop with setState messages.
  dialog.addEventListener('wa-after-hide', () => {
    if (suppressNextPost) {
      suppressNextPost = false;
      return;
    }
    postDismissed();
  });
  // Scoped to the dialog so it only runs while open and only for keys that
  // originate inside it. stopPropagation prevents the global command-palette
  // listener (on document) from firing.
  dialog.addEventListener('keydown', (event) => {
    if (isCommandPaletteShortcut(event)) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  return {
    element: dialog,
    isVisible: () => dialog.open,
    show: () => {
      dialog.open = true;
    },
    hide: () => {
      if (!dialog.open) return;
      suppressNextPost = true;
      dialog.open = false;
    },
  };
}
