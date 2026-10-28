import { Effect, Schema } from 'effect';

// IPC plumbing for the in-app Review workbench: the renderer mounts
// `<texra-diff-view>` (Monaco-backed) inside a persistent Review tab beside a
// hierarchical changed-file index. A `.diff` patch opened in the OS default
// editor is only the fallback when the renderer cannot be reached
// (`desktopDiffHost.ts`).
//
// `desktop:showDiff` carries the original/proposed text + a hint language
// for Monaco's tokenizer, so the renderer never has to read disk. The
// main process keeps the file paths around for its own logging.

export const DESKTOP_DIFF_COMMANDS = {
  SHOW_DIFF: 'desktop:showDiff',
  CLOSE_DIFF: 'desktop:closeDiff',
} as const;

export const DesktopShowDiffMessageSchema = Schema.Struct({
  session: Schema.String.check(Schema.isMinLength(1)),
  command: Schema.Literal(DESKTOP_DIFF_COMMANDS.SHOW_DIFF),
  /**
   * Names the diff this message opens, so the `desktop:closeDiff` below can
   * close that diff and no other. A tool-edit preview uses its request id;
   * every other producer gets one minted by `desktopDiffHost.openDiff`.
   */
  previewId: Schema.String.check(Schema.isMinLength(1)),
  title: Schema.String,
  // The one path the Review workbench displays. Always supplied by the
  // producer; no fallback reconstruction in the renderer.
  displayPath: Schema.String,
  originalText: Schema.String,
  proposedText: Schema.String,
  additions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  deletions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(0)),
  ),
  // Monaco language id (e.g. 'plaintext', 'typescript', 'latex'). The
  // renderer falls back to 'plaintext' on unknown values.
  language: Schema.String.pipe(
    Schema.withDecodingDefaultType(Effect.succeed('plaintext')),
  ),
});

export type DesktopShowDiffMessage =
  (typeof DesktopShowDiffMessageSchema)['Type'];

export const DesktopCloseDiffMessageSchema = Schema.Struct({
  session: Schema.String.check(Schema.isMinLength(1)),
  command: Schema.Literal(DESKTOP_DIFF_COMMANDS.CLOSE_DIFF),
  /**
   * The `previewId` of the diff the sender opened. The Review pane keys its
   * reviews by this id, so the renderer drops this review and no other (a
   * second pending edit of the same file stays), and the Review tab goes
   * only once that empties the pane.
   */
  previewId: Schema.String.check(Schema.isMinLength(1)),
});

export type DesktopCloseDiffMessage =
  (typeof DesktopCloseDiffMessageSchema)['Type'];

// `desktop:closeDiff` is consumed by the renderer's window-message
// handler. The main process posts it from `desktopDiffHost.closeDiff`,
// the counterpart of the `desktop:showDiff` that opened the Review tab;
// the Playwright trajectory test constructs the literal
// `{ command: 'desktop:closeDiff', previewId }` inline via `window.postMessage`,
// since that test runs in the browser context where importing this
// module isn't worth the bundle hit. The schema remains the source of
// truth. No `buildDesktopCloseDiffMessage` helper is defined to avoid
// dead code (Cursor Bugbot review on PR #3815).
