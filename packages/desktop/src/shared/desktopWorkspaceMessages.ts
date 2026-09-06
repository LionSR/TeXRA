// Wire contract for the workspace shell surfaces: editor file I/O, terminal
// pty streams, and embedded browser control.
//
// These cross the renderer/main IPC boundary, so unlike the in-memory tab model
// they are Zod schemas: the renderer's requests are validated in the main
// process before touching the filesystem or spawning a shell.

import { z } from 'zod';

/** Auxiliary resources and replies belong to the paper that opened them. */
const DesktopWorkspaceMessageSchema = z.object({ session: z.string() });

export const DESKTOP_WORKSPACE_COMMANDS = {
  // Editor
  LIST_FILES: 'desktop:workspace:listFiles',
  FILES_LISTED: 'desktop:workspace:filesListed',
  FILES_LIST_ERROR: 'desktop:workspace:filesListError',
  READ_FILE: 'desktop:workspace:readFile',
  FILE_READ: 'desktop:workspace:fileRead',
  WRITE_FILE: 'desktop:workspace:writeFile',
  FILE_WRITTEN: 'desktop:workspace:fileWritten',
  FILE_ERROR: 'desktop:workspace:fileError',
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
  // Environment
  ENVIRONMENT_REQUEST: 'desktop:environment:request',
  ENVIRONMENT_STATE: 'desktop:environment:state',
} as const;

// ── Editor ──
//
// Editor file I/O is request/response RPC over the fire-and-forget channel.
// The renderer tags each request with a `requestId` (the same correlation
// pattern as `desktopPromptMessages.ts`) and the main process echoes it in
// the response, so concurrent requests for the same path cannot
// cross-resolve. `path`/`directory` still ride along for the main process's
// own use and for logging context.

const DesktopListFilesMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.LIST_FILES),
  requestId: z.uuid(),
  directory: z.string().prefault(''),
});

const DesktopWorkspaceFileEntrySchema = z.object({
  path: z.string(),
  isDirectory: z.boolean(),
});

export const DesktopFilesListedMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED),
    requestId: z.uuid(),
    directory: z.string(),
    files: z.array(DesktopWorkspaceFileEntrySchema),
  });

export const DesktopFilesListErrorMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILES_LIST_ERROR),
    requestId: z.uuid(),
    directory: z.string(),
    message: z.string(),
  });

const DesktopReadFileMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.READ_FILE),
  requestId: z.uuid(),
  path: z.string(),
});

export const DesktopFileReadMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILE_READ),
    requestId: z.uuid(),
    path: z.string(),
    contents: z.string(),
  });

const DesktopWriteFileMessageSchema = DesktopWorkspaceMessageSchema.extend({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE),
  requestId: z.uuid(),
  path: z.string(),
  contents: z.string(),
});

export const DesktopFileWrittenMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN),
    requestId: z.uuid(),
    path: z.string(),
  });

export const DesktopFileErrorMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILE_ERROR),
    requestId: z.uuid(),
    path: z.string(),
    message: z.string(),
  });

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

// ── Environment ──

const DesktopEnvironmentRequestMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_REQUEST),
  });

const DesktopEnvironmentSummarySchema = z.object({
  isGitRepository: z.boolean(),
  branch: z.string().optional(),
  upstream: z.string().optional(),
  changedFiles: z.int().nonnegative(),
  additions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
  ahead: z.int().nonnegative(),
  behind: z.int().nonnegative(),
});

export type DesktopEnvironmentSummary = z.infer<
  typeof DesktopEnvironmentSummarySchema
>;

export const EMPTY_DESKTOP_ENVIRONMENT_SUMMARY = {
  isGitRepository: false,
  changedFiles: 0,
  additions: 0,
  deletions: 0,
  ahead: 0,
  behind: 0,
} satisfies DesktopEnvironmentSummary;

export const DesktopEnvironmentStateMessageSchema =
  DesktopWorkspaceMessageSchema.extend({
    command: z.literal(DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_STATE),
    environment: DesktopEnvironmentSummarySchema,
  });

/** Everything the main process accepts from the renderer. */
export const DesktopWorkspaceInboundMessageSchema = z.discriminatedUnion(
  'command',
  [
    DesktopListFilesMessageSchema,
    DesktopReadFileMessageSchema,
    DesktopWriteFileMessageSchema,
    DesktopTerminalStartMessageSchema,
    DesktopTerminalInputMessageSchema,
    DesktopTerminalResizeMessageSchema,
    DesktopTerminalCloseMessageSchema,
    DesktopBrowserOpenMessageSchema,
    DesktopBrowserBoundsMessageSchema,
    DesktopBrowserHideMessageSchema,
    DesktopBrowserCloseMessageSchema,
    DesktopEnvironmentRequestMessageSchema,
  ],
);
