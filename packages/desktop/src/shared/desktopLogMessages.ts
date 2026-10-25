import { Effect, Schema } from 'effect';

export const DESKTOP_LOG_COMMANDS = {
  REQUEST_LOG: 'desktop:requestLog',
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

/**
 * One line of the desktop log file. The main process writes the structured
 * entry it receives from the shared log sink as JSON, so the renderer reads
 * severity, time, and identity as fields instead of recovering them from a
 * formatted line. Levels are Effect's own names (`WARN`, `ERROR`, ...).
 */
export const DesktopLogLineSchema = Schema.Struct({
  level: Schema.String,
  timestamp: Schema.String,
  message: Schema.Unknown,
  cause: Schema.optional(Schema.String),
  annotations: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  spans: Schema.Record(Schema.String, Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  fiberId: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
});

export type DesktopLogLine = typeof DesktopLogLineSchema.Type;

/**
 * The display text for one line: its message, then whatever the entry carries
 * that the row's own level and time fields do not already show. Shared so the
 * writer and the viewer agree without the viewer reaching into core.
 */
export function desktopLogLineText(line: DesktopLogLine): string {
  const parts = Array.isArray(line.message) ? line.message : [line.message];
  const message = parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ');
  // `channel` is the annotation key the harness's log sink writes. The renderer
  // cannot import core, so it is named here, where the writer and the viewer
  // already share this line's schema.
  const channel = line.annotations['channel'];
  const detail = Object.entries(line.annotations).filter(
    ([key]) => key !== 'channel',
  );
  return [
    `${typeof channel === 'string' ? `[${channel}] ` : ''}${message}`,
    line.cause,
    detail.length === 0
      ? undefined
      : JSON.stringify(Object.fromEntries(detail)),
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join('\n');
}

export type DesktopLogSnapshot = typeof DesktopLogSnapshotSchema.Type;
export type DesktopSetLogMessage = typeof DesktopSetLogMessageSchema.Type;
