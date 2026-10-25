import { mkdir, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

import { resolveChildRunOutput } from '@agent/storage/childRunOutput';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  type ResultMeta,
  type RunId,
} from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
  seedRows,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
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
import { ToolRegistry, toolTable } from '@tools/toolTable';

const parentRunId = 'aaaaaa111111' as RunId;
const childRunId = 'bbbbbb222222' as RunId;
const otherParentRunId = 'cccccc333333' as RunId;
const relativePath = 'r1/draft.tex';

setupPlatform({
  storagePath: fakePath('storage'),
  workspacePath: fakePath('workspace'),
});
let session: SessionHandle;
beforeEach(async () => {
  session = await Effect.runPromise(createProcessSession());
});

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

const completedWorkflowResult: ResultMeta = {
  producer: 'subagent',
  output: { response: '', files: [] },
};

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

const persistCompletedChild = (parentId: RunId = parentRunId) =>
  Effect.gen(function* () {
    const storageRoot = session.roots.storage;
    const absolutePath = path.join(
      storageRoot,
      `executions/${childRunId}/${relativePath}`,
    );
    publishTestRunStart(session, parentId);
    yield* session.log.settled;
    yield* seedRows(session.log)([
      {
        type: 'run.start',
        aggregateId: qualifyAggregateId('run', childRunId),
        identity: { kind: 'agent', agent: 'draft' },
        userFollowUpSupport: 'unsupported',
        parent: { id: parentId, callId: null },
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
    yield* session.log.transact([
      {
        type: 'run.result',
        aggregateId: qualifyAggregateId('run', childRunId),
        result: completedWorkflowResult,
      },
    ]);
    // How the child ended, and what it declared, is its `run.end` row's.
    yield* session.log.transact([
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

describe('resolveChildRunOutput', () => {
  it.effect(
    'resolves a declared regular output of a completed direct child',
    () =>
      Effect.gen(function* () {
        const absolutePath = yield* persistCompletedChild();

        expect(
          yield* resolveChildRunOutput(parentRunId, absolutePath, session).pipe(
            Effect.provide(resolveLayer),
          ),
        ).toEqual({
          kind: 'runStorage',
          absolutePath,
          relativePath,
          runId: childRunId,
        });
      }),
  );

  it.effect('rejects output references from an unrelated run tree', () =>
    Effect.gen(function* () {
      const absolutePath = yield* persistCompletedChild(otherParentRunId);

      const error = yield* Effect.flip(
        resolveChildRunOutput(parentRunId, absolutePath, session).pipe(
          Effect.provide(resolveLayer),
        ),
      );
      expect(error.message).toContain('is not a direct child');
    }),
  );

  it.effect(
    'rejects files that are present but absent from the result manifest',
    () =>
      Effect.gen(function* () {
        const absolutePath = yield* persistCompletedChild();
        const undeclaredPath = absolutePath.replace('draft.tex', 'notes.tex');
        yield* Effect.promise(() => writeFile(undeclaredPath, 'notes'));

        const error = yield* Effect.flip(
          resolveChildRunOutput(parentRunId, undeclaredPath, session).pipe(
            Effect.provide(resolveLayer),
          ),
        );
        expect(error.message).toContain('is not a declared output');
      }),
  );

  it.effect('fails loudly when a declared output has disappeared', () =>
    Effect.gen(function* () {
      const absolutePath = yield* persistCompletedChild();
      yield* Effect.promise(() => rm(absolutePath));

      const error = yield* Effect.flip(
        resolveChildRunOutput(parentRunId, absolutePath, session).pipe(
          Effect.provide(resolveLayer),
        ),
      );
      expect(error.message).toContain('is missing');
    }),
  );

  it.effect('rejects paths outside run storage', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        resolveChildRunOutput(
          parentRunId,
          fakePath('workspace/draft.tex'),
          session,
        ).pipe(Effect.provide(resolveLayer)),
      );
      expect(error.message).toContain('not inside run storage');
    }),
  );
});
