// Wire contract for the open papers: the main process tells the renderer
// which folders are open and which one the window shows; the renderer asks to
// show another one, or to close one.

import { z } from 'zod';

import { workspaceInitials } from './desktopTaskShell';

export const DESKTOP_PAPER_COMMANDS = {
  PAPERS: 'desktop:papers',
  SELECT_PAPER: 'desktop:papers:select',
  CLOSE_PAPER: 'desktop:papers:close',
} as const;

const DesktopPaperSummarySchema = z.object({
  /** Canonical folder path; the paper's identity. */
  root: z.string(),
  /** Folder basename, for the rail row. */
  name: z.string(),
});
export type DesktopPaperSummary = z.infer<typeof DesktopPaperSummarySchema>;

/**
 * What a rail row, switcher entry, or paper chip prints for one paper: fact
 * strings only (G4), keyed by the paper's root. The renderer derives it from
 * the summary until the host snapshot carries it (PRD 8.1).
 */
export interface DesktopPaperDisplay {
  readonly key: string;
  readonly name: string;
  readonly initials: string;
  readonly subtitle: string;
}

export function paperDisplay(paper: DesktopPaperSummary): DesktopPaperDisplay {
  return {
    key: paper.root,
    name: paper.name,
    initials: workspaceInitials(paper.root),
    subtitle: paper.root,
  };
}

export const DesktopPapersMessageSchema = z.object({
  command: z.literal(DESKTOP_PAPER_COMMANDS.PAPERS),
  papers: z.array(DesktopPaperSummarySchema),
  /** Root of the paper this window shows; null when no folder is open. */
  activeRoot: z.string().nullable(),
});
export type DesktopPapersMessage = z.infer<typeof DesktopPapersMessageSchema>;

export const DesktopSelectPaperMessageSchema = z.object({
  command: z.literal(DESKTOP_PAPER_COMMANDS.SELECT_PAPER),
  root: z.string(),
});

export const DesktopClosePaperMessageSchema = z.object({
  command: z.literal(DESKTOP_PAPER_COMMANDS.CLOSE_PAPER),
  root: z.string(),
});
