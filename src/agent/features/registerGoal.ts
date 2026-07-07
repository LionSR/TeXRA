import { SharedToolInjectionRegistry } from '@agent/runtime/toolInjection';
import { isGoalEnabled } from '@tools/goal';

/**
 * Wire the Goal (autonomous-continuation) feature into the tool-use loop.
 *
 * The unified `plan` tool owns both planning and goal lifecycle commands
 * (update / pause / complete), so it is auto-injected whenever goal is
 * enabled — any tool-use agent can drive the autonomous loop without opting
 * into the tool in YAML.
 *
 * The continuation itself is not registered here: `ToolUseWaitNode` calls
 * `maybeBuildGoalContinuation` directly at the pre-wait point. There is no
 * idle-continuation registry — goal was its only consumer.
 */
export function registerGoalFeature(): void {
  SharedToolInjectionRegistry.register({
    toolName: 'plan',
    shouldInject: () => isGoalEnabled(),
  });
}
