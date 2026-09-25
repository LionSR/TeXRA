import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

type DesktopFileSelectionModule =
  typeof import('@desktop/main/desktopFileSelection');

async function loadDesktopFileSelection(): Promise<DesktopFileSelectionModule> {
  vi.resetModules();
  const { installPlatform } = await import('@test/support/setupPlatform');
  await installPlatform({});
  return import('@desktop/main/desktopFileSelection');
}

const BASE_FILE_OPTIONS = [
  'main.tex',
  'notes.md',
  'sections/main_edited.tex',
  'sections/main_r1.tex',
  'templates/main.tex',
];

/**
 * The file lists and pickers of one paper: the `host` snapshot's file
 * catalogs and the `pickFiles` and `attachDroppedFiles` arms (PRD 8.1, 8.3).
 */
describe('desktop file selection', () => {
  const tempDirs = useTempDirs();
  let workspacePath: string;
  /** The runtime the listing and drop programs below settle on; installed by
   *  `createFileSelection`, as the desktop window installs its own. */
  let runtime: ProcessRuntime;

  beforeEach(async () => {
    workspacePath = await makeTempDir('texra-files-', tempDirs);
    const entries = [
      'main.tex',
      'notes.md',
      'command.tex',
      'sections/main_r1.tex',
      'sections/main_edited.tex',
      'build/ignored.tex',
      'figures/plot.png',
      'templates/main.tex',
      'node_modules/pkg/ignored.tex',
    ];
    await Promise.all(
      entries.map(async (entry) => {
        await mkdir(join(workspacePath, dirname(entry)), { recursive: true });
        await writeFile(join(workspacePath, entry), '');
      }),
    );
  });

  async function createFileSelection(
    overrides: Partial<
      Parameters<DesktopFileSelectionModule['createDesktopFileSelection']>[0]
    > = {},
  ) {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    // Read after the load: `loadDesktopFileSelection` resets the module
    // registry and installs a fresh process runtime.
    const { testRuntime } = await import('@test/support/testProcessRuntime');
    runtime = testRuntime();
    return createDesktopFileSelection({
      workspacePath,
      showOpenFileDialog: vi.fn(async () => undefined),
      ...overrides,
    });
  }

  it.effect('lists the base and edited candidates of the paper', () =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(() => createFileSelection());

      const options = yield* withProcessServices(runtime, files.fileOptions());

      expect(options.baseFile).toEqual(BASE_FILE_OPTIONS);
      expect(options.editedFile).toEqual(
        expect.arrayContaining([
          'sections/main_edited.tex',
          'sections/main_r1.tex',
        ]),
      );
      expect(options.commit).toEqual(['HEAD']);
    }),
  );

  it.effect(
    'opens the native picker and returns workspace-relative paths',
    () =>
      Effect.gen(function* () {
        const showOpenFileDialog = vi
          .fn()
          .mockResolvedValue([
            join(workspacePath, 'main.tex'),
            join(workspacePath, 'sections', 'main_r1.tex'),
          ]);
        const files = yield* Effect.promise(() =>
          createFileSelection({ showOpenFileDialog }),
        );

        expect(
          yield* Effect.promise(() => files.pickFiles('input', 'main.tex')),
        ).toEqual(['main.tex', 'sections/main_r1.tex']);
        expect(showOpenFileDialog).toHaveBeenCalledWith(
          expect.objectContaining({
            title: 'Select input files',
            allowMultiple: true,
            defaultPath: join(workspacePath, 'main.tex'),
          }),
        );
      }),
  );

  it.effect(
    'reports a cancelled picker as null and attaches only the admitted dropped files',
    () =>
      Effect.gen(function* () {
        const files = yield* Effect.promise(() => createFileSelection());

        expect(
          yield* Effect.promise(() => files.pickFiles('context')),
        ).toBeNull();
        expect(
          yield* withProcessServices(
            runtime,
            files.attachDroppedFiles(
              [
                join(workspacePath, 'notes.md'),
                join(workspacePath, 'sections'),
                '/elsewhere/x.tex',
              ],
              'context',
            ),
          ),
        ).toEqual(['notes.md']);

        const error = yield* Effect.flip(
          withProcessServices(
            runtime,
            files.attachDroppedFiles(
              [join(workspacePath, 'sections')],
              'input',
            ),
          ),
        );
        expect(error).toMatchObject({ _tag: 'Rejected' });
      }),
  );

  it.effect('skips a circular symlink instead of failing the catalog', () =>
    Effect.gen(function* () {
      const loop = join(workspacePath, 'loop');
      yield* Effect.promise(() => symlink(loop, loop));
      const files = yield* Effect.promise(() => createFileSelection());

      expect(
        (yield* withProcessServices(runtime, files.fileOptions())).baseFile,
      ).toEqual(BASE_FILE_OPTIONS);
    }),
  );

  it.effect('rejects a listing of a missing workspace loudly', () =>
    Effect.gen(function* () {
      const files = yield* Effect.promise(() =>
        createFileSelection({
          workspacePath: join(workspacePath, 'missing'),
        }),
      );

      const error = yield* Effect.flip(
        withProcessServices(runtime, files.fileOptions()),
      );
      expect(error).toBeInstanceOf(Error);
    }),
  );
});
