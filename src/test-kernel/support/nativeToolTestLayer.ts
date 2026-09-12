/** Explicit call capabilities over the test host's existing process services. */
import { Layer } from 'effect';

import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import { workspaceRoots } from '@platform/workspaceRoots';
import { effectRuntime } from '@platform/processRuntime';

/** Each invocation owns its tracker; tests may supply a run and its workspace frame. */
export function nativeToolTestLayer(options: Partial<ToolCallShape> = {}) {
  return Layer.merge(
    Layer.effectContext(effectRuntime().contextEffect),
    Layer.sync(ToolCall, () => ({
      config: options.inScope
        ? options.inScope(() => workspaceRoots().config)
        : workspaceRoots().config,
      tracker: new FileInteractionState(),
      run: undefined,
      inScope: (operation) => operation(),
      ...options,
    })),
  );
}
