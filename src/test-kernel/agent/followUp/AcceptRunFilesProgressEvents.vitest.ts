import '@test/support/sessionGraphTestSetup';

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

// Local imports
import { WorkspaceFs } from '@platform/rootedFs';
import type { RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  closeTestSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import { AcceptRunFilesTool } from '@texra/tools/AcceptRunFilesTool';

// Local file imports
import { autoDecideRequests } from '../progressTestUtils';

const runId = 'abcdef' as RunId;
const storagePath = '/storage';

describe('accept_run_files progress events', () => {
  it.live(
    'refuses symlinked run-storage entries so unemitted files cannot be accepted',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({ workspacePath: '/workspace', storagePath }),
        );
        const session = yield* openTestDefaultSession({
          roots: testWorkspaceRoots(),
          transcriptMode: {
            kind: 'ephemeral',
            reason: 'accept files test session',
          },
        });
        yield* Effect.addFinalizer(() =>
          closeTestSession(session.roots.storage),
        );
        publishTestRunStart(session, runId);
        const requests = autoDecideRequests(session, () => ({
          action: 'approve',
        }));
        yield* Effect.addFinalizer(() => Effect.sync(requests.detach));

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
          path.join(storagePath, `executions/${runId}/r1/Draft/appendices.tex`),
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
  );
});
