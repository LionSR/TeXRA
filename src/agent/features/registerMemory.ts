import { getGlobalState } from '@agent/core/stateStore';
import { registerToolInjection } from '@agent/runtime/toolInjection';
import { GlobalStateKey } from '@common/state/stateKeys';

/**
 * Auto-inject the memory tool into every tool-use agent (including subagents)
 * so they share the same /memories directory. Predicate runs per-cycle so
 * toggling `MEMORY_ENABLED` from settings takes effect on the next cycle
 * without restarting.
 */
export function registerMemoryFeature(): void {
  registerToolInjection({
    toolName: 'memory',
    shouldInject: () =>
      getGlobalState().get<boolean>(GlobalStateKey.MEMORY_ENABLED, true),
  });
}
