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
 * What a rail row, switcher entry, or paper chip prints for one paper: fact
 * strings only (G4), produced once by the main process (PRD 8.1). `root` is
 * the folder the paper is, which the renderer's editor and terminal need.
 */
const DesktopPaperDisplaySchema = z.object({
  /** The session key; the paper's identity on every message. */
  key: z.string(),
  /** Canonical folder path. */
  root: z.string(),
  /** Folder basename. */
  name: z.string(),
  initials: z.string(),
  subtitle: z.string(),
});
export type DesktopPaperDisplay = z.infer<typeof DesktopPaperDisplaySchema>;

export const DesktopPapersMessageSchema = z.object({
  command: z.literal(DESKTOP_PAPER_COMMANDS.PAPERS),
  papers: z.array(DesktopPaperDisplaySchema),
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
});
