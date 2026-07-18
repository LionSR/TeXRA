// Desktop first-run walkthrough — owns wa-dialog wiring, focus restore, and
// the user-vs-programmatic dismissal distinction, plus the desktop onboarding
// copy and route actions. Repatriated from src/shared/wa/walkthroughDialog.ts
// (#8825): the desktop renderer is its only consumer.

import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, nothing, render, type TemplateResult } from 'lit';

import { waIcon } from '@shared/wa/webAwesomeIcons';

import { isCommandPaletteShortcut } from './desktopCommandPalette';
import type { DesktopRoute } from '../desktopShellMessages';

interface WalkthroughStep {
  readonly index: string;
  readonly title: string;
  readonly body: string;
}

interface WalkthroughAction {
  readonly label: string;
  readonly onClick: () => void;
  // The "primary" action also serves as the initial focus target on show —
  // restoring the original "Got it"-first focus policy.
  readonly emphasis?: 'primary' | 'secondary';
  readonly className?: string;
  readonly appearance?: 'filled' | 'outlined' | 'plain';
  readonly variant?: 'brand' | 'neutral';
}

interface WalkthroughDialogController {
  element: HTMLElement;
  isVisible(): boolean;
  show(): void;
  hide(): void;
}

export interface DesktopFirstRunWalkthroughOptions {
  document: Document;
  dismiss(): void;
  setRoute(route: DesktopRoute): void;
  /** Open the Settings overlay focused on the Multi-Agent (team picker) tab. */
  openMultiAgent(): void;
}

const ONBOARDING_STEPS: ReadonlyArray<WalkthroughStep> = [
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
    title: 'Pick your team',
    body: 'Choose a discipline (physics, math, ML, Lean) and the orchestrator brings the right specialists.',
  },
  {
    index: '4',
    title: 'Start a run',
    body: 'Use the launcher and follow live output in Progress.',
  },
];

// Each createFirstRunWalkthrough() call grabs a unique id so two co-existing
// dialogs cannot collide on aria-labelledby.
let walkthroughTitleCounter = 0;

function nextWalkthroughTitleId(): string {
  walkthroughTitleCounter += 1;
  return `walkthrough-title-${walkthroughTitleCounter}`;
}

export function createFirstRunWalkthrough({
  document,
  dismiss: postDismissed,
  setRoute,
  openMultiAgent,
}: DesktopFirstRunWalkthroughOptions): WalkthroughDialogController {
  const actions: readonly WalkthroughAction[] = [
    {
      label: 'Go to Launcher',
      appearance: 'outlined',
      className: 'desktop-secondary-button',
      onClick: () => setRoute('main'),
    },
    {
      label: 'Pick Your Team',
      emphasis: 'primary',
      appearance: 'filled',
      variant: 'brand',
      className: 'desktop-primary-button',
      onClick: () => openMultiAgent(),
    },
  ];

  const titleId = nextWalkthroughTitleId();
  const dialog = document.createElement('wa-dialog');
  dialog.classList.add('desktop-onboarding');
  dialog.withoutHeader = true;
  // The visible <h1> inside the body is the dialog's accessible name; ARIA
  // resolves it via aria-labelledby below. Skip the redundant `label`
  // attribute that would otherwise add an extra aria-label.
  dialog.setAttribute('aria-labelledby', titleId);

  // Distinguishes user-initiated close (Escape / button click) — which fires
  // the dismissed callback back to the host — from programmatic close from
  // hide(), which would otherwise feedback-loop with host state syncs.
  let suppressNextPost = false;

  const closeDialog = (): void => {
    dialog.open = false;
  };

  const actionTemplate = (action: WalkthroughAction): TemplateResult => html`
    <wa-button
      class=${action.className ?? ''}
      appearance=${action.appearance ?? 'outlined'}
      variant=${action.variant ?? 'neutral'}
      ?data-walkthrough-primary=${action.emphasis === 'primary'}
      @click=${() => {
        action.onClick();
        closeDialog();
      }}
    >
      ${action.label}
    </wa-button>
  `;

  render(
    html`
      <header class="desktop-onboarding-header">
        ${waIcon('circle-info', { className: 'desktop-onboarding-icon' })}
        <div>
          <h1 id=${titleId}>Welcome to TeXRA Desktop</h1>
          <p>
            Start from a workspace, configure model access, pick a team for your
            field, and run without switching to VS Code.
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
      ${
        actions.length > 0
          ? html`
              <div slot="footer" class="desktop-onboarding-actions">
                ${actions.map(actionTemplate)}
              </div>
            `
          : nothing
      }
    `,
    dialog,
  );

  // wa-dialog handles modal backdrop, focus trap, escape key, and focus
  // restoration automatically. Reapply the previous "primary action focused
  // first" policy so keyboard users can dismiss with one Enter, and intercept
  // the command-palette shortcut so it does not fire while the dialog is open.
  dialog.addEventListener('wa-after-show', () => {
    dialog.querySelector<HTMLElement>('[data-walkthrough-primary]')?.focus();
  });
  // Every user-initiated dismissal (Escape, footer buttons) posts the
  // dismissed signal back to the host. Programmatic hide() suppresses the
  // post via suppressNextPost to avoid a feedback loop with state messages.
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
