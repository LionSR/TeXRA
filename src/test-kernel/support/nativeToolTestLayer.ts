/** Explicit call capabilities over the test host's existing process services. */
import { type Effect, Layer, Scope, SynchronizedRef } from 'effect';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { Runs } from '@agent/runtime/runRegistry';
import type { BoundModel } from '@agent/runtime/run/modelBinding';
import {
  ToolContext,
  type ToolContextShape,
  type ToolEnv,
} from '@agent/core/tools/ToolTypes';
import {
  IssuingScript,
  ScriptCalls,
  RunCall,
  type RunCallShape,
  type ToolRun,
} from '@agent/runtime/RunCall';
import type { AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { OpenStep } from '@agent/runtime/loop/step';
import type { RuntimeTool } from '@agent/runtime/ToolServices';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { sessionFsLayer } from '@platform/rootedFs';
import type { PermissionPayload } from '@shared/schemas';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testRunRegistry } from '@test/support/runHandleFixtures';
import { testCallPluginServices } from '@test/support/testPluginServices';
import { generateShortId } from '@utils/core';
import { RunFileService } from '@utils/files/runStorage';

/** The run a test call is made under: what every fixture names, plus whatever
 *  else of the run the case under test actually reads. */
type TestCallRun = Pick<ToolRun, 'session' | 'runId' | 'toolPolicy'> &
  Partial<ToolRun>;

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
    host: stores.host,
    runTools: Object.values(tools),
    injectTools: false,
    injectInstalled: false,
    stores,
    workspaceRoot: undefined,
    held: { warnings: [], loaded: new Map() },
  },
  steps: noStep(),
});

/** Each invocation owns its read set; tests may supply a run and the
 *  roots it answers for. The call's `Runs` are its run's session's; a call
 *  outside any run gets a registry over an empty fold, as it tracks no run. */
export function nativeToolTestLayer(
  options: Partial<ToolEnv> &
    Partial<Pick<ToolContextShape, 'callId' | 'emit'>> & {
      run?: TestCallRun;
      readFiles?: Set<string>;
      origin?: Partial<
        Pick<RunCallShape, 'responseId' | 'instruction' | 'attempt' | 'logId'>
      >;
    } = {},
) {
  const roots = options.roots ?? testWorkspaceRoots();
  const { run, readFiles, origin, workingDirectory, stepRoots } = options;
  const callId = options.callId ?? `call-${generateShortId()}`;
  return Layer.mergeAll(
    Layer.effectContext(testRuntime().contextEffect),
    // The call's rooted filesystems, from the same roots it is given.
    sessionFsLayer(roots).pipe(
      Layer.provide(Layer.effectContext(testRuntime().contextEffect)),
    ),
    Layer.sync(ToolContext, (): ToolContextShape => ({
      callId,
      env: {
        roots,
        ...(workingDirectory !== undefined && { workingDirectory }),
        ...(stepRoots !== undefined && { stepRoots }),
      },
      emit: options.emit ?? (() => undefined),
      ...(run !== undefined && {
        // A run's requests open unbound on its session: a test call has no
        // loop to bind them to.
        requests: {
          nextId: (prefix: string) => `${prefix}-${generateShortId()}`,
          open: (
            payload: PermissionPayload,
            opened?: { readonly onNeverCommitted?: Effect.Effect<void> },
          ) => run.session.requests.ask(run.runId, payload, opened),
        },
      }),
    })),
    // A test call is no script's and issues none.
    Layer.succeed(ScriptCalls)(null),
    Layer.succeed(IssuingScript)(null),
    run === undefined
      ? Layer.succeed(RunCall)(null)
      : Layer.succeed(RunCall)({
          // A fixture is the slice of the run its case reads; the run
          // answers for its own config and trace with the inert pair.
          run: {
            config: AgentConfigSchema.parse({
              agent: 'test',
              model: 'test-model',
            }),
            model: testModelCell('test-model'),
            logger: noopTrace,
            steps: noStep(),
            scope: Scope.makeUnsafe(),
            task: null,
            opening: null,
            fileService: new RunFileService(run.runId, roots),
            callbacks: {},
            ...run,
          },
          readFiles: readFiles ?? new Set<string>(),
          responseId: 'test-response',
          instruction: undefined,
          attempt: 1,
          logId: `log-${callId}`,
          ...origin,
        }),
    // The session's plugin services, over the same `Runs`, as a step pins
    // them for the call.
    testCallPluginServices.pipe(
      Layer.provideMerge(
        Layer.sync(Runs, () => run?.session.runs ?? testRunRegistry()),
      ),
    ),
  );
}
