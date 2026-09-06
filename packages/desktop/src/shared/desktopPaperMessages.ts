// Wire contract for the open papers: the main process tells the renderer
// which papers are open and which one the window shows; the renderer asks to
// show another one, or to close one. A paper is named on the wire by its
// session key (the storage root the fold's `SessionView.key` carries), so
// the rail row, the frames, and the requests of one paper all share it.

import { z } from 'zod';

export const DESKTOP_PAPER_COMMANDS = {
  PAPERS: 'desktop:papers',
  /** The renderer's first ask after it boots: which papers are open. */
  REQUEST_PAPERS: 'desktop:papers:request',
  SELECT_PAPER: 'desktop:papers:select',
  CLOSE_PAPER: 'desktop:papers:close',
} as const;

/**
 * One open paper: its session key and the folder it is, which the
 * renderer's editor and terminal need. What a rail row, switcher entry, or
 * paper chip prints for it is the `paper` display record of the session's
 * host snapshot (PRD 8.1), which rides the session's frames and is not
 * repeated here.
 */
const DesktopPaperSchema = z.object({
  /** The session key; the paper's identity on every message. */
  key: z.string(),
  /** Canonical folder path. */
  root: z.string(),
});

export const DesktopPapersMessageSchema = z.object({
  command: z.literal(DESKTOP_PAPER_COMMANDS.PAPERS),
  papers: z.array(DesktopPaperSchema),
  /** Key of the session this window shows: an open paper's, or the
   *  no-workspace session's, which is never listed in `papers`. */
  activeKey: z.string(),
});
export type DesktopPapersMessage = z.infer<typeof DesktopPapersMessageSchema>;

export const DesktopSelectPaperMessageSchema = z.object({
  command: z.literal(DESKTOP_PAPER_COMMANDS.SELECT_PAPER),
  key: z.string(),
});

export const DesktopClosePaperMessageSchema = z.object({
  command: z.literal(DESKTOP_PAPER_COMMANDS.CLOSE_PAPER),
  key: z.string(),
  /** Dirtiness belongs to the addressed paper's editor, including when hidden. */
  hasUnsavedChanges: z.boolean(),
});
