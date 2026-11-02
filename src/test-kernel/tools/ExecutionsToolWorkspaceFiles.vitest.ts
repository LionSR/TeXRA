// Node imports
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { layer } from '@effect/vitest';

import { Effect, Layer, Context } from 'effect';

import { expect } from 'vitest';

import { SessionLog } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { seedEditedFiles, seedRunRecord } from '@test/support/runRecordSeeds';
import {
  createTempDirPlatform,
  useTempDirs,
  withTempDirEffect,
} from '@test/support/tempDirPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import type { AgentConfig, RunId } from '@texra-ai/harness/schemas';

const tempDirs = useTempDirs();

/** The test's session over the host's roots, as the harness holds it. */
const sessionHandle = Effect.flatMap(TestSession, sessionHandleOf);

/** A tool call under the test session's `tool-test` run. */
const toolTestCall = Layer.unwrap(
  Effect.map(sessionHandle, (session) =>
    nativeToolTestLayer({
      run: { session, runId: 'tool-test' as RunId, toolPolicy: {} },
    }),
  ),
);

/** A host in a temp directory of its own per test, and a session over its
 *  roots whose requests a person answers from the view. */
const perTest = Layer.provideMerge(
  TestSession.layer(undefined, { host: {} }),
  FakeHost.layer(() => createTempDirPlatform('texra-executions-', tempDirs)),
);

// Live clock: the session's publisher and readers run on real turns.
layer(SessionGraph.layer, { excludeTestServices: true })(
  'ExecutionsTool',
  (it) => {
    it.layer(perTest, { buildPerTest: true })((it) => {
      it.effect(
        "rejects '..' path traversal in /executions/{id}/files/{path}",
        () =>
          Effect.gen(function* () {
            const result = yield* ExecutionsTool.call({
              path: '/executions/abc123def456/files/../../../../../../etc/passwd',
            });

            expect(result.status).toBe('error');
            expect(result.error).toContain("must not contain '..'");
          }).pipe(Effect.provide(toolTestCall)),
      );

      it.effect('refuses unrecorded workspace file reads', () =>
        Effect.gen(function* () {
          const session = yield* sessionHandle;
          yield* withTempDirEffect('texra-exec-files-', (workspace) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                writeFile(path.join(workspace, 'secret.md'), 'secret'),
              );
              // A stored run in this workspace whose settled calls edited
              // only `review.md`.
              const runId = 'abc123' as RunId;
              publishTestRunStart(session, runId);
              yield* Context.get(session, SessionLog).settled;
              yield* seedRunRecord(session, runId, {
                agent: 'chat',
                model: 'deepseek/deepseek-v4-flash',
                workingDirectory: workspace,
              } as AgentConfig);
              yield* seedEditedFiles(session, runId, ['review.md']);

              const result = yield* ExecutionsTool.call({
                path: '/executions/abc123/workspace-files/secret.md',
              }).pipe(Effect.provide(toolTestCall));

              expect(result.status).toBe('error');
              expect(result.error).toContain('Workspace file not found');
            }),
          );
        }),
      );
    });
  },
);
