// Standard library imports
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeAll, describe, expect, vi } from 'vitest';

// Local imports - test support
import { testRuntime } from '@test/support/testProcessRuntime';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

type DesktopDiffHostModule = typeof import('@desktop/main/desktopDiffHost');

// The Review pane a diff lands in is keyed by the project's storage root, which
// the window binds per open project rather than reading off the caller.
const REVIEW_ROOTS = { storage: '/projects/paper/.texra' };

let createDesktopDiffHost: DesktopDiffHostModule['createDesktopDiffHost'];
let removeExternalDiffPatchDirs: DesktopDiffHostModule['removeExternalDiffPatchDirs'];

const tempDirs = useTempDirs();

/** The window's run: `openDiff` is the program the caller settles. */
const onWindow = (
  program: Parameters<ReturnType<typeof testRuntime>['runPromise']>[0],
) => testRuntime().runPromise(program);

afterEach(async () => {
  await testRuntime().runPromise(removeExternalDiffPatchDirs);
});

describe('createDesktopDiffHost', () => {
  // The dynamic import pulls the full desktop main graph through the module
  // runner; keep the hook timeout generous for cold combined test runs.
  beforeAll(async () => {
    ({ createDesktopDiffHost, removeExternalDiffPatchDirs } =
      await import('@desktop/main/desktopDiffHost'));
  }, 60_000);

  it('removes the patch directory immediately when the editor fails to open', async () => {
    const failure = new Error('editor unavailable');
    // The member is a program, so the refusal is its failure, not a rejection.
    const openPath = vi.fn((_filePath: string): Effect.Effect<void, Error> =>
      Effect.fail(failure),
    );
    const host = createDesktopDiffHost({
      runtime: testRuntime(),
      openPath,
    }).inProject(REVIEW_ROOTS);
    const tempDir = await makeTempDir('texra-diff-host-test-', tempDirs);
    const [original, proposed] = ['a.tex', 'b.tex'].map((name) => ({
      filePath: path.join(tempDir, name),
    }));
    await writeFile(original!.filePath, 'a\n', 'utf8');
    await writeFile(proposed!.filePath, 'b\n', 'utf8');

    // The open failure reaches the caller, carrying the host's own rejection,
    // and not a cleanup artifact.
    await expect(
      onWindow(host.openDiff(original!, proposed!, 'Compare')),
    ).rejects.toMatchObject({
      _tag: 'ExternalOpenFailed',
      kind: 'path',
      cause: failure,
    });

    const diffDir = path.dirname(openPath.mock.calls[0][0]);
    expect(path.basename(diffDir)).toMatch(/^texra-desktop-diff-/);
    expect(existsSync(diffDir)).toBe(false);
  });
});
