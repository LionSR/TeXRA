/**
 * Onboarding slice: onboarding-funnel pushes. The getting-started and
 * orchestrator-hint banners are `SET_BANNER` surfaces owned by bannerSlice.
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewHandlerRegistry } from '@shared/schemas';

// Local imports - main view
import { onboardingFunnelState$ } from '../mainViewState';

// `satisfies Partial<...>` subset — owns only onboarding commands; see
// bannerSlice.ts for the rationale.
export const onboardingHandlers = {
  [MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL]: (message) => {
    onboardingFunnelState$.set(message.state);
  },
} satisfies Partial<MainViewHandlerRegistry>;
