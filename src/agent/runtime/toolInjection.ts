import { GlobalStateKey } from '@shared/state/stateKeys';
import type { RegisteredToolName } from '@tools/registry';
// Deliberately not the `@tools/goal` barrel: it also loads goalStore, whose
// session graph must not sit behind tool resolution (see the barrel's note).
import { isGoalEnabled } from '@tools/goal/goalFeatureFlag';
import { readPlatformSetting } from '@utils/config/platformSettings';

/**
 * A tool that should be auto-injected into every tool-use agent's resolved
 * tool list when `shouldInject()` returns true. Used to keep agents from
 * having to opt into shared infrastructure (memory, goal) in YAML.
 *
 * Core flow code iterates the registry — it doesn't know which features are
 * registered.
 */
interface ConditionalToolInjection {
  readonly toolName: RegisteredToolName;
  shouldInject(): boolean;
}

export class ToolInjectionRegistry {
  private readonly injections: ConditionalToolInjection[] = [];

  register(injection: ConditionalToolInjection): void {
    if (this.injections.some((i) => i.toolName === injection.toolName)) {
      throw new Error(
        `Duplicate conditional tool injection: ${injection.toolName}`,
      );
    }
    this.injections.push(injection);
  }

  list(): readonly ConditionalToolInjection[] {
    return [...this.injections];
  }
}

/**
 * The process-wide injections every host shares. Each predicate reads its
 * setting when a run resolves its tools, so `initPlatform()` and the process
 * workspace roots must be initialized by then.
 */
export const SharedToolInjectionRegistry = new ToolInjectionRegistry();

SharedToolInjectionRegistry.register({
  toolName: 'memory',
  shouldInject: () =>
    readPlatformSetting<boolean>(GlobalStateKey.MEMORY_ENABLED),
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
