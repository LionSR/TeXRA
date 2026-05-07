import { platform } from '@platform/platform';
import {
  DESKTOP_ONBOARDING_COMMANDS,
  DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
  type DesktopOnboardingSetStateMessage,
} from '../desktopOnboardingMessages.js';
import {
  createDesktopErrorReporter,
  type DesktopCommandMessage,
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
  const reportAsyncError = createDesktopErrorReporter(options.onAsyncError);

  function makeSetStateMessage(
    shouldShow: boolean,
  ): DesktopOnboardingSetStateMessage {
    return {
      command: DESKTOP_ONBOARDING_COMMANDS.SET_STATE,
      shouldShow,
    };
  }

  function postCurrentState(): void {
    const dismissed = state.get<boolean>(
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      false,
    );
    renderer.postToRenderer(makeSetStateMessage(!dismissed));
  }

  async function dismiss(): Promise<void> {
    await state.update(DESKTOP_ONBOARDING_DISMISSED_STATE_KEY, true);
    renderer.postToRenderer(makeSetStateMessage(false));
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE:
          postCurrentState();
          return true;
        case DESKTOP_ONBOARDING_COMMANDS.DISMISS:
          void dismiss().catch(reportAsyncError);
          return true;
        case DESKTOP_ONBOARDING_COMMANDS.SHOW:
          renderer.postToRenderer(makeSetStateMessage(true));
          return true;
        default:
          return false;
      }
    },
  };
}
