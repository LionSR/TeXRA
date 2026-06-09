import { maybeBuildOdysseyContinuation } from '@agent/odyssey';
import { idleContinuationRegistry } from '@agent/runtime/idleContinuation';
import { toolInjectionRegistry } from '@agent/runtime/toolInjection';
import { OdysseyStore, isOdysseyEnabled } from '@tools/odyssey';

export function registerOdysseyFeature(): void {
  // The unified `plan` tool owns both planning and odyssey lifecycle commands
  // (update / pause / complete). Auto-inject it when odyssey is enabled so any
  // tool-use agent can drive the autonomous loop without having to opt into the
  // tool in YAML.
  toolInjectionRegistry.register({
    toolName: 'plan',
    shouldInject: () => isOdysseyEnabled(),
  });

  idleContinuationRegistry.register({
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
