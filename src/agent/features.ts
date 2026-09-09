import { SharedToolInjectionRegistry } from '@agent/runtime/toolInjection';
import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { isGoalEnabled } from '@tools/goal';

/**
 * Register the conditional tool injections (memory, plan/goal).
 *
 * `memory` reads the global state store the caller passes in — every host
 * composition root already holds it. `plan` still reads host config
 * (`workspaceRoots().config`) when its predicate runs at injection time, so
 * process workspace roots must be initialized before a run injects tools.
 */
export function registerAgentFeatures(globalState: StateStore): void {
  SharedToolInjectionRegistry.register({
    toolName: 'memory',
    shouldInject: () =>
      globalState.get<boolean>(GlobalStateKey.MEMORY_ENABLED, true),
  });

  // The unified `plan` tool owns both planning and goal lifecycle commands
  // (update / pause / complete), so it is auto-injected whenever goal is
  // enabled: any tool-use agent can drive the autonomous loop without opting
  // into the tool in YAML.
  //
  // The goal continuation itself is not registered here: `ToolUseWaitNode`
  // calls `maybeBuildGoalContinuation` directly at the pre-wait point. There
  // is no idle-continuation registry — goal was its only consumer.
  SharedToolInjectionRegistry.register({
    toolName: 'plan',
    shouldInject: () => isGoalEnabled(),
  });
}
