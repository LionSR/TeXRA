import {
  planOnboardingFunnelTransition,
  type OnboardingFunnelState,
} from '@controllers/onboarding/onboardingFunnel';
import { OnboardingRefreshQueue } from '@controllers/onboarding/OnboardingRefreshQueue';
import { platform } from '@platform/platform';
import type { StateStore } from '@platform/interfaces';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  readOnboardingFlags,
  setFirstRunDone,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import {
  buildDesktopOnboardingSetStateMessage,
  DESKTOP_ONBOARDING_COMMANDS,
  DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
} from '../shared/desktopOnboardingMessages.js';
import {
  createCommandHandler,
  type DesktopMessageHandler,
  type DesktopRenderer,
} from './desktopIpcTypes.js';

export interface DesktopOnboardingIpcOptions {
  state?: StateStore;
  /**
   * Host-provided check for a usable credential (a subscription or any
   * provider API key). Async because the secrets read can involve disk I/O.
   */
  hasCredential: () => boolean | Promise<boolean>;
  /** Post SET_SELECTED_AGENT to the renderer when entering State 1. */
  selectSetupAgent: () => Promise<void>;
  /** Launch the setup conversation when the user clicks "Run Setup". */
  kickoffSetup: () => Promise<void>;
  /** Run ChatGPT sign-in flow from the welcome card. */
  signInWithChatGpt: () => Promise<void>;
  /**
   * Open the getting-started walkthrough from the State 0 welcome card. The
   * desktop shell can't host the VS Code walkthrough, so the host wires this to
   * the closest analog: opening the desktop getting-started docs externally.
   */
  openGettingStarted: () => Promise<void>;
  onAsyncError?: (error: unknown) => void;
}

export interface DesktopOnboardingIpc extends DesktopMessageHandler {
  /** Recompute the funnel from credentials + flags and push it to the webview. */
  refreshOnboardingFunnel(): Promise<void>;
}

export function createDesktopOnboardingIpc(
  renderer: DesktopRenderer,
  options: DesktopOnboardingIpcOptions,
): DesktopOnboardingIpc {
  const state = options.state ?? platform().globalState;
  let previousFunnelState: OnboardingFunnelState | undefined;
  let setupKickoffStarted = false;
  // Serialize refreshes so concurrent callers (WEBVIEW_READY, post-backfill,
  // auth refresh, api-key hooks, run completion) never interleave. The funnel
  // derivation has an internal `await` (the credential probe) and mutates the
  // shared `previousFunnelState`; without serialization the last caller to
  // finish could push a `SET_ONBOARDING_FUNNEL` derived from a stale previous
  // state. A latch coalesces overlapping requests: while one refresh is in
  // flight, a single re-run is queued and run once the current one settles, so
  // callers always observe a consistent terminal state.
  const funnelRefreshQueue = new OnboardingRefreshQueue(
    runOnboardingFunnelRefresh,
  );

  function postCurrentState(): void {
    const dismissed = state.get<boolean>(
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      false,
    );
    renderer.postToRenderer(buildDesktopOnboardingSetStateMessage(!dismissed));
  }

  async function runOnboardingFunnelRefresh(): Promise<void> {
    const hasCredential = await Promise.resolve(options.hasCredential()).catch(
      () => false,
    );
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
      await options.selectSetupAgent();
    }
    // Entering State 1 only selects the setup agent and paints the setup card;
    // it never auto-starts the setup conversation. The user launches setup
    // explicitly via the card's "Run Setup" button (ONBOARDING_RUN_SETUP).
  }

  // Single guarded entry point for launching setup. The explicit "Run Setup"
  // card action routes through here so a setup run can't be started twice
  // concurrently — the host's `handleExecute`/`runAgent` has no in-flight
  // dedup of its own.
  function startSetupKickoff(): void {
    if (setupKickoffStarted) return;
    setupKickoffStarted = true;
    // Fire-and-forget: the host kickoff runs the setup conversation to
    // completion, which must NOT block the serialized funnel-refresh chain —
    // otherwise a later "skip setup" / sign-out / credential-removal refresh
    // would queue behind the entire setup run, leaving the card stuck on 'setup'.
    void options
      .kickoffSetup()
      .catch(() => {
        // Swallow — the kickoff handler already surfaced the error to the user.
      })
      .finally(() => {
        // Clear the guard once the run settles (success or failure), not only on
        // error: while it's in flight the guard blocks a concurrent second run,
        // but afterwards another manual "Run Setup" click must be able to launch
        // setup again (otherwise the guard would stay stuck for the window's
        // lifetime after the first kickoff).
        setupKickoffStarted = false;
      });
  }

  function refreshOnboardingFunnel(): Promise<void> {
    return funnelRefreshQueue.run();
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
    await options.selectSetupAgent();
    // Route through the shared guard so a double-click of "Run Setup" can't
    // launch a second concurrent run.
    startSetupKickoff();
    await refreshOnboardingFunnel();
  }

  async function signInWithChatGpt(): Promise<void> {
    await options.signInWithChatGpt();
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
        // State 0 walkthrough button. The desktop shell can't host the VS Code
        // getting-started walkthrough, so this opens the desktop docs externally
        // (the host wires `openGettingStarted`).
        [MAIN_VIEW_COMMANDS.ONBOARDING_OPEN_GETTING_STARTED]: () =>
          options.openGettingStarted(),
      },
      { onAsyncError: options.onAsyncError },
    ),
    refreshOnboardingFunnel,
  };
}
