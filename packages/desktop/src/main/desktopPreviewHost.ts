import { access } from 'node:fs/promises';
import path from 'node:path';

import { isLatexFile } from '@common/files/fileTypeUtils';
import type { ExternalOpener } from '@hosts/uiHosts';
import type { FileLocation } from '@shared/schemas';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import { getFileStem } from '@utils/core';
import { createExternalLocation } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { buildDesktopShowPdfMessage } from '../desktopPdfMessages.js';

interface DesktopShellAdapter {
  openExternal(url: string): Promise<void>;
  openPath(filePath: string): Promise<string>;
}

export interface DesktopPreviewHost extends ExternalOpener {
  openBuildDisplay: BuildDisplayFn;
}

export interface DesktopPreviewHostOptions {
  shell: DesktopShellAdapter;
  showErrorMessage?: (message: string) => Promise<void> | void;
  /**
   * Posts a `desktop:showPdf` IPC message to the renderer so it can
   * mount an `<iframe>` (Electron's built-in Chromium PDF viewer)
   * inside the wa-dialog overlay. Return `false` (or throw) when the
   * renderer is not reachable — e.g. the IPC bridge isn't wired yet
   * at startup, or the BrowserWindow has been destroyed. The host
   * then transparently falls back to `shell.openPath` so the user
   * never gets a silent failure (mirrors the diff host's contract,
   * caught by Copilot review on PR #3815).
   *
   * When undefined, `openBuildDisplay` skips the overlay entirely and
   * uses the external-viewer flow — keeps tests and unattended
   * invocations working.
   */
  postToRenderer?(message: unknown): boolean | void;
  /**
   * Force the legacy external-viewer flow (`shell.openPath`). Useful
   * for headless tests and as an opt-out if the in-app overlay
   * misbehaves. Defaults to `false` (prefer the in-app overlay).
   */
  forceExternal?: boolean;
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
      if (getErrorCode(error) === 'ENOENT') {
        await fail(`File not found: ${filePath}`);
      }
      await fail(`Cannot access file ${filePath}: ${toErrorMessage(error)}`);
    }
  }

  async function openPath(filePath: string): Promise<void> {
    await ensurePathExists(filePath);

    let shellError = '';
    try {
      shellError = await options.shell.openPath(filePath);
    } catch (error) {
      shellError = toErrorMessage(error);
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

  // Try to render the PDF in the wa-dialog overlay. Returns `false` (so
  // the caller falls back to `shell.openPath`) when the renderer rejects
  // or throws — mirrors the diff host's contract.
  function tryShowPdfInRenderer(pdfPath: string, title: string): boolean {
    if (!options.postToRenderer || options.forceExternal) return false;
    try {
      const result = options.postToRenderer(
        buildDesktopShowPdfMessage({ title, pdfPath }),
      );
      return result !== false;
    } catch (error) {
      console.error(
        '[desktop] desktopPreviewHost: postToRenderer failed; falling back to external viewer',
        error,
      );
      return false;
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
      `${getFileStem(sourcePath)}.pdf`,
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
    if (!built.ok) {
      // The full engine log (up to 200 lines) goes to console.error, not the
      // dialog message -- fail() surfaces the message via a blocking native
      // `dialog.showMessageBox` modal (see main/index.ts's showErrorMessage),
      // which has no scrolling affordance and would render as an oversized,
      // unreadable dialog for a multi-hundred-line raw compiler log.
      console.error(
        `[desktop] LaTeX build failed for ${sourcePath}:\n${built.logTail}`,
      );
      await fail(
        `LaTeX build failed for ${sourcePath}. See the LaTeX log next to the source for details.`,
      );
    }

    // Confirm the PDF is on disk before rendering it (the iframe will
    // load nothing and present a blank surface otherwise).
    await ensurePathExists(pdfPath);

    if (tryShowPdfInRenderer(pdfPath, path.basename(pdfPath))) return;

    await openPath(pdfPath);
  }

  return {
    openBuildDisplay,
    openExternal,
    openPath,
  };
}
