import { access } from 'node:fs/promises';
import path from 'node:path';

import { isLatexFile } from '@common/files/fileTypeUtils';
import type { ExternalOpener } from '@hosts/externalOpener';
import type { BuildDisplayFn } from '@tools/approval/latexPreview';
import type { FileLocation } from '@utils/files';
import { createExternalLocation } from '@utils/files';

import { buildDesktopShowPdfMessage } from '../desktopPdfMessages.js';

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

  // Try to render the PDF inside the desktop via the wa-dialog overlay.
  // Returns `true` when the renderer accepted the IPC, `false` when we
  // should fall back to the external viewer. Mirrors the diff host's
  // contract: a `false` return value or a thrown error opts into
  // `shell.openPath`. Bot review on #3815 explicitly required not
  // silently swallowing IPC failures.
  function tryShowPdfInRenderer(pdfPath: string, title: string): boolean {
    if (!options.postToRenderer || options.forceExternal) return false;
    try {
      const result = options.postToRenderer(
        buildDesktopShowPdfMessage({ title, pdfPath }),
      );
      // `void` (the common case) is treated as success; explicit
      // `false` opts into the external-viewer fallback.
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

    // Confirm the PDF is on disk before rendering it (the iframe will
    // happily load nothing and present a blank surface otherwise).
    await ensurePathExists(pdfPath);

    // Prefer the in-app overlay (audit item B / trajectory #17).
    // External-viewer fallback covers headless tests and the
    // `forceExternal` escape hatch.
    if (tryShowPdfInRenderer(pdfPath, path.basename(pdfPath))) return;

    await openPath(pdfPath);
  }

  return {
    openBuildDisplay,
    openExternal,
    openPath,
  };
}
