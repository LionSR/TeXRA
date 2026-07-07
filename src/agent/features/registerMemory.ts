import { platform } from '@platform/platform';
import { SharedToolInjectionRegistry } from '@agent/runtime/toolInjection';
import { GlobalStateKey } from '@shared/state/stateKeys';

export function registerMemoryFeature(): void {
  SharedToolInjectionRegistry.register({
    toolName: 'memory',
    shouldInject: () =>
      platform().globalState.get<boolean>(GlobalStateKey.MEMORY_ENABLED, true),
  });
}
