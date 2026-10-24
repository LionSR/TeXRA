// Wire contract for the workspace shell surfaces: editor file I/O, terminal
// pty runs, and embedded browser control.
//
// These cross the renderer/main IPC boundary, so unlike the in-memory tab model
// they are Zod schemas: the renderer's requests are validated in the main
// process before touching the filesystem or spawning a shell.

import { Schema, Struct } from 'effect';

/** Auxiliary resources and replies belong to the paper that opened them. */
const DesktopWorkspaceMessageSchema = Schema.Struct({ session: Schema.String });

export const DESKTOP_WORKSPACE_COMMANDS = {
  // Editor
  FILES_CHANGED: 'desktop:workspace:filesChanged',
  OPEN_DOCUMENT: 'desktop:workspace:openDocument',
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
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.FILES_CHANGED),
    }),
  );

export const DesktopOpenDocumentMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.OPEN_DOCUMENT),
      target: Schema.String,
    }),
  );

// ── Terminal ──

const DesktopTerminalStartMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START),
      sessionId: Schema.String,
      cols: Schema.Int.check(Schema.isGreaterThan(0)),
      rows: Schema.Int.check(Schema.isGreaterThan(0)),
      initialCommand: Schema.optional(
        Schema.String.check(Schema.isMinLength(1)),
      ),
    }),
  );

const DesktopTerminalInputMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT),
      sessionId: Schema.String,
      data: Schema.String,
    }),
  );

const DesktopTerminalResizeMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE),
      sessionId: Schema.String,
      cols: Schema.Int.check(Schema.isGreaterThan(0)),
      rows: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  );

const DesktopTerminalCloseMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE),
      sessionId: Schema.String,
    }),
  );

export const DesktopTerminalDataMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_DATA),
      sessionId: Schema.String,
      data: Schema.String,
    }),
  );

export const DesktopTerminalExitMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_EXIT),
      sessionId: Schema.String,
      exitCode: Schema.Int,
    }),
  );

export const DesktopTerminalErrorMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_ERROR),
      sessionId: Schema.String,
      message: Schema.String,
    }),
  );

export const DesktopTerminalOpenCommandMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_OPEN_COMMAND),
      initialCommand: Schema.String.check(Schema.isMinLength(1)),
    }),
  );

// ── Browser ──

const DesktopBrowserBoundsSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  height: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type DesktopBrowserBounds = typeof DesktopBrowserBoundsSchema.Type;

const DesktopBrowserOpenMessageSchema = DesktopWorkspaceMessageSchema.mapFields(
  Struct.assign({
    command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN),
    tabId: Schema.String,
    url: Schema.String,
  }),
);

const DesktopBrowserBoundsMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS),
      tabId: Schema.String,
      bounds: DesktopBrowserBoundsSchema,
    }),
  );

const DesktopBrowserHideMessageSchema = DesktopWorkspaceMessageSchema.mapFields(
  Struct.assign({
    command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE),
  }),
);

const DesktopBrowserCloseMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE),
      tabId: Schema.String,
    }),
  );

export const DesktopBrowserStateMessageSchema =
  DesktopWorkspaceMessageSchema.mapFields(
    Struct.assign({
      command: Schema.Literal(DESKTOP_WORKSPACE_COMMANDS.BROWSER_STATE),
      tabId: Schema.String,
      title: Schema.String,
    }),
  );

/** Everything the main process accepts from the renderer. */
export const DesktopWorkspaceInboundMessageSchema = Schema.Union([
  DesktopTerminalStartMessageSchema,
  DesktopTerminalInputMessageSchema,
  DesktopTerminalResizeMessageSchema,
  DesktopTerminalCloseMessageSchema,
  DesktopBrowserOpenMessageSchema,
  DesktopBrowserBoundsMessageSchema,
  DesktopBrowserHideMessageSchema,
  DesktopBrowserCloseMessageSchema,
]);

export type DesktopWorkspaceInboundMessage =
  (typeof DesktopWorkspaceInboundMessageSchema)['Type'];

/** A workspace request before the project transport stamps its `session`. */
export type DesktopWorkspaceRequest =
  DesktopWorkspaceInboundMessage extends infer M
    ? M extends DesktopWorkspaceInboundMessage
      ? Omit<M, 'session'>
      : never
    : never;

/** The commands the main process routes to a project's workspace. */
export const DESKTOP_WORKSPACE_INBOUND_COMMANDS =
  DesktopWorkspaceInboundMessageSchema.members; /* TODO(effect-schema): flatMap; was `.flatMap((option) => [ ...option.shape.command.values, ])` */

type WorkspaceOutbound =
  | typeof DesktopWorkspaceFilesChangedMessageSchema.Type
  | typeof DesktopTerminalDataMessageSchema.Type
  | typeof DesktopTerminalExitMessageSchema.Type
  | typeof DesktopTerminalErrorMessageSchema.Type
  | typeof DesktopBrowserStateMessageSchema.Type;

/** A workspace reply before the project transport stamps its `session`. */
export type DesktopWorkspaceReply = WorkspaceOutbound extends infer M
  ? M extends WorkspaceOutbound
    ? Omit<M, 'session'>
    : never
  : never;
