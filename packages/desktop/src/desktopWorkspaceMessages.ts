// Wire contract for the workspace shell surfaces: editor file I/O, terminal
// pty streams, and embedded browser control.
//
// These cross the renderer/main IPC boundary, so unlike the in-memory tab model
// they are Zod schemas: the renderer's requests are validated in the main
// process before touching the filesystem or spawning a shell.

import { z } from 'zod';

export const DESKTOP_WORKSPACE_COMMANDS = {
  // Editor
  LIST_FILES: 'desktop:workspace:listFiles',
  FILES_LISTED: 'desktop:workspace:filesListed',
  READ_FILE: 'desktop:workspace:readFile',
  FILE_READ: 'desktop:workspace:fileRead',
  WRITE_FILE: 'desktop:workspace:writeFile',
  FILE_WRITTEN: 'desktop:workspace:fileWritten',
  FILE_ERROR: 'desktop:workspace:fileError',
  // Terminal
  TERMINAL_START: 'desktop:terminal:start',
  TERMINAL_INPUT: 'desktop:terminal:input',
  TERMINAL_RESIZE: 'desktop:terminal:resize',
  TERMINAL_CLOSE: 'desktop:terminal:close',
  TERMINAL_DATA: 'desktop:terminal:data',
  TERMINAL_EXIT: 'desktop:terminal:exit',
  TERMINAL_ERROR: 'desktop:terminal:error',
  // Browser
  BROWSER_OPEN: 'desktop:browser:open',
  BROWSER_BOUNDS: 'desktop:browser:bounds',
  BROWSER_HIDE: 'desktop:browser:hide',
  BROWSER_NAVIGATE: 'desktop:browser:navigate',
  BROWSER_BACK: 'desktop:browser:back',
  BROWSER_FORWARD: 'desktop:browser:forward',
  BROWSER_RELOAD: 'desktop:browser:reload',
  BROWSER_CLOSE: 'desktop:browser:close',
  BROWSER_STATE: 'desktop:browser:state',
} as const;

// ── Editor ──

const DesktopListFilesMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.LIST_FILES),
});

const DesktopWorkspaceFileEntrySchema = z.object({
  path: z.string(),
  isDirectory: z.boolean(),
});

export const DesktopFilesListedMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED),
  files: z.array(DesktopWorkspaceFileEntrySchema),
});

const DesktopReadFileMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.READ_FILE),
  path: z.string(),
});

export const DesktopFileReadMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILE_READ),
  path: z.string(),
  contents: z.string(),
});

const DesktopWriteFileMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE),
  path: z.string(),
  contents: z.string(),
});

export const DesktopFileWrittenMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN),
  path: z.string(),
});

export const DesktopFileErrorMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.FILE_ERROR),
  path: z.string(),
  message: z.string(),
});

// ── Terminal ──

const DesktopTerminalStartMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START),
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const DesktopTerminalInputMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT),
  sessionId: z.string(),
  data: z.string(),
});

const DesktopTerminalResizeMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE),
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const DesktopTerminalCloseMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE),
  sessionId: z.string(),
});

export const DesktopTerminalDataMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_DATA),
  sessionId: z.string(),
  data: z.string(),
});

export const DesktopTerminalExitMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_EXIT),
  sessionId: z.string(),
  exitCode: z.number().int(),
});

export const DesktopTerminalErrorMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_ERROR),
  sessionId: z.string(),
  message: z.string(),
});

// ── Browser ──

const DesktopBrowserBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export type DesktopBrowserBounds = z.infer<typeof DesktopBrowserBoundsSchema>;

const DesktopBrowserOpenMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN),
  tabId: z.string(),
  url: z.string(),
});

const DesktopBrowserBoundsMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS),
  tabId: z.string(),
  bounds: DesktopBrowserBoundsSchema,
});

const DesktopBrowserHideMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE),
});

const DesktopBrowserNavigateMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_NAVIGATE),
  tabId: z.string(),
  url: z.string(),
});

/** Back / forward / reload / close all carry just the tab id. */
const browserTabCommand = <T extends string>(command: T) =>
  z.object({ command: z.literal(command), tabId: z.string() });

const DesktopBrowserBackMessageSchema = browserTabCommand(
  DESKTOP_WORKSPACE_COMMANDS.BROWSER_BACK,
);
const DesktopBrowserForwardMessageSchema = browserTabCommand(
  DESKTOP_WORKSPACE_COMMANDS.BROWSER_FORWARD,
);
const DesktopBrowserReloadMessageSchema = browserTabCommand(
  DESKTOP_WORKSPACE_COMMANDS.BROWSER_RELOAD,
);
const DesktopBrowserCloseMessageSchema = browserTabCommand(
  DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE,
);

export const DesktopBrowserStateMessageSchema = z.object({
  command: z.literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_STATE),
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loading: z.boolean(),
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
    DesktopBrowserNavigateMessageSchema,
    DesktopBrowserBackMessageSchema,
    DesktopBrowserForwardMessageSchema,
    DesktopBrowserReloadMessageSchema,
    DesktopBrowserCloseMessageSchema,
  ],
);
