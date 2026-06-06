import { getGlobalState } from '@agent/core/stateStore';
import { registerToolInjection } from '@agent/runtime/toolInjection';
import { GlobalStateKey } from '@shared/state/stateKeys';

export function registerMemoryFeature(): void {
  registerToolInjection({
    toolName: 'memory',
    shouldInject: () =>
      getGlobalState().get<boolean>(GlobalStateKey.MEMORY_ENABLED, true),
  });
}
