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

export const DesktopProjectsMessageSchema = z.object({
  command: z.literal(DESKTOP_PROJECT_COMMANDS.PROJECTS),
  /** The open projects' session keys, in rail order. What a rail row,
   *  switcher entry, or project chip prints for one is the `project` display
   *  record of its host snapshot (PRD 8.1), which rides the session's frames
   *  and is not repeated here; its folder stays with the main process. */
  open: z.array(z.string()),
  /** Key of the session this window shows: an open project's, or the
   *  no-workspace session's, which is never listed in `open`. */
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
