/** Explicit call capabilities over the test host's existing process services. */
import { Context, Effect, Layer, Schema, Scope, SynchronizedRef } from 'effect';

import { Interactions } from '@agent/runtime/HostInteractions';
import { SessionRequests } from '@agent/runtime/requestPolicy';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { Runs } from '@agent/runtime/runRegistry';
import {
  ToolContext,
  type ITool,
  type ToolContextShape,
  type ToolEnv,
} from '@agent/core/tools/ToolTypes';
import { RunCall, type RunCallShape } from '@agent/runtime/RunCall';
import type { AgentRunShape } from '@agent/runtime/run/AgentRun';
import type { OpenStep } from '@agent/runtime/loop/step';
import {
  ChildRuns,
  childRuns,
  type PluginToolServices,
} from '@agent/runtime/ToolServices';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { sessionFsLayer } from '@platform/rootedFs';
import type { SettingsStores } from '@shared/config/settings';
import type { DraftBlob } from '@shared/session/historyTurns';
import { RunHistory } from '@shared/session/runHistory';
import { NO_FACTS } from '@shared/session/runFacts';
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
type TestCallRun = Pick<RunCallShape['run'], 'runId' | 'toolPolicy'> &
  Partial<RunCallShape['run']> & {
    readonly session: Context.Context<SessionServices>;
  };

/** A run's live model cell holding only the id a tool reads off it. */
export const testModelCell = (modelId: string) =>
  SynchronizedRef.makeUnsafe({ modelId } as BoundModel);

/** A run that has opened no step yet. */
export const noStep = () => SynchronizedRef.makeUnsafe<OpenStep | null>(null);

/** A run fixture's step fields: no step opened yet, and every step offers
 *  exactly `tools`, as the run's own tools over an empty catalog. */
export const testRunTools = (
  stores: SettingsStores,
  tools: Readonly<Record<string, ITool<Error, PluginToolServices>>> = {},
): Pick<AgentRunShape, 'toolInputs' | 'steps'> => ({
  toolInputs: {
    tools: [],
    runTools: Object.values(tools),
    injectTools: false,
    injectInstalled: false,
    stores,
    workspaceRoot: undefined,
    held: { warnings: [], loaded: new Map(), entries: new Map() },
  },
  steps: noStep(),
});

/** Tests may supply a run and the roots it answers for; the run's facts
 *  (what it read and edited) are read from its session's store, as a
 *  resumed process reads them. The call's `Runs` are its run's session's;
 *  a call outside any run gets a registry over an empty fold, as it tracks
 *  no run. */
export function nativeToolTestLayer(
  options: Partial<Omit<ToolEnv, 'run'>> &
    Partial<Pick<ToolContextShape, 'callId' | 'emit'>> & {
      run?: TestCallRun;
      origin?: Partial<
        Pick<RunCallShape, 'responseId' | 'instruction' | 'attempt' | 'logId'>
      >;
    } = {},
) {
  const roots = options.roots ?? testWorkspaceRoots();
  const { run, origin, workingDirectory, stepRoots } = options;
  const callId = options.callId ?? `call-${crypto.randomUUID()}`;
  // A fixture is the slice of the run its case reads; the run answers for
  // its own config and trace with the inert pair.
  const { session, ...runFields } = run ?? {};
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
    fileService: new RunFileService(run.runId, roots),
    callbacks: {},
    ...runFields,
    runId: run.runId,
    toolPolicy: run.toolPolicy,
  };
  // One layer value, which the plugin services are built over; the child
  // door reads the same runs off the call's session.
  const runs = Layer.sync(Runs, () =>
    session === undefined ? testRunRegistry() : Context.get(session, Runs),
  );
  // A test call is no script's and issues none; under a run it launches
  // children through the door over its own place in the run, and outside
  // one the place and the door keep their defaults (null, a refusal).
  const runCall: RunCallShape | null =
    toolRun === undefined || session === undefined
      ? null
      : {
          run: toolRun,
          session,
          responseId: 'test-response',
          instruction: undefined,
          attempt: 1,
          logId: `log-${callId}`,
          // The run's rows as the store holds them: what a case seeds
          // (`seedEditedFiles`) is what the call reads.
          facts: Context.get(session, RunHistory)
            .load(toolRun.runId)
            .pipe(
              Effect.map((state) => state ?? NO_FACTS),
              Effect.orDie,
            ),
          script: null,
          scriptCalls: null,
          ...origin,
        };
  const childDoor =
    runCall === null
      ? Layer.effectDiscard(Effect.void)
      : Layer.succeed(ChildRuns)(childRuns(runCall));
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
      ...(toolRun !== undefined &&
        session !== undefined && {
          // A run's requests open unbound on its session: a test call has no
          // loop to bind them to.
          requests: {
            nextId: (prefix: string) => `${prefix}-${crypto.randomUUID()}`,
            open: <P extends PermissionPayload>(
              payload: P,
              blobs?: readonly DraftBlob[],
            ) =>
              Context.get(session, SessionRequests)
                .ask(toolRun.runId, payload, {
                  ...(blobs && { blobs }),
                })
                .pipe(
                  Effect.map((decision) => ({
                    // The fixture always answers the supplied request's kind.
                    payload: payload as Extract<
                      PermissionPayload,
                      { kind: P['kind'] }
                    >,
                    decision,
                  })),
                ),
            post: (requestId: string, payload: PermissionPayload) =>
              Context.get(session, RunHistory)
                .open(toolRun.runId)
                .pipe(
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
              Context.get(session, Interactions).emit(event, payload),
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
