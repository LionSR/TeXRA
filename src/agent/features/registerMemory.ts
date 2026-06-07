import { platform } from '@platform/platform';
import { toolInjectionRegistry } from '@agent/runtime/toolInjection';
import { GlobalStateKey } from '@shared/state/stateKeys';

export function registerMemoryFeature(): void {
  toolInjectionRegistry.register({
    toolName: 'memory',
    shouldInject: () =>
      platform().globalState.get<boolean>(GlobalStateKey.MEMORY_ENABLED, true),
  });
}
