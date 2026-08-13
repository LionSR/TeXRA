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
  command: z.literal(DESKTOP_DIFF_COMMANDS.SHOW_DIFF),
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
