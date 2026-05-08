// Desktop wrapper around the host-neutral first-run walkthrough in
// `src/shared/wa/walkthroughDialog.ts`. The shared helper owns the wa-dialog
// shell, focus restore, command-palette-shortcut interception, and the
// programmatic-vs-user-dismissal distinction; this wrapper supplies the
// desktop's onboarding copy, the navigation actions (open Settings / Launcher
// / dismiss), and the desktop CSS class hooks.

import {
  createWalkthroughDialog,
  type WalkthroughDialogController,
  type WalkthroughStep,
} from '@shared/wa/walkthroughDialog';

import type { DesktopRoute } from '../desktopShellMessages';

export interface DesktopFirstRunWalkthroughOptions {
  document: Document;
  dismiss(): void;
  setRoute(route: DesktopRoute): void;
}

export type DesktopFirstRunWalkthrough = WalkthroughDialogController;

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
  return createWalkthroughDialog({
    document,
    title: 'Welcome to TeXRA Desktop',
    description:
      'Start from a workspace, configure model access, choose an agent, and run without switching to VS Code.',
    steps: ONBOARDING_STEPS,
    onUserDismiss: postDismissed,
    classes: {
      dialog: 'desktop-onboarding',
      header: 'desktop-onboarding-header',
      icon: 'desktop-onboarding-icon',
      steps: 'desktop-onboarding-steps',
      stepIndex: 'desktop-onboarding-step-index',
      actions: 'desktop-onboarding-actions',
    },
    actions: [
      {
        label: 'Open Settings',
        appearance: 'outlined',
        className: 'desktop-secondary-button',
        onClick: () => setRoute('settings'),
      },
      {
        label: 'Go to Launcher',
        appearance: 'outlined',
        className: 'desktop-secondary-button',
        onClick: () => setRoute('main'),
      },
      {
        label: 'Got it',
        emphasis: 'primary',
        appearance: 'filled',
        variant: 'brand',
        className: 'desktop-primary-button',
        onClick: () => {
          /* dialog auto-closes; onUserDismiss handles the post */
        },
      },
    ],
  });
}
