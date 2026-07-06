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
    postToRenderer?: (message: unknown) => boolean | void;
    forceExternal?: boolean;
  }): {
    openBuildDisplay(location: { absolutePath: string }): Promise<void>;
    openExternal(url: string): Promise<void>;
    openPath(filePath: string): Promise<void>;
  };
}

async function loadDesktopPreviewHost(
  compileLatex2Pdf = vi.fn(async () => ({ ok: true })),
  access?: (filePath: string) => Promise<void>,
  checkToolInstalled = vi.fn(async () => true),
): Promise<DesktopPreviewHostModule> {
  vi.resetModules();
  vi.doMock('@latex/texTools', () => ({ compileLatex2Pdf }));
  vi.doMock('@latex/latexToolchain', () => ({
    hasLatexCompiler: checkToolInstalled,
  }));
  if (access != null) {
    vi.doMock('node:fs/promises', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs/promises')>()),
      access,
    }));
  }
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopPreviewHost.ts'))
  ) as Promise<DesktopPreviewHostModule>;
}

function makeShell(openPathResult = '') {
  return {
    openExternal: vi.fn(async (_url: string) => {}),
    openPath: vi.fn(async (_path: string) => openPathResult),
  };
}

describe('desktop preview host', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.doUnmock('@latex/texTools');
    vi.doUnmock('@latex/latexToolchain');
    vi.doUnmock('node:fs/promises');
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

  async function makeOverlayFixture(): Promise<{
    texPath: string;
    pdfPath: string;
  }> {
    const dir = await makeTempDir();
    const texPath = path.join(dir, 'paper.tex');
    const pdfPath = path.join(dir, 'paper.pdf');
    await writeFile(texPath, '\\documentclass{article}');
    await writeFile(pdfPath, 'pdf');
    return { texPath, pdfPath };
  }

  it('opens existing files through Electron shell.openPath', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'output.pdf');
    await writeFile(filePath, 'pdf');
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell });

    await host.openPath(filePath);
    expect(shell.openPath).toHaveBeenCalledWith(filePath);
  });

  it('reports missing files before calling shell.openPath', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const missingPath = path.join(await makeTempDir(), 'missing.pdf');
    const showErrorMessage = vi.fn();
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell, showErrorMessage });

    await expect(host.openPath(missingPath)).rejects.toThrow(
      `File not found: ${missingPath}`,
    );
    expect(showErrorMessage).toHaveBeenCalledWith(
      `File not found: ${missingPath}`,
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('preserves access failure details before calling shell.openPath', async () => {
    const accessError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const access = vi.fn(async (_filePath: string) => {
      throw accessError;
    });
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost(
      undefined,
      access,
    );
    const filePath = path.join(await makeTempDir(), 'blocked.pdf');
    const showErrorMessage = vi.fn();
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell, showErrorMessage });

    await expect(host.openPath(filePath)).rejects.toThrow(
      `Cannot access file ${filePath}: permission denied`,
    );
    expect(showErrorMessage).toHaveBeenCalledWith(
      `Cannot access file ${filePath}: permission denied`,
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('reports Electron shell.openPath errors once', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const dir = await makeTempDir();
    const filePath = path.join(dir, 'blocked.pdf');
    await writeFile(filePath, 'pdf');
    const showErrorMessage = vi.fn();
    const shell = makeShell('No associated application');

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
    const compileLatex2Pdf = vi.fn(async () => ({ ok: true }));
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
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell });

    await host.openBuildDisplay({ absolutePath: texPath });
    expect(compileLatex2Pdf).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: texPath }),
      { outputDirectory: dir },
    );
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });

  it('opens compile-preview PDF targets without running LaTeX', async () => {
    const compileLatex2Pdf = vi.fn(async () => ({ ok: true }));
    const checkToolInstalled = vi.fn(async () => true);
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost(
      compileLatex2Pdf,
      undefined,
      checkToolInstalled,
    );
    const dir = await makeTempDir();
    const pdfPath = path.join(dir, 'preview.pdf');
    await writeFile(pdfPath, 'pdf');
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell });

    await host.openBuildDisplay({ absolutePath: pdfPath });
    expect(compileLatex2Pdf).not.toHaveBeenCalled();
    expect(checkToolInstalled).not.toHaveBeenCalled();
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });

  it('reports missing LaTeX toolchains before compiling preview sources', async () => {
    const compileLatex2Pdf = vi.fn(async () => ({ ok: true }));
    const checkToolInstalled = vi.fn(async () => false);
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost(
      compileLatex2Pdf,
      undefined,
      checkToolInstalled,
    );
    const dir = await makeTempDir();
    const texPath = path.join(dir, 'preview.tex');
    await writeFile(
      texPath,
      '\\documentclass{article}\\begin{document}x\\end{document}',
    );
    const showErrorMessage = vi.fn();
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell, showErrorMessage });

    const message = `No LaTeX compiler found for ${texPath}. Install latexmk or pdflatex to compile and preview this file.`;
    await expect(
      host.openBuildDisplay({ absolutePath: texPath }),
    ).rejects.toThrow(message);
    expect(showErrorMessage).toHaveBeenCalledWith(message);
    expect(compileLatex2Pdf).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('reports LaTeX build failures without opening stale PDFs', async () => {
    const logTail = 'simulated compile log tail';
    const compileLatex2Pdf = vi.fn(async () => ({ ok: false, logTail }));
    const { createDesktopPreviewHost } =
      await loadDesktopPreviewHost(compileLatex2Pdf);
    const dir = await makeTempDir();
    const texPath = path.join(dir, 'preview.tex');
    await writeFile(
      texPath,
      '\\documentclass{article}\\begin{document}x\\end{document}',
    );
    const showErrorMessage = vi.fn();
    const shell = makeShell();
    // Silence and inspect the console.error the full log tail is routed to
    // instead of the (short) dialog message -- see the desktop preview host's
    // fail() call, which must not stuff the full engine log into a native
    // dialog.showMessageBox modal.
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const host = createDesktopPreviewHost({ shell, showErrorMessage });

    const message = `LaTeX build failed for ${texPath}. See the LaTeX log next to the source for details.`;
    await expect(
      host.openBuildDisplay({ absolutePath: texPath }),
    ).rejects.toThrow(message);
    expect(showErrorMessage).toHaveBeenCalledWith(message);
    expect(showErrorMessage).not.toHaveBeenCalledWith(
      expect.stringContaining(logTail),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(logTail),
    );
    expect(shell.openPath).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('opens external URLs through Electron shell.openExternal', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell });

    await host.openExternal('https://texra.ai');
    expect(shell.openExternal).toHaveBeenCalledWith('https://texra.ai');
  });

  // --- Audit item B / trajectory #17: in-app PDF overlay ----------------

  it('prefers the in-app PDF overlay when postToRenderer accepts the post', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const { texPath, pdfPath } = await makeOverlayFixture();
    const shell = makeShell();
    const postToRenderer = vi.fn((_message: unknown) => true);

    const host = createDesktopPreviewHost({ shell, postToRenderer });

    await host.openBuildDisplay({ absolutePath: texPath });
    // The overlay path is taken; shell.openPath is NOT called.
    expect(postToRenderer).toHaveBeenCalledTimes(1);
    expect(postToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'desktop:showPdf',
        title: 'paper.pdf',
        pdfPath,
      }),
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('falls back to external viewer when postToRenderer returns false', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const { texPath, pdfPath } = await makeOverlayFixture();
    const shell = makeShell();
    const postToRenderer = vi.fn((_message: unknown) => false);

    const host = createDesktopPreviewHost({ shell, postToRenderer });

    await host.openBuildDisplay({ absolutePath: texPath });
    expect(postToRenderer).toHaveBeenCalledTimes(1);
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });

  it('falls back to external viewer when postToRenderer throws', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const { texPath, pdfPath } = await makeOverlayFixture();
    const shell = makeShell();
    const postToRenderer = vi.fn((_message: unknown) => {
      throw new Error('IPC bridge not ready');
    });
    // Silence the expected console.error so the test output is clean.
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    const host = createDesktopPreviewHost({ shell, postToRenderer });

    await host.openBuildDisplay({ absolutePath: texPath });
    expect(postToRenderer).toHaveBeenCalledTimes(1);
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
    consoleErrorSpy.mockRestore();
  });

  it('forceExternal=true skips the overlay path entirely', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const { texPath, pdfPath } = await makeOverlayFixture();
    const shell = makeShell();
    const postToRenderer = vi.fn((_message: unknown) => true);

    const host = createDesktopPreviewHost({
      shell,
      postToRenderer,
      forceExternal: true,
    });

    await host.openBuildDisplay({ absolutePath: texPath });
    expect(postToRenderer).not.toHaveBeenCalled();
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });
});
