import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

import { loadSourceModule } from './loadSourceModule.ts';

type DesktopFileSelectionModule =
  typeof import('@desktop/main/desktopFileSelection');

async function loadDesktopFileSelection(): Promise<DesktopFileSelectionModule> {
  vi.resetModules();
  const [{ installPlatform }, { nodeFilesystem }] = await Promise.all([
    import('@test/support/setupPlatform'),
    import('@platform/defaults/nodeFilesystem'),
  ]);
  await installPlatform({}, { fs: nodeFilesystem });
  return loadSourceModule('@desktop/main/desktopFileSelection');
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
    return createDesktopFileSelection({
      workspacePath,
      showOpenFileDialog: vi.fn(async () => undefined),
      ...overrides,
    });
  }

  it('lists the base and edited candidates of the paper', async () => {
    const files = await createFileSelection();

    const options = await files.fileOptions();

    expect(options.baseFile).toEqual(BASE_FILE_OPTIONS);
    expect(options.editedFile).toEqual(
      expect.arrayContaining([
        'sections/main_edited.tex',
        'sections/main_r1.tex',
      ]),
    );
    expect(options.commit).toEqual(['HEAD']);
    expect(await files.hasInputFiles()).toBe(true);
  });

  it('lists nothing without a workspace', async () => {
    const files = await createFileSelection({ workspacePath: undefined });

    expect(await files.fileOptions()).toEqual({
      baseFile: [],
      editedFile: [],
      commit: ['HEAD'],
    });
    expect(await files.hasInputFiles()).toBe(false);
    expect(await files.pickFiles('input')).toBeNull();
  });

  it('opens the native picker and returns workspace-relative paths', async () => {
    const showOpenFileDialog = vi
      .fn()
      .mockResolvedValue([
        join(workspacePath, 'main.tex'),
        join(workspacePath, 'sections', 'main_r1.tex'),
      ]);
    const files = await createFileSelection({ showOpenFileDialog });

    expect(await files.pickFiles('input', 'main.tex')).toEqual([
      'main.tex',
      'sections/main_r1.tex',
    ]);
    expect(showOpenFileDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Select input files',
        allowMultiple: true,
        defaultPath: join(workspacePath, 'main.tex'),
      }),
    );
  });

  it('reports a cancelled picker as null and attaches only the admitted dropped files', async () => {
    const files = await createFileSelection();

    expect(await files.pickFiles('context')).toBeNull();
    expect(
      await files.attachDroppedFiles(
        [
          join(workspacePath, 'notes.md'),
          join(workspacePath, 'sections'),
          '/elsewhere/x.tex',
        ],
        'context',
      ),
    ).toEqual(['notes.md']);
    await expect(
      files.attachDroppedFiles([join(workspacePath, 'sections')], 'input'),
    ).rejects.toMatchObject({ _tag: 'Rejected' });
  });

  it('rejects a listing of a missing workspace loudly', async () => {
    const files = await createFileSelection({
      workspacePath: join(workspacePath, 'missing'),
    });

    await expect(files.fileOptions()).rejects.toThrow();
  });
});
