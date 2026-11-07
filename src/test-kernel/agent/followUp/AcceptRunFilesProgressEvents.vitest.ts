// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Layer, Schema } from 'effect';
import { layer } from '@effect/vitest';
import { expect } from 'vitest';

// Local imports
import { WorkspaceFs } from '@texra-ai/harness/host';
import { RunIdSchema } from '@texra-ai/harness/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { AcceptRunFilesTool } from '@texra/tools/AcceptRunFilesTool';

// Local file imports
import { autoDecideRequests } from '../progressTestUtils';

const runId = Schema.decodeUnknownSync(RunIdSchema)('abcdef');
const storagePath = '/storage';

// The process session over the host's roots, opened as a host whose
// person answers from the view: its runs' requests wait for a decision.
layer(
  TestSession.layer(undefined, { host: {} }).pipe(
    Layer.provideMerge(SessionGraph.layer),
    Layer.provideMerge(
      FakeHost.layer({ workspaceRoot: '/workspace', storagePath }),
    ),
  ),
  { excludeTestServices: true },
)('accept_run_files progress events', (it) => {
  it.effect(
    'refuses symlinked run-storage entries so unemitted files cannot be accepted',
    () =>
      Effect.flatMap(Effect.flatMap(TestSession, sessionHandleOf), (session) =>
        Effect.gen(function* () {
          yield* publishTestRunStart(session, runId);
          const requests = yield* autoDecideRequests(session, () => ({
            action: 'approve',
          }));

          // Each run-storage entry the walk probes, with the type `lstat`
          // reports for it, keyed by the absolute path the code joins (an
          // interpolated `/` names a different file where the separator is
          // not `/`).
          const entries = new Map<string, FileSystem.File.Type>(
            [
              `executions/${runId}`,
              `executions/${runId}/r1`,
              `executions/${runId}/r1/Draft`,
            ].map((entry) => [path.join(storagePath, entry), 'Directory']),
          );
          entries.set(
            path.join(
              storagePath,
              `executions/${runId}/r1/Draft/appendices.tex`,
            ),
            'SymbolicLink',
          );
          const written: string[] = [];
          const workspaceFs = yield* WorkspaceFs;
          const processFs = yield* FileSystem.FileSystem;
          const rootInfo = yield* processFs.stat('/');
          const probe = (target: string, real: typeof processFs.stat) => {
            const type = entries.get(target);
            return type === undefined
              ? real(target)
              : Effect.succeed({ ...rootInfo, type });
          };

          const result = yield* AcceptRunFilesTool.call({
            execution_id: runId,
            files: [
              {
                path: 'r1/Draft/appendices.tex',
                original: 'Draft/appendices.tex',
              },
            ],
          }).pipe(
            Effect.provideService(WorkspaceFs, {
              ...workspaceFs,
              writeFile: (target: string) =>
                Effect.sync(() => void written.push(target)),
            }),
            Effect.provideService(FileSystem.FileSystem, {
              ...processFs,
              lstat: (target: string) => probe(target, processFs.lstat),
              stat: (target: string) => probe(target, processFs.stat),
            }),
            Effect.provide(
              nativeToolTestLayer({
                run: { runId, session, toolPolicy: {} },
              }),
            ),
          );

          expect(result.status).toBe('error');
          expect(result.error).toContain('symlink');
          expect(requests.opened).toEqual([]);
          expect(written).toEqual([]);
        }).pipe(Effect.provide(nativeToolTestLayer())),
      ),
  );
});
