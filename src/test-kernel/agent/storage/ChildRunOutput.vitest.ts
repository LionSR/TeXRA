import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Deferred, Effect, Layer, Schema, Context } from 'effect';
import { expect } from 'vitest';

import {
  RunIdSchema,
  AgentConfigSchema,
  type RunId,
} from '@texra-ai/harness/schemas';
import { ToolRegistry } from '@texra-ai/harness/plugins';
import { resolveChildRunOutput } from '@agent/storage/childRunOutput';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionRoots } from '@platform/rootedFs';
import { SessionLog } from '@shared/session/runHistory';
import { publishTestRunStart, seedRows } from '@test/support/sessionTestUtils';
import { runStart } from '@test/support/sessionRows';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { documentsOutputFact } from '@texra/shared/plugins/documents';
import { THEORY_MODULES, THEORY_PROGRAMS } from '@texra/tools/theory/programs';
import {
  RoundOutputSchema,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import { toolTable } from '@tools/toolTable';
import { programTool } from '@agent/runtime/delegation/ProgramTool';
import type { ScriptScope } from '@agent/runtime/RunCall';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { errorOf } from '@test/support/toolResultFields';
import { autoDecideRequests } from '../progressTestUtils';

const parentRunId = Schema.decodeUnknownSync(RunIdSchema)('aaaaaa111111');
const childRunId = Schema.decodeUnknownSync(RunIdSchema)('bbbbbb222222');
const otherParentRunId = Schema.decodeUnknownSync(RunIdSchema)('cccccc333333');
const relativePath = 'r1/draft.tex';

/** The test's session over the process roots, whose storage the child's
 *  output is resolved against. */
const processSession = Effect.flatMap(TestSession.open(), sessionHandleOf);

/** The child's declared files, as its documents report them. */
function workflowRounds(absolutePath: string): RoundOutput[] {
  return [
    Schema.decodeUnknownSync(RoundOutputSchema)({
      round: 1,
      outputs: [
        {
          source: 'draft',
          round: 1,
          location: {
            kind: 'runStorage',
            absolutePath,
            relativePath,
            runId: childRunId,
          },
          lineage: null,
          diff: null,
        },
      ],
      compile: null,
      missingOutputs: [],
      latexdiffs: [],
      reply: null,
    }),
  ];
}

/** The filesystem, and the theory plugin's program, whose result names a
 *  completed task's files. */
const resolveLayer = Layer.merge(
  nodePlatformLayer,
  Layer.succeed(ToolRegistry)(
    toolTable([
      {
        id: 'theory',
        scriptModules: THEORY_MODULES,
        programs: THEORY_PROGRAMS,
      },
    ]),
  ),
);

const persistCompletedChild = (
  session: Context.Context<SessionServices>,
  parentId: RunId = parentRunId,
) =>
  Effect.gen(function* () {
    const storageRoot = Context.get(session, SessionRoots).storage;
    const absolutePath = path.join(
      storageRoot,
      `executions/${childRunId}/${relativePath}`,
    );
    yield* publishTestRunStart(session, parentId);
    yield* Context.get(session, SessionLog).drained;
    yield* seedRows(Context.get(session, SessionLog))([
      runStart(childRunId, {
        identity: { kind: 'agent', agent: 'draft' },
        parent: { id: parentId, call: null },
      }),
      {
        type: 'run.config',
        aggregateId: childRunId,
        config: Schema.decodeUnknownSync(AgentConfigSchema)({
          agent: 'draft',
          model: 'openai/gpt-6.1-sol',
          script: { kind: 'program', name: 'edit', args: {} },
        }),
      },
    ]);
    // What the child declared is its documents row; how it ended, its
    // `run.end` row.
    yield* Context.get(session, SessionLog).transact([
      {
        type: 'plugin.fact',
        aggregateId: childRunId,
        ...documentsOutputFact(
          { intro: '', requests: ['Revise.'], templates: [], creates: false },
          workflowRounds(absolutePath),
        ),
      },
      {
        type: 'run.end',
        aggregateId: childRunId,
        outcome: 'completed',
        output: { response: '', files: [] },
      },
    ]);
    yield* Effect.promise(() =>
      mkdir(path.join(storageRoot, `executions/${childRunId}/r1`), {
        recursive: true,
      }),
    );
    yield* Effect.promise(() => writeFile(absolutePath, 'draft'));
    return absolutePath;
  });

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'resolveChildRunOutput',
  (it) => {
    it.layer(FakeHost.layer(), { buildPerTest: true })((it) => {
      it.effect('rejects output references from an unrelated run tree', () =>
        Effect.gen(function* () {
          const session = yield* processSession;
          const absolutePath = yield* persistCompletedChild(
            session,
            otherParentRunId,
          );

          const error = yield* Effect.flip(
            resolveChildRunOutput(parentRunId, absolutePath).pipe(
              Effect.provide(resolveLayer),
              Effect.provide(session),
            ),
          );
          expect(error.message).toContain('is not a direct child');
        }),
      );

      // A model names the merge program's edited file in its `args`; that
      // file is read into the revision prompt, so it takes the rule the
      // launch's file lists take.
      it.effect(
        "rejects a model's merge launch whose edited file is another run tree's output",
        () =>
          Effect.gen(function* () {
            const session = yield* processSession;
            const forbidden = yield* persistCompletedChild(
              session,
              otherParentRunId,
            );
            yield* publishTestRunStart(session, parentRunId);
            // A launch past the check is refused, so the case ends either way.
            yield* autoDecideRequests(session, () => ({ action: 'reject' }));

            const result = yield* programTool()
              .call({ name: 'merge', args: { editedFile: forbidden } })
              .pipe(
                // The table the call reads is its step's; this step's holds
                // the theory plugin, so `resolveLayer`'s table is merged last.
                Effect.provide(
                  Layer.merge(
                    nativeToolTestLayer({
                      run: { runId: parentRunId, toolPolicy: {}, session },
                    }).pipe(Layer.provideMerge(resolveLayer)),
                    resolveLayer,
                  ),
                ),
                Effect.provide(session),
              );
            expect(errorOf(result)).toContain('is not a direct child');
          }),
      );

      // A script's merge launch is reused only for the same file bytes: an
      // edited file changed in place between two launches is a new launch.
      it.effect(
        "does not reuse a script's merge launch whose edited file changed",
        () =>
          Effect.gen(function* () {
            const session = yield* processSession;
            const host = yield* FakeHost;
            const base = host.path('workspace/base.tex');
            const edited = host.path('workspace/edited.tex');
            yield* Effect.promise(() =>
              mkdir(path.dirname(base), { recursive: true }),
            );
            yield* Effect.promise(() => writeFile(base, 'base'));
            yield* Effect.promise(() => writeFile(edited, 'first edit'));
            yield* publishTestRunStart(session, parentRunId);
            yield* autoDecideRequests(session, () => ({ action: 'reject' }));
            // The script both launches belong to: what its calls share.
            let sharedValues = Context.empty();
            const script: ScriptScope = {
              source: '',
              title: null,
              callId: 'script-call',
              calls: Effect.succeed([]),
              shared: <A, E, R>(
                key: Context.Key<unknown, Deferred.Deferred<A, E>>,
                make: Effect.Effect<A, E, R>,
              ): Effect.Effect<A, E, R> =>
                Effect.suspend(() => {
                  const existing = Context.getOrUndefined(sharedValues, key);
                  if (existing !== undefined) return Deferred.await(existing);
                  const made = Deferred.makeUnsafe<A, E>();
                  sharedValues = Context.add(sharedValues, key, made);
                  return make.pipe(
                    Effect.onExit((exit) => Deferred.done(made, exit)),
                  );
                }),
            };
            const launch = (callId: string) =>
              programTool()
                .call({
                  name: 'merge',
                  inputFiles: [base],
                  args: { editedFile: edited },
                })
                .pipe(
                  Effect.provide(
                    nativeToolTestLayer({
                      callId,
                      run: { runId: parentRunId, toolPolicy: {}, session },
                      origin: { script },
                    }).pipe(Layer.provideMerge(resolveLayer)),
                  ),
                  Effect.provide(session),
                );

            yield* launch('script-call/1');
            yield* Effect.promise(() => writeFile(edited, 'second edit'));
            const second = yield* launch('script-call/2');
            expect(errorOf(second)).not.toContain(
              'same prompt, options and files',
            );
          }),
      );

      it.effect('rejects paths outside run storage', () =>
        Effect.gen(function* () {
          const session = yield* processSession;
          const host = yield* FakeHost;
          const error = yield* Effect.flip(
            resolveChildRunOutput(
              parentRunId,
              host.path('workspace/draft.tex'),
            ).pipe(Effect.provide(resolveLayer), Effect.provide(session)),
          );
          expect(error.message).toContain('not inside run storage');
        }),
      );
    });
  },
);
