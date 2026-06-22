import { platform } from '@platform/platform';
import {
  planOnboardingFunnelTransition,
  readOnboardingFlags,
  setFirstRunDone,
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
  /** Post SET_SELECTED_AGENT to the renderer when entering State 1. */
  selectSetupAgent?: () => Promise<void>;
  /** Auto-start the setup conversation on the State 0→1 transition. */
  kickoffSetup?: () => Promise<void>;
  /** Run ChatGPT sign-in flow from the welcome card. */
  signInWithChatGpt?: () => Promise<void>;
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
  let setupKickoffStarted = false;

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
    if (transition.selectSetupAgent) {
      await options.selectSetupAgent?.();
    }
    if (transition.kickoffSetup && !setupKickoffStarted) {
      setupKickoffStarted = true;
      try {
        await options.kickoffSetup?.();
      } catch {
        setupKickoffStarted = false;
      }
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

  async function skipSetup(): Promise<void> {
    await setFirstRunDone(state, true);
    await refreshOnboardingFunnel();
  }

  async function runSetup(): Promise<void> {
    await options.selectSetupAgent?.();
    await options.kickoffSetup?.();
    await refreshOnboardingFunnel();
  }

  async function signInWithChatGpt(): Promise<void> {
    await options.signInWithChatGpt?.();
    await refreshOnboardingFunnel();
  }

  return {
    ...createCommandHandler(
      {
        // Every main-view mount must clear MainApp's first-paint `pending`
        // guard with a concrete state (State 0 welcome card, State 1 setup,
        // or State 2 done).
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
        [MAIN_VIEW_COMMANDS.ONBOARDING_SKIP_SETUP]: () => skipSetup(),
        [MAIN_VIEW_COMMANDS.ONBOARDING_RUN_SETUP]: () => runSetup(),
        [MAIN_VIEW_COMMANDS.ONBOARDING_SIGN_IN_CHATGPT]: () =>
          signInWithChatGpt(),
      },
      { onAsyncError: options.onAsyncError },
    ),
    refreshOnboardingFunnel,
  };
}
