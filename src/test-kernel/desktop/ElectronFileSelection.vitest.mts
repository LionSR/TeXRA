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
    }) => Promise<string | undefined>;
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

describe('desktop file selection', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'texra-files-'));
    await mkdir(join(workspacePath, 'sections'), { recursive: true });
    await mkdir(join(workspacePath, 'build'), { recursive: true });
    await mkdir(join(workspacePath, 'figures'), { recursive: true });
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
    await writeFile(
      join(workspacePath, 'node_modules', 'pkg', 'ignored.tex'),
      '',
    );
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('responds to launcher file-list requests with filtered workspace-relative files', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
    });

    expect(
      files.handleMessage({ command: MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.SET_INPUT_FILE,
        files: [
          'main.tex',
          'notes.md',
          'sections/main_edited.tex',
          'sections/main_r1.tex',
        ],
      }),
    );

    messages.length = 0;
    files.handleMessage({ command: MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES });
    await vi.waitFor(() =>
      expect(messages[0]).toMatchObject({
        command: MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES,
        inputFiles: [
          'main.tex',
          'notes.md',
          'sections/main_edited.tex',
          'sections/main_r1.tex',
        ],
      }),
    );
  });

  it('opens the host picker and returns workspace-relative selections', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const showOpenFileDialog = vi.fn(async () =>
      join(workspacePath, 'main.tex'),
    );
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
      showOpenFileDialog,
    });

    expect(
      files.handleMessage({ command: MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
        filePath: 'main.tex',
      }),
    );
    expect(showOpenFileDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: workspacePath,
        filters: [{ name: 'input files', extensions: ['txt', 'tex', 'md'] }],
      }),
    );
  });

  it('updates edited-file options when an input file is selected', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
    });

    expect(
      files.handleMessage({
        command: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
        filePath: 'main.tex',
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.SET_EDITED_FILE,
        files: ['sections/main_edited.tex', 'sections/main_r1.tex'],
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
        ],
        preserveBaseFile: true,
      }),
    );
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
      files.handleMessage({ command: MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE }),
    ).toBe(true);

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  });

  it('normalizes selected external paths before sending them to the renderer', async () => {
    const { createDesktopFileSelection } = await loadDesktopFileSelection();
    const messages: unknown[] = [];
    const externalFile = `${join(workspacePath, '..', 'external')}\\paper.tex`;
    const files = createDesktopFileSelection({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
      showOpenFileDialog: async () => externalFile,
    });

    files.handleMessage({ command: MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE });

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
        filePath: externalFile.replaceAll('\\', '/'),
      }),
    );
  });
});
