import { platform } from '@platform/platform';
import { maybeBuildOdysseyContinuation } from '@agent/odyssey';
import { registerIdleContinuation } from '@agent/runtime/idleContinuation';
import { registerToolInjection } from '@agent/runtime/toolInjection';
import {
  ODYSSEY_FEATURE_FLAG_KEY,
  ODYSSEY_TOOL_NAME,
} from '@tools/odyssey/odysseyMeta';
import { OdysseyStore } from '@tools/odyssey/odysseyStore';

export function registerOdysseyFeature(): void {
  registerToolInjection({
    toolName: ODYSSEY_TOOL_NAME,
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
