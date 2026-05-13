import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  type DiffSession,
  type DiffSource,
  type DiffViewHost,
} from '@hosts/diffViewHost';
import { computeUserPatch } from '@tools/approval/toolEditApproval';

import {
  buildDesktopShowDiffMessage,
  monacoLanguageForFilePath,
} from '../desktopDiffMessages.js';

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
  async function openDiff(
    original: DiffSource,
    proposed: DiffSource,
    title: string,
  ): Promise<DiffSession> {
    const [originalContent, proposedContent] = await Promise.all([
      readFile(original.filePath, 'utf8'),
      readFile(proposed.filePath, 'utf8'),
    ]);

    // Prefer the in-app overlay when wired. Falling back to the external
    // editor is intentional for headless tests + the audit-item-C escape
    // hatch (`forceExternal`). Wrap the post in try/catch and respect a
    // `false` return value from `postToRenderer` so we transparently
    // fall back when the IPC bridge isn't reachable yet (startup race)
    // or the BrowserWindow has been destroyed (Copilot/Cursor review
    // on #3815 — silent overlay failure was the only previous failure
    // mode).
    if (options.postToRenderer && !options.forceExternal) {
      // Pick a language hint from the proposed file extension; the
      // proposed path is the one the user is reviewing for acceptance,
      // so its extension wins over the (possibly stale) original.
      let posted = false;
      try {
        const result = options.postToRenderer(
          buildDesktopShowDiffMessage({
            title,
            originalText: originalContent,
            proposedText: proposedContent,
            language: monacoLanguageForFilePath(proposed.filePath),
            originalPath: original.filePath,
            proposedPath: proposed.filePath,
          }),
        );
        // `void` (the common case) is treated as success; explicit
        // `false` opts into the external-editor fallback.
        posted = result !== false;
      } catch (error) {
        console.error(
          '[desktop] desktopDiffHost: postToRenderer failed; falling back to external editor',
          error,
        );
      }
      if (posted) return { original, proposed, title };
      // fall through to the external-editor flow below.
    }

    // External-editor fallback: keep the previous behaviour — write a
    // unified patch file to a tmp dir and hand off via `openPath`.
    const patch =
      computeUserPatch(originalContent, proposedContent) ??
      `No textual changes for ${path.basename(proposed.filePath)}.\n`;
    const tempDir = await mkdtemp(path.join(tmpdir(), 'texra-desktop-diff-'));
    const diffPath = path.join(tempDir, `${randomUUID()}.diff`);

    await writeFile(diffPath, patch, 'utf8');
    await options.openPath(diffPath);

    return { original, proposed, title };
  }

  return { openDiff };
}
