import { platform } from '@platform/platform';
import { registerToolInjection } from '@agent/runtime/toolInjection';
import { GlobalStateKey } from '@shared/state/stateKeys';

export function registerMemoryFeature(): void {
  registerToolInjection({
    toolName: 'memory',
    shouldInject: () =>
      platform().globalState.get<boolean>(GlobalStateKey.MEMORY_ENABLED, true),
  });
}
