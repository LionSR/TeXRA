// Desktop wrapper around shared walkthroughDialog — supplies onboarding copy and route actions.

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
  /** Open the Settings overlay focused on the Multi-Agent (team picker) tab. */
  openMultiAgent(): void;
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
    title: 'Pick your team',
    body: 'Choose a discipline (physics, math, ML, Lean) and the orchestrator brings the right specialists.',
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
  openMultiAgent,
}: DesktopFirstRunWalkthroughOptions): DesktopFirstRunWalkthrough {
  return createWalkthroughDialog({
    document,
    title: 'Welcome to TeXRA Desktop',
    description:
      'Start from a workspace, configure model access, pick a team for your field, and run without switching to VS Code.',
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
    ],
  });
}
