import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopPreviewHostModule {
  createDesktopPreviewHost(options: {
    shell: {
      openExternal(url: string): Promise<void>;
      openPath(filePath: string): Promise<string>;
    };
    showErrorMessage?: (message: string) => Promise<void> | void;
  }): {
    openBuildDisplay(location: { absolutePath: string }): Promise<void>;
    openExternal(url: string): Promise<void>;
    openPath(filePath: string): Promise<void>;
  };
}

async function loadDesktopPreviewHost(
  compileLatex2Pdf = vi.fn(async () => true),
): Promise<DesktopPreviewHostModule> {
  vi.resetModules();
  vi.doMock('@latex/texTools', () => ({ compileLatex2Pdf }));
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopPreviewHost.ts'))
  ) as Promise<DesktopPreviewHostModule>;
}

describe('desktop preview host', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.doUnmock('@latex/texTools');
    vi.restoreAllMocks();
    const dirs = tempDirs.splice(0);
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'texra-preview-host-'));
    tempDirs.push(dir);
    return dir;
  }

  it('opens existing files through Electron shell.openPath', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'output.pdf');
    await writeFile(filePath, 'pdf');
    const shell = {
      openExternal: vi.fn(async (_url: string) => {}),
      openPath: vi.fn(async (_path: string) => ''),
    };

    const host = createDesktopPreviewHost({ shell });

    await host.openPath(filePath);
    expect(shell.openPath).toHaveBeenCalledWith(filePath);
  });

  it('reports missing files before calling shell.openPath', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const missingPath = path.join(await makeTempDir(), 'missing.pdf');
    const showErrorMessage = vi.fn();
    const shell = {
      openExternal: vi.fn(async (_url: string) => {}),
      openPath: vi.fn(async (_path: string) => ''),
    };

    const host = createDesktopPreviewHost({ shell, showErrorMessage });

    await expect(host.openPath(missingPath)).rejects.toThrow(
      `File not found: ${missingPath}`,
    );
    expect(showErrorMessage).toHaveBeenCalledWith(
      `File not found: ${missingPath}`,
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('reports Electron shell.openPath errors once', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'blocked.pdf');
    await writeFile(filePath, 'pdf');
    const showErrorMessage = vi.fn();
    const shell = {
      openExternal: vi.fn(async (_url: string) => {}),
      openPath: vi.fn(async (_path: string) => 'No associated application'),
    };

    const host = createDesktopPreviewHost({ shell, showErrorMessage });

    await expect(host.openPath(filePath)).rejects.toThrow(
      `Failed to open file ${filePath}: No associated application`,
    );
    expect(showErrorMessage).toHaveBeenCalledTimes(1);
    expect(showErrorMessage).toHaveBeenCalledWith(
      `Failed to open file ${filePath}: No associated application`,
    );
  });

  it('builds LaTeX previews and opens the generated PDF path', async () => {
    const compileLatex2Pdf = vi.fn(async () => true);
    const { createDesktopPreviewHost } =
      await loadDesktopPreviewHost(compileLatex2Pdf);
    const dir = await makeTempDir();
    const texPath = path.join(dir, 'preview.tex');
    const pdfPath = path.join(dir, 'preview.pdf');
    await writeFile(
      texPath,
      '\\documentclass{article}\\begin{document}x\\end{document}',
    );
    await writeFile(pdfPath, 'pdf');
    const shell = {
      openExternal: vi.fn(async (_url: string) => {}),
      openPath: vi.fn(async (_path: string) => ''),
    };

    const host = createDesktopPreviewHost({ shell });

    await host.openBuildDisplay({ absolutePath: texPath });
    expect(compileLatex2Pdf).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: texPath }),
      { outputDirectory: dir },
    );
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });

  it('opens external URLs through Electron shell.openExternal', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const shell = {
      openExternal: vi.fn(async (_url: string) => {}),
      openPath: vi.fn(async (_path: string) => ''),
    };

    const host = createDesktopPreviewHost({ shell });

    await host.openExternal('https://texra.ai');
    expect(shell.openExternal).toHaveBeenCalledWith('https://texra.ai');
  });
});
