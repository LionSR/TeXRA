import { Schema } from 'effect';
import {
  decodingDefault,
  decodingDefaultType,
  NonNegativeIntSchema,
} from '@texra-ai/worldline/schemas';

// IPC plumbing for the in-app Review workbench: the renderer mounts
// `<texra-diff-view>` (Monaco-backed) inside a persistent Review tab beside a
// hierarchical changed-file index. A `.diff` patch opened in the OS default
// editor is only the fallback when the renderer cannot be reached
// (`desktopDiffHost.ts`).
//
// `desktop:showDiff` carries the original/proposed text + a hint language
// for Monaco's tokenizer, so the renderer never has to read disk. The
// main process keeps the file paths around for its own logging.

export const DESKTOP_DIFF_COMMANDS = Object.freeze({
  SHOW_DIFF: 'desktop:showDiff',
  CLOSE_DIFF: 'desktop:closeDiff',
} as const);

export const DesktopShowDiffMessageSchema = Schema.Struct({
  session: Schema.NonEmptyString,
  command: Schema.Literal(DESKTOP_DIFF_COMMANDS.SHOW_DIFF),
  /**
   * Names the diff this message opens, so the `desktop:closeDiff` below can
   * close that diff and no other. A tool-edit preview uses its request id;
   * every other producer gets one minted by `desktopDiffHost.openDiff`.
   */
  previewId: Schema.NonEmptyString,
  title: Schema.String,
  // The one path the Review workbench displays. Always supplied by the
  // producer; no fallback reconstruction in the renderer.
  displayPath: Schema.String,
  originalText: Schema.String,
  proposedText: Schema.String,
  additions: decodingDefault(NonNegativeIntSchema, 0),
  deletions: decodingDefault(NonNegativeIntSchema, 0),
  // Monaco language id (e.g. 'plaintext', 'typescript', 'latex'). The
  // renderer falls back to 'plaintext' on unknown values.
  language: decodingDefaultType(Schema.String, 'plaintext'),
});

export type DesktopShowDiffMessage =
  (typeof DesktopShowDiffMessageSchema)['Type'];

export const DesktopCloseDiffMessageSchema = Schema.Struct({
  session: Schema.NonEmptyString,
  command: Schema.Literal(DESKTOP_DIFF_COMMANDS.CLOSE_DIFF),
  /**
   * The `previewId` of the diff the sender opened. The Review pane keys its
   * reviews by this id, so the renderer drops this review and no other (a
   * second pending edit of the same file stays), and the Review tab goes
   * only once that empties the pane.
   */
  previewId: Schema.NonEmptyString,
});
