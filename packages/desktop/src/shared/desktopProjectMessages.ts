// Wire contract for the open projects: the main process tells the renderer
// which projects are open and which one the window shows; the renderer asks to
// show another one, or to close one. A project is named on the wire by its
// session key (the storage root the fold's `SessionView.key` carries), so
// the rail row, the frames, and the requests of one project all share it.

import { z } from 'zod';

export const DESKTOP_PROJECT_COMMANDS = {
  PROJECTS: 'desktop:projects',
  /** The renderer's first ask after it boots: which projects are open. */
  REQUEST_PROJECTS: 'desktop:projects:request',
  SELECT_PROJECT: 'desktop:projects:select',
  CLOSE_PROJECT: 'desktop:projects:close',
} as const;

/**
 * One open project: its session key and the folder it is, which the
 * renderer's editor and terminal need. What a rail row, switcher entry, or
 * project chip prints for it is the `project` display record of the session's
 * host snapshot (PRD 8.1), which rides the session's frames and is not
 * repeated here.
 */
const DesktopProjectSchema = z.object({
  /** The session key; the project's identity on every message. */
  key: z.string(),
  /** Canonical folder path. */
  root: z.string(),
});

export const DesktopProjectsMessageSchema = z.object({
  command: z.literal(DESKTOP_PROJECT_COMMANDS.PROJECTS),
  projects: z.array(DesktopProjectSchema),
  /** Key of the session this window shows: an open project's, or the
   *  no-workspace session's, which is never listed in `projects`. */
  activeKey: z.string(),
});
export type DesktopProjectsMessage = z.infer<
  typeof DesktopProjectsMessageSchema
>;

export const DesktopSelectProjectMessageSchema = z.object({
  command: z.literal(DESKTOP_PROJECT_COMMANDS.SELECT_PROJECT),
  key: z.string(),
});

export const DesktopCloseProjectMessageSchema = z.object({
  command: z.literal(DESKTOP_PROJECT_COMMANDS.CLOSE_PROJECT),
  key: z.string(),
  /** Dirtiness belongs to the addressed project's editor, including when hidden. */
  hasUnsavedChanges: z.boolean(),
});
