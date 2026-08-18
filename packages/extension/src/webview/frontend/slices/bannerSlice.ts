/**
 * Banner slice: the single `SET_BANNER` handler for every main-view banner
 * surface (API-key, agent-config, dependency, getting-started, login, and
 * the orchestrator hint).
 */

// Local imports - shared IPC and schemas
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import type { MainViewBanner, MainViewHandlerRegistry } from '@shared/schemas';

// Local imports - main view
import {
  agentConfigBanner$,
  apiKeyBanner$,
  dependencyBanner$,
  gettingStartedVisible$,
  getModelOptionsForSession,
  loginBannerVisible$,
  model$,
  sessionHintDismissed$,
  sessionType$,
} from '../mainViewState';

function shouldForceApiKeyBanner(): boolean {
  if (apiKeyBanner$.get().requiresKey) {
    return true;
  }
  const option = getModelOptionsForSession(sessionType$.get()).find(
    (item) => item.value === model$.get(),
  );
  return option?.requiresKey ?? false;
}

// `MainViewHandlerRegistry` is now exhaustive (every MainView outbound
// command needs a real handler or `unsupported(...)` — see
// `@shared/utils/dispatcher`). This slice only owns banner commands, so it's
// typed as a `satisfies Partial<...>` subset rather than the full registry;
// `messageDispatcher.ts` spreads all six slices together and is the actual
// exhaustiveness checkpoint TypeScript enforces.
export const bannerHandlers = {
  [MAIN_VIEW_COMMANDS.SET_BANNER]: (message) => {
    const { visible, data } = message;
    const apply: Record<MainViewBanner, () => void> = {
      apiKey: () => {
        if (visible) {
          apiKeyBanner$.set({
            visible: true,
            provider: data?.provider ?? '',
            requiresKey: data?.requiresKey ?? false,
          });
        } else if (!shouldForceApiKeyBanner()) {
          apiKeyBanner$.set({ visible: false });
        }
      },
      agentConfig: () => {
        agentConfigBanner$.set(
          visible
            ? {
                visible: true,
                agentName: data?.agentName ?? '',
                customDirSet: data?.customDirSet ?? false,
              }
            : { visible: false },
        );
      },
      dependency: () => {
        dependencyBanner$.set(
          visible
            ? { visible: true, missingTools: data?.missingTools ?? [] }
            : { visible: false },
        );
      },
      gettingStarted: () => {
        gettingStartedVisible$.set(visible);
      },
      login: () => {
        loginBannerVisible$.set(visible);
      },
      orchestrator: () => {
        sessionHintDismissed$.set(!visible);
      },
    };
    apply[message.banner]();
  },
} satisfies Partial<MainViewHandlerRegistry>;
