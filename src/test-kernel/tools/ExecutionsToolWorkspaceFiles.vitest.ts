import '@test/support/sessionGraphTestSetup';

// Test composition imports

// Node imports
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { it } from '@effect/vitest';

import { Effect } from 'effect';

import { beforeEach, describe, expect } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { type RunId } from '@shared/schemas';
import { openTestDefaultSession } from '@test/support/sessionEnd';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { seedEditedFiles, seedRunRecord } from '@test/support/runRecordSeeds';
import {
  createTempDirPlatform,
  useTempDirs,
  withTempDirEffect,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { ExecutionsTool } from '@tools/ExecutionsTool';

const tempDirs = useTempDirs();

describe('ExecutionsTool', () => {
  setupPlatform(() => createTempDirPlatform('texra-executions-', tempDirs));

  beforeEach(async () => {
    await Effect.runPromise(
      openTestDefaultSession({
        roots: testWorkspaceRoots(),
        transcriptMode: { kind: 'ephemeral', reason: 'executions tool test' },
      }),
    );
  });

  it.live("rejects '..' path traversal in /executions/{id}/files/{path}", () =>
    Effect.gen(function* () {
      const result = yield* ExecutionsTool.call({
        path: '/executions/abc123def456/files/../../../../../../etc/passwd',
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain("must not contain '..'");
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.live('refuses unrecorded workspace file reads', () =>
    Effect.gen(function* () {
      yield* withTempDirEffect('texra-exec-files-', (workspace) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(path.join(workspace, 'secret.md'), 'secret'),
          );
          // A stored run in this workspace whose settled calls edited
          // only `review.md`.
          const runId = 'abc123' as RunId;
          const session = testDefaultSession();
          publishTestRunStart(session, runId);
          yield* session.log.settled;
          yield* seedRunRecord(session, runId, {
            agent: 'chat',
            model: 'deepseek/deepseek-v4-flash',
            workingDirectory: workspace,
          } as AgentConfig);
          yield* seedEditedFiles(session, runId, ['review.md']);

          const result = yield* ExecutionsTool.call({
            path: '/executions/abc123/workspace-files/secret.md',
          });

          expect(result.status).toBe('error');
          expect(result.error).toContain('Workspace file not found');
        }),
      );
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: testDefaultSession(),
            runId: 'tool-test' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});
