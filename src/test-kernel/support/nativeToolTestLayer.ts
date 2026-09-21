/** Explicit call capabilities over the test host's existing process services. */
import { Layer } from 'effect';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { Runs } from '@agent/runtime/runRegistry';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import { noopTrace } from '@agent/trace';
import { sessionFsLayer } from '@platform/rootedFs';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testRunRegistry } from '@test/support/runHandleFixtures';

type CallRun = NonNullable<ToolCallShape['run']>;

/** The run a test call is made under: what every fixture names, plus whatever
 *  else of the run the case under test actually reads. */
type TestCallRun = Pick<CallRun, 'session' | 'runId' | 'toolPolicy'> &
  Partial<CallRun>;

/** Each invocation owns its tracker; tests may supply a run and the roots it
 *  answers for. The call's `Runs` are its run's session's; a call outside any
 *  run gets a registry over an empty fold, as it tracks no run. */
export function nativeToolTestLayer(
  options: Omit<Partial<ToolCallShape>, 'run'> & { run?: TestCallRun } = {},
) {
  const roots = options.roots ?? testWorkspaceRoots();
  const { run, ...call } = options;
  return Layer.mergeAll(
    Layer.effectContext(testRuntime().contextEffect),
    // The call's rooted filesystems, from the same roots it is given.
    sessionFsLayer(roots).pipe(
      Layer.provide(Layer.effectContext(testRuntime().contextEffect)),
    ),
    Layer.sync(ToolCall, () => ({
      roots,
      tracker: new FileInteractionState(),
      // The run answers for its own config and trace; a fixture that does not
      // care about either gets the inert pair.
      run: run && {
        config: AgentConfigSchema.parse({ agent: 'test', model: 'test-model' }),
        logger: noopTrace,
        ...run,
      },
      ...call,
    })),
    Layer.sync(Runs, () => run?.session.runs ?? testRunRegistry()),
  );
}
