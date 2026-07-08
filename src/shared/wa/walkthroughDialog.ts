// Host-neutral first-run walkthrough dialog. Hosts supply the heading copy,
// numbered steps, and footer actions; the helper owns wa-dialog wiring,
// focus restore, and the user-vs-programmatic dismissal distinction.
//
// Stays inside `src/shared/wa/` per CLAUDE.md "VS Code-free zones": no
// `vscode` imports, no Electron-specific APIs. The desktop renderer wraps
// this with its DESKTOP_ONBOARDING IPC + DesktopRoute concerns; future
// extension webviews will wrap it with their own walkthrough commands.

import '@awesome.me/webawesome/dist/components/dialog/dialog.js';
import '@awesome.me/webawesome/dist/components/button/button.js';
import { html, nothing, render, type TemplateResult } from 'lit';

import { isCommandPaletteShortcut } from './commandPalette';
import { waIcon, type TeXRAIconName } from './webAwesomeIcons';

export interface WalkthroughStep {
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

export interface WalkthroughDialogOptions {
  readonly document: Document;
  readonly title: string;
  readonly description: string;
  readonly steps: readonly WalkthroughStep[];
  readonly actions: readonly WalkthroughAction[];
  // Called on every user-initiated dismissal (Escape, primary button, etc.).
  // Programmatic hide() suppresses this callback to avoid feedback loops with
  // host state-sync messages.
  readonly onUserDismiss: () => void;
  readonly icon?: TeXRAIconName;
  readonly classes?: WalkthroughDialogClassNames;
}

interface WalkthroughDialogClassNames {
  readonly dialog?: string;
  readonly header?: string;
  readonly icon?: string;
  readonly steps?: string;
  readonly stepIndex?: string;
  readonly actions?: string;
}

export interface WalkthroughDialogController {
  element: HTMLElement;
  isVisible(): boolean;
  show(): void;
  hide(): void;
}

// Each createWalkthroughDialog() call grabs a unique id so two co-existing
// dialogs cannot collide on aria-labelledby.
let walkthroughTitleCounter = 0;

function nextWalkthroughTitleId(): string {
  walkthroughTitleCounter += 1;
  return `walkthrough-title-${walkthroughTitleCounter}`;
}

export function createWalkthroughDialog({
  document,
  title,
  description,
  steps,
  actions,
  onUserDismiss,
  icon = 'circle-info',
  classes,
}: WalkthroughDialogOptions): WalkthroughDialogController {
  const titleId = nextWalkthroughTitleId();
  const dialog = document.createElement('wa-dialog');
  if (classes?.dialog) dialog.classList.add(classes.dialog);
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
      <header class=${classes?.header ?? ''}>
        ${waIcon(icon, { className: classes?.icon })}
        <div>
          <h1 id=${titleId}>${title}</h1>
          <p>${description}</p>
        </div>
      </header>
      <ol class=${classes?.steps ?? ''}>
        ${steps.map(
          (step) => html`
            <li>
              <span class=${classes?.stepIndex ?? ''}>${step.index}</span>
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
              <div slot="footer" class=${classes?.actions ?? ''}>
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
    onUserDismiss();
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
