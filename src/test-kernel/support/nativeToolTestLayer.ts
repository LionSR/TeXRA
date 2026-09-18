/** Explicit call capabilities over the test host's existing process services. */
import { Layer } from 'effect';

import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { Runs } from '@agent/runtime/runRegistry';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import { sessionFsLayer } from '@platform/rootedFs';
import { processWorkspaceRoots } from '@platform/workspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testRunRegistry } from '@test/support/runHandleFixtures';

/** Each invocation owns its tracker; tests may supply a run and the roots it
 *  answers for. The call's `Runs` are its run's session's; a call outside any
 *  run gets a registry over an empty fold, as it tracks no run. */
export function nativeToolTestLayer(options: Partial<ToolCallShape> = {}) {
  const roots = options.roots ?? processWorkspaceRoots();
  return Layer.mergeAll(
    Layer.effectContext(testRuntime().contextEffect),
    // The call's rooted filesystems, from the same roots it is given.
    sessionFsLayer(roots).pipe(
      Layer.provide(Layer.effectContext(testRuntime().contextEffect)),
    ),
    Layer.sync(ToolCall, () => ({
      roots,
      tracker: new FileInteractionState(),
      run: undefined,
      ...options,
    })),
    Layer.sync(Runs, () => options.run?.session.runs ?? testRunRegistry()),
  );
}
