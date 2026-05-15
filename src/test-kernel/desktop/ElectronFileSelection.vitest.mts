import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopFileSelectionModule {
  createDesktopFileSelection(options: {
    postToRenderer(message: unknown): void;
    getWorkspacePath?: () => string | undefined;
    showOpenFileDialog?: (options: {
      title: string;
      defaultPath?: string;
      filters: Array<{ name: string; extensions: string[] }>;
      allowMultiple?: boolean;
    }) => Promise<string[] | undefined>;
    onError?: (error: unknown) => void;
  }): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

async function loadDesktopFileSelection(): Promise<DesktopFileSelectionModule> {
  vi.resetModules();
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopFileSelection.ts'))
  ) as Promise<DesktopFileSelectionModule>;
}

/**
 * Post W4-collapse the desktop file selection module routes only single-slot
 * base/edited dropdowns + the disk-listing refresh; input/context/media are
 * multi-only and travel through the SELECT_MULTIPLE_FILES path which the
 * desktop main delegates to its native picker elsewhere.
 */
describe('desktop file selection', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'texra-files-'));
    await mkdir(join(workspacePath, 'sections'), { recursive: true });
    await mkdir(join(workspacePath, 'build'), { recursive: true });
    await mkdir(join(workspacePath, 'figures'), { recursive: true });
    await mkdir(join(workspacePath, 'templates'), { recursive: true });
    await mkdir(join(workspacePath, 'node_modules', 'pkg'), {
      recursive: true,
    });
    await writeFile(join(workspacePath, 'main.tex'), '');
    await writeFile(join(workspacePath, 'notes.md'), '');
    await writeFile(join(workspacePath, 'command.tex'), '');
    await writeFile(join(workspacePath, 'sections', 'main_r1.tex'), '');
    await writeFile(join(workspacePath, 'sections', 'main_edited.tex'), '');
    await writeFile(join(workspacePath, 'build', 'ignored.tex'), '');
    await writeFile(join(workspacePath, 'figures', 'plot.png'), '');
    await writeFile(join(workspacePath, 'templates', 'main.tex'), '');
    await writeFile(
      join(workspacePath, 'node_modules', 'pkg', 'ignored.tex'),
      '',
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('refreshes the base-file dropdown options on REFRESH_ALL_FILES', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
    });

    expect(
      files.handleMessage({ command: MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
        files: [
          'main.tex',
          'notes.md',
          'sections/main_edited.tex',
          'sections/main_r1.tex',
          'templates/main.tex',
        ],
        preserveBaseFile: true,
      }),
    );
  });

  it('preserves the current base-file selection when requested', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
    });

    expect(
      files.handleMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
        preserveBaseFile: true,
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
        files: [
          'main.tex',
          'notes.md',
          'sections/main_edited.tex',
          'sections/main_r1.tex',
          'templates/main.tex',
        ],
        preserveBaseFile: true,
      }),
    );
  });

  it('lists edited-file options for a given base file', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
    });

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
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const showOpenFileDialog = vi
      .fn()
      .mockResolvedValue([
        join(workspacePath, 'main.tex'),
        join(workspacePath, 'sections', 'main_r1.tex'),
      ]);
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
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

  it('does not open the multi-file picker without a workspace', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const showOpenFileDialog = vi.fn();
    const files = createDesktopFileSelection({
      postToRenderer: vi.fn(),
      getWorkspacePath: () => undefined,
      showOpenFileDialog,
    });

    expect(
      files.handleMessage({
        command: MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES,
        fileType: 'input',
      }),
    ).toBe(true);

    await vi.waitFor(() => expect(showOpenFileDialog).not.toHaveBeenCalled());
  });

  it('leaves recent-commit requests for the main IPC router', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const files = createDesktopFileSelection({
      postToRenderer: vi.fn(),
      getWorkspacePath: () => workspacePath,
    });

    expect(
      files.handleMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      }),
    ).toBe(false);
  });

  it('reports asynchronous file-listing errors without rejecting from handleMessage', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const onError = vi.fn();
    const files = createDesktopFileSelection({
      postToRenderer: vi.fn(),
      getWorkspacePath: () => join(workspacePath, 'missing'),
      onError,
    });

    expect(
      files.handleMessage({ command: MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES }),
    ).toBe(true);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });
});
