/** Explicit call capabilities over the test host's existing process services. */
import { Context, Layer } from 'effect';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { Runs } from '@agent/runtime/runRegistry';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import { sessionFsLayer } from '@platform/rootedFs';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testRunRegistry } from '@test/support/runHandleFixtures';
import { toolTable } from '@tools/toolTable';
import { CompositionKey, type PinnedComposition } from '@tools/compositions';

type CallRun = NonNullable<ToolCallShape['run']>;

/** The run a test call is made under: what every fixture names, plus whatever
 *  else of the run the case under test actually reads. */
type TestCallRun = Pick<CallRun, 'session' | 'runId' | 'toolPolicy'> &
  Partial<CallRun>;

/** A pinned composition with no plugins, for a run fixture offered none. */
export const emptyPinnedComposition: PinnedComposition = {
  key: new CompositionKey('0'.repeat(64), {
    plugins: [],
    disabled: [],
    host: null,
    approvalPromptsUnavailable: false,
    tools: [],
    injected: [],
  }),
  table: toolTable({}),
  services: Context.empty(),
};

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
        composition: emptyPinnedComposition,
        ...run,
      },
      ...call,
    })),
    Layer.sync(Runs, () => run?.session.runs ?? testRunRegistry()),
  );
}
