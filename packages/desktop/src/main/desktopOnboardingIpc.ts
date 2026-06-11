import { platform } from '@platform/platform';
import { setOnboardingDeclined } from '@controllers/onboarding/onboardingFunnel';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc/mainViewCommands';
import {
  buildDesktopOnboardingSetStateMessage,
  DESKTOP_ONBOARDING_COMMANDS,
  DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
} from '../desktopOnboardingMessages.js';
import {
  createCommandHandler,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';
import type { StateStore } from '@platform/interfaces/state';

export interface DesktopOnboardingIpcOptions {
  state?: StateStore;
  onAsyncError?: (error: unknown) => void;
}

export function createDesktopOnboardingIpc(
  renderer: DesktopRenderer,
  options: DesktopOnboardingIpcOptions = {},
): DesktopMessageHandler {
  const state = options.state ?? platform().globalState;

  function postCurrentState(): void {
    const dismissed = state.get<boolean>(
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      false,
    );
    renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(!dismissed));
  }

  function postMainViewFunnelState(): void {
    renderer.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'done',
    });
  }

  async function dismiss(): Promise<void> {
    await state.update(DESKTOP_ONBOARDING_DISMISSED_STATE_KEY, true);
    renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(false));
  }

  async function skipMainOnboarding(): Promise<void> {
    await setOnboardingDeclined(state, true);
    postMainViewFunnelState();
  }

  return createCommandHandler(
    {
      // Desktop does not run State 0/1 yet, so every main-view mount must
      // clear MainApp's first-paint `pending` guard with a concrete state.
      [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: {
        when: (message) => message.view === 'main',
        run: () => postMainViewFunnelState(),
        claim: false,
      },
      [DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE]: () => postCurrentState(),
      [DESKTOP_ONBOARDING_COMMANDS.DISMISS]: () => dismiss(),
      // Welcome-card skip (PRD: agent-native onboarding). Host-neutral
      // declined flag — the same one the CLI picker persists. Keep the
      // renderer on desktop's current `done` funnel state afterward.
      [MAIN_VIEW_COMMANDS.ONBOARDING_SKIP]: () => skipMainOnboarding(),
    },
    { onAsyncError: options.onAsyncError },
  );
}
