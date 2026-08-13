/**
 * Onboarding slice: onboarding-funnel pushes plus the getting-started and
 * orchestrator-hint banners that drive the onboarding surfaces.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewHandlerRegistry } from '@shared/schemas';

// Local imports - main view
import {
  gettingStartedVisible$,
  onboardingFunnelState$,
  sessionHintDismissed$,
} from '../mainViewState';

// `satisfies Partial<...>` subset — owns only onboarding commands; see
// bannerSlice.ts for the rationale.
export const onboardingHandlers = {
  [MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL]: (message) => {
    onboardingFunnelState$.set(message.state);
  },

  [MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER]: () => {
    gettingStartedVisible$.set(true);
  },
  [MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER]: () => {
    gettingStartedVisible$.set(false);
  },

  [MAIN_VIEW_COMMANDS.SHOW_ORCHESTRATOR_BANNER]: () => {
    sessionHintDismissed$.set(false);
  },
  [MAIN_VIEW_COMMANDS.HIDE_ORCHESTRATOR_BANNER]: () => {
    sessionHintDismissed$.set(true);
  },
} satisfies Partial<MainViewHandlerRegistry>;
