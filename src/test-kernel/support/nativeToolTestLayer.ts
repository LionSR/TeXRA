/** Explicit call capabilities over the test host's existing process services. */
import { Layer, Scope, SynchronizedRef } from 'effect';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { Runs } from '@agent/runtime/runRegistry';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import { ToolCall, type ToolCallShape } from '@agent/runtime/ToolCall';
import type { AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { OpenStep } from '@agent/runtime/loop/step';
import type { RuntimeTool } from '@agent/runtime/ToolServices';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { sessionFsLayer } from '@platform/rootedFs';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testRunRegistry } from '@test/support/runHandleFixtures';
import { testCallPluginServices } from '@test/support/testPluginServices';

type CallRun = NonNullable<ToolCallShape['run']>;

/** The run a test call is made under: what every fixture names, plus whatever
 *  else of the run the case under test actually reads. */
type TestCallRun = Pick<CallRun, 'session' | 'runId' | 'toolPolicy'> &
  Partial<CallRun>;

/** A run's live model cell holding only the id a tool reads off it. */
export const testModelCell = (modelId: string) =>
  SynchronizedRef.makeUnsafe({ modelId } as BoundModel);

/** A run that has opened no step yet. */
export const noStep = () => SynchronizedRef.makeUnsafe<OpenStep | null>(null);

/** A run fixture's step fields: no step opened yet, and every step offers
 *  exactly `tools`, as the run's own tools over an empty catalog. */
export const testRunTools = (
  stores: ModelOptionStores,
  tools: Readonly<Record<string, RuntimeTool>> = {},
): Pick<AgentRunShape, 'toolInputs' | 'steps'> => ({
  toolInputs: {
    tools: [],
    approvalPromptsUnavailable: false,
    host: undefined,
    runTools: Object.values(tools),
    injectTools: false,
    stores,
    workspaceRoot: undefined,
    held: { warnings: [], loaded: new Map() },
  },
  steps: noStep(),
});

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
        model: testModelCell('test-model'),
        logger: noopTrace,
        steps: noStep(),
        scope: Scope.makeUnsafe(),
        ...run,
      },
      ...call,
    })),
    // The session's plugin services, over the same `Runs`, as a step pins
    // them for the call.
    testCallPluginServices.pipe(
      Layer.provideMerge(
        Layer.sync(Runs, () => run?.session.runs ?? testRunRegistry()),
      ),
    ),
  );
}
