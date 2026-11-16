import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Layer, Schema, Context } from 'effect';
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
        parent: null,
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
            resolveChildRunOutput(parentRunId, absolutePath)
              .pipe(Effect.provide(resolveLayer))
              .pipe(Effect.provide(session)),
          );
          expect(error.message).toContain('is not a direct child');
        }),
      );

      it.effect('rejects paths outside run storage', () =>
        Effect.gen(function* () {
          const session = yield* processSession;
          const host = yield* FakeHost;
          const error = yield* Effect.flip(
            resolveChildRunOutput(parentRunId, host.path('workspace/draft.tex'))
              .pipe(Effect.provide(resolveLayer))
              .pipe(Effect.provide(session)),
          );
          expect(error.message).toContain('not inside run storage');
        }),
      );
    });
  },
);
