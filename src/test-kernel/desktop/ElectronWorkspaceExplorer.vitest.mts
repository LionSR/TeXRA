import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';

import { moduleFileUrl, desktopSourcePath } from './desktopTestPaths.mjs';

interface DesktopWorkspaceExplorerModule {
  createDesktopWorkspaceExplorer(options: {
    postToRenderer(message: unknown): void;
    getWorkspacePath?: () => string | undefined;
    openPath?: (filePath: string) => Promise<void>;
    onError?: (error: unknown) => void;
  }): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

const COMMANDS = {
  REQUEST_TREE: 'desktop:requestWorkspaceTree',
  SET_TREE: 'desktop:setWorkspaceTree',
  OPEN_FILE: 'desktop:openWorkspaceFile',
  SELECT_FILE: 'desktop:selectWorkspaceFile',
} as const;

async function loadDesktopWorkspaceExplorer(): Promise<DesktopWorkspaceExplorerModule> {
  vi.resetModules();
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopWorkspaceExplorer.ts'))
  ) as Promise<DesktopWorkspaceExplorerModule>;
}

describe('desktop workspace explorer', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'texra-explorer-'));
    await mkdir(join(workspacePath, 'sections'), { recursive: true });
    await mkdir(join(workspacePath, 'figures'), { recursive: true });
    await mkdir(join(workspacePath, 'build'), { recursive: true });
    await writeFile(join(workspacePath, 'main.tex'), '');
    await writeFile(join(workspacePath, 'refs.bib'), '');
    await writeFile(join(workspacePath, 'sections', 'intro.tex'), '');
    await writeFile(join(workspacePath, 'figures', 'plot.png'), '');
    await writeFile(join(workspacePath, 'build', 'ignored.tex'), '');
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('loads a filtered workspace tree with file-selection categories', async () => {
    const { createDesktopWorkspaceExplorer } =
      await loadDesktopWorkspaceExplorer();
    const messages: unknown[] = [];
    const explorer = createDesktopWorkspaceExplorer({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
    });

    expect(explorer.handleMessage({ command: COMMANDS.REQUEST_TREE })).toBe(
      true,
    );

    await vi.waitFor(() =>
      expect(messages).toContainEqual(
        expect.objectContaining({
          command: COMMANDS.SET_TREE,
          files: [
            'figures/plot.png',
            'main.tex',
            'refs.bib',
            'sections/intro.tex',
          ],
        }),
      ),
    );

    const treeMessage = messages[0] as {
      tree: Array<{
        name: string;
        type: string;
        children?: Array<{ path: string; categories?: string[] }>;
      }>;
    };
    const figureDir = treeMessage.tree.find((node) => node.name === 'figures');
    expect(figureDir?.children?.[0]).toMatchObject({
      path: 'figures/plot.png',
      categories: ['media'],
    });
  });

  it('hands an explorer selection to the existing main-view file selection flow', async () => {
    const { createDesktopWorkspaceExplorer } =
      await loadDesktopWorkspaceExplorer();
    const messages: unknown[] = [];
    const explorer = createDesktopWorkspaceExplorer({
      postToRenderer: (message) => messages.push(message),
      getWorkspacePath: () => workspacePath,
    });

    expect(
      explorer.handleMessage({
        command: COMMANDS.SELECT_FILE,
        fileType: 'input',
        filePath: 'sections/intro.tex',
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        command: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
        filePath: 'sections/intro.tex',
      }),
    );
  });

  it('opens selected files through the desktop host path bridge', async () => {
    const { createDesktopWorkspaceExplorer } =
      await loadDesktopWorkspaceExplorer();
    const openPath = vi.fn(async () => undefined);
    const explorer = createDesktopWorkspaceExplorer({
      postToRenderer: vi.fn(),
      getWorkspacePath: () => workspacePath,
      openPath,
    });

    expect(
      explorer.handleMessage({
        command: COMMANDS.OPEN_FILE,
        filePath: 'main.tex',
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(openPath).toHaveBeenCalledWith(join(workspacePath, 'main.tex')),
    );
  });
});
