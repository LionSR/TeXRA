import { z } from 'zod';

// IPC plumbing for the in-app Review workbench.
//
// The desktop main process used to satisfy `DiffViewHost.openDiff` by
// generating a `.diff` patch file and opening it in the OS default editor
// (`desktopDiffHost.ts`). With #3801's three-pane shell landed, the
// renderer can now mount `<texra-diff-view>` (Monaco-backed) inside a
// persistent Review tab beside a hierarchical changed-file index.
//
// `desktop:showDiff` carries the original/proposed text + a hint language
// for Monaco's tokenizer, so the renderer never has to read disk. The
// main process keeps the file paths around for its own logging.

export const DESKTOP_DIFF_COMMANDS = {
  SHOW_DIFF: 'desktop:showDiff',
  CLOSE_DIFF: 'desktop:closeDiff',
} as const;

export const DesktopShowDiffMessageSchema = z.object({
  session: z.string().min(1),
  command: z.literal(DESKTOP_DIFF_COMMANDS.SHOW_DIFF),
  /**
   * Names the diff this message opens, so the `desktop:closeDiff` below can
   * close that diff and no other. A tool-edit preview uses its request id;
   * every other producer gets one minted by `desktopDiffHost.openDiff`.
   */
  previewId: z.string().min(1),
  title: z.string(),
  // The one path the Review workbench displays. Always supplied by the
  // producer; no fallback reconstruction in the renderer.
  displayPath: z.string(),
  originalText: z.string(),
  proposedText: z.string(),
  additions: z.int().nonnegative().prefault(0),
  deletions: z.int().nonnegative().prefault(0),
  // Monaco language id (e.g. 'plaintext', 'typescript', 'latex'). The
  // renderer falls back to 'plaintext' on unknown values.
  language: z.string().default('plaintext'),
});

export type DesktopShowDiffMessage = z.infer<
  typeof DesktopShowDiffMessageSchema
>;

export const DesktopCloseDiffMessageSchema = z.object({
  session: z.string().min(1),
  command: z.literal(DESKTOP_DIFF_COMMANDS.CLOSE_DIFF),
  /**
   * The `previewId` of the diff the sender opened. The Review pane retains
   * one review per path, so the renderer drops the reviews this id opened
   * and no others, and the Review tab goes only once that empties the pane.
   */
  previewId: z.string().min(1),
});

export type DesktopCloseDiffMessage = z.infer<
  typeof DesktopCloseDiffMessageSchema
>;

// `desktop:closeDiff` is consumed by the renderer's window-message
// handler. The main process posts it from `desktopDiffHost.closeDiff`,
// the counterpart of the `desktop:showDiff` that opened the Review tab;
// the Playwright trajectory test constructs the literal
// `{ command: 'desktop:closeDiff', previewId }` inline via `window.postMessage`,
// since that test runs in the browser context where importing this
// module isn't worth the bundle hit. The schema remains the source of
// truth. No `buildDesktopCloseDiffMessage` helper is defined to avoid
// dead code (Cursor Bugbot review on PR #3815).
