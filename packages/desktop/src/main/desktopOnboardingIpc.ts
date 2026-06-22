import { platform } from '@platform/platform';
import {
  planOnboardingFunnelTransition,
  readOnboardingFlags,
  setOnboardingDeclined,
  type OnboardingFunnelState,
} from '@controllers/onboarding/onboardingFunnel';
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
  /**
   * Host-provided check for a usable credential (relay sign-in + server-side
   * keys, or any provider API key). Async because both the relay auth check
   * and the secrets read can involve disk/network I/O.
   */
  hasCredential?: () => boolean | Promise<boolean>;
  onAsyncError?: (error: unknown) => void;
}

export interface DesktopOnboardingIpc extends DesktopMessageHandler {
  /** Recompute the funnel from credentials + flags and push it to the webview. */
  refreshOnboardingFunnel(): Promise<void>;
}

export function createDesktopOnboardingIpc(
  renderer: DesktopRenderer,
  options: DesktopOnboardingIpcOptions = {},
): DesktopOnboardingIpc {
  const state = options.state ?? platform().globalState;
  let previousFunnelState: OnboardingFunnelState | undefined;

  function postCurrentState(): void {
    const dismissed = state.get<boolean>(
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      false,
    );
    renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(!dismissed));
  }

  async function refreshOnboardingFunnel(): Promise<void> {
    const hasCredential = options.hasCredential
      ? await Promise.resolve(options.hasCredential()).catch(() => false)
      : false;
    const flags = readOnboardingFlags(state);
    const transition = planOnboardingFunnelTransition(previousFunnelState, {
      hasCredential,
      ...flags,
    });
    previousFunnelState = transition.state;

    renderer.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: transition.state,
    });

    if (transition.clearDeclined) {
      await setOnboardingDeclined(state, false);
    }
  }

  async function dismiss(): Promise<void> {
    await state.update(DESKTOP_ONBOARDING_DISMISSED_STATE_KEY, true);
    renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(false));
  }

  async function skipMainOnboarding(): Promise<void> {
    await setOnboardingDeclined(state, true);
    await refreshOnboardingFunnel();
  }

  return {
    ...createCommandHandler(
      {
        // Desktop does not run State 0/1 yet, so every main-view mount must
        // clear MainApp's first-paint `pending` guard with a concrete state.
        [MAIN_VIEW_COMMANDS.WEBVIEW_READY]: {
          when: (message) => message.view === 'main',
          run: () => refreshOnboardingFunnel(),
          claim: false,
        },
        [DESKTOP_ONBOARDING_COMMANDS.REQUEST_STATE]: () => postCurrentState(),
        [DESKTOP_ONBOARDING_COMMANDS.DISMISS]: () => dismiss(),
        // Welcome-card skip (PRD: agent-native onboarding). Host-neutral
        // declined flag — the same one the CLI picker persists. After
        // persisting the declined flag, recompute the funnel; the derivation
        // produces 'done' when no credential is present.
        [MAIN_VIEW_COMMANDS.ONBOARDING_SKIP]: () => skipMainOnboarding(),
      },
      { onAsyncError: options.onAsyncError },
    ),
    refreshOnboardingFunnel,
  };
}
