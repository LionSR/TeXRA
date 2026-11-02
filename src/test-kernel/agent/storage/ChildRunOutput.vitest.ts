import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Layer, Schema, Context } from 'effect';
import { expect } from 'vitest';

import {
  AgentConfigSchema,
  qualifyAggregateId,
  type RunId,
} from '@texra-ai/harness/schemas';
import { ToolRegistry } from '@texra-ai/harness/plugins';
import { resolveChildRunOutput } from '@agent/storage/childRunOutput';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionRoots } from '@platform/rootedFs';
import { SessionLog } from '@shared/session/runHistory';
import { publishTestRunStart, seedRows } from '@test/support/sessionTestUtils';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import {
  DOCUMENT_TASK_BLOCK,
  documentsOutputFact,
  documentsSummary,
} from '@texra/shared/plugins/documents';
import { DOCUMENT_TASK_RESULT } from '@texra/tools/documents/documentResult';
import {
  RoundOutputSchema,
  type RoundOutput,
} from '@texra/shared/plugins/documentOutputs';
import { toolTable } from '@tools/toolTable';

const parentRunId = 'aaaaaa111111' as RunId;
const childRunId = 'bbbbbb222222' as RunId;
const otherParentRunId = 'cccccc333333' as RunId;
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
      latexdiffs: [],
      reply: null,
    }),
  ];
}

/** The filesystem, and the documents plugin's block, whose result names a
 *  completed task's files. */
const resolveLayer = Layer.merge(
  nodePlatformLayer,
  Layer.succeed(ToolRegistry)(
    toolTable([
      {
        id: 'documents',
        agentBlock: { ...DOCUMENT_TASK_BLOCK, result: DOCUMENT_TASK_RESULT },
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
    publishTestRunStart(session, parentId);
    yield* Context.get(session, SessionLog).settled;
    yield* seedRows(Context.get(session, SessionLog))([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', childRunId),
        identity: { kind: 'agent', agent: 'draft' },
        userFollowUpSupport: 'unsupported',
        parent: { id: parentId, call: null },
        provenance: null,
      },
      {
        type: 'run.config',
        aggregateId: qualifyAggregateId('run', childRunId),
        config: Schema.decodeUnknownSync(AgentConfigSchema)({
          agent: 'draft',
          script: {
            code: 'return 1;',
            title: 'draft',
            tools: [],
            kind: 'recipe',
            block: 'task',
            options: {},
          },
        }),
      },
    ]);
    yield* Context.get(session, SessionLog).transact([
      {
        type: 'run.result',
        aggregateId: qualifyAggregateId('run', childRunId),
        result: { producer: 'subagent', output: { response: '', files: [] } },
      },
    ]);
    // How the child ended, and what it declared, is its `run.end` row's.
    yield* Context.get(session, SessionLog).transact([
      {
        type: 'run.end',
        aggregateId: qualifyAggregateId('run', childRunId),
        outcome: 'completed',
        output: {
          response: '',
          files: [],
          structured: documentsSummary(
            documentsOutputFact(workflowRounds(absolutePath)),
          ),
        },
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

layer(SessionGraph.layer, { excludeTestServices: true })(
  'resolveChildRunOutput',
  (it) => {
    it.layer(
      FakeHost.layer({
        storagePath: fakePath('storage'),
        workspacePath: fakePath('workspace'),
      }),
      { buildPerTest: true },
    )((it) => {
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
          const error = yield* Effect.flip(
            resolveChildRunOutput(parentRunId, fakePath('workspace/draft.tex'))
              .pipe(Effect.provide(resolveLayer))
              .pipe(Effect.provide(session)),
          );
          expect(error.message).toContain('not inside run storage');
        }),
      );
    });
  },
);
