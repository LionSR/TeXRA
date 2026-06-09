import { toolInjectionRegistry } from '@agent/runtime/toolInjection';
import { isOdysseyEnabled } from '@tools/odyssey';

/**
 * Wire the Odyssey (autonomous-continuation) feature into the tool-use loop.
 *
 * The unified `plan` tool owns both planning and odyssey lifecycle commands
 * (update / pause / complete), so it is auto-injected whenever odyssey is
 * enabled — any tool-use agent can drive the autonomous loop without opting
 * into the tool in YAML.
 *
 * The continuation itself is not registered here: `ToolUseWaitNode` calls
 * `maybeBuildOdysseyContinuation` directly at the pre-wait point. There is no
 * idle-continuation registry — odyssey was its only consumer.
 */
export function registerOdysseyFeature(): void {
  toolInjectionRegistry.register({
    toolName: 'plan',
    shouldInject: () => isOdysseyEnabled(),
  });
}
