import { access } from 'node:fs/promises';
import path from 'node:path';

import { isLatexFile } from '@common/files/fileTypeUtils';
import type { ExternalOpener } from '@hosts/externalOpener';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import type { FileLocation } from '@utils/files';
import { createExternalLocation } from '@utils/files';

export interface DesktopShellAdapter {
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<string>;
}

export interface DesktopPreviewHost extends ExternalOpener {
  openBuildDisplay: BuildDisplayFn;
}

export interface DesktopPreviewHostOptions {
  shell: DesktopShellAdapter;
  showErrorMessage?: (message: string) => Promise<void> | void;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export function createDesktopPreviewHost(
  options: DesktopPreviewHostOptions,
): DesktopPreviewHost {
  async function fail(message: string): Promise<never> {
    await options.showErrorMessage?.(message);
    throw new Error(message);
  }

  async function ensurePathExists(filePath: string): Promise<void> {
    try {
      await access(filePath);
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        await fail(`Cannot access file ${filePath}: ${toErrorMessage(error)}`);
      }
      await fail(`File not found: ${filePath}`);
    }
  }

  async function openPath(filePath: string): Promise<void> {
    await ensurePathExists(filePath);

    let shellError = '';
    try {
      shellError = await options.shell.openPath(filePath);
    } catch (error) {
      await fail(`Failed to open file ${filePath}: ${toErrorMessage(error)}`);
    }

    if (shellError) {
      await fail(`Failed to open file ${filePath}: ${shellError}`);
    }
  }

  async function openExternal(url: string): Promise<void> {
    try {
      await options.shell.openExternal(url);
    } catch (error) {
      await fail(`Failed to open URL ${url}: ${toErrorMessage(error)}`);
    }
  }

  async function openBuildDisplay(fileLocation: FileLocation): Promise<void> {
    const sourcePath = fileLocation.absolutePath;
    await ensurePathExists(sourcePath);

    if (!isLatexFile(sourcePath)) {
      await openPath(sourcePath);
      return;
    }

    const outputDirectory = path.dirname(sourcePath);
    const pdfPath = path.join(
      outputDirectory,
      `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`,
    );
    const { hasLatexCompiler } = await import('@latex/latexToolchain');
    if (!(await hasLatexCompiler())) {
      await fail(
        `No LaTeX compiler found for ${sourcePath}. Install latexmk or pdflatex to compile and preview this file.`,
      );
    }

    const { compileLatex2Pdf } = await import('@latex/texTools');
    const built = await compileLatex2Pdf(createExternalLocation(sourcePath), {
      outputDirectory,
    });
    if (!built) {
      await fail(
        `LaTeX build failed for ${sourcePath}. See the LaTeX log next to the source for details.`,
      );
    }

    await openPath(pdfPath);
  }

  return {
    openBuildDisplay,
    openExternal,
    openPath,
  };
}
