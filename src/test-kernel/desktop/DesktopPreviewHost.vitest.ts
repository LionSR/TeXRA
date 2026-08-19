import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModuleMocks } from '@test/support/moduleMocks';
import {
  cleanupTempDirs,
  makeTempDir as makeSharedTempDir,
} from '@test/support/tempDirPlatform';
import { createExternalLocation } from '@utils/files/fileLocation';

import { loadSourceModule } from './loadSourceModule.ts';

const mocks = createModuleMocks();

type FakeCompile = (location: { absolutePath: string }) => Promise<{
  ok: boolean;
  pdfPath?: string;
  logTail?: string;
}>;

/**
 * Stand-in LaTeX engine: succeeds and reports the PDF it "wrote" next to the
 * source, the way the real `compileLatex2Pdf` does.
 */
function fakeCompiler() {
  return vi.fn(async (location: { absolutePath: string }) => ({
    ok: true,
    pdfPath: location.absolutePath.replace(/\.tex$/, '.pdf'),
  }));
}

async function loadDesktopPreviewHost(
  compileLatex2Pdf: FakeCompile = fakeCompiler(),
  access?: (filePath: string) => Promise<void>,
  checkToolInstalled = vi.fn(async () => true),
): Promise<typeof import('@desktop/main/desktopPreviewHost')> {
  vi.resetModules();
  mocks.doMock('@latex/texTools', () => ({ compileLatex2Pdf }));
  mocks.doMock('@latex/latexToolchain', () => ({
    hasLatexCompiler: checkToolInstalled,
  }));
  if (access != null) {
    mocks.doMock('node:fs/promises', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:fs/promises')>()),
      access,
    }));
  }
  return loadSourceModule('@desktop/main/desktopPreviewHost');
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
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  async function makeTempDir(): Promise<string> {
    return makeSharedTempDir('texra-preview-host-', tempDirs);
  }

  const TEX_SOURCE =
    '\\documentclass{article}\\begin{document}x\\end{document}';

  async function makeTexFixture(
    stem: string,
    { withPdf = true }: { withPdf?: boolean } = {},
  ): Promise<{ dir: string; texPath: string; pdfPath: string }> {
    const dir = await makeTempDir();
    const texPath = path.join(dir, `${stem}.tex`);
    const pdfPath = path.join(dir, `${stem}.pdf`);
    await writeFile(texPath, TEX_SOURCE);
    if (withPdf) await writeFile(pdfPath, 'pdf');
    return { dir, texPath, pdfPath };
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
    const compileLatex2Pdf = fakeCompiler();
    const { createDesktopPreviewHost } =
      await loadDesktopPreviewHost(compileLatex2Pdf);
    const { dir, texPath, pdfPath } = await makeTexFixture('preview');
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell });

    await host.openBuildDisplay(createExternalLocation(texPath));
    expect(compileLatex2Pdf).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: texPath }),
      { outputDirectory: dir },
    );
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });

  it('opens compile-preview PDF targets without running LaTeX', async () => {
    const compileLatex2Pdf = fakeCompiler();
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

    await host.openBuildDisplay(createExternalLocation(pdfPath));
    expect(compileLatex2Pdf).not.toHaveBeenCalled();
    expect(checkToolInstalled).not.toHaveBeenCalled();
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });

  it('reports missing LaTeX toolchains before compiling preview sources', async () => {
    const compileLatex2Pdf = fakeCompiler();
    const checkToolInstalled = vi.fn(async () => false);
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost(
      compileLatex2Pdf,
      undefined,
      checkToolInstalled,
    );
    const { texPath } = await makeTexFixture('preview', { withPdf: false });
    const showErrorMessage = vi.fn();
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell, showErrorMessage });

    const message = `No LaTeX compiler found for ${texPath}. Install latexmk or pdflatex to compile and preview this file.`;
    await expect(
      host.openBuildDisplay(createExternalLocation(texPath)),
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
    const { texPath } = await makeTexFixture('preview', { withPdf: false });
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
      host.openBuildDisplay(createExternalLocation(texPath)),
    ).rejects.toThrow(message);
    expect(showErrorMessage).toHaveBeenCalledWith(message);
    expect(showErrorMessage).not.toHaveBeenCalledWith(
      expect.stringContaining(logTail),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(logTail),
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('opens external URLs through Electron shell.openExternal', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const shell = makeShell();

    const host = createDesktopPreviewHost({ shell });

    await host.openExternal('https://texra.ai');
    expect(shell.openExternal).toHaveBeenCalledWith('https://texra.ai');
  });

  it('prefers the in-app PDF overlay when postToRenderer accepts the post', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const { texPath, pdfPath } = await makeTexFixture('paper');
    const shell = makeShell();
    const postToRenderer = vi.fn((_message: unknown) => true);

    const host = createDesktopPreviewHost({ shell, postToRenderer });

    await host.openBuildDisplay(createExternalLocation(texPath));
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
    const { texPath, pdfPath } = await makeTexFixture('paper');
    const shell = makeShell();
    const postToRenderer = vi.fn((_message: unknown) => false);

    const host = createDesktopPreviewHost({ shell, postToRenderer });

    await host.openBuildDisplay(createExternalLocation(texPath));
    expect(postToRenderer).toHaveBeenCalledTimes(1);
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });

  it('falls back to external viewer when postToRenderer throws', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const { texPath, pdfPath } = await makeTexFixture('paper');
    const shell = makeShell();
    const postToRenderer = vi.fn((_message: unknown) => {
      throw new Error('IPC bridge not ready');
    });
    // Silence the expected console.error so the test output is clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const host = createDesktopPreviewHost({ shell, postToRenderer });

    await host.openBuildDisplay(createExternalLocation(texPath));
    expect(postToRenderer).toHaveBeenCalledTimes(1);
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });

  it('forceExternal=true skips the overlay path entirely', async () => {
    const { createDesktopPreviewHost } = await loadDesktopPreviewHost();
    const { texPath, pdfPath } = await makeTexFixture('paper');
    const shell = makeShell();
    const postToRenderer = vi.fn((_message: unknown) => true);

    const host = createDesktopPreviewHost({
      shell,
      postToRenderer,
      forceExternal: true,
    });

    await host.openBuildDisplay(createExternalLocation(texPath));
    expect(postToRenderer).not.toHaveBeenCalled();
    expect(shell.openPath).toHaveBeenCalledWith(pdfPath);
  });
});
