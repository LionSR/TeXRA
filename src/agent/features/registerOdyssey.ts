import { platform } from '@platform/platform';
import { maybeBuildOdysseyContinuation } from '@agent/odyssey';
import { registerIdleContinuation } from '@agent/runtime/idleContinuation';
import { registerToolInjection } from '@agent/runtime/toolInjection';
import { ODYSSEY_FEATURE_FLAG_KEY } from '@tools/odyssey/odysseyMeta';
import { OdysseyStore } from '@tools/odyssey/odysseyStore';

export function registerOdysseyFeature(): void {
  // The unified `plan` tool owns both planning and odyssey lifecycle commands
  // (update / pause / complete). Auto-inject it when the experimental odyssey
  // flag is on so any tool-use agent can drive the autonomous loop without
  // having to opt into the tool in YAML.
  registerToolInjection({
    toolName: 'plan',
    shouldInject: () =>
      platform().config.get<boolean>(ODYSSEY_FEATURE_FLAG_KEY, false),
  });

  registerIdleContinuation({
    source: 'odyssey',
    async build(ctx) {
      const followUp = await maybeBuildOdysseyContinuation(ctx);
      if (!followUp) return null;
      return {
        source: 'odyssey',
        followUp,
        commit: () => OdysseyStore.recordContinuation(ctx.streamId),
      };
    },
  });
}
