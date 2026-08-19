import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
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

/** Lets microtasks and a macrotask queued via `runAsync` settle. */
function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) =>
    setImmediate(() => setImmediate(() => resolve())),
  );
}

/**
 * Post W4-collapse the desktop file selection module routes only single-slot
 * base/edited dropdowns + the disk-listing refresh; input/context/media are
 * multi-only and travel through the SELECT_MULTIPLE_FILES path which the
 * desktop main delegates to its native picker elsewhere.
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
  ): Promise<{
    files: ReturnType<DesktopFileSelectionModule['createDesktopFileSelection']>;
    messages: unknown[];
  }> {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
      ...overrides,
    });
    return { files, messages };
  }

  it('refreshes the base-file dropdown options on REFRESH_ALL_FILES', async () => {
    const { files, messages } = await createFileSelection();

    expect(
      files.handleMessage({ command: MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
        files: BASE_FILE_OPTIONS,
        preserveBaseFile: true,
      }),
    );
  });

  it('preserves the current base-file selection when requested', async () => {
    const { files, messages } = await createFileSelection();

    expect(
      files.handleMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
        preserveBaseFile: true,
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
        files: BASE_FILE_OPTIONS,
        preserveBaseFile: true,
      }),
    );
  });

  it('lists edited-file options for a given base file', async () => {
    const { files, messages } = await createFileSelection();

    expect(
      files.handleMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE,
        baseFile: 'main.tex',
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.SET_EDITED_FILE,
        files: ['sections/main_edited.tex', 'sections/main_r1.tex'],
      }),
    );
  });

  it('opens the desktop multi-file picker and returns relative input paths', async () => {
    const showOpenFileDialog = vi
      .fn()
      .mockResolvedValue([
        join(workspacePath, 'main.tex'),
        join(workspacePath, 'sections', 'main_r1.tex'),
      ]);
    const { files, messages } = await createFileSelection({
      showOpenFileDialog,
    });

    expect(
      files.handleMessage({
        command: MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES,
        fileType: 'input',
        currentFile: 'main.tex',
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.SET_INPUT_FILES,
        files: ['main.tex', 'sections/main_r1.tex'],
      }),
    );
    expect(showOpenFileDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Select input files',
        allowMultiple: true,
        defaultPath: join(workspacePath, 'main.tex'),
      }),
    );
  });

  it.each([
    {
      name: 'without a workspace',
      overrides: { getWorkspacePath: () => undefined },
      request: { fileType: 'input' },
    },
    {
      // 'output' is a valid MultipleDocumentFileType and the shared webview
      // frontend's "Select output files" button posts it through this same
      // command on every host, but MULTI_SET_COMMAND_BY_FILE_TYPE here only
      // covers input/context/media, so isDesktopMultiFileType rejects it and
      // the picker never opens. Pinned so a future fix to add output support
      // has to update this expectation deliberately.
      name: 'for output files',
      overrides: {},
      request: { fileType: 'output', currentFile: 'main.tex' },
    },
  ])(
    'does not open the multi-file picker $name',
    async ({ overrides, request }) => {
      const showOpenFileDialog = vi.fn();
      const { files } = await createFileSelection({
        showOpenFileDialog,
        ...overrides,
      });

      expect(
        files.handleMessage({
          command: MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES,
          ...request,
        }),
      ).toBe(true);

      // The picker path is async (dispatched via runAsync), so let queued
      // work settle before asserting the picker stayed closed — a negative
      // vi.waitFor would pass on its first poll without observing anything.
      await flushAsyncWork();
      expect(showOpenFileDialog).not.toHaveBeenCalled();
    },
  );

  it('leaves recent-commit requests for the main IPC router', async () => {
    const { files } = await createFileSelection();

    expect(
      files.handleMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      }),
    ).toBe(false);
  });

  it('reports asynchronous file-listing errors without rejecting from handleMessage', async () => {
    const onError = vi.fn();
    const { files } = await createFileSelection({
      getWorkspacePath: () => join(workspacePath, 'missing'),
      onError,
    });

    expect(
      files.handleMessage({ command: MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES }),
    ).toBe(true);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });
});
