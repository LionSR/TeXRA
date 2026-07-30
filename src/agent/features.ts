import { SharedToolInjectionRegistry } from '@agent/runtime/toolInjection';
import { platform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { isGoalEnabled } from '@tools/goal';

// Must be called after initPlatform(): predicates read host services
// (platform().config, platform().globalState).
export function registerAgentFeatures(): void {
  SharedToolInjectionRegistry.register({
    toolName: 'memory',
    shouldInject: () =>
      platform().globalState.get<boolean>(GlobalStateKey.MEMORY_ENABLED, true),
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
