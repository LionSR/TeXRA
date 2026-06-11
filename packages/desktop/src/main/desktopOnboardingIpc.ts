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

  async function dismiss(): Promise<void> {
    await state.update(DESKTOP_ONBOARDING_DISMISSED_STATE_KEY, true);
    renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(false));
  }

  return createCommandHandler(
    {
      [DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE]: () => postCurrentState(),
      [DESKTOP_ONBOARDING_COMMANDS.DISMISS]: () => dismiss(),
      // Welcome-card skip (PRD: agent-native onboarding). Host-neutral
      // declined flag — the same one the CLI picker persists. The desktop
      // does not push SET_ONBOARDING_FUNNEL yet (the card stays hidden via
      // the webview's 'done' default), but the flag write keeps the skip
      // semantics consistent once it does.
      [MAIN_VIEW_COMMANDS.ONBOARDING_SKIP]: () =>
        setOnboardingDeclined(state, true),
    },
    { onAsyncError: options.onAsyncError },
  );
}
