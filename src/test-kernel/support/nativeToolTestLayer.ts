/** Explicit call capabilities over the test host's existing process services. */
import { Effect, Layer, Schema, Scope, SynchronizedRef } from 'effect';

import { Runs } from '@agent/runtime/runRegistry';
import {
  ToolContext,
  type ToolContextShape,
  type ToolEnv,
} from '@agent/core/tools/ToolTypes';
import { RunCall, type RunCallShape } from '@agent/runtime/RunCall';
import type { AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { OpenStep } from '@agent/runtime/loop/step';
import {
  ChildRuns,
  childRuns,
  type RuntimeTool,
} from '@agent/runtime/ToolServices';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import type { ModelOptionStores } from '@model/computeModelOptions';
import { sessionFsLayer } from '@platform/rootedFs';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  type PermissionPayload,
} from '@shared/schemas';
import { noopTrace } from '@test/support/noopTrace';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testRunRegistry } from '@test/support/runHandleFixtures';
import { testCallPluginServices } from '@test/support/testPluginServices';
import { RunFileService } from '@utils/files/runStorage';

/** The run a test call is made under: what every fixture names, plus whatever
 *  else of the run the case under test actually reads. */
type TestCallRun = Pick<
  RunCallShape['run'],
  'session' | 'runId' | 'toolPolicy'
> &
  Partial<RunCallShape['run']>;

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
    held: { warnings: [], loaded: new Map(), entries: new Map() },
  },
  steps: noStep(),
});

/** Each invocation owns its read set; tests may supply a run and the
 *  roots it answers for. The call's `Runs` are its run's session's; a call
 *  outside any run gets a registry over an empty fold, as it tracks no run. */
export function nativeToolTestLayer(
  options: Partial<Omit<ToolEnv, 'run'>> &
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
  const callId = options.callId ?? `call-${crypto.randomUUID()}`;
  // A fixture is the slice of the run its case reads; the run answers for
  // its own config and trace with the inert pair.
  const toolRun: RunCallShape['run'] | undefined = run && {
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
      agent: 'test',
      model: 'test-model',
    }),
    model: testModelCell('test-model'),
    logger: noopTrace,
    parentStage: noopTrace.openStage('Run: test'),
    steps: noStep(),
    scope: Scope.makeUnsafe(),
    opening: null,
    // The run's files hold what it read: a case that seeds or checks that
    // set shares its own with the run.
    fileService: Object.assign(
      new RunFileService(run.runId, roots),
      readFiles && { readFiles },
    ),
    callbacks: {},
    ...run,
  };
  // One layer value, so the child door and the plugin services share it.
  const runs = Layer.sync(Runs, () => run?.session.runs ?? testRunRegistry());
  // A test call is no script's and issues none; under a run it launches
  // children through the door over its own place in the run, and outside
  // one the place and the door keep their defaults (null, a refusal).
  const runCall: RunCallShape | null =
    toolRun === undefined
      ? null
      : {
          run: toolRun,
          responseId: 'test-response',
          instruction: undefined,
          attempt: 1,
          logId: `log-${callId}`,
          script: null,
          scriptCalls: null,
          ...origin,
        };
  const childDoor =
    runCall === null
      ? Layer.effectDiscard(Effect.void)
      : Layer.effect(
          ChildRuns,
          Effect.map(Runs, (registry) => childRuns(runCall, registry)),
        ).pipe(Layer.provide(runs));
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
        ...(toolRun !== undefined && { run: toolRun }),
      },
      emit: options.emit ?? (() => undefined),
      ...(toolRun !== undefined && {
        // A run's requests open unbound on its session: a test call has no
        // loop to bind them to.
        requests: {
          nextId: (prefix: string) => `${prefix}-${crypto.randomUUID()}`,
          open: (
            payload: PermissionPayload,
            opened?: { readonly onNeverCommitted?: Effect.Effect<void> },
          ) => toolRun.session.requests.ask(toolRun.runId, payload, opened),
          post: (requestId: string, payload: PermissionPayload) =>
            toolRun.session.runHistory.open(toolRun.runId).pipe(
              Effect.flatMap((cell) =>
                cell.append([
                  {
                    type: 'request.opened',
                    aggregateId: qualifyAggregateId('run', toolRun.runId),
                    requestId,
                    payload,
                  },
                ]),
              ),
              Effect.asVoid,
            ),
          present: (event, payload) =>
            toolRun.session.interactions.emit(event, payload),
        },
      }),
    })),
    runs,
    Layer.succeed(RunCall)(runCall),
    childDoor,
    // The session's plugin services, over the same `Runs`, as a step pins
    // them for the call.
    testCallPluginServices.pipe(Layer.provideMerge(runs)),
  );
}
