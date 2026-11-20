import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect, FileSystem, Schema } from 'effect';
import { describe, expect, it } from 'vitest';

import { RunIdSchema } from '@texra-ai/harness/schemas';
import { runDirUnder } from '@texra-ai/harness/plugins';
import { RunWorkspace } from '@texra/tools/documents/runWorkspace';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { createFakeHost } from '@test/support/fakeHost';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

/** One of the run workspace's programs on the node `FileSystem` the process
 *  runtime serves it with in production. */
const onNodeFs = <A, E>(
  program: Effect.Effect<A, E, FileSystem.FileSystem>,
): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(nodePlatformLayer)));

describe('round-dir ownership', () => {
  // Failure mode: a mirror created over an entry already at its path
  // removed whatever stood there, the run's own file included.
  it('never replaces a real file at the mirror path with a link', async () => {
    const tempDir = await makeTempDir('texra-mirror-own-file-', tempDirs);
    const workspaceDir = path.join(tempDir, 'workspace');
    const storageRoot = path.join(tempDir, 'storage');
    await mkdir(workspaceDir, { recursive: true });
    // The run workspace takes the roots it works under as a value.
    const { roots } = createFakeHost({
      workspaceRoot: workspaceDir,
      storageRoot,
    });
    const stylePath = path.join(workspaceDir, 'macros.sty');
    await writeFile(stylePath, 'workspace\n');

    const runId = Schema.decodeUnknownSync(RunIdSchema)('c3c3c3c3c3c3');
    const runFile = path.join(runDirUnder(roots.storage, runId), 'macros.sty');
    await mkdir(path.dirname(runFile), { recursive: true });
    await writeFile(runFile, 'the run wrote this\n');

    const fileService = new RunWorkspace(runId, roots);
    await onNodeFs(
      fileService.mirrorWorkspaceFile({
        kind: 'workspace',
        absolutePath: stylePath,
        relativePath: 'macros.sty',
      }),
    );

    expect((await lstat(runFile)).isSymbolicLink()).toBe(false);
    await expect(readFile(runFile, 'utf8')).resolves.toBe(
      'the run wrote this\n',
    );
  });
});
