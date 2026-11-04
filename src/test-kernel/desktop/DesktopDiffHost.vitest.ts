// Standard library imports
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeAll, expect, vi } from 'vitest';

// Local imports - test support
import { SessionGraph } from '@test/support/testKernel';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

type DesktopDiffHostModule = typeof import('@desktop/main/desktopDiffHost');

// The Review pane a diff lands in is keyed by the project's storage root, which
// the window binds per open project rather than reading off the caller.
const REVIEW_ROOTS = { storage: '/projects/paper/.texra' };

let createDesktopDiffHost: DesktopDiffHostModule['createDesktopDiffHost'];
let removeExternalDiffPatchDirs: DesktopDiffHostModule['removeExternalDiffPatchDirs'];

const tempDirs = useTempDirs();

// Live clock: the window's open and the patch directory's removal are real
// filesystem work.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'createDesktopDiffHost',
  (it) => {
    // The dynamic import pulls the full desktop main graph through the module
    // runner; keep the hook timeout generous for cold combined test runs.
    beforeAll(async () => {
      ({ createDesktopDiffHost, removeExternalDiffPatchDirs } =
        await import('@desktop/main/desktopDiffHost'));
    }, 60_000);

    it.effect(
      'removes the patch directory immediately when the editor fails to open',
      () =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => removeExternalDiffPatchDirs);
          const failure = new Error('editor unavailable');
          // The member is a program, so the refusal is its failure, not a
          // rejection.
          const openPath = vi.fn(
            (_filePath: string): Effect.Effect<void, Error> =>
              Effect.fail(failure),
          );
          const host = createDesktopDiffHost({
            runtime: yield* SessionGraph.runtime,
            openPath,
          }).inProject(REVIEW_ROOTS);
          const tempDir = yield* Effect.promise(() =>
            makeTempDir('texra-diff-host-test-', tempDirs),
          );
          const [original, proposed] = ['a.tex', 'b.tex'].map((name) => ({
            filePath: path.join(tempDir, name),
          }));
          yield* Effect.promise(() =>
            writeFile(original!.filePath, 'a\n', 'utf8'),
          );
          yield* Effect.promise(() =>
            writeFile(proposed!.filePath, 'b\n', 'utf8'),
          );

          // The open failure reaches the caller, carrying the host's own
          // rejection, and not a cleanup artifact.
          const error = yield* Effect.flip(
            host.openDiff(original!, proposed!, 'Compare'),
          );
          expect(error).toMatchObject({
            _tag: 'ExternalOpenFailed',
            kind: 'path',
            cause: failure,
          });

          const diffDir = path.dirname(openPath.mock.calls[0][0]);
          expect(path.basename(diffDir)).toMatch(/^texra-desktop-diff-/);
          expect(existsSync(diffDir)).toBe(false);
        }),
    );
  },
);
