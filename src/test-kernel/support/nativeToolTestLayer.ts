/** Explicit call capabilities over the test host's existing process services. */
import { Layer } from 'effect';

import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { Runs } from '@agent/runtime/runRegistry';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import { workspaceRoots } from '@platform/workspaceRoots';
import { effectRuntime } from '@platform/processRuntime';
import { testRunRegistry } from '@test/support/runHandleFixtures';

/** Each invocation owns its tracker; tests may supply a run and its workspace frame.
 *  The call's `Runs` are its run's session's; a call outside any run gets a
 *  registry over an empty fold, as it tracks no run. */
export function nativeToolTestLayer(options: Partial<ToolCallShape> = {}) {
  return Layer.mergeAll(
    Layer.effectContext(effectRuntime().contextEffect),
    Layer.sync(ToolCall, () => ({
      roots: options.inScope
        ? options.inScope(() => workspaceRoots())
        : workspaceRoots(),
      tracker: new FileInteractionState(),
      run: undefined,
      inScope: (operation) => operation(),
      ...options,
    })),
    Layer.sync(Runs, () => options.run?.session.runs ?? testRunRegistry()),
  );
}
