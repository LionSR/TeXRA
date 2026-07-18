import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { nanoid } from 'nanoid';

import {
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/uiHosts';
import { computeUserPatch } from '@tools/approval/toolEditApproval';

import {
  DESKTOP_DIFF_COMMANDS,
  type DesktopShowDiffMessage,
  monacoLanguageForFilePath,
} from '../desktopDiffMessages.js';
import { createTexraTempDir } from './desktopTempDir.js';

export interface DesktopDiffHostOptions {
  /**
   * Falls back to the OS default editor (writes a `.diff` patch file and
   * calls `openPath`). Used when the renderer overlay is unavailable or
   * `forceExternal === true`.
   */
  openPath(filePath: string): Promise<void>;
  /**
   * Posts a `desktop:showDiff` IPC message to the renderer so it can
   * mount `<texra-diff-view>` inside the wa-dialog overlay. Return
   * `false` (or throw) when the renderer is not reachable — e.g. the
   * IPC bridge isn't wired yet at startup, or the BrowserWindow has
   * been destroyed. The host then transparently falls back to the
   * external-editor flow so the user never gets a silent failure
   * (caught by Copilot review on PR #3815).
   *
   * When undefined, `openDiff` skips the overlay entirely and uses
   * the external-editor flow — keeps tests and unattended invocations
   * working.
   */
  postToRenderer?(message: unknown): boolean | void;
  /**
   * Force the legacy external-editor flow (writes a `.diff` patch file).
   * Useful for headless tests and as an opt-out if the in-app overlay
   * misbehaves. Defaults to `false` (prefer the in-app overlay).
   */
  forceExternal?: boolean;
}

export function createDesktopDiffHost(
  options: DesktopDiffHostOptions,
): Pick<DiffViewHost, 'openDiff'> {
  // Try to render the diff in the wa-dialog overlay. Returns `false` (so the
  // caller falls back to the external editor) when the renderer rejects or
  // throws; mirrors the preview host's contract.
  function tryShowDiffInRenderer(message: DesktopShowDiffMessage): boolean {
    if (!options.postToRenderer || options.forceExternal) return false;
    try {
      return options.postToRenderer(message) !== false;
    } catch (error) {
      console.error(
        '[desktop] desktopDiffHost: postToRenderer failed; falling back to external editor',
        error,
      );
      return false;
    }
  }

  async function openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Promise<DiffSession> {
    const [originalContent, proposedContent] = await Promise.all([
      readFile(original.filePath, 'utf8'),
      readFile(proposed.filePath, 'utf8'),
    ]);

    // Prefer the in-app overlay when wired. A `false` return value or
    // a thrown error opts into the external-editor fallback (covers the
    // startup IPC race, destroyed BrowserWindow, and `forceExternal`).
    const shownInRenderer = tryShowDiffInRenderer({
      command: DESKTOP_DIFF_COMMANDS.SHOW_DIFF,
      title,
      originalText: originalContent,
      proposedText: proposedContent,
      language: monacoLanguageForFilePath(proposed.filePath),
      originalPath: original.filePath,
      proposedPath: proposed.filePath,
    });
    if (shownInRenderer) return { original, proposed, title };

    // External-editor fallback: write a unified patch file and open it.
    const patch =
      computeUserPatch(originalContent, proposedContent) ??
      `No textual changes for ${path.basename(proposed.filePath)}.\n`;
    const tempDir = await createTexraTempDir('texra-desktop-diff-');
    const diffPath = path.join(tempDir, `${nanoid()}.diff`);

    await writeFile(diffPath, patch, 'utf8');
    await options.openPath(diffPath);

    return { original, proposed, title };
  }

  return { openDiff };
}
