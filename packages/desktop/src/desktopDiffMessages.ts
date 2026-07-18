import { z } from 'zod';

import { getBasename } from '@utils/core';

// IPC plumbing for the in-app diff overlay (audit item C, trajectory #18).
//
// The desktop main process used to satisfy `DiffViewHost.openDiff` by
// generating a `.diff` patch file and opening it in the OS default editor
// (`desktopDiffHost.ts`). With #3801's three-pane shell landed, the
// renderer can now mount `<texra-diff-view>` (Monaco-backed) inside a
// `wa-dialog` overlay — the same pattern as the settings overlay.
//
// `desktop:showDiff` carries the original/proposed text + a hint language
// for Monaco's tokenizer, so the renderer never has to read disk. The
// main process keeps the file paths around for its own logging.

export const DESKTOP_DIFF_COMMANDS = {
  SHOW_DIFF: 'desktop:showDiff',
  CLOSE_DIFF: 'desktop:closeDiff',
} as const;

export const DesktopShowDiffMessageSchema = z.object({
  command: z.literal(DESKTOP_DIFF_COMMANDS.SHOW_DIFF),
  title: z.string(),
  originalText: z.string(),
  proposedText: z.string(),
  // Monaco language id (e.g. 'plaintext', 'typescript', 'latex'). The
  // renderer falls back to 'plaintext' on unknown values.
  language: z.string().default('plaintext'),
  // File hints purely for the dialog header / a11y label. Not used to
  // re-read content — the text is already in the payload.
  originalPath: z.string().optional(),
  proposedPath: z.string().optional(),
});

export type DesktopShowDiffMessage = z.infer<
  typeof DesktopShowDiffMessageSchema
>;

export const DesktopCloseDiffMessageSchema = z.object({
  command: z.literal(DESKTOP_DIFF_COMMANDS.CLOSE_DIFF),
});

// `desktop:closeDiff` is consumed by the renderer's window-message
// handler; producers (today: the Playwright trajectory test) construct
// the literal `{ command: 'desktop:closeDiff' }` inline via
// `window.postMessage`, since that test runs in the browser context
// where importing this module isn't worth the bundle hit. The schema
// (`DesktopCloseDiffMessageSchema`) remains the source of truth. No
// `buildDesktopCloseDiffMessage` helper is defined to avoid dead code
// (Cursor Bugbot review on PR #3815).

// Map a file extension to a Monaco language id. Kept narrow on purpose —
// Monaco's full registry is large and we only need the languages a TeXRA
// workflow actually emits diffs for. Falls back to 'plaintext'.
//
// VS Code-free zone: pure string mapping, no `vscode.languages` lookup.
const EXTENSION_TO_MONACO_LANGUAGE: Record<string, string> = {
  '.tex': 'latex',
  '.bib': 'bibtex',
  '.cls': 'latex',
  '.sty': 'latex',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.py': 'python',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
};

export function monacoLanguageForFilePath(
  filePath: string | undefined,
): string {
  if (!filePath) return 'plaintext';
  // Browser-safe (no node:path): getBasename handles both separators. We
  // accept any segment after the last dot in the basename.
  const basename = getBasename(filePath);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex < 0) return 'plaintext';
  const ext = basename.slice(dotIndex).toLowerCase();
  return EXTENSION_TO_MONACO_LANGUAGE[ext] ?? 'plaintext';
}
