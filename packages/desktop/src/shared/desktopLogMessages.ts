import { Schema } from 'effect';

export const DESKTOP_LOG_COMMANDS = {
  REQUEST_LOG: 'desktop:requestLog',
  FOLLOW_LOG: 'desktop:followLog',
  SET_LOG: 'desktop:setLog',
  COPY_LOG: 'desktop:copyLog',
  EXPORT_LOG: 'desktop:exportLog',
} as const;

const DesktopLogSnapshotSchema = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  path: Schema.String,
});

export const DesktopSetLogMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_LOG_COMMANDS.SET_LOG),
  log: DesktopLogSnapshotSchema,
});

/** The Logs tab was shown (`following`) or hidden: main pushes the log
 *  each time the file changes while it is shown. */
export const DesktopFollowLogMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_LOG_COMMANDS.FOLLOW_LOG),
  following: Schema.Boolean,
});

export type DesktopLogSnapshot = typeof DesktopLogSnapshotSchema.Type;
export type DesktopSetLogMessage = typeof DesktopSetLogMessageSchema.Type;
