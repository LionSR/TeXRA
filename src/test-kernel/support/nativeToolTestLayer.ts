/** Explicit call capabilities over the calling fiber's process services. */
import {
  Context,
  Effect,
  Layer,
  Schema,
  ScopedRef,
  Semaphore,
  SynchronizedRef,
} from 'effect';

import { RunFileService } from '@texra-ai/harness/plugins';
import { callRequests } from '@agent/runtime/loop/toolGuard';
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
import { ProjectTools, type OpenStep } from '@agent/runtime/loop/step';
import {
  ChildRuns,
  childRuns,
  type PluginToolServices,
} from '@agent/runtime/ToolServices';
import type { BoundModel } from '@agent/runtime/modelAccess/ModelAccess';
import { sessionFsLayer } from '@platform/rootedFs';
import { RunHistory } from '@shared/session/runHistory';
import { NO_FACTS } from '@shared/session/runFacts';
import { AgentConfigSchema } from '@shared/schemas';
import { noopTrace } from '@test/support/noopTrace';
import { FakeHost } from '@test/support/testKernel';
import { testRunRegistry } from '@test/support/runHandleFixtures';

/** The run a test call is made under: what every fixture names, plus whatever
 *  else of the run the case under test actually reads. */
type TestCallRun = Pick<RunCallShape['run'], 'runId' | 'toolPolicy'> &
  Partial<RunCallShape['run']> & {
    readonly session: Context.Context<SessionServices>;
  };

/** A run that has opened no step yet. */
const noStep = () => SynchronizedRef.makeUnsafe<OpenStep | null>(null);

/** A run fixture's step fields: no step opened yet, and every step offers
 *  exactly `tools`, as the run's own tools over an empty catalog. */
export const testRunTools = (
  tools: Readonly<Record<string, ITool<Error, PluginToolServices>>> = {},
): Pick<AgentRunShape, 'toolInputs' | 'steps'> => ({
  toolInputs: {
    tools: [],
    runTools: Object.values(tools),
    injectTools: false,
    injectInstalled: false,
    held: { warnings: [], loaded: new Map(), entries: new Map() },
  },
  steps: noStep(),
});

/** Tests may supply a run and the roots it answers for; the run's facts
 *  (what it read and edited) are read from its session's store, as a
 *  resumed process reads them. The call's `Runs` are its run's session's;
 *  a call outside any run gets a registry over an empty fold, as it tracks
 *  no run. The process services the call reads are the calling fiber's:
 *  a suite provides this layer inside its `SessionGraph` block. */
export function nativeToolTestLayer(
  options: Partial<Omit<ToolEnv, 'run'>> &
    Partial<Pick<ToolContextShape, 'callId' | 'emit'>> & {
      run?: TestCallRun;
      origin?: Partial<
        Pick<RunCallShape, 'responseId' | 'instruction' | 'attempt' | 'logId'>
      >;
    } = {},
) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const roots = options.roots ?? (yield* FakeHost).roots;
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
        // cast: a tool reads only the id off the run's model cell.
        model: yield* ScopedRef.make(
          () => ({ modelId: 'test-model' }) as BoundModel,
        ),
        logger: noopTrace,
        parentStage: noopTrace.openStage('Run: test'),
        steps: noStep(),
        scope: yield* Effect.scope,
        opening: null,
        fileService: new RunFileService(run.runId, roots),
        callbacks: {},
        awaitedCalls: Semaphore.makeUnsafe(Number.MAX_SAFE_INTEGER),
        // A root unless the fixture names its parent edge.
        entry: { parent: null, awaited: false },
        ...runFields,
        runId: run.runId,
        toolPolicy: run.toolPolicy,
      };
      // One layer value, which the plugin services are built over; the child
      // door reads the same runs off the call's session.
      const runs =
        session === undefined
          ? Layer.effect(Runs, testRunRegistry(roots))
          : Layer.succeed(Runs)(Context.get(session, Runs));
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
        // The call's rooted filesystems, from the same roots it is given.
        sessionFsLayer(roots),
        Layer.effect(
          ToolContext,
          Effect.gen(function* () {
            // A run's requests are its loop's: `callRequests` over the run's
            // cell, under the ids this call's first attempt derives.
            const requests =
              runCall === null
                ? undefined
                : yield* Effect.map(
                    Context.get(runCall.session, RunHistory)
                      .open(runCall.run.runId)
                      .pipe(Effect.orDie),
                    (cell) =>
                      callRequests(
                        runCall.run,
                        runCall.session,
                        cell,
                        cell.append,
                        { responseId: runCall.responseId, callId, attempt: 1 },
                        0,
                        null,
                        'The test call ended.',
                      ).requests,
                  );
            return {
              callId,
              env: {
                roots,
                ...(workingDirectory !== undefined && { workingDirectory }),
                ...(stepRoots !== undefined && { stepRoots }),
                ...(toolRun !== undefined && { run: toolRun }),
              },
              emit: options.emit ?? (() => undefined),
              ...(requests !== undefined && { requests }),
            } satisfies ToolContextShape;
          }),
        ),
        runs,
        Layer.succeed(RunCall)(runCall),
        childDoor,
        // The session's plugin services as a step pins them for the call, every
        // plugin on, built in this layer's scope; a call outside a session has
        // none.
        session === undefined
          ? Layer.empty
          : Layer.effectContext(
              Effect.gen(function* () {
                const pinned = yield* Context.get(session, ProjectTools).pin(
                  Effect.succeed(new Set<string>()),
                  { installed: true },
                );
                return yield* pinned.services(
                  new Set(pinned.plugins.map(({ id }) => id)),
                );
              }),
            ),
      );
    }),
  );
}
