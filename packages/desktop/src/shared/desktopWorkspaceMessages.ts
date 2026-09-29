// Wire contract for the workspace shell surfaces: editor file I/O, terminal
// pty runs, and embedded browser control.
//
// These cross the renderer/main IPC boundary, so unlike the in-memory tab model
// they are Zod schemas: the renderer's requests are validated in the main
// process before touching the filesystem or spawning a shell.

import { z } from 'zod';

/** Auxiliary resources and replies belong to the paper that opened them. */
const DesktopWorkspaceMessageSchema = z.object({ session: z.string() });

export const DESKTOP_WORKSPACE_COMMANDS = {
  // Editor
  FILES_CHANGED: 'desktop:workspace:filesChanged',
  // Terminal
  TERMINAL_START: 'desktop:terminal:start',
  TERMINAL_INPUT: 'desktop:terminal:input',
  TERMINAL_RESIZE: 'desktop:terminal:resize',
  TERMINAL_CLOSE: 'desktop:terminal:close',
  TERMINAL_DATA: 'desktop:terminal:data',
  TERMINAL_EXIT: 'desktop:terminal:exit',
  TERMINAL_ERROR: 'desktop:terminal:error',
  TERMINAL_OPEN_COMMAND: 'desktop:terminal:openCommand',
  // Browser
  BROWSER_OPEN: 'desktop:browser:open',
  BROWSER_BOUNDS: 'desktop:browser:bounds',
  BROWSER_HIDE: 'desktop:browser:hide',
  BROWSER_CLOSE: 'desktop:browser:close',
  BROWSER_STATE: 'desktop:browser:state',
} as const;

// ── Editor ──
//
// The editor's file I/O is `host.request` (`workspaceFile`), answered like any
// other host request; only the change notice below is a desktop command.

/**
 * Something outside the editor wrote into the workspace — an accepted run
 * output, an accepted LaTeX diff — so the file tree's cached listing is out of
 * date. Carries no paths: the tree re-lists from the main process anyway, and
 * a path list would only tempt the renderer into a partial update it has no
 * way to keep consistent with the directories it has not loaded.
 */
export const DesktopWorkspaceFilesChangedMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILES_CHANGED),
  });

// ── Terminal ──

const DesktopTerminalStartMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START),
  sessionId: z.string(),
  cols: z.int().positive(),
  rows: z.int().positive(),
  initialCommand: z.string().min(1).optional(),
});

const DesktopTerminalInputMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT),
  sessionId: z.string(),
  data: z.string(),
});

const DesktopTerminalResizeMessageSchema = DesktopWorkspaceMessageSchema.extend(
  {
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE),
    sessionId: z.string(),
    cols: z.int().positive(),
    rows: z.int().positive(),
  },
);

const DesktopTerminalCloseMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE),
  sessionId: z.string(),
});

export const DesktopTerminalDataMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_DATA),
    sessionId: z.string(),
    data: z.string(),
  });

export const DesktopTerminalExitMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_EXIT),
    sessionId: z.string(),
    exitCode: z.int(),
  });

export const DesktopTerminalErrorMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_ERROR),
    sessionId: z.string(),
    message: z.string(),
  });

export const DesktopTerminalOpenCommandMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_OPEN_COMMAND),
    initialCommand: z.string().min(1),
  });

// ── Browser ──

const DesktopBrowserBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export type DesktopBrowserBounds = z.infer<typeof DesktopBrowserBoundsSchema>;

const DesktopBrowserOpenMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN),
  tabId: z.string(),
  url: z.string(),
});

const DesktopBrowserBoundsMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS),
  tabId: z.string(),
  bounds: DesktopBrowserBoundsSchema,
});

const DesktopBrowserHideMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE),
});

const DesktopBrowserCloseMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE),
  tabId: z.string(),
});

export const DesktopBrowserStateMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_STATE),
    tabId: z.string(),
    title: z.string(),
  });

/** Everything the main process accepts from the renderer. */
export const DesktopWorkspaceInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    DesktopTerminalStartMessageSchema,
    DesktopTerminalInputMessageSchema,
    DesktopTerminalResizeMessageSchema,
    DesktopTerminalCloseMessageSchema,
    DesktopBrowserOpenMessageSchema,
    DesktopBrowserBoundsMessageSchema,
    DesktopBrowserHideMessageSchema,
    DesktopBrowserCloseMessageSchema,
  ],
);

export type DesktopWorkspaceInboundMessage = z.infer<
  typeof DesktopWorkspaceInboundMessageSchema
>;

/** The commands the main process routes to a project's workspace. */
export const DESKTOP_WORKSPACE_INBOUND_COMMANDS =
  DesktopWorkspaceInboundMessageSchema.options.flatMap((option) => [
    ...option.shape.command.values,
  ]);

type WorkspaceOutbound =
  | z.infer<typeof DesktopWorkspaceFilesChangedMessageSchema>
  | z.infer<typeof DesktopTerminalDataMessageSchema>
  | z.infer<typeof DesktopTerminalExitMessageSchema>
  | z.infer<typeof DesktopTerminalErrorMessageSchema>
  | z.infer<typeof DesktopBrowserStateMessageSchema>;

/** A workspace reply before the project transport stamps its `session`. */
export type DesktopWorkspaceReply = WorkspaceOutbound extends infer M
  ? M extends WorkspaceOutbound
    ? Omit<M, 'session'>
    : never
  : never;
